# Changelog

## Unreleased

## 1.4.0

### Added

- **Discovery in the reused host:** with `testy.reuseTestHosts`, the test host that runs a project's tests also discovers them, so a save that runs tests starts one process fewer. On the save-loop benchmark an edit that runs one test file took about 250 ms (19%) less.
- **Faster coverage reading:** later coverage reports of the same instrumented output are checked against the layout of the first and only their hit counts are read; on a 2,001-class report, reading fell from about 34 to 11 ms. Anything unexpected falls back to the full parse.
- **Per-test coverage survives restarts:** with `testy.selectionGranularity: "test"`, each test's own coverage is saved and restored, so the first edit after a reload already runs only the affected tests of a file.

- **Saves finish running tests:** a save during an automatic run no longer throws away the test files it is running. Running files finish and report their results within `testy.finishRunningTests` seconds (default 5) while no further files start, unless the change affects all of them, and the next run does not repeat files that already ran against the changes.
- **Per-test durations and time limit:** Testy learns each test's own duration, **Show Slowest Test Files and Tests** lists the slowest tests too, and `testy.testTimeoutSeconds` (default 120) stops a test that runs too long and reports it as errored, instead of holding a worker for the whole `testy.timeoutSeconds`.
- **Long files split:** baselines and runs of everything split a test file that would finish alone at the end into parts that several workers run at once, by the duration of each test, and combine its results and coverage as one run (`testy.splitLongTestFiles`).
- **Kept test hosts:** a run whose builds changed nothing reuses the previous run's test hosts, prepared outputs and discovery. `testy.isolatedTraits` gives test files a process of their own, and `testy.testProcessMemoryLimit` replaces a reused host that grew too large.
- **Pinned tests:** **Pin to Automatic Runs** on Test Explorer items runs them with every automatic run; **Testy: Unpin All Tests** clears them. `testy.alwaysRunFailing` reruns failing files with every automatic run.
- **Markers follow unsaved edits:** inline results and exception markers move with your edits until you save, instead of turning grey or disappearing; a changed line loses its marker.
- **Shared resources:** `testy.inclusiveTraits` lets test files share a resource with each other but not with exclusive users of it, and `testy.workerTraits` lets a test file that uses several CPUs take several test-file workers.
- **Testy Queue view:** the Testing sidebar lists the current run's test files, running, queued and finished, with times and why each was selected.
- **Richer timeline:** the exported timeline shows each build, discovery and instrumentation on preparation lanes, waits for shared resources on worker lanes, passing and failing batches in colour, and the editor's event-loop delay.
- **Coverage suppression:** `// testy: no coverage` before a member or type, or `// testy: no coverage start` … `end` around several, leaves that code uninstrumented; edits in such files select conservatively.
- **Faster coverage snapshots:** the collector's snapshot command runs without Testy's process owner, cutting each snapshot (one per test file with reused hosts, one per test with test granularity) from about 70 to 47 ms.
- **Line costs:** the covering hover says how long the tests through a line take, and which is the slowest.
- **Lower process priority:** builds, instrumentation and test processes run below normal priority, so the editor stays responsive during runs (`testy.processPriority`).

- **Learned scheduling:** Testy saves how long each test file takes and uses it to order runs. Affected runs start previously failing files, then new files, then the shortest. Baselines and run-all runs start the longest files first so none is left running alone at the end, while one worker works from the short end so results still arrive early. The status bar shows the expected time left while tests run.
- **Test granularity:** `testy.selectionGranularity: "test"` learns each test's own coverage, with a collector snapshot per test, and reruns only the tests inside a covered file that executed the edited body. The file's coverage stays complete and current after such a partial run.
- **Reused test hosts:** `testy.reuseTestHosts` runs a project's test files in one long-lived test process per worker, splitting coverage between them with collector snapshots, so only the first file per worker pays the test host's start-up.
- **Timeline and slow files:** **Testy: Export Timeline…** writes the last 10 minutes of runs, phases and test batches per worker as a trace file for Perfetto or `chrome://tracing`, and **Testy: Show Slowest Test Files** (now **Show Slowest Test Files and Tests**) lists the test files that take longest. Both are in the status bar menu.
- **Safety net:** `testy.safetyNet` (`related` or `all`) runs the test files an affected run did not select once the editor is quiet, without delaying feedback on a save. A file that newly fails is reported as a selection miss.
- **Exception markers:** every line of your code on the stack of a failing test is marked at the end of the line and in the scroll bar, where it threw and the callers that led there, with the failure in the hover. They follow `testy.inlineResults`.
- **Debug a Test Covering This Line:** debugs one covering test file and stops on the line, with a temporary breakpoint. It is in the editor context menu and the inline results hover.
- **Shared resources:** `testy.exclusiveTraits` keeps test files that share an external resource apart. Files whose tests have the same trait, such as `Database`, never run at the same time, while other files stay parallel. `testy.serialTraits` runs matching files with nothing else beside them.
- **Excluded traits:** `testy.excludeTraits` keeps tests with the named traits, such as `Integration` or `Category=Slow`, out of automatic runs and the baseline. They stay in Test Explorer and run when you run them yourself.

### Fixed

- A test project that another workspace project references no longer builds twice in parallel. Testy built it with an explicit `TargetFramework`, which MSBuild's own build of the reference does not pass, so the two instances could fail writing the same outputs (for example `The process cannot access the file '….runtimeconfig.json'`).
- Test traits and categories from MSTest 4, NUnit and xUnit v3 are read again: those frameworks report each trait as a `{ "name": "value" }` object (a category as its name with an empty value), which discovery dropped, so no `trait:` or `category:` tags appeared.

### Changed

- **Reused test hosts by default:** `testy.reuseTestHosts` is now on. A baseline of 120 files took about a third less time, and a run of everything less than half. Tests share static state with earlier files of the same process; list their traits in `testy.isolatedTraits` or turn the setting off for suites that need a fresh process per file.
- **Lazy per-test coverage:** with `testy.selectionGranularity: "test"`, a baseline or a run of everything no longer takes a coverage snapshot per test; each test's coverage is learned by the first edit that selects its file.

- **Method-level selection:** an edit inside a method, accessor or constructor body reruns only the test files whose coverage executed that body, instead of every test file that reached the file. Saving one handler that a shared registry or DI container constructs for every test no longer reruns the whole project. Test files that provably missed the edit keep their coverage current, moved to the new version of the file. Set `testy.selectionGranularity` to `file` for the previous behaviour.
- **Faster saves:** body edits build, instrument and discover only the test projects that will run, the build keeps the MSBuild server alive between saves, and `testy.debounceTime` now defaults to 50 ms for the `save` trigger (500 ms, as before, for `fileSystem`).

## 1.3.0

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
- **Covering tests:** hovering a covered gutter line names the test files that cover it, and **Run Tests Covering This Line** in the editor context menu runs them.
- Attachments reported by the test framework (for example TRX files or screenshots) are listed in the run output.

- **Keybindings:** `Ctrl+; T` (`Cmd+; T`) runs affected tests now, and `Ctrl+; Ctrl+T` (`Cmd+; Cmd+T`) runs the tests covering the current line in a C# editor.
- **Run Affected Tests for This Folder/Project** in the Explorer context menu of folders and `.csproj` files.
- The Testing view shows a welcome message with links to the output and walkthrough when no MTP test project is found.
- `testy.problems.publishBuildDiagnostics` (`auto`, `always`, `never`) controls whether build errors go to the Problems panel; `auto` skips them while the C# extension already reports them.
- Run profiles have a configure (gear) action that opens their settings.
- Stack frames with deterministic `/_/` paths link to the matching workspace file when it is unambiguous.
- Class items in Test Explorer have a range, so classes get Run/Debug gutter actions and **Go to Test**.
- In affected runs, test files that failed last time run first.
- Test results survive a VS Code reload: each test's last outcome is saved with the cache, so the status bar shows the previous pass/fail counts and previously failing files still run first. **Reset Caches and Baseline** clears them.
- **Inline results:** covered lines in C# editors show whether the test files covering them passed, failed or are pending, and failing lines are marked in the scroll bar. Hovering a covered line lists the covering test files with their status, with **Run covering tests** and **Show in Test Explorer** links. `testy.inlineResults` (`off`, `gutter`, `gutterAndHover`) controls it; while it is on, `testy.showCoverage` marks only uncovered lines.
- **Keybindings:** `Ctrl+; P` (`Cmd+; P`) pauses or resumes automatic testing and `Ctrl+; X` (`Cmd+; X`) cancels the current run.
- **Open Testy Settings** in the status bar menu.

### Changed

- **Requires VS Code 1.140 or later** (previously 1.99). The extension is built for the Node 24 runtime that version ships.
- Pausing automatic testing is remembered per workspace and no longer edits `.vscode/settings.json`; `testy.autoRun` is now only the default.
- Test Explorer's refresh button rediscovers tests without running them. **Rebuild and Run All C# Tests** (renamed from **Refresh and Run All C# Tests**, with a run-all icon) still rebuilds and runs everything.
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
- **Readable test names:** Test Explorer groups tests by class (Project → File → Class → Test), and test names no longer repeat the namespace and class (xUnit shows `Method(args)`). Custom display names are kept.
- Project and file names, project tags and opened editor paths keep their real case on Windows instead of being lowercased.
- `testy.buildConfiguration` and `testy.testArguments` are window-scoped, since they always applied to the whole workspace.
- The runtime observer targets .NET 8, so older managed processes that inherit it can load it.
- Analyzer errors show `Type: message` instead of a stack trace.
- A burst of file changes, such as a branch switch, is handled as one update; writes to `bin/` and `obj/` are ignored without touching the disk, and large workspaces use far fewer file watchers.
- Coverage decorations are no longer recomputed on every keystroke while gutter coverage is hidden.
- Source analysis is about 4x faster and uses less CPU and memory: fingerprints are streamed instead of building normalized copies of each file, and all analyzer requests share one CPU budget. Cached fingerprints are recomputed once after upgrading.
- SDK resolver digests are kept on disk between project evaluations instead of being rehashed by each evaluation process.

- Saving editor settings or non-.NET tooling files outside every project, such as `.vscode/settings.json`, a root `package.json` or `tsconfig.json`, lock files or ESLint and Prettier configuration, no longer restores every project and reruns every test. `.vscode`, `.vs` and `.idea` are excluded by default. Other files outside every project, such as test data that tests read at runtime, still run every test project, without a restore. Only changes that affect restore (project files, props/targets, `global.json`, `nuget.config`, lock files and evaluated imports) repeat `dotnet restore`.
- The default `testy.fileWatcherPattern` also covers `.razor`, `.cshtml`, `.xaml`, `.axaml` and `.proto` files.
- Test files containing skipped tests now get reliable traces, so changes select them precisely instead of falling back to their project.
- Coverage saves from test files that finish close together are combined into one write. Cancelled runs still save completed files.
- In `fileSystem` trigger mode, incremental runs check only changed files instead of every known source file. Every known input is still checked in the background after such a run, and a change found without a file event starts a follow-up run.
- Coverage reports and runtime-observation logs are deleted as soon as each test file finishes, instead of at the end of the run.
- Large workspaces block the editor less while loading project graphs, reading saved project evaluations and validating analysis results.
- Startup and environment notifications are localized; the English detail stays in the output.
- Production builds ship external source maps alongside the bundle for readable error reports.
- **Reopening a workspace no longer reruns the whole suite.** Saved coverage is trusted again when the settings, Testy version, environment variables and coverage tools it was learned under still match: the startup run checks every tracked file, the watched files outside every project (such as shared test data, `nuget.config` or a root `.runsettings`) and each project's restored packages, and reruns only test files affected by changes made while VS Code was closed, along with changes no run consumed before closing (for example while automatic testing was paused) and test files whose coverage was stale when saved. Changing a setting that starts a new baseline, or a different .NET SDK or evaluation tools, still runs everything. A baseline interrupted by closing VS Code resumes.
- Editing a constructor, operator or conversion body, or an ordinary comment, no longer reruns the whole project and its dependents; only test files covering the change run.
- The first-baseline prompt mentions the one-time download of the coverage collector, and a failed collector setup shows a warning that opens `testy.coverageToolPath`.
- The status bar tooltip and menu say whether automatic testing is paused for this workspace or turned off by `testy.autoRun`.
- The settings schema rejects empty and duplicate entries, documents the `testy.debugConfiguration` properties, and marks tuning settings as advanced.
- Coverage updates and affected-test selection are much faster in large workspaces: merging coverage no longer gets quadratically slower as a baseline grows, coverage refreshes at most every 250 ms during a baseline, and selection groups test files by project.
- The coverage cache stores each path once, so large solutions no longer exceed its size limit and lose older coverage.
- Less disk work per run: tool fingerprints, the Roslyn identity and source manifests are reused, committed files are rechecked only once per run, and output directories are removed and repaired faster.

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
- Saves made while Testy starts up are kept and run only after the pause and baseline-consent settings are applied; before, they could build while paused or before consent. A failed cache restore no longer prevents those settings and file watching from being applied.
- If the installed Roslyn fails the analyzer self-test, analysis fails with a clear error instead of retrying in a one-shot process with the same Roslyn, which could produce wrong fingerprints and skip affected tests.
- Each error is logged once instead of up to three times.
- Closing VS Code stops test processes immediately, and deactivation finishes within about 3 seconds.
- An empty command passed to the Windows process host reports a clear error.

- Test Explorer's refresh no longer cancels the first-baseline prompt; previously **Run Now** then did nothing and a later settings change started the baseline without asking.
- Automatic runs during a continuous run are reported as part of that continuous run when it comes from the matching profile; with `testy.runWithCoverage`, a continuous **Run** does not receive them, so their coverage keeps its line detail.
- File watchers are no longer all recreated after every input change, and a change reported by overlapping watchers starts one run. Input watchers still report files the `testy.fileWatcherPattern` watcher covers, since `files.watcherExclude` can hide them from it.
- Testy commands work in Restricted Mode and without an open folder, and explain what is needed instead of failing with "command not found".
- If a test process reports an error, such as a failed kill, Testy kills its whole process tree and waits for it to exit before reporting the failure.
- On Windows, another window no longer takes over the storage lock from a live window after sleep/resume or a stall of up to 10 minutes.
- The analyzer server bounds request line length and queues requests beyond a concurrency limit, and alias analysis honours cancellation and the shared CPU limit.
- The runtime observer no longer serializes unrelated assembly loads in the test process, and never throws into it.
- Disposing Testy no longer hangs after a run was cancelled while reusing a prepared output, and every shutdown step runs even if an earlier one fails.
- A test host that exits right after its last result no longer turns a complete run into a failure.
- Binary references without a `HintPath` and analyzer or source-generator DLLs are tracked as project inputs, so rebuilding one selects the projects that use it.
- Quoted `PATH` entries are resolved on Windows and an over-long Windows command line gets a clear error.
- A missing evaluation snapshot on a fresh install is no longer logged as a failure; evaluations skipped for size are logged.
- Oversized coverage reports and cache records are rejected instead of exhausting memory, and the analyzer server bounds its request queue.
- Interrupted output claims and helper temporary files are cleaned up, and captured process output is capped at 1 MiB per stream.

### Internal

- Type-aware ESLint (including floating-promise checks) and stricter TypeScript checks are enforced; opted-in tests are type-checked.
- `global.json` pins the .NET SDK; shared .NET build settings live in `backend/Directory.Build.props`/`.targets`, with deterministic builds and English-only resources.
- Engine run orchestration is split into phases, duplicated helpers are consolidated, and dead code is removed.
- Regression tests are organized by topic, and the VS Code test runner is updated for current VS Code builds.
- Faster path normalization, file-event handling, project-evaluation validation, prepared-output hashing and POSIX process cleanup on large workspaces.
- `extension.ts` is split into a controller and UI presenters (`src/controller.ts`, `src/ui/*`).
- Test files are linted; the .NET helpers build with the recommended analyzer rules and have their own xUnit tests (`npm run test:dotnet`).
- Cancelling source analysis now also interrupts Roslyn parsing.
- CI on Windows, macOS and Linux (Node 20 and 22), a tag-triggered release to the Marketplace and Open VSX, CodeQL, Dependabot, and a packaged-file snapshot check.
- Environment errors are typed instead of matched by message text; architecture layering is enforced by lint rules.
- The MTP client reports the real extension version; project-graph output carries a format version and uses source-generated JSON.
- Checked-in xUnit v3 and NUnit fixtures, extension-host tests for every command and for each framework, process-level analyzer tests, and timing-independent waits in previously flaky tests.
- `backend/global.json` was removed so backend tests use the pinned SDK; `SECURITY.md`, a code of conduct, and issue and PR templates were added.

- Engine stages return results that the engine applies; pure selection, freshness and trace-reliability rules live in `src/core/runPolicy.ts` and `src/core/traceReliability.ts`. Runner lanes and preparation are separate modules, and both caches share one hash memo.
- All analyzer JSON uses source-generated serialization with reflection disabled; the project graph task writes its output atomically.
- New backend tests cover the Windows process host job, project graph edge cases, PDB source locations, startup hook concurrency and analyzer server limits.
- CI compiles once per OS, gates TypeScript line coverage, checks l10n drift and runs the extension tests on the minimum VS Code version. Release secrets are scoped to the publish steps, actions are pinned to commit SHAs, and the published VSIX is the one that was checked.
- Timing-based unit tests use explicit synchronization instead of sleeps. `npm run clean` removes build and benchmark output; benchmarks write results to `.benchmarks/`.
- The engine takes injectable services, owns its analyzer server pool, and its run stages change engine state only through named host methods. Reading coverage no longer marks traces stale or schedules saves.
- `projects.ts` is split into discovery, graph and build modules; owner-record handling is shared by run outputs and prepared storage; preparation tool identity moved to `preparationTools.ts`.
- The coverage cache moved to `coverage-v3` with versioned records and a shared path table; the old directory is removed. Saved project graphs store listing digests instead of full file lists.
- The analyzer server reuses parsed alias sources, avoids per-line copies, answers cancellations of queued requests at once, and reports its version. Helper assemblies are stamped with the extension version; NuGet uses package source mapping.
- CI runs the minimum VS Code on Windows too, tests the latest .NET 10 SDK, audits npm signatures, reviews dependency changes and runs benchmarks weekly. Releases check the changelog and that the tag is on `main`, fail when a marketplace token is missing, publish before creating the GitHub release, and attach provenance attestations, an SBOM and source maps.
- Lint fails on warnings and covers scripts; tests use `noImplicitReturns`, coverage gates include branches and functions, and Windows runs the process-teardown and junction tests.


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
