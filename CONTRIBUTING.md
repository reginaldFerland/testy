# Local development

1. Run `npm ci` with Node 22 (see `.nvmrc`) and the .NET SDK pinned by `global.json` (10.0.300 or a later feature band) installed.
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
- `npm run test:extension`: VS Code extension tests. Use `TESTY_VSCODE_PATH` to reuse an installed VS Code and `TESTY_COVERAGE_TOOL` to reuse an installed collector.
- `npm run test:dotnet`: xUnit tests for the .NET helpers in `backend/Testy.Backend.Tests` (command-line quoting, PATH resolution, evaluation allowlists, source fingerprints, JSON contracts). They run on any OS; the `build:*` scripts and the VSIX never include them.
- `npm run typecheck:tests`: tests opt in to type checking with a leading `// @ts-check`. New test files should opt in; many older ones use deliberately partial mocks and do not yet.
- `npm run l10n:export`: regenerate `l10n/bundle.l10n.json` after changing user-facing strings. Call `l10n.t(...)` literally so the extractor finds them.

There is no CI. Before a change is merged or published, run locally `npm test` (it compiles, lints and typechecks first), `npm run test:integration` and `npm run test:extension`. Windows-specific code paths (ProcessHost, Job Objects) need a manual run on a Windows machine.

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

See [validation evidence](docs/1.0-validation.md) for measured performance and platform limits, and the [performance review](docs/performance-review.md) for optimization measurements and remaining candidates.

## Packaging

Run `npm run package`, then **Extensions: Install from VSIX…** to test the local installable package. Nothing is published by packaging or installing a VSIX.
