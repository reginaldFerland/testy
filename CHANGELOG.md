# Changelog

## Unreleased

### Added

- **Debug profile:** debug tests from Test Explorer (requires the C# extension). Each selected project runs in one process without coverage, and the run timeout does not apply.
- **Continuous run:** Test Explorer's continuous run is supported. While automatic testing is paused, a continuous run keeps its selected tests running after changes.
- **Native coverage view:** coverage appears in Test Explorer's coverage view with per-line statement ranges (taken from the open editor's text when there is one) and per-method (function) coverage, can be filtered per test file and project, and retained coverage is published even without a run.
- **Status bar menu:** pause or resume, run affected tests now, refresh, cancel the current run, clear coverage, reset caches and baseline, and show output.
- **New commands:** **Run Affected Tests Now**, **Cancel Current Run**, **Clear Coverage**, **Reset Caches and Baseline**, and separate **Pause**/**Resume** buttons in Test Explorer.
- **Project filtering:** `testy.solution` limits Testy to the projects of a `.sln`, `.slnx` or `.slnf`; `testy.projects.include` and `testy.projects.exclude` filter projects by glob.
- **Problems panel:** build errors and warnings are listed there and cleared after the next successful build.
- **Better failures:** expected/actual diffs when the framework reports them, clickable stack frames, and a message location on the failing line in your code.
- **Test tree:** project and framework tags for filtering, and test ranges that span the declaration when the framework reports it.
- **Walkthrough and localization:** a getting-started walkthrough covers prerequisites, the first baseline, coverage, pausing and debugging; all strings are localizable.
- A one-time notice explains duplicate test entries when C# Dev Kit is also installed.
- **Export Coverage:** write the current coverage as LCOV or Cobertura XML for other tools.
- **Why did this run?** Each selected test file shows why it ran (for example, it covers a changed file, or a project fallback), in the run output, the log and Test Explorer.
- **Configuration profiles:** `testy.additionalConfigurations` adds Run and Run with coverage profiles that build with another MSBuild configuration, such as `Release`.
- **Trait tags:** test traits and categories become Test Explorer tags (`trait:Key=Value`, `category:Value`).
- Establishing a baseline shows progress with a percentage in the status bar.
- Build errors are shown on the affected project items in Test Explorer, with a link to the output.
- **Context menus:** **Why Was This Selected?** on Test Explorer items, **Exclude Project from Testy** on project items, **Show Output** on failure messages, and **Run Affected Tests for This File** in the editor and Explorer.
- **Debug configuration:** `testy.debugConfiguration` adds properties to the `coreclr` attach configuration, and each `testy.additionalConfigurations` entry also gets a Debug profile.
- **Continuous coverage:** the Run with coverage profile supports continuous runs, which collect and show coverage in their automatic runs.
- **Multi-root settings:** `testy.solution`, `testy.exclude` and `testy.projects.*` can be set per folder and apply to that folder's projects, with relative paths resolved against it. Differing folder values of `testy.buildConfiguration` or `testy.testArguments` are reported.
- Testy activates for workspaces that only contain `.slnf` solution filters.

### Changed

- Pausing automatic testing is remembered per workspace and no longer edits `.vscode/settings.json`; `testy.autoRun` is now only the default.
- Test Explorer's refresh button rediscovers tests without running them. **Refresh and Run All C# Tests** still rebuilds and runs everything.
- Gutter coverage markers are optional (`testy.showCoverage` now defaults to `false`), and have light and dark theme variants.
- Output uses a log channel with levels (**Developer: Set Log Level…**).
- The first open of a workspace asks before building and running the baseline (**Run Now**, **Not Now**, **Don't Ask Again**); until then, a save or a manual run starts it. Workspaces with a retained baseline start as before.
- In Restricted Mode Testy now activates without running anything, shows **Testy: Restricted Mode** in the status bar, and starts when the workspace is trusted. Settings that choose what runs are ignored from untrusted workspace settings.
- Startup and environment errors (missing `dotnet`, unsupported SDK, analyzer crash, unreadable `testy.solution`) are shown once per session as a notification with **Show Output** and **Open Settings**; build and test failures stay in the status bar.
- Automatic runs are named by their trigger in Test Explorer's results, for example `Testy · on save: Calculator.cs`. Discovery-only refreshes are no longer kept in the results history.
- Export Coverage asks which folder to export in a multi-root workspace.
- The status bar item has a screen-reader label.
- `testy.coverageToolPath` must be an absolute path; a relative path is rejected instead of being resolved differently for the check and the launch.
- Path normalization during analysis, discovery and project filtering no longer blocks the editor with synchronous file-system calls, the coverage parser receives the tracked file list once instead of with every report, Windows command lookups are memoized, and cache saves no longer fsync the epoch file.
- The extension is bundled into a single module, and activation no longer waits for the coverage cache to be restored, so startup is faster and the package smaller.
- `testy.dotnetPath` and `testy.coverageToolPath` are machine-overridable. `testy.solution`, `testy.exclude`, `testy.projects.*`, `testy.buildConfiguration`, `testy.testArguments` and `testy.debugConfiguration` are resource-scoped; the rest are window-scoped because one engine serves every folder of a workspace.
- Prepared test outputs are kept after cancelled runs instead of being rebuilt, and file copies use the operating system's fast copy path.
- Preparation tool fingerprints are cached between runs instead of rehashing the collector and SDK each time.
- Retained preparation templates are rebuilt once after upgrading, because their environment identity changed.
- Status bar progress text is localizable.
- The manifest declares its license, keywords, links and a workspace extension kind for remote development.
- The .NET helpers restore only from nuget.org with lock files, and packaged builds are reproducible. NuGet vulnerability advisories stay warnings instead of failing packaging, and helper stack traces include line numbers.
- The analyzer starts faster and uses less memory; its diagnostics are UTF-8.
- Source analysis runs in a long-lived helper process, so repeated analyses take milliseconds instead of about 150 ms each; it falls back to one process per request if the helper cannot start.
- The analyzer uses the Roslyn compiler of your installed .NET SDK instead of bundling it, shrinking the package from about 3.8 MB to 0.3 MB. After an SDK update that changes Roslyn, the first run may select a few extra tests.

### Fixed

- VSTest projects and test targets older than .NET 10 are skipped and listed in Output instead of stopping the whole workspace; multi-targeted test projects keep their .NET 10+ targets.
- A failing test batch no longer stops the rest of the run. Its tests are reported as errored, and failed batches are shown in the status bar and output.
- Source analysis no longer fails on very large repositories or assemblies whose results exceeded the output buffer.
- One unreadable source file, embedded PDB, or permission-denied directory no longer fails analysis or project discovery for everything.
- Saved project evaluations are reused after an editor restart instead of always being re-evaluated.
- Locks and private outputs left by crashed windows are recovered even when their process ID has been reused, such as after a reboot or in containers; a long-running holder no longer makes other windows time out.
- A test host that hangs after finishing keeps its results instead of failing at the timeout.
- Failing to delete a stale cache slot falls back to a fresh preparation instead of failing the run.
- Cancelling one caller no longer cancels other callers waiting on the same SDK check.
- Build planning for solutions with hundreds of test projects no longer stalls the editor.
- Paths containing `%`, `$(` or `;` no longer break project inspection, and inspection no longer leaves MSBuild nodes holding the bundled analyzer.
- A second local connection to a test host's port is detected and the run discarded.
- Windows process-host failures are reported as start-up errors rather than test failures, and test processes inherit only their standard handles.
- The bundled analyzer compiles against the minimum supported MSBuild API, so it no longer risks missing-method failures on older .NET 10 SDK feature bands.
- Assembly loads that occur while the runtime observer is writing its log are deferred instead of risking a garbled log line.
- Analyzer and process-host errors include full exception details in Output.
- Output directories, `HintPath` and rule-set paths are resolved correctly on macOS and Linux when MSBuild values contain backslashes.
- A running window no longer loses a shared-storage lock when its heartbeat pauses (sleep, a busy extension host), and shutdown no longer waits forever on a stuck lock holder.
- A crashed owner whose process ID was reused is recognized on macOS.
- Corrupt coverage-cache entries are discarded and re-learned, so cache pruning no longer stops; the coverage cache is capped and maintained incrementally, and caches are fsynced before replacing the previous file.
- A prepared-output file that cannot be deleted (for example, held by antivirus) no longer disables the cache, damaged owner records are reclaimed, and partial trimming keeps the newest preparations.
- Cancelling one coverage read no longer cancels others sharing the parser.
- A test run whose selected tests no longer exist (MTP exit code 8) no longer reports a host failure. The connect timeout is longer under the coverage collector, and debugging fails clearly if the host never reports its process ID.
- Runtime observation no longer fails when an unrelated .NET process, such as an MSBuild node, is killed mid-run.
- On Windows, `dotnet`, the coverage collector and commands run by the process owner are resolved from PATH, never from the workspace.
- Project discovery finds `.csproj` files regardless of extension case and follows symlinked directories, with cycle protection.
- A briefly locked source file no longer fails the whole refresh.
- Overlapping source refreshes no longer let an older read overwrite newer file hashes, which could commit a stale trace as fresh.
- SDK checks are cancelled and awaited when Testy is disposed or its caches are reset, instead of outliving the window for up to the run timeout.
- A failed runner lane or preparation-tool lookup is no longer reused for the rest of the run, and cancelled work waiting for a worker slot stops immediately.
- A test host that exits right after closing its connection reports its exit code and output instead of a connection-disposed error.
- The analyzer helper ignores duplicate request IDs without losing the original request's cancellation, frees malformed requests, caps unterminated output, and stops project-graph evaluation when MSBuild cancels it.
- Relative file names in Cobertura reports are resolved against the report's `<sources>`.
- Debugging in multi-root workspaces attaches in the folder that contains the tests.
- Project analysis output is deterministic and explains why evaluation reuse is unavailable.
- An error while workspace folders change is reported instead of escaping the event handler.
- Ending the baseline progress disposes its cancellation listener.
- The Pause/Resume and Run buttons in Test Explorer's title bar use numeric ordering.

### Internal

- Type-aware ESLint (including floating-promise checks) and stricter TypeScript checks are enforced; opted-in tests are type-checked.
- `global.json` pins the .NET SDK; shared .NET build settings live in `backend/Directory.Build.props`/`.targets`, with deterministic builds and English-only resources.
- Engine run orchestration is split into phases, duplicated helpers are consolidated, and dead code is removed.
- Regression tests are organized by topic, and the VS Code test runner is updated for current VS Code builds.
- Faster path normalization, file-event handling, project-evaluation validation, prepared-output hashing and POSIX process cleanup on large workspaces.
- `extension.ts` is split into a controller and UI presenters (`src/controller.ts`, `src/ui/*`).
- Test files are linted; the .NET helpers build with the recommended analyzer rules and have their own xUnit tests (`npm run test:dotnet`).
- Cancelling source analysis now also interrupts Roslyn parsing.
- There is no CI; validation is local (see CONTRIBUTING).

## 1.2.0

Faster repeated runs: smarter scheduling, reuse of prepared outputs, project evaluations and source analysis across runs and restarts.

- Schedule idle project runners before creating additional workers within a project, and redistribute spare capacity as projects finish.
- Reuse validated prepared outputs between runs, with fresh discovery, isolated collector sessions, bounded retention, and cleanup on shutdown.
- Reuse project evaluations after validating their recorded inputs and filesystem queries, including changes made while automation is idle.
- Defer instrumentation for discovery-only targets, overlap source analysis with runner preparation within the worker budget, and share tool fingerprints within each run.
- Retain validated preparation templates across clean editor shutdowns, with exclusive ownership, bounded storage, fresh startup discovery, and conservative crash recovery.
- Resolve changed global aliases and analyze C# source files in one helper process, preserving conservative fallback and incremental file selection.
- Avoid building unused method-level coverage XML trees and reuse source-path normalization within each report.
- Let automatic test-file workers use available CPUs minus one while keeping initial project preparation conservative and preserving explicit worker limits.
- Reuse aggregated coverage lines when only test ownership or freshness changes, with invalidation for changed contributions and source geometry.
- Reuse validated project evaluations after authoritative Restore on repeated full baselines, including fresh SDK and analyzer identity checks.
- Write independent coverage source records concurrently while preserving checkpoint ordering and cancellation draining.
- Combine output-reset permission repair and metadata inventory, with shared bounded filesystem concurrency and fewer unchanged mode writes.
- Grow prepared-output entry retention with worker and target needs while preserving the 512-MiB byte limit and exclusive ownership across restarts.
- Maintain coverage ownership and stale-owner counts incrementally, preserving immutable summaries and cancellation-safe publication.
- Read coverage-cache records concurrently within a shared filesystem budget while preserving snapshot and warning order.
- Skip redundant coverage-cache maintenance after validated cleanup when saves cannot orphan source records; invalidate that proof after removals, membership changes, external writes, or interrupted publication.
- Reuse unchanged coverage summaries and positive-hit aggregates while still checkpointing new trace metadata, dependencies, and exact freshness counts.
- Retain bounded project-evaluation snapshots across editor restarts, with authoritative Restore and fresh validation of captured inputs before reuse.
- Reuse successful source analysis during unchanged full refreshes within an editor session, validating parsed source bytes, alias inputs, and analyzer context while retrying incomplete results.
- Instrument independent DLLs concurrently with the bundled collector during initial preparation, sharing idle project workers and draining interrupted work before restoring outputs.
- Reuse unchanged editor coverage decorations, while refreshing them after document, freshness, visibility, or editor-identity changes.
- Avoid redundant Windows directory permission writes during output reset, and recognize forward-slash relative paths when identifying preparation tools.
- Identify cache tools using their actual launch rules, including Windows `Path` environments and POSIX paths that traverse symlinks before `..`; retain fresh execution when identity is uncertain.
- Exclude local performance diagnostics and copied fixtures from shareable packages while retaining compiled runtime modules.
- Restore coverage indexes without temporary replacement sets for new groups, retaining duplicate-group handling and atomic cancellation.
- Use the same launch-aware executable identity for project-evaluation caching as for analysis and prepared outputs.

## 1.1.0

- Run independent project discovery, source analysis, and test files concurrently with configurable worker limits.
- Batch compatible MSBuild roots so shared dependencies are built once, while preserving output and reference-context isolation.
- Preserve stable test identities, checkpoint completed parallel work safely, and drain workers during cancellation.
- Add deep dependency-graph benchmarks and concurrency regressions.

## 1.0.0

First release with Testy's own Test Explorer integration, affected test selection, and retained coverage on .NET 10+ and MTP.

- Track evaluated shared build inputs and preserve MSBuild reference-property contexts.
- Preserve manual container scopes through discovery and honor individual-case exclusions.
- Report missing or unfinished outcomes without checkpointing incomplete batches.
- Repair test-modified output permissions and cancel recursive project discovery promptly.
- Restore large caches in a cancellable worker, preserve unreadable-record geometry, and index live result IDs.

- Resolve coverage exclusions across partial declarations and preserve stable Unicode/colliding xUnit identities.
- Retain unselected coverage and outcomes; preserve aggregate history through manual subsets and interrupted learning.
- Cancel cache checkpoints promptly; isolate manual build scope and build excluded required dependencies.
- Watch external linked source directories and clean test-owned descendants on normal exit as well as cancellation.
- Parse coverage in a worker; cache identity/geometry indexes, publish coverage deltas, and bound output-copy concurrency.

- Preserve shared-UID failures and retry semantics; continue after skipped or initialization-failing files.
- Honor excluded/hidden code, binary references, directory changes, changing workspace roots, and per-project SDK contexts.
- Checkpoint baseline progress; preserve manual-run attribution and mark stale dependency/test inputs.
- Share sparse coverage geometry, cache summaries, index ownership, and reuse isolated output preparation.
- Support path-dependent xUnit identities and missing NUnit source locations; rebuild the analyzer on F5.

- Own Test Explorer integration backed by .NET 10+ and Microsoft.Testing.Platform; no Dev Kit dependency.
- Automatic startup baseline and affected test-file execution based on recorded runtime code usage.
- Roslyn declaration analysis triggers project fallback for compile-time dependencies such as inlined constants.
- Retained coverage contributions, stale coverage markers, and conservative fallback for uncertain impact.
- Live test results, source locations, failure details, and a compact status display.
- Default editor-save triggers, optional file-system watching, generated-file exclusions, and pause/resume.
- Cancellation scoped to Testy-owned automatic runs, with pending changes preserved across restarts.
- Refresh builds, rediscovers, and runs all tests. Coverage, full-suite mode, and runner settings are configurable.

## 0.0.1

- Initial file-watcher prototype using C# Dev Kit and global VS Code test commands.
