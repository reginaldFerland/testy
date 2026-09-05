# Fourth review remediation

The eight confirmed findings from the review of `72148d5` are addressed. The two confirmed behavior decisions remain: discover tests only in opened workspace folders, and stop the batch when a build fails.

| Finding | Change and regression evidence |
| --- | --- |
| Stale manual project graphs | Retain whole evaluation snapshots by workspace entry point. Replace selected snapshots and refresh overlapping roots together, so old transitive edges cannot be merged back. Remove deleted roots. Unit coverage preserves unrelated scopes; real MTP regressions delete a test project and reverse a valid dependency relationship. |
| Exclusions lost during runtime fallback | Carry explicit excluded IDs into the runner. Exclude their native nodes from file expansion. Reject runtime or changed exclusions that cannot be honored before executing tests. Controlled runner tests cover both paths. |
| Contextual binary producers | Keep individual evaluated producer contexts as well as merged source ownership. Index every assembly output, build required binary producers in order, and pass their evaluated global properties to MSBuild. A real fixture verifies clean outputs and a subsequent edit with stale outputs. |
| Repeated watcher work | Return before reading input paths in save mode. Cache filesystem plans using a version that changes only when evaluated input paths change. Tests verify unchanged discovery does not read paths or recreate watchers, while changed inputs rebuild the plan. |
| Dense coverage checkpoints | Pack geometry/hits and aggregate in bounded, cancellable chunks. Stage replacement before committing it. Reuse canonical geometry and serialize JSON in bounded native batches to an atomic temporary file. Tests cover a single large file, host timer progress, cancellation during packing and writing, cache round trips, and concurrent editor summary reads. |
| Startup cache failure | Treat non-cancellation restoration errors as optional-cache failures, log the problem, and schedule a fresh baseline. Keep cancellation authoritative and preserve existing cache files. Tests cover a damaged epoch path and startup scheduling after a simulated worker failure. |
| Detached POSIX descendants | Combine immediate process-group signalling with an inherited per-process ownership nonce. Scan and terminate matching detached/reparented children before releasing the run. Tests cover completion, cancellation and an unrelated process that must survive. Windows retains its Job Object implementation. |
| Duplicate output and context updates | Separate retained MTP result snapshots from output publication. Buffer output until a terminal result and publish it once; preserve distinct row/retry output. Send pause context commands only when their value changes. Tests exercise actual transport and UI publication. |

POSIX cleanup follows inherited ownership. A program that deliberately strips its environment and detaches, or delegates work to an external service, must manage that work itself. This boundary is documented in the README. Process environments inspected for the nonce are not logged or persisted.

## Validation

On macOS arm64, .NET SDK 10.0.400, Node 22.23.1 and dotnet-coverage 18.1.0:

- Compilation of TypeScript and both .NET helpers, ESLint, and all **67 unit tests** pass.
- All **27 real MTP integration tests** pass, including the three new project-graph regressions.
- Both actual VS Code host scenarios pass from source and from the extracted VSIX.
- Packaging succeeds; all **62 packaged JavaScript/helper files** match the compiled working tree.
- `git diff --check` passes.

All 67 unit tests also pass in an isolated Linux arm64 Node 22.23 Alpine container using the final compiled runtime files and packaged JavaScript dependencies. This includes actual detached-child cleanup and the Node MTP protocol peer. Linux uses `/proc` to identify owned processes; macOS uses its native `ps`. The real .NET integration suite was not rerun on Linux for this revision.

Native Windows has not been run locally. The repository CI matrix includes Windows.

## Responsiveness

`node test/performance/checkpoints.cjs` exercises an already populated store/cache over 100 source files, with all reported lines covered. Times exclude XML parsing, .NET execution, editor rendering and IPC. A 5 ms timer measures host responsiveness while replacement, aggregation and persistence execute.

| Positive lines | Replacement | Aggregation | Save including I/O | Largest timer gap |
| --- | ---: | ---: | ---: | ---: |
| 100,000 | 8.0 ms | 14.9 ms | 9.2 ms | 7.2 ms |
| 500,000 | 28.7 ms | 46.3 ms | 30.5 ms | 6.5 ms |
| 1,000,000 | 56.5 ms | 78.9 ms | 55.4 ms | 5.8 ms |

The review's million-line probe measured a 142.1 ms timer gap and an 89.8 ms save. These are local synthetic measurements, not a latency guarantee. Chunking mainly improves interruptibility; the total cost of processing a large report remains proportional to its data.

Repeated unchanged save-mode watcher calls now avoid all path reads. The controlled 50,000-file probe fell from roughly 830 ms per call to below 0.01 ms; it excludes filesystem and VS Code IPC work. Twenty thousand identical status updates now issue one pause-context command instead of twenty thousand.
