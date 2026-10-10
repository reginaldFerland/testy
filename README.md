# Testy

Fast feedback for C# without rerunning the whole suite after every save.

Testy runs your tests through **.NET 10+ and Microsoft.Testing.Platform (MTP)**, learns which source files each test file exercises, and reruns only the affected test files when you save. Results appear in VS Code's Test Explorer, and coverage stays available across partial runs.

## Features

- **Affected tests on save.** Edits rerun every test file known to exercise the changed code, with a conservative project-wide fallback whenever impact is uncertain.
- **Retained coverage.** Each test file keeps its own coverage contribution, so partial runs never erase coverage from other tests. Coverage appears in Test Explorer's native coverage view and can be filtered by test file or project.
- **Test Explorer integration.** Run, debug, or continuously run individual tests, files, and projects. Failures show expected/actual diffs when the framework reports them, plus clickable stack frames.
- **Build problems in the Problems panel.** Compiler errors and warnings from Testy's builds are listed there and cleared after the next successful build.
- **Parallel and cached.** Discovery, builds, and test files run concurrently, and prepared outputs and project evaluations are reused safely across runs and restarts.
- **No C# Dev Kit required.** Testy talks to MTP directly.

## Requirements

- VS Code 1.99 or later.
- [.NET SDK 10](https://dotnet.microsoft.com/download) or later. If your workspace has a `global.json`, it must select a supported SDK.
- C# test projects that target .NET 10 or later and use [Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-intro). MSTest, xUnit v3 (MTP v2), and NUnit with the MTP adapter are tested. VSTest projects and test targets older than .NET 10 are skipped and listed in Output.
- A trusted workspace. Testy builds and runs workspace code, so it does not start in Restricted Mode.
- NuGet access on first use, to install Microsoft's `dotnet-coverage` collector (unless you set `testy.coverageToolPath`).
- Portable debug symbols (the .NET default) for source mapping and coverage.
- The [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp), only for debugging tests.

## Getting started

1. Open a folder or workspace that contains MTP test projects, and trust it.
2. Testy builds, discovers, and runs every test file once to establish a baseline. The status bar shows a baseline progress indicator with a percentage (no popup); cancel it with **Testy: Cancel Current Run** or the stop button in Test Explorer. The **Get started with Testy** walkthrough covers the same steps.
3. Save a source file. Testy cancels its previous automatic run, waits briefly for edits to settle, then builds and runs the affected test files.

Saves never cancel a run you started manually. Changes are accumulated across cancelled runs, and an interrupted baseline resumes where it stopped.

## Commands

Click the Testy status bar item to open its action menu. Every action is also available from the Command Palette:

| Command | What it does |
| --- | --- |
| **Testy: Pause Automatic Testing** / **Resume Automatic Testing** | Stop or restart runs on save. Remembered per workspace without changing your settings. |
| **Testy: Run Affected Tests Now** | Run the tests affected by pending changes immediately. |
| **Testy: Refresh and Run All C# Tests** | Rebuild, rediscover, and run everything to replace the baseline. |
| **Testy: Cancel Current Run** | Cancel the active run. |
| **Testy: Clear Coverage** | Discard retained coverage. |
| **Testy: Export Coverage…** | Write the current merged coverage as LCOV or Cobertura XML (default `coverage/testy.lcov` or `coverage/testy.cobertura.xml` in the first workspace folder), with paths relative to the workspace. Stale coverage is not exported. |
| **Testy: Reset Caches and Baseline** | Delete learned coverage, saved project evaluations, and prepared test outputs, then establish a fresh baseline. |
| **Testy: Show Output** | Open the Testy log, including build output and why each selection was made. |
| **Testy: Show Actions** | Open the status bar menu. |

The refresh button in Test Explorer rediscovers tests without running them. Test items are tagged by project and framework (`project:<name>`, `framework:<tfm>`) for filtering. Traits reported by the test framework (xUnit traits, NUnit `Category`, MSTest `TestCategory`) become `trait:<key>=<value>` tags, plus `category:<value>` for category traits, so you can filter Test Explorer with, for example, `@testy:trait:Category=Integration`. Spaces in tag values appear as `_`.

## Debugging tests

Use the **Debug** profile in Test Explorer. Testy starts the test host, waits for it to report its process ID, and attaches the `coreclr` debugger. Debug runs use one process per project, run without coverage, and are not limited by `testy.timeoutSeconds`. The C# extension must be installed; Testy offers to install it if it is missing.

## Build configurations

List extra configurations in `testy.additionalConfigurations` (for example `["Release"]`) to get **Run (Release)** and **Run with coverage (Release)** profiles next to the defaults. A manual run through one of them builds, discovers and runs with that configuration for that run only. Automatic runs always use `testy.buildConfiguration`, and the profiles are not the default. Coverage learned under another configuration is shown, but it is not trusted to narrow later selections: the affected files are conservatively rerun and relearned by the next automatic run.

## Continuous run

The Run profile supports Test Explorer's continuous run. While automatic testing is paused, a continuous run keeps the selected tests running after changes.

## Coverage

Coverage collection is enabled by default (`testy.runWithCoverage`). Fresh coverage appears in Test Explorer's coverage view and can be filtered per test file or project. Coverage retained from earlier sessions is published after startup checks, or at the first run if automatic testing is paused.

Optional gutter markers (`testy.showCoverage`, off by default) also show coverage that is **stale** because a source file, contributing test, or dependency changed since it was collected:

- A **filled green circle** marks a covered line.
- A **red ring** marks an uncovered line.
- An **amber diamond** marks stale coverage, or coverage of an unsaved version of the file.

On first use, Testy installs a pinned version of `dotnet-coverage` into its own storage; it never adds packages to your projects. If setup fails, tests continue with conservative selection and the status tooltip explains why coverage is unavailable.

## How affected selection works

During the baseline, every test file runs separately under coverage. Testy records which workspace source files each test file reaches, including indirect calls and assemblies loaded at runtime. Later saves select every test file known to exercise the changed code.

When impact can't be proven from coverage, Testy falls back to all test files in the affected project and its dependent test projects. This happens for new or unknown files, project or configuration changes, missing coverage, and incomplete traces. A Roslyn analyzer, using the compiler of your installed .NET SDK, also catches declaration changes such as constants, signatures, and attributes that affect consumers without showing up in runtime coverage. Set `testy.runMode` to `all` to always run the complete suite.

Each run explains itself. When a test file is queued, Testy writes a line such as `Selected CalculatorTests.cs: covers Calculator.cs (changed)` to the run output and the Testy log, and shows the same reason as the file's description in Test Explorer while the run is active. The reason is one of: the changed files its coverage trace links to it (the first three, then a count), its own file changed, a named project fallback (configuration change, no coverage trace yet, a change that could not be analyzed precisely), baseline, manual run, or run-all mode.

See [How Testy works](docs/how-it-works.md) for the full details: caching, evaluation reuse, runtime observation, theory rows, generated files, and process cleanup.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `testy.autoRun` | `true` | Establish a baseline on open and run automatically. Pausing is stored per workspace and overrides this default. |
| `testy.runMode` | `affected` | `affected` or `all`. |
| `testy.trigger` | `save` | `save` for editor saves, or `fileSystem` to include external disk changes and branch switches. |
| `testy.debounceTime` | `500` | Delay after the latest change, in milliseconds. |
| `testy.runWithCoverage` | `true` | Collect coverage. Disabling it uses project fallback. |
| `testy.showCoverage` | `false` | Also show coverage and stale markers in editor gutters. |
| `testy.solution` | (empty) | Optional `.sln`, `.slnx`, or `.slnf` whose projects limit the entry points. `${workspaceFolder}` is supported. |
| `testy.projects.include` | `[]` | Globs for entry-point projects to include, for example `tests/**/*.csproj`. |
| `testy.projects.exclude` | `[]` | Globs for entry-point projects to exclude. Exclusions win over inclusions. |
| `testy.exclude` | `[]` | Additional file patterns to ignore. |
| `testy.fileWatcherPattern` | Source and configuration files | Which files can trigger runs. |
| `testy.buildConfiguration` | `Debug` | MSBuild configuration for automatic runs and the default profiles. |
| `testy.additionalConfigurations` | `[]` | Extra MSBuild configurations such as `Release`. Each adds `Run (Release)` and `Run with coverage (Release)` profiles that build and run manual selections with that configuration. |
| `testy.maxParallelProjects` | `0` (automatic) | Workers for initial project preparation, builds, source analysis, and discovery. |
| `testy.maxParallelTestFiles` | `0` (automatic) | Workers for test-file execution. Use `1` for tests that share databases, ports, or other external resources. |
| `testy.dotnetPath` | `dotnet` | Path to the .NET CLI. *Machine-overridable.* |
| `testy.testArguments` | `[]` | Additional MTP arguments, such as framework settings. |
| `testy.timeoutSeconds` | `600` | Limit for each build, discovery, or test-file run. Debug runs are not limited. |
| `testy.coverageToolPath` | Automatic | Existing `dotnet-coverage` executable. *Machine-overridable.* |

One engine serves every folder of a multi-root workspace, so settings other than the two executable paths are window-scoped: set them in user or workspace settings, not per folder. With `0`, test-file workers use available CPUs minus one, and project workers use up to four while reserving one CPU.

## Remote, WSL, and dev containers

Testy runs where your workspace files live. In Remote - SSH, WSL, or a dev container, install the .NET 10 SDK on the remote side, and the C# extension there too if you want to debug. The `dotnet-coverage` download also happens on the remote side.

## Using Testy with C# Dev Kit

Testy does not need C# Dev Kit, but they can be installed together. If both are enabled, Test Explorer shows two trees for the same tests, and both extensions build your projects. Testy shows a one-time notice when it detects Dev Kit. To avoid duplicate work, disable Dev Kit's testing for the workspace, or disable one of the extensions there.

## Troubleshooting

- **Something looks wrong.** Run **Testy: Show Output**. The log includes build output, resolved worker limits, phase timings, and why each test was selected. Use **Developer: Set Log Level…** and choose Testy for more detail.
- **A project's tests are missing.** VSTest projects and test targets older than .NET 10 are skipped and listed in Output. Check `testy.solution` and `testy.projects.*` too.
- **Coverage is unavailable.** The status tooltip explains why. If NuGet access is blocked, install `dotnet-coverage` yourself and set `testy.coverageToolPath`.
- **Results seem stale or selections too narrow.** Run **Testy: Reset Caches and Baseline**, or **Refresh and Run All C# Tests** after changing external data, services, or environment variables.
- **A test batch could not run.** The status bar shows batch errors. The affected tests are marked errored, the remaining batches continue, and Output has the details.
- **Tests interfere with each other.** Set `testy.maxParallelTestFiles` to `1`.

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
