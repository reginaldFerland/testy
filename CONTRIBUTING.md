# Local development

1. Run `npm ci` with Node 24 (see `.nvmrc`) and the .NET SDK pinned by `global.json` (10.0.300 or a later feature band) installed.
2. Open this repository in VS Code and press F5. The launch task builds the .NET helpers, then starts the TypeScript watcher (`out/`, used by tests) and the esbuild watcher (`dist/extension.js`, used by the Extension Development Host).
3. Open `test/fixtures/ImpactDemo` in the Extension Development Host and trust the workspace.
4. Wait for the baseline, edit `ImpactDemo/Arithmetic.cs`, and save. Check Test Explorer, coverage, and **Testy: Show Output**.
5. Restart the debug session after changing a .NET helper. TypeScript changes rebundle automatically; reload the host to activate them.

## Build layout

- `npm run compile` runs `tsc` (emits `out/` with declarations for the Node test suites), bundles with esbuild into `dist/`, and builds the .NET helpers into `dist/analyzer`, `dist/processhost` and `dist/observer`.
- The packaged extension runs only from `dist/`: `extension.js` plus the `cacheWorker`, `coverageWorker` and `posixOwner` entry points it starts. `vscode:prepublish` builds a minified bundle without source maps. `.vscodeignore` is an allowlist; check `npx vsce ls` after adding runtime files.
- Runtime npm packages are bundled, so every npm dependency is a devDependency.

## Checks

- `npm test`: compile, lint (type-aware ESLint), type-check opted-in tests, then run the unit tests.
- `npm run test:integration`: integration tests against the real .NET SDK and MTP fixtures.
- `npm run test:extension`: VS Code extension tests, run by `test/extension/run.mjs` on `@vscode/test-electron` (pass `scenarios`, `commands`, `xunit` or `nunit` to run one configuration). Use `TESTY_VSCODE_PATH` to reuse an installed VS Code and `TESTY_COVERAGE_TOOL` to reuse an installed collector.
- `npm run test:dotnet`: xUnit tests for the .NET helpers in `backend/Testy.Backend.Tests` (command-line quoting, PATH resolution, evaluation allowlists, source fingerprints, JSON contracts). They run on any OS; the `build:*` scripts and the VSIX never include them.
- `npm run typecheck:tests`: every `test/**/*.cjs` file is type-checked (`checkJs` in `tsconfig.tests.json`) against the declarations in `out/`, so run `npm run compile` first. No `// @ts-check` marker is needed. Type test code with JSDoc and `import('../../out/...')` types; use `/** @type {any} */` only for a deliberate partial mock, with a comment. All tests are also linted with the type-aware `@typescript-eslint/no-floating-promises`, `no-misused-promises` and `await-thenable` rules (`node:test` registration calls are exempt), so a forgotten `await` fails `npm run lint`.
- `:only` variants (`test:unit:only`, `test:integration:only`, `test:extension:only`) skip the compile step that `test`, `test:integration` and `test:extension` run first. Use them after `npm run compile`; CI compiles once and uses them.
- `npm run clean`: removes `out/`, `dist/`, `coverage/`, `.benchmarks/` and any `*.vsix` in the repository root (`node scripts/clean.mjs --all` also removes the `.vscode-test/` VS Code download). Run `npm run compile` afterwards.
- `npm run l10n:export`: regenerate `l10n/bundle.l10n.json` after changing user-facing strings. Call `l10n.t(...)` literally so the extractor finds them. The extractor is fetched on demand at a pinned version rather than installed with the other dev dependencies.

- `npm run coverage`: run the unit tests with Node's built-in coverage report (`--experimental-test-coverage`, tests and `node_modules` excluded) and fail below the line-coverage floor set in the script. CI runs it on Ubuntu; raise the floor when coverage improves.
- `npm run check:vsix`: compare the VSIX file list (`vsce ls`) with the snapshot in `scripts/vsix-files.txt`; run it after a build. `npm run check:vsix -- --vsix testy.vsix` compares the entries of a built package instead (CI and the release job use it on the exact file they upload or publish). Refresh the snapshot with `node scripts/check-vsix-files.mjs --update` when a packaging change is intended.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request to `main`. On Windows, macOS and Ubuntu it compiles once, then lints, type-checks the tests and runs the unit tests (on Node 24, the extension host's Node in the minimum supported VS Code, per `.nvmrc`), `npm run test:dotnet`, the integration tests and the extension tests (under `xvfb-run` on Linux) through the `:only` scripts. Ubuntu also enforces the unit-test line-coverage floor and fails when `npm run l10n:export` changes `l10n/`. A separate job repeats the extension tests on the minimum VS Code in `engines.vscode` (`TESTY_VSCODE_VERSION=min`; a version number or `insiders` also works locally). A packaging job builds the VSIX once, checks its file list and uploads it as an artifact. Every action is pinned to a commit SHA with a version comment; Dependabot proposes updates. CodeQL (`codeql.yml`) scans the TypeScript and C# code, and Dependabot proposes weekly grouped updates for npm, NuGet and Actions.

Pushing a `v*` tag runs `release.yml`: it repeats CI as a gate, requires the tag to match `package.json`, packages the VSIX once, checks that file's contents with `check:vsix`, attaches it to a GitHub release, and publishes to the Visual Studio Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`). A publish step is skipped when its secret is absent. The tokens are exposed only to their own publish step.

`npm run vscode:prepublish` lints before building, so packaging is gated on lint locally too; `npm run test:extension` compiles first so it never runs a stale `dist/`. Windows-specific code paths (ProcessHost, Job Objects) run in CI on Windows, but still deserve a manual check on a real machine after changes.

The .NET helpers restore in locked mode for packaged builds. After changing a helper's package versions, run `npm run build:dotnet` and commit the regenerated `packages.lock.json` files.

## Test details

Integration tests copy the sample workspace into a temporary directory, build it, modify its source, and assert the selected test identities, failure results, retained coverage, constant-change fallback, and cancellation. The extension-host suite downloads an isolated VS Code build and exercises saves, pause/resume, refresh, and external linked-file events.

The analyzer compiles against the oldest supported Roslyn (5.0, as shipped by SDK 10.0.100) but does not bundle it: `RoslynLoader` loads the Roslyn of the installed .NET SDK at run time, and a self-test at server start rejects one that behaves differently. Unit validation rejects platform-specific managed binaries and any bundled Roslyn, so a VSIX built on one OS can use the same analyzer on another. Source analysis is served by a long-lived analyzer process (`--server`) that falls back to one process per request; project graph evaluation always runs in a fresh MSBuild process. The runtime observer uses a .NET startup hook compatible with the collector and managed child runtimes; it does not edit workspace packages or build outputs.

## Benchmarks

```sh
# 4,800-case deep dependency graph benchmark (three serial/automatic pairs)
npm run benchmark
# Report parsing, output reuse, identity lookup, and UI publication probes
npm run benchmark:responsiveness
node test/performance/cache-and-results.cjs
node test/performance/cache-membership.cjs
node test/performance/live-updates.cjs
node test/performance/discovery.cjs
```

Each benchmark mirrors its JSON result lines into `.benchmarks/<script>-<timestamp>.jsonl` (git-ignored; override with `TESTY_BENCH_DIR`), while scratch workspaces live in the OS temp directory. Keep ad-hoc logs and reports there rather than in `out/`, which holds only `tsc` output. `npm run clean` removes it.

See [validation evidence](docs/1.0-validation.md) for measured performance and platform limits, and the [performance review](docs/performance-review.md) for optimization measurements and remaining candidates.

## Packaging

Run `npm run package`, then **Extensions: Install from VSIX…** to test the local installable package. Nothing is published by packaging or installing a VSIX.
