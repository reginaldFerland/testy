# Testy

Fast feedback for C# without rerunning the whole suite after every save.

Testy runs your tests through **.NET 10+ and Microsoft.Testing.Platform (MTP)**, learns which source files each test file exercises, and runs the affected files when you save. Results appear in VS Code's Test Explorer. Coverage stays available across partial runs.

## Getting started

1. Install the .NET 10 SDK or later and use an MTP-enabled C# test project. Testy does not require C# Dev Kit.
2. Open the workspace in VS Code and trust it. Testy builds, discovers, and runs all C# tests to establish the initial baseline.
3. Save a source file. Testy cancels its previous automatic run, waits briefly for edits to settle, then builds and runs affected test files.

Click the Testy status item to pause or resume automatic testing. Use **Testy: Refresh and Run All C# Tests** to build, rediscover, and replace the baseline. Individual tests, files and projects can also be run from Test Explorer. Container runs include tests added since the last discovery and honor explicit exclusions. Saves never cancel a manually initiated run.

Coverage collection is enabled by default. On first use, Testy installs a pinned version of Microsoft's `dotnet-coverage` tool into its own storage. This requires access to NuGet; it does not add packages to your projects. You can supply an existing collector through `testy.coverageToolPath`. If setup fails, tests continue with conservative selection and the status tooltip explains that coverage is unavailable.

## How affected selection works

Testy discovers tests in isolated outputs per project and target framework, then runs selected test files concurrently in separate processes. During affected runs, projects needed only for discovery avoid coverage instrumentation; newly selected projects are prepared before execution. Source analysis overlaps runner preparation within the configured project worker budget. The scheduler uses idle project runners first and assigns spare workers to busier projects. Each worker reuses its own output and collector session; files mutated by tests are restored from that worker's pristine template before reuse. Test targets that share output directories with another framework or reference context are saved before another build can overwrite them. Testy records the workspace source files that execution reaches, including indirect calls, and keeps a separate coverage contribution for each test file. Later changes select every test file known to have exercised the changed code.

Prepared outputs are cached between runs and can survive a clean editor shutdown. Testy validates the complete build output, preparation tools, environment, and configuration before reusing instrumentation, and runs fresh discovery on every run. Shutdown drains active work, deletes working copies and reports, and retains only pristine templates. Another editor instance can claim those templates exclusively; live instances never share mutable outputs or collector sessions. The entry allowance starts at 16 and grows to accommodate the test-file worker budget across prepared targets. Active caches and the combined retained templates each remain bounded by 512 MiB, with active work temporarily exempt. Least recently used idle entries are evicted, and outputs from crashed active owners are discarded. Startup still performs build checks and establishes a fresh baseline; saved coverage supplies history while that runs. Custom collectors retain their complete environment, so editor environment changes can invalidate their preparations.

Project evaluations can also be reused within the editor session and across restarts after validating the files, existence checks, and directory searches MSBuild used. Saved evaluations are bounded to 128 project roots and 32 MiB. A full refresh or startup still checks the SDK and runs Restore before validating an existing evaluation, so generated imports and restored assets remain authoritative. Changes to imports, SDKs, file inventories, configuration, environment, or evaluation tools require fresh evaluation. Unsupported custom evaluation logic and unavailable or invalid saved evaluations use normal evaluation. Builds continue to use MSBuild's incremental checks.

Successful source analyses are retained within the editor session, including across full refreshes. Reuse requires matching source bytes, alias inputs, and analyzer context. Generated sources are checked after Build, and partial declarations and exclusions are resolved against the current projects. Incomplete analysis is retried; custom CLI wrappers or injected runtime components use fresh analysis.

The bundled collector instruments independent workspace DLLs concurrently during initial preparation when project workers are available. This shares the existing preparation budget with source analysis and discovery. Each private test-file worker still prepares one DLL at a time, and warm prepared-output cache hits skip instrumentation.

Workspace assemblies loaded from original build outputs, other paths, or memory are also recorded, including loads in child .NET processes that inherit and support the startup hook. When a load bypasses the instrumented copy, Testy records a dependency on the loaded project. Changes and new source files in that project rerun the calling test file, even without a `ProjectReference`. Those loads do not themselves supply line coverage. If runtime observation is incomplete, retained coverage stays visible and selection becomes conservative.

A collector command can succeed without instrumenting a module, for example when its symbols are missing. Testy verifies that the assembly bytes changed and retains project dependencies for skipped modules, so their callers cannot be silently omitted.

When target frameworks share an output directory, Testy snapshots each target immediately after building it. Discovery, test execution, and portable symbols use that target's copy.

New or unknown source files, project/configuration changes, missing coverage, and incomplete or failing traces use a conservative fallback: all test files in the affected project and its dependent test projects. A bundled Roslyn analyzer also detects declaration changes, including constants, signatures, attributes, and initializers that can affect consumers without appearing in runtime coverage. Edits in coverage-excluded methods or hidden regions also force fallback. Recorded runtime dependencies and workspace binary references are included even without a `ProjectReference`. Evaluated imports, resources and additional build inputs are tracked across consuming projects. MSBuild applies reference-specific properties when building dependencies. Ordinary method-body edits use the recorded traces. Choose `testy.runMode: "all"` to always run the complete suite.

The first baseline requires separate test-file runs for attribution. Independent files run concurrently, including files in the same test project. Complete projects in run-all mode, and runs without collection, batch tests by project. Compatible build roots share an MSBuild invocation so their shared dependencies can be reused. Project discovery runs concurrently; files whose provider identities cannot be safely mapped to another worker use their original runner. Partial selections and exclusions also use that runner. Subsequent runs build the affected roots and execute only selected test files. Source files with hidden or remapped `#line` regions use conservative project selection because coverage may not identify their physical methods. For unobserved external dependencies, changes to databases, services, environment variables, or data outside the watched files require a full refresh.

Changes are accumulated across cancelled runs. Completed, version-checked test files are checkpointed during the baseline, so cancellation resumes unfinished work. An interrupted test file never replaces its previous contribution. Instrumentation happens in temporary copies, so a cancelled collector cannot modify your normal build outputs.

## Coverage and results

- A **filled green circle** marks a covered line.
- A **red ring** marks an uncovered line.
- An **amber diamond** marks coverage that is stale or belongs to an unsaved version of the file.

Rerunning a file replaces its coverage contribution while retaining contributions from other tests. Deleted tests lose their contributions. Coverage from different versions of a source file is never combined into a misleading green result. A manually selected subset of a test file does not overwrite that file's complete coverage contribution. Manual runs without collection preserve the existing impact map. Editing a contributing test or dependency marks retained production coverage stale, even if the production file itself is unchanged.

A manual subset of files in run-all mode collects separate file contributions. The previous project aggregate remains visible as stale history until every file has been relearned or the whole project runs again. The same retention applies when switching from run-all to affected mode. Outcomes for tests outside the final affected selection remain available.

Some frameworks report deferred theory rows under one shared test identity; Testy preserves a failure if another row subsequently passes. Testy maps runtime-only rows using provider identities, source paths, and unambiguous type/method metadata. If a row cannot be selected individually after discovery, Testy runs its containing file. Rows whose file cannot be identified appear under **Unmapped runtime tests** and rerun their project. Output explains the expanded selection.

Explicit exclusions still apply to that fallback. If a runtime-only exclusion cannot be honored by the provider, the run reports the limitation before executing tests. An unavailable coverage cache is reported in Output and does not prevent a fresh startup baseline.

A manual test selection preserves failures from unselected runtime rows. Their outcomes change only when those rows run again or a complete run establishes that they no longer exist.

Overlapping manual selections run each discovered test once after fallback expansion. A complete refresh removes runtime rows that no longer exist, including when the project runs file by file or resumes from a completed checkpoint. Partial or cancelled refreshes retain unresolved rows until the remaining project files finish.

Test failures include their messages and stack traces in Test Explorer. The status item shows progress, passing/failing totals, and fresh production-code line coverage. **Testy: Show Output** includes build output and explains each selection.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `testy.autoRun` | `true` | Establish a baseline on open and run automatically. |
| `testy.runMode` | `affected` | `affected` or `all`. |
| `testy.trigger` | `save` | Editor saves, or `fileSystem` for external disk changes too. |
| `testy.debounceTime` | `500` | Delay after the latest change, in milliseconds. |
| `testy.runWithCoverage` | `true` | Collect coverage; disabling it uses project fallback. |
| `testy.showCoverage` | `true` | Show coverage gutter markers. |
| `testy.exclude` | `[]` | Additional file patterns to ignore. |
| `testy.fileWatcherPattern` | Source and configuration files | Customize which files can trigger runs. |
| `testy.buildConfiguration` | `Debug` | MSBuild configuration. |
| `testy.maxParallelProjects` | `0` | Worker budget for initial project preparation, builds, source analysis, and discovery. |
| `testy.maxParallelTestFiles` | `0` | Worker budget for test-file execution and private runner preparation; a project batch uses one worker. |
| `testy.dotnetPath` | `dotnet` | Path to the CLI executable. |
| `testy.testArguments` | `[]` | Additional MTP arguments, such as framework settings. |
| `testy.timeoutSeconds` | `600` | Limit for each build, discovery, or test-file run. |
| `testy.coverageToolPath` | Automatic | Optional existing `dotnet-coverage` executable. |

Concurrency settings use `0` for automatic. Test-file workers use `max(1, available CPUs - 1)`; initial project preparation uses `max(1, min(4, available CPUs - 1))` because builds and source analysis can also schedule internal parallel work. For example, a machine with 10 available CPUs uses 4 project workers and 9 test-file workers. Each additional file worker can prepare its own isolated runner and consumes additional memory. Use `1` for sequential operation or an explicit positive integer to choose either limit. These settings apply on the next run without clearing learned coverage. Test frameworks retain their own internal scheduling. Tests that share databases, fixed ports, or other external resources may require `testy.maxParallelTestFiles: 1`; private outputs isolate files in the build output, not external resources. Output reports the resolved limits, phase timings, and any identity or build-output constraints on parallelism.

Generated files and build outputs (`bin`, `obj`, `TestResults`, `*.g.cs`, `*.generated.cs`, `*.designer.cs`, and files with an auto-generated header in the first 2,048 bytes) do not trigger test runs. Observed generated headers remain recognized through deletion and rename; a refresh or save that sees ordinary content clears that classification. Header-marked outputs and configured `testy.exclude` patterns are also excluded from input hashes, so a generator that rewrites them during a build does not restart the baseline. Ignored Compile inputs still supply global aliases and partial-type coverage-exclusion metadata for conservative source analysis. Evaluated generator inputs remain tracked unless explicitly excluded. Directory events honor the same exclusions as their children. VS Code file renames and deletions are handled in both trigger modes.

Generated headers must be declarations in leading comments. A marker such as `"<auto-generated/>"` inside a handwritten test or an explanatory comment does not exclude that file. Inherited `.editorconfig` files, global analyzer configuration, and configured rulesets are tracked as compiler inputs. Creating or deleting a previously absent configuration also invalidates the consuming projects, including changes that arrive while tests run.

Saved and on-disk generated headers use the same 2,048-byte prefix, including UTF-8 and UTF-16 files with a BOM in either byte order. Removing a generated header makes the file an ordinary tracked input again.

Filesystem mode also watches evaluated source files and build inputs linked from outside the workspace, including known inputs outside the usual file-pattern extensions. Excluding a referenced project from discovery does not prevent MSBuild from building that required dependency.

External input watchers are installed before builds and discovery, allowing a corrected linked file to recover a failed run. Inherited `global.json` candidates are tracked before SDK validation, so correcting an invalid initial SDK pin also triggers recovery. SDK file creation and deletion participate in input-version checks.

## Requirements and boundaries

- VS Code 1.99 or later, with a trusted local workspace or a remote extension host that has the .NET CLI.
- .NET SDK 10 or later; test projects must target .NET 10 or later and enable MTP. Referenced production libraries may target compatible earlier frameworks.
- An MTP test framework that supports the standard discovery and execution server protocol. Integration tests cover MSTest 4.3.3, xUnit v3 3.2.0 with MTP v2, and NUnit 4.4.0 with adapter 6.3.0.
- Portable debug symbols for source mapping and coverage. A missing source location causes conservative selection.

Test discovery is scoped to projects inside the opened workspace folders. Referenced projects outside those folders are built as dependencies, but their tests are not discovered. A build failure stops the current batch, including independent projects.

When an evaluated project stops being a test target or leaves the workspace, its test inventory, runtime rows, coverage and baseline checkpoints are removed. Required references still build as dependencies. These removals persist even if a subsequent build fails.

Source analysis can inspect generated declarations only when they appear in evaluated Compile inputs. If a source generator applies coverage-exclusion metadata through compiler-only output, use `testy.runMode: "all"`. Changes to external services, environment variables, and unwatched data require a full refresh.

Child execution that suppresses startup hooks or runs through an external service cannot supply module dependencies. Use run-all mode when tests rely on workspace code executed that way.

Testy cleans up owned test processes after completion, cancellation, and extension-host failure. On Windows, a Job Object contains descendants. On macOS and Linux, an independent supervisor watches the extension host’s control pipe and combines process groups with an inherited ownership marker to find detached children. The supervisor uses VS Code’s bundled runtime; no separate Node installation is required. Programs that deliberately remove that marker and detach, or launch work through an external service, must manage that work's lifetime themselves.

Private run output carries process ownership metadata. Startup and subsequent runs reclaim output left by dead hosts while preserving live windows' output. Unmarked directories created by older versions are preserved because their ownership cannot be verified.

Testy does not migrate VSTest projects or edit their package references. A project using VSTest gets an actionable setup error. If your workspace uses a `global.json`, it must select a supported SDK. Microsoft documents [MTP setup](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-intro) and the [.NET 10 CLI integration](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp).

## Development

```sh
npm ci
npm test
npm run test:integration
npm run test:extension
npm run package
# Optional 4,800-case deep dependency graph benchmark (three serial/automatic pairs):
npm run benchmark
# Optional report parsing, output reuse, identity lookup, and UI publication probes:
npm run benchmark:responsiveness
node test/performance/cache-and-results.cjs
node test/performance/cache-membership.cjs
node test/performance/live-updates.cjs
node test/performance/discovery.cjs
```

Compilation builds TypeScript, the bundled .NET source analyzer, the Windows process owner, and the runtime observer. The observer uses a .NET startup hook compatible with the collector and managed child runtimes; it does not edit workspace packages or build outputs. Integration tests copy the sample workspace into a temporary directory, build it, modify its source, and assert the selected test identities, failure results, retained coverage, constant-change fallback, and cancellation. Set `TESTY_COVERAGE_TOOL` to an existing collector executable to reuse it in tests. The extension-host suite downloads an isolated VS Code build and exercises actual saves, pause/resume, refresh, and external linked-file events. Set `TESTY_VSCODE_PATH` to use an existing VS Code executable instead.

The analyzer bundles pinned, portable Roslyn NuGet assemblies. Unit validation rejects platform-specific managed binaries, so a VSIX built on one OS can use the same analyzer on another.

For interactive development, open this repository in VS Code and press **F5**. The launch task builds the bundled .NET helpers before starting the TypeScript watcher. Open `test/fixtures/ImpactDemo` in the Extension Development Host, save a source edit, and inspect Test Explorer and **Testy: Show Output**. To test the installable artifact, use **Extensions: Install from VSIX…** and choose `testy-1.2.0.vsix`; reload the window afterward. No publication is needed.

See [validation evidence](docs/1.0-validation.md) for measured performance and platform limits.
The [latest performance review](docs/performance-review.md) records optimization measurements and remaining candidates.
