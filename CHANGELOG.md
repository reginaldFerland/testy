# Changelog

## 1.1.0

- Run independent project discovery, source analysis, and test files concurrently with configurable worker limits.
- Batch compatible MSBuild roots so shared dependencies are built once, while preserving output and reference-context isolation.
- Preserve stable test identities, checkpoint completed parallel work safely, and drain workers during cancellation.
- Add deep dependency-graph benchmarks and concurrency regressions.

## 1.0.0

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
