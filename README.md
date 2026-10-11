# Testy

Fast feedback for C# without rerunning the whole suite after every save.

Testy runs your tests through **.NET 10+ and Microsoft.Testing.Platform (MTP)**, learns which source files each test file exercises, and reruns only the affected test files when you save. Results appear in VS Code's Test Explorer, and coverage stays available across partial runs.

## Features

- **Affected tests on save.** Edits rerun every test file known to exercise the changed code, with a conservative project-wide fallback whenever impact is uncertain.
- **Retained coverage.** Each test file keeps its own coverage contribution, so partial runs never erase coverage from other tests. Coverage appears in Test Explorer's native coverage view and can be filtered by test file or project.
- **Inline results.** Covered lines of C# files show whether the test files that exercise them passed (green check), failed (red cross) or have not run since a change (grey dash). Hover a covered line to see those test files, jump to them in Test Explorer, or rerun them.
- **Test Explorer integration.** Tests are grouped as project, file, class, test, with xUnit's namespace-qualified default names shortened to the method name. Run, debug, or continuously run individual tests, classes, files, and projects. Failures show expected/actual diffs when the framework reports them, plus clickable stack frames.
- **Build problems in the Problems panel.** Compiler errors and warnings from Testy's builds are listed there and cleared after the next successful build.
- **Parallel and cached.** Discovery, builds, and test files run concurrently, each worker reuses one test process for its files, and prepared outputs and project evaluations are reused safely across runs and restarts. Testy learns how long each test file and each test takes: affected runs start failing and short files first, full runs start long files first and split a file that would finish alone into parts, and the status bar shows the time left. Test processes run below normal priority, so the editor stays responsive.
- **Saves don't throw work away.** A save during a run lets the test files already running finish (stopping at once only when the change affects all of them), and the next run doesn't repeat them.
- **Pinned tests.** Pin tests or files in Test Explorer to run them with every automatic run, and optionally rerun failing files every time.
- **No C# Dev Kit required.** Testy talks to MTP directly.

## Requirements

- VS Code 1.140 or later.
- [.NET SDK 10](https://dotnet.microsoft.com/download) or later. If your workspace has a `global.json`, it must select a supported SDK.
- C# test projects that target .NET 10 or later and use [Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-intro). MSTest, xUnit v3 (MTP v2), and NUnit with the MTP adapter are tested. VSTest projects and test targets older than .NET 10 are skipped and listed in Output.
- A trusted workspace. Testy builds and runs workspace code, so in Restricted Mode it runs nothing: the status bar shows **Testy: Restricted Mode**, settings that choose what runs (`testy.dotnetPath`, `testy.coverageToolPath`, `testy.testArguments`, `testy.solution`, `testy.debugConfiguration`, `testy.buildConfiguration`, `testy.additionalConfigurations`) are ignored from workspace settings, and Testy starts as soon as you trust the workspace.
- NuGet access on first use, to install Microsoft's `dotnet-coverage` collector (unless you set `testy.coverageToolPath`).
- Portable debug symbols (the .NET default) for source mapping and coverage.
- The [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp), only for debugging tests.

## Getting started

1. Open a folder or workspace that contains MTP test projects, and trust it.
2. The first time a workspace opens, Testy asks before it builds anything. **Run Now** builds, discovers, and runs every test file once to establish a baseline; **Not Now** waits for a save or a manual run and asks again next time; **Don't Ask Again** always waits for a save or a manual run in this workspace. Workspaces that already have a baseline continue automatically. The status bar shows a baseline progress indicator with a percentage (no popup); cancel it with **Testy: Cancel Current Run** or the stop button in Test Explorer. The **Get started with Testy** walkthrough covers the same steps.
3. Save a source file. Testy stops its previous automatic run (test files it is running finish first, unless the save affects all of them, see `testy.finishRunningTests`), waits briefly for edits to settle, then builds and runs the affected test files.

Saves never cancel a run you started manually. Changes are accumulated across cancelled runs, and an interrupted baseline resumes where it stopped.

Reopening a workspace reuses its saved coverage when the settings, Testy version, environment and coverage tools it was learned under still match: the startup run builds and rediscovers as usual, then reruns only the test files affected by changes made while VS Code was closed, including shared test data and other watched files outside every project, restored packages, and changes that no run consumed before closing. A different .NET SDK reruns everything. Changing a setting that starts a new baseline, such as `testy.buildConfiguration`, runs everything again.

## Commands

Click the Testy status bar item to open its action menu. Every action is also available from the Command Palette:

| Command | What it does |
| --- | --- |
| **Testy: Pause Automatic Testing** / **Resume Automatic Testing** | Stop or restart runs on save. Remembered per workspace without changing your settings. **Pause or Resume Automatic Testing** toggles it (`Ctrl+;` `P`, `Cmd+;` `P` on macOS). The status bar tooltip says whether testing is paused for this workspace or disabled by `testy.autoRun`. |
| **Testy: Run Affected Tests Now** | Run the tests affected by pending changes immediately (`Ctrl+;` `T`, `Cmd+;` `T` on macOS). |
| **Testy: Rebuild and Run All C# Tests** | Rebuild, rediscover, and run everything to replace the baseline. |
| **Testy: Cancel Current Run** | Cancel the active run (`Ctrl+;` `X`, `Cmd+;` `X` on macOS). |
| **Testy: Clear Coverage** | Discard retained coverage. |
| **Testy: Export Coverage…** | Write the current merged coverage as LCOV or Cobertura XML (default `coverage/testy.lcov` or `coverage/testy.cobertura.xml`), with paths relative to the workspace. In a multi-root workspace, choose one folder (only its files, relative to it) or all folders. Stale coverage is not exported. |
| **Testy: Show Slowest Test Files and Tests** | List the test files with the longest learned run times and the tests with the longest durations; choose one to show it in Test Explorer. |
| **Testy: Export Timeline…** | Write what Testy did in the last 10 minutes as a trace file to open in [Perfetto](https://ui.perfetto.dev) or `chrome://tracing`: runs and phases, each build, discovery and instrumentation on a preparation lane, each test file on the worker that ran it (green passed, red failed, grey waits for a shared resource), and the editor's event-loop delay. |
| **Testy: Unpin All Tests** | Unpin every test item pinned with **Pin to Automatic Runs**. |
| **Testy: Reset Caches and Baseline** | Delete learned coverage, saved project evaluations, and prepared test outputs, then establish a fresh baseline. |
| **Testy: Show Output** | Open the Testy log, including build output and why each selection was made. |
| **Testy: Show Actions** | Open the status bar menu. |
| **Run Affected Tests for This File** | In the editor and Explorer context menus of a `.cs` file: run the tests affected by that file, as if it had been saved. |
| **Run Affected Tests for This Folder or Project** | In the Explorer context menu of a folder or `.csproj`: run the tests affected by the C# source files Testy knows in it. |
| **Run Tests Covering This Line** | In the editor context menu: run the test files whose retained coverage hits the cursor line (`Ctrl+;` `Ctrl+T`, `Cmd+;` `Cmd+T` on macOS). The inline results hover offers the same for the hovered line. |
| **Debug a Test Covering This Line** | In the editor context menu: debug one test file whose retained coverage hits the cursor line, stopping on that line. With several covering files, you pick one (failing files are listed first). Testy adds a breakpoint on the line for the run unless one is already there, and removes it afterwards. The inline results hover offers the same as **Debug to this line**. |

The keyboard shortcuts use the `Ctrl+;` (`Cmd+;`) chord of VS Code's own testing shortcuts, with keys those leave free.

Test Explorer items also have **Why Was This Selected?**, which explains whether and why the item ran in the latest run, and **Pin to Automatic Runs** / **Unpin from Automatic Runs**: pinned tests, classes, files and projects run with every automatic run, whatever changed (remembered per workspace). Project items have **Exclude Project from Testy**, which adds the project to `testy.projects.exclude` (per folder in a multi-root workspace). A failure message's context menu has **Show Output**.

The **Testy Queue** view in the Testing sidebar lists the test files of the current or latest run: running ones with their time so far, queued ones in the order they start with their expected time, then finished ones, each with why it was selected. Choose one to show it in Test Explorer.

Startup and environment problems, such as a missing `dotnet`, an unsupported SDK, an analyzer crash or an unreadable `testy.solution`, are also shown once per session as a notification with **Show Output** and **Open Settings**. Build and test failures only update the status bar.

The refresh button in Test Explorer rediscovers tests without running them. Test items are tagged by project and framework (`project:<name>`, `framework:<tfm>`) for filtering. Traits reported by the test framework (xUnit traits, NUnit `Category`, MSTest `TestCategory`) become `trait:<key>=<value>` tags, plus `category:<value>` for category traits, so you can filter Test Explorer with, for example, `@testy:trait:Category=Integration`. Spaces in tag values appear as `_`.

## Debugging tests

Use the **Debug** profile in Test Explorer. Testy starts the test host, waits for it to report its process ID, and attaches the `coreclr` debugger. Debug runs use one process per project, run without coverage, and are not limited by `testy.timeoutSeconds`. The C# extension must be installed; Testy offers to install it if it is missing.

Set `testy.debugConfiguration` to add properties to the attach configuration, for example `{ "justMyCode": false, "symbolOptions": { "searchMicrosoftSymbolServer": true } }`. Testy always sets `request` and `processId`.

## Build configurations

List extra configurations in `testy.additionalConfigurations` (for example `["Release"]`) to get **Run (Release)**, **Run with coverage (Release)** and **Debug (Release)** profiles next to the defaults. A manual run through one of them builds, discovers and runs with that configuration for that run only. Automatic runs always use `testy.buildConfiguration`, and the profiles are not the default. Coverage learned under another configuration is shown, but it is not trusted to narrow later selections: the affected files are conservatively rerun and relearned by the next automatic run.

## Continuous run

The Run and Run with coverage profiles support Test Explorer's continuous run. While automatic testing is paused, a continuous run keeps the selected tests running after changes. A continuous run started from **Run with coverage** collects and shows coverage in its automatic runs even when `testy.runWithCoverage` is off.

Automatic runs are named by what started them in Test Explorer's results, for example `Testy · on save: Calculator.cs`.

## Coverage

Coverage collection is enabled by default (`testy.runWithCoverage`). Fresh coverage appears in Test Explorer's coverage view and can be filtered per test file or project. Coverage retained from earlier sessions is published after startup checks, or at the first run if automatic testing is paused.

Optional gutter markers (`testy.showCoverage`, off by default) also show coverage that is **stale** because a source file, contributing test, or dependency changed since it was collected:

- A **filled green circle** marks a covered line.
- A **red ring** marks an uncovered line.
- An **amber diamond** marks stale coverage, or coverage of an unsaved version of the file.

On first use, Testy installs a pinned version of Microsoft's `dotnet-coverage` from NuGet into its own storage (the first-baseline prompt mentions this); it never adds packages to your projects. If setup fails, for example offline or behind a proxy, tests continue with conservative selection and a notification offers to open `testy.coverageToolPath`, where you can point Testy to a `dotnet-coverage` you installed yourself.

### Inline results

With `testy.inlineResults` (on by default), every covered line of a C# file shows the latest outcome of the test files whose retained coverage hits it:

- A **green check**: every covering test file passed.
- A **red cross**: at least one covering test file has a failing test. Failures stay visible until the file reruns, and are also marked in the scroll bar.
- A **grey dash**: a covering test file has not run since a change (its coverage is stale or it has no results yet), or the editor had unsaved changes before Testy could follow them.

**Exception markers.** While inline results are on, every line of your code on the stack of a failing test is marked at the end of the line and in the scroll bar: `✗ thrown here` where the test threw, `✗ on the stack` for the callers that led there. Hovering the marker names the failing tests and their messages, with links to them in Test Explorer. A marker disappears when its tests pass, follows unsaved edits like the gutter markers (and is hidden on a line you changed), and is hidden when the file was saved with changes since the failure, because its line numbers may no longer match.

Results are per test file, the granularity of Testy's coverage: a red cross means a test file that exercises the line has a failure, not necessarily a test that reached that line. Hovering a covered line (`gutterAndHover`, the default) shows **Covered by N test files (X failing)**, the first ten files with their status and failing tests, links that reveal them in Test Explorer, what those tests cost (the total and slowest time of the tests that ran the line when each test's coverage is known, otherwise of the covering files), and **Run covering tests**. Set `testy.inlineResults` to `gutter` for markers without the hover, or `off`.

A `// testy: no coverage` comment before a member or type (or `// testy: no coverage start` … `end` around several) leaves that code uninstrumented, like NCrunch's `//ncrunch: no coverage`; see [Coverage suppression](docs/how-it-works.md#coverage-suppression).

While you edit a C# file, its markers follow your edits: they move with the lines below an edit and disappear from the lines you changed, keeping the status of the saved code until you save and the tests run again. A file that was already unsaved when Testy first saw it shows grey dashes instead.

Only one marker is drawn per line. While inline results are on, they own covered lines, and `testy.showCoverage` adds only the red ring for uncovered lines and the amber diamond for stale uncovered lines. **Clear Coverage** hides both until the next run, **Reset Caches and Baseline** removes them with the coverage, and in Restricted Mode nothing is shown.

## How affected selection works

During the baseline, every test file runs separately under coverage. Testy records which workspace source files each test file reaches, including indirect calls and assemblies loaded at runtime. Later saves select every test file known to exercise the changed code. An edit inside a method, accessor or constructor body is matched to the bodies each test file executed, so saving one handler reruns only the tests that call it, even when every test constructs it through a shared registry or DI container. With `testy.selectionGranularity` set to `test`, Testy also learns each test's own coverage and runs only the tests inside those files that executed the edit. Only the test projects that will run are built, and test files that missed the edit keep their coverage current.

When impact can't be proven from coverage, Testy falls back to all test files in the affected project and its dependent test projects. This happens for new or unknown files, project or configuration changes, missing coverage, and incomplete traces. A Roslyn analyzer, using the compiler of your installed .NET SDK, also catches declaration changes such as constants, signatures, and attributes that affect consumers without showing up in runtime coverage. Set `testy.runMode` to `all` to always run the complete suite, or `testy.safetyNet` to `related` or `all` to check the unselected tests in the background (see [Safety net](docs/how-it-works.md#safety-net)).

Each run explains itself. When a test file is queued, Testy writes a line such as `Selected CalculatorTests.cs: covers Calculator.cs (changed)` to the run output and the Testy log, and shows the same reason as the file's description in Test Explorer while the run is active. The reason is one of: the changed files its coverage trace links to it (the first three, then a count), its own file changed, a named project fallback (configuration change, no coverage trace yet, a change that could not be analyzed precisely), baseline, manual run, or run-all mode.

See [How Testy works](docs/how-it-works.md) for the full details: caching, evaluation reuse, runtime observation, theory rows, generated files, and process cleanup.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `testy.autoRun` | `true` | Run automatically after changes. The first baseline of a workspace still asks first. Pausing is stored per workspace and overrides this default. |
| `testy.runMode` | `affected` | `affected` or `all`. |
| `testy.selectionGranularity` | `method` | `method` runs the test files whose coverage executed an edited body; `test` runs only the tests within them whose own coverage did (see [Test granularity](docs/how-it-works.md#test-granularity)); `file` runs every test file whose coverage reached the edited file. |
| `testy.alwaysRunFailing` | `false` | Automatic runs also run every test file whose latest results include a failure, until it passes. |
| `testy.safetyNet` | `off` | After an automatic affected run, also run the test files it did not select once the editor is quiet: `related` (the other files of the affected test projects) or `all`. Any change cancels them until the next quiet period. Files that newly fail are reported. |
| `testy.excludeTraits` | `[]` | Traits whose tests automatic runs skip, such as `Integration` or `Category=Slow`. They still run from Test Explorer. |
| `testy.trigger` | `save` | `save` for editor saves, or `fileSystem` to include external disk changes and branch switches. |
| `testy.debounceTime` | `50` | Delay after the latest change, in milliseconds. Unless set, `fileSystem` triggers wait `500`. |
| `testy.finishRunningTests` | `5` | When a change arrives during an automatic run, test files already running keep running for up to this many seconds to finish, unless it affects all of them; no further files start. `0` cancels at once. |
| `testy.runWithCoverage` | `true` | Collect coverage. Disabling it uses project fallback. |
| `testy.showCoverage` | `false` | Also show coverage and stale markers in editor gutters. |
| `testy.inlineResults` | `gutterAndHover` | Pass/fail markers on covered lines (`gutter`), plus a hover listing the covering test files (`gutterAndHover`), or `off`. |
| `testy.problems.publishBuildDiagnostics` | `auto` | Publish build errors to the Problems panel: `auto` skips them while the C# extension is active (it reports them too), or `always` / `never`. |
| `testy.solution` | (empty) | Optional `.sln`, `.slnx`, or `.slnf` whose projects limit the entry points. Relative paths resolve against the folder that sets it. `${workspaceFolder}` is supported. *Per folder.* |
| `testy.projects.include` | `[]` | Globs for entry-point projects to include, for example `tests/**/*.csproj`. *Per folder.* |
| `testy.projects.exclude` | `[]` | Globs for entry-point projects to exclude. Exclusions win over inclusions. *Per folder.* |
| `testy.exclude` | `[]` | Additional file patterns to ignore. *Per folder.* |
| `testy.fileWatcherPattern` | Source and configuration files | Which files can trigger runs. |
| `testy.buildConfiguration` | `Debug` | MSBuild configuration for automatic runs and the default profiles. |
| `testy.additionalConfigurations` | `[]` | Extra MSBuild configurations such as `Release`. Each adds `Run (Release)`, `Run with coverage (Release)` and `Debug (Release)` profiles that build and run or debug manual selections with that configuration. |
| `testy.maxParallelProjects` | `0` (automatic) | Workers for initial project preparation, builds, source analysis, and discovery. |
| `testy.maxParallelTestFiles` | `0` (automatic) | Workers for test-file execution. Use `1` to run every file sequentially. |
| `testy.splitLongTestFiles` | `true` | In baselines and runs of everything, split a long test file that would finish alone into parts that several workers run at once. |
| `testy.reuseTestHosts` | `true` | Run each project's test files in one long-lived test process per worker instead of a process per file, splitting coverage with collector snapshots, and keep those processes for the next run when nothing they loaded was rebuilt. Faster, but tests share static state with earlier files in the same process (see [Reused test hosts](docs/how-it-works.md#reused-test-hosts)). |
| `testy.isolatedTraits` | `[]` | Traits whose test files always run in a test process of their own, such as `Isolated`. |
| `testy.testProcessMemoryLimit` | `0` | Memory in MiB a reused test process may use after a test file before it is replaced; `0` for no limit. |
| `testy.exclusiveTraits` | `[]` | Traits that name a shared external resource, such as `Database` or `Resource=Ports`. Test files with tests matching the same entry never run at the same time; other files stay parallel. |
| `testy.inclusiveTraits` | `[]` | Traits naming a shared resource test files may use together, but never beside files that use it exclusively (`testy.exclusiveTraits`), such as a database they only read. |
| `testy.serialTraits` | `[]` | Traits whose test files run with no other test file at the same time, such as `Category=Serial`. |
| `testy.workerTraits` | `{}` | Traits whose test files use several CPUs, and how many test-file workers each takes while it runs, for example `{ "Category=Parallel": 4 }`. |
| `testy.processPriority` | `belowNormal` | Priority of the builds, instrumentation and test processes Testy starts; `normal` for timing-sensitive tests. |
| `testy.dotnetPath` | `dotnet` | Path to the .NET CLI. *Machine-overridable.* |
| `testy.testArguments` | `[]` | Additional MTP arguments, such as framework settings. |
| `testy.timeoutSeconds` | `600` | Limit for each build, discovery, or test-file run. Debug runs are not limited. |
| `testy.testTimeoutSeconds` | `120` | Limit for each test, from when the framework reports it started. A test that runs longer stops its test process and is reported as errored. `0` turns it off. Debug runs are not limited. |
| `testy.coverageToolPath` | Automatic | Absolute path to an existing `dotnet-coverage` executable. *Machine-overridable.* |
| `testy.debugConfiguration` | `{}` | Extra properties for the `coreclr` attach configuration of Debug profiles, such as `justMyCode`, `symbolOptions` or `sourceFileMap`. |

One engine serves every folder of a multi-root workspace. Settings marked *per folder* can be set in a folder's settings: they then apply to that folder's projects and resolve relative paths and globs against it (folder `exclude` patterns add to the workspace ones; a folder `solution` or `projects.include` replaces the inherited value for that folder). `testy.buildConfiguration` and `testy.testArguments` can be set per folder but apply to the whole run: when folders disagree, Testy warns and uses the workspace value. Other settings are window-scoped. Tuning settings (`debounceTime`, `fileWatcherPattern`, `maxParallel*`, `splitLongTestFiles`, `processPriority`, the `*Traits` settings, `reuseTestHosts`, `testProcessMemoryLimit`, `timeoutSeconds`, `testTimeoutSeconds`) are tagged `advanced`; filter the Settings editor with `@tag:advanced`. With `0`, test-file workers use available CPUs minus one, and project workers use up to four while reserving one CPU.

## Remote, WSL, and dev containers

Testy runs where your workspace files live. In Remote - SSH, WSL, or a dev container, install the .NET 10 SDK on the remote side, and the C# extension there too if you want to debug. The `dotnet-coverage` download also happens on the remote side.

## Using Testy with C# Dev Kit

Testy does not need C# Dev Kit, but they can be installed together. If both are enabled, Test Explorer shows two trees for the same tests, and both extensions build your projects. Testy shows a one-time notice when it detects Dev Kit. To avoid duplicate work, disable Dev Kit's testing for the workspace, or disable one of the extensions there.

## Troubleshooting

- **Something looks wrong.** Run **Testy: Show Output**. The log includes build output, resolved worker limits, phase timings, and why each test was selected. Use **Developer: Set Log Level…** and choose Testy for more detail.
- **A project's tests are missing.** VSTest projects and test targets older than .NET 10 are skipped and listed in Output. Check `testy.solution` and `testy.projects.*` too.
- **Coverage is unavailable.** The status tooltip explains why. If NuGet access is blocked, install `dotnet-coverage` yourself and set `testy.coverageToolPath`.
- **Results seem stale or selections too narrow.** Run **Testy: Reset Caches and Baseline**, or **Rebuild and Run All C# Tests** after changing external data, services, or environment variables.
- **A test batch could not run.** The status bar shows batch errors. The affected tests are marked errored, the remaining batches continue, and Output has the details.
- **Tests interfere with each other.** Tests that share static state across files need their own process: list their trait in `testy.isolatedTraits`, or turn off `testy.reuseTestHosts`. Tests that share an external resource can be kept apart with `testy.exclusiveTraits`. As a last resort, set `testy.maxParallelTestFiles` to `1`.
- **A test hangs.** `testy.testTimeoutSeconds` (two minutes by default) stops it and reports it as errored, so the worker moves on.
- **The editor feels slow during runs.** Testy's processes already run below normal priority (`testy.processPriority`); lower `testy.maxParallelTestFiles` to leave more CPUs free. **Testy: Export Timeline…** shows the editor's event-loop delay next to what ran.

## Known limitations

- Test projects must use MTP on .NET 10 or later. Testy does not migrate VSTest projects.
- Only tests inside the opened workspace folders are discovered. Referenced projects outside them are built but not searched for tests.
- Changes to databases, services, environment variables, or unwatched data are invisible to affected selection; use a full refresh.
- Code reached through external services, or child processes that suppress .NET startup hooks, can't be traced. Use `testy.runMode: "all"` if your tests rely on that.
- Coverage is line-based; branch coverage isn't reported.
- Source files with hidden or remapped `#line` regions use project fallback.
- Debugging requires the C# extension.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing, and benchmarking. Design and validation notes live in [docs](docs/).

## License

See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
