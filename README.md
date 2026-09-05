# Testy

Fast feedback for C# without rerunning the whole suite after every save.

Testy runs your tests through **.NET 10+ and Microsoft.Testing.Platform (MTP)**, learns which source files each test file exercises, and runs the affected files when you save. Results appear in VS Code's Test Explorer. Coverage stays available across partial runs.

## Getting started

1. Install the .NET 10 SDK or later and use an MTP-enabled C# test project. Testy does not require C# Dev Kit.
2. Open the workspace in VS Code and trust it. Testy builds, discovers, and runs all C# tests to establish the initial baseline.
3. Save a source file. Testy cancels its previous automatic run, waits briefly for edits to settle, then builds and runs affected test files.

Click the Testy status item to pause or resume automatic testing. Use **Testy: Refresh and Run All C# Tests** to build, rediscover, and replace the baseline. Individual tests and files can also be run from Test Explorer. Saves never cancel a manually initiated run.

Coverage collection is enabled by default. On first use, Testy installs a pinned version of Microsoft's `dotnet-coverage` tool into its own storage. This requires access to NuGet; it does not add packages to your projects. You can supply an existing collector through `testy.coverageToolPath`. If setup fails, tests continue with conservative selection and the status tooltip explains that coverage is unavailable.

## How affected selection works

Each test file runs in an isolated copy of its project's build output. Testy records the workspace source files that execution reaches, including indirect calls, and keeps a separate coverage contribution for that test file. Later changes select every test file known to have exercised the changed code.

New or unknown source files, project/configuration changes, missing coverage, and incomplete or failing traces use a conservative fallback: all test files in the affected project and its dependent test projects. A bundled Roslyn analyzer also detects declaration changes, including constants, signatures, attributes, and initializers that can affect consumers without appearing in runtime coverage. Ordinary method-body edits use the recorded traces. Choose `testy.runMode: "all"` to always run the complete suite.

The first baseline takes longer than a single suite invocation because attribution requires separate test-file runs. Subsequent runs build once per affected project and execute only selected test files. This is runtime impact tracking, not a guarantee about unobserved external dependencies: changes to databases, services, environment variables, or data outside the watched files require a full refresh.

Changes are accumulated across cancelled runs. Incomplete runs never replace the dependency map or saved coverage. Instrumentation happens in temporary copies, so a cancelled collector cannot modify your normal build outputs.

## Coverage and results

- A **filled green circle** marks a covered line.
- A **red ring** marks an uncovered line.
- An **amber diamond** marks coverage that is stale or belongs to an unsaved version of the file.

Rerunning a file replaces its coverage contribution while retaining contributions from other tests. Deleted tests lose their contributions. Coverage from different versions of a source file is never combined into a misleading green result. A manually selected subset of a test file does not overwrite that file's complete coverage contribution.

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
| `testy.dotnetPath` | `dotnet` | Path to the CLI executable. |
| `testy.testArguments` | `[]` | Additional MTP arguments, such as framework settings. |
| `testy.timeoutSeconds` | `600` | Limit for each build, discovery, or test-file run. |
| `testy.coverageToolPath` | Automatic | Optional existing `dotnet-coverage` executable. |

Generated files and build outputs (`bin`, `obj`, `TestResults`, `*.g.cs`, `*.generated.cs`, `*.designer.cs`, and files with an auto-generated header) do not trigger test runs. VS Code file renames and deletions are handled in both trigger modes.

## Requirements and boundaries

- VS Code 1.99 or later, with a trusted local workspace or a remote extension host that has the .NET CLI.
- .NET SDK 10 or later; test projects must target .NET 10 or later and enable MTP. Referenced production libraries may target compatible earlier frameworks.
- An MTP test framework that supports the standard discovery and execution server protocol. The integration fixture uses MSTest 4.3.3 / MTP 2.3.3.
- Portable debug symbols for source mapping and coverage. A missing source location causes conservative selection.

Testy does not migrate VSTest projects or edit their package references. A project using VSTest gets an actionable setup error. If your workspace uses a `global.json`, it must select a supported SDK. Microsoft documents [MTP setup](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-intro) and the [.NET 10 CLI integration](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test-mtp).

## Development

```sh
npm ci
npm test
npm run test:integration
npm run test:extension
npm run package
```

Compilation builds both TypeScript and the bundled, platform-independent .NET source analyzer. Integration tests copy the sample workspace into a temporary directory, build it, modify its source, and assert the selected test identities, failure results, retained coverage, constant-change fallback, and cancellation. Set `TESTY_COVERAGE_TOOL` to an existing collector executable to reuse it in tests. The extension-host suite downloads an isolated VS Code build and exercises the actual save, pause/resume, and refresh flows. Set `TESTY_VSCODE_PATH` to use an existing VS Code executable instead.
