# Local development

1. Run `npm ci` with Node 24 (see `.nvmrc`) and the .NET SDK pinned by `global.json` (10.0.300 or a later feature band) installed.

## Supported targets

- Minimum VS Code: `engines.vscode` in `package.json` (currently 1.140). `@types/vscode` must stay at the same version, and run the extension-host tests against that minimum locally (`TESTY_VSCODE_VERSION=min npm run test:extension:only`).
- Target projects: .NET 10 or later test projects that run on Microsoft.Testing.Platform (MSTest, xUnit v3 with MTP v2, NUnit with the MTP adapter). VSTest projects and test targets older than .NET 10 are skipped with a reason, not supported; do not add compatibility code for them.
- Building and developing Testy needs the .NET SDK from `global.json` or any later 10.0 feature band (`rollForward: latestFeature`).
2. Open this repository in VS Code and press F5. The launch task builds the .NET helpers, then starts the TypeScript watcher (`out/`, used by tests) and the esbuild watcher (`dist/extension.js`, used by the Extension Development Host).
3. Open `test/fixtures/ImpactDemo` in the Extension Development Host and trust the workspace.
4. Wait for the baseline, edit `ImpactDemo/Arithmetic.cs`, and save. Check Test Explorer, coverage, and **Testy: Show Output**.
5. Restart the debug session after changing a .NET helper. TypeScript changes rebundle automatically; reload the host to activate them.

## Build layout

- `npm run compile` runs `tsc` (emits `out/` with declarations for the Node test suites), bundles with esbuild into `dist/`, and builds the .NET helpers into `dist/analyzer`, `dist/processhost` and `dist/observer`.
- The packaged extension runs only from `dist/`: `extension.js` plus the `cacheWorker`, `coverageWorker` and `posixOwner` entry points it starts. `vscode:prepublish` builds a minified bundle whose external source maps (`dist/*.map`) stay out of the VSIX. `.vscodeignore` is an allowlist; check `npx vsce ls` after adding runtime files.
- Runtime npm packages are bundled, so every npm dependency is a devDependency.

## Checks

- `npm test`: compile, lint (type-aware ESLint, zero warnings allowed), type-check the tests, then run the unit tests (`npm run test:unit:only` is the same run without the preparation). The unit suite runs with Node's default test concurrency; limiting it with `--test-concurrency` was slower on a 10-core machine, so process-heavy tests wait for conditions with generous deadlines rather than relying on a low concurrency. The unit scripts preload `test/unit/support/fastFsync.mjs`, which turns durability flushes (`FileHandle.sync`) into no-ops: no unit test can observe one, and on macOS each is a full device cache flush that made the suite three times slower. Tests of flush ordering wrap `sync` per handle, and `storageDurability.test.cjs` keeps real flushes. Keep each unit test to a few seconds: shrink production-sized limits through their seams (`CacheLimits`, `lockTiming`) and fire timers instead of waiting for them.
- `npm run test:integration`: integration tests against the real .NET SDK and MTP fixtures. Node runs test files in parallel but the tests of one file in sequence, so keep each file to a cohesive group of at most a dozen fixture builds; the regression scenarios share their fixtures through `test/integration/support/regressions.cjs`. Node's default file concurrency was the fastest measured on a 10-core Mac (261 s, against 280 s with 6 files at once and 317 s with 4).
- `npm run test:extension`: VS Code extension tests, run by `test/extension/run.mjs` on `@vscode/test-electron` (pass `scenarios`, `commands`, `xunit` or `nunit` to run one configuration). Use `TESTY_VSCODE_PATH` to reuse an installed VS Code and `TESTY_COVERAGE_TOOL` to reuse an installed collector.
- `npm run test:dotnet`: xUnit tests for the .NET helpers in `backend/Testy.Backend.Tests` (command-line quoting, PATH resolution, evaluation allowlists, source fingerprints, JSON contracts). They run on any OS; the `build:*` scripts and the VSIX never include them.
- `npm run typecheck:tests`: every `test/**/*.cjs` file is type-checked (`checkJs` in `tsconfig.tests.json`) against the declarations in `out/`, so run `npm run compile` first. No `// @ts-check` marker is needed. Type test code with JSDoc and `import('../../out/...')` types; use `/** @type {any} */` only for a deliberate partial mock, with a comment. All tests are also linted with the type-aware `@typescript-eslint/no-floating-promises`, `no-misused-promises` and `await-thenable` rules (`node:test` registration calls are exempt), so a forgotten `await` fails `npm run lint`.
- `:only` variants (`test:unit:only`, `test:integration:only`, `test:extension:only`) skip the compile step that `test`, `test:integration` and `test:extension` run first. Use them after `npm run compile`; `npm run verify` compiles once and uses them.
- `npm run clean`: removes `out/`, `dist/`, `coverage/`, `.benchmarks/` and any `*.vsix` in the repository root (`node scripts/clean.mjs --all` also removes the `.vscode-test/` VS Code download). Run `npm run compile` afterwards.
- `npm run l10n:export`: regenerate `l10n/bundle.l10n.json` after changing user-facing strings. Call `l10n.t(...)` literally so the extractor finds them. The extractor is fetched on demand at a pinned version rather than installed with the other dev dependencies.

- `npm run coverage`: run the unit tests with Node's built-in coverage report (`--experimental-test-coverage`, tests and `node_modules` excluded) and fail below the line, branch and function floors set in the script. Raise the floors when coverage improves.
- `npm run check:changelog`: fail unless `CHANGELOG.md` has a `## <version>` section for the `package.json` version (the release job runs it).
- `npm run check:vsix`: compare the VSIX file list (`vsce ls`) with the snapshot in `scripts/vsix-files.txt`; run it after a build. `npm run check:vsix -- --vsix testy.vsix` compares the entries of a built package instead (the release job uses it on the exact file it publishes). Refresh the snapshot with `node scripts/check-vsix-files.mjs --update` when a packaging change is intended.

## Before pushing

Run `npm run verify` before every push; nothing else runs these suites. It works the same on macOS, Linux and Windows. It builds once (`tsc`, the esbuild bundle and the three .NET helpers side by side), then runs, in parallel where they do not contend, ESLint, the test type check, `npm audit --omit=dev --audit-level=high`, `npm audit signatures`, `npm run l10n:export` (failing when it changes `l10n/`), `npm run check:changelog`, `npm run check:vsix` and the unit, .NET, integration and extension tests. It prints a timing table and exits non-zero when any step fails, with the end of each failed step's log (every log is kept in a `testy-verify-*` temporary directory until a run passes). The extension tests start only after the integration tests finish: their fixed waits for file system events failed under the integration suite's CPU load. A full run takes about six minutes on a 10-core Mac (about 4.7 minutes of integration tests, then 1.4 of extension tests).

- `npm run verify -- --skip-extension` (or `--skip-<step>` for any step) leaves a step out; `npm run verify -- --only unit,lint` runs just those steps and the build steps they need; `--list` names the steps.
- The audits and the l10n extractor need network access. Set `TESTY_VSCODE_PATH` to reuse an installed VS Code for the extension tests.
- On Windows, `npm run test:windows` is the quick check of the Windows-specific code paths; run the full `npm run verify` there as well before pushing changes that touch processes, paths or the .NET helpers.

## Continuous integration

There is no CI: nothing runs automatically on a push or pull request, and no macOS or Linux runner is used. Verification is local. Before pushing, run the full local verification on macOS (see "Before pushing"). For a change that touches Windows-specific code (ProcessHost, job objects, executable resolution, junctions), also run the full verification, or at least `npm run test:windows`, on a Windows clone.

`npm run test:windows` is the quick Windows check: it runs only the tests whose behaviour is Windows-specific. Run `npx tsc -p ./` and `npm run build:process-host` first. On macOS and Linux the Windows-only tests skip, and the dual-platform ones run against the POSIX owner. `npm run test:windows:slow` adds the slow Windows integration tests (needs `npm run build:dotnet`).

Marking a Windows-specific test: in `test/unit` or `test/integration`, start its name with `[windows]` (for example `test('[windows] junctions resolve to their target', ...)`), or `[windows-slow]` for a test that builds real projects; `scripts/test-windows.mjs` finds the files by that prefix and runs them with `--test-name-pattern`. A test is Windows-specific only if it needs real Windows behaviour; a test that sets `process.platform` or uses `path.win32` runs everywhere and stays unmarked. In `backend/Testy.Backend.Tests`, add `[Trait("Platform", "Windows")]` to the `[Fact]`; `npm run test:windows` runs those through `dotnet test --project Testy.Backend.Tests --filter-trait "Platform=Windows"` (the xunit.v3 Microsoft.Testing.Platform filter).

The workflows are manual or tag-only. `codeql.yml` (TypeScript and C# scans) runs only when triggered by hand (`workflow_dispatch`), and so does `performance.yml`. Every action is pinned to a commit SHA with a version comment; Dependabot proposes weekly grouped updates for npm, NuGet, the .NET SDK and Actions (its pull requests trigger no workflow). Review dependency changes yourself, including `npm audit --omit=dev --audit-level=high`.

`performance.yml` runs the benchmarks when triggered by hand and uploads `.benchmarks/` as the `benchmarks` artifact.

### Releasing

1. Set the new version in `package.json` (and `package-lock.json`, for example with `npm version <version> --no-git-tag-version`).
2. In `CHANGELOG.md`, rename `## Unreleased` to `## <version>` and add a fresh empty `## Unreleased` section above it if you keep one.
3. Merge that change to `main`, then tag the merge commit and push the tag: `git tag v<version> && git push origin v<version>`.

Pushing a `v*` tag runs `release.yml` (it is the only workflow a tag triggers, and it runs no tests; run the local checks before tagging, including `npm audit --omit=dev --audit-level=high` and `npm run check:vsix`). It requires the tagged commit to be on `main`, the tag to match `package.json`, `CHANGELOG.md` to have a section for the version (`npm run check:changelog`), and both `VSCE_PAT` and `OVSX_PAT` to be set (a missing token fails the run; it never skips publishing). It packages the VSIX once, checks that file's contents with `check:vsix`, generates an SPDX SBOM of the locked npm and NuGet dependencies, collects the production source maps (`dist/*.map`, which are kept out of the VSIX) and attests the VSIX, source maps and SBOM with build provenance (`gh attestation verify testy.vsix --repo reginaldFerland/testy`). The publish job then publishes to the Visual Studio Marketplace and Open VSX, and only then creates the GitHub release with those files attached; already-published versions are skipped, so a failed run can be re-run. The tokens are exposed only to the token check and their own publish step. To rehearse everything except publishing, run the **Release** workflow manually from any branch with `dry-run` left on.

`npm run vscode:prepublish` lints before building, so packaging is gated on lint locally too; `npm run test:extension` compiles first so it never runs a stale `dist/`. Windows-specific code paths (ProcessHost, Job Objects) are verified only on a Windows clone, so run `npm run test:windows` there after changing them.

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
node test/performance/coverage-scaling.cjs
node test/performance/live-updates.cjs
node test/performance/discovery.cjs
```

Each benchmark mirrors its JSON result lines into `.benchmarks/<script>-<timestamp>.jsonl` (git-ignored; override with `TESTY_BENCH_DIR`), while scratch workspaces live in the OS temp directory. Keep ad-hoc logs and reports there rather than in `out/`, which holds only `tsc` output. `npm run clean` removes it.

See [validation evidence](docs/1.0-validation.md) for measured performance and platform limits, and the [performance review](docs/performance-review.md) for optimization measurements and remaining candidates.

## Packaging

Run `npm run package`, then **Extensions: Install from VSIX…** to test the local installable package. Nothing is published by packaging or installing a VSIX.
