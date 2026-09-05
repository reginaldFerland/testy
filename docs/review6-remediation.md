# Sixth review remediation

Reviewed behavior, affected-test correctness, cancellation, coverage retention, input tracking, process/output ownership, startup restoration, and performance against commit `260a703`. Six confirmed findings are addressed by this revision. The two agreed behavior decisions remain: test discovery is limited to opened workspace folders, and any build failure stops the entire batch.

## Findings and changes

| Priority | Finding | Result |
| --- | --- | --- |
| P1 | Frameworks sharing a TargetPath could execute the final binary twice and miss a failure. | Shared output directories are detected in linear time. Each affected test target is copied immediately after its build. Preparation, portable-symbol lookup, batching and coverage aggregates retain project/framework identity. All builds still finish before tests start. |
| P1 | Commented, Unicode and generated-file global exclusion aliases could omit affected callers. | Roslyn parses aliases, including comments, identifier escapes, attribute suffixes and conditional branches. Evaluated Compile inputs remain available for alias analysis even when ignored for change tracking. An alias-set change refreshes declaration analysis. |
| P2 | User-excluded sources still participated in hashing and could repeatedly cancel their own baseline. | Configured exclusions apply to tracked source/build-input hashes and freshness checks. Required excluded project dependencies still build. |
| P2 | Dense source membership blocked the extension host during cache restoration. | Worker transfer uses numeric membership buffers; conversion, staged index installation and pruning yield in chunks. Cancellation publishes no partial state. Changes during lock waits, parsing or installation take precedence over restored history. Restoring no longer constructs a discarded full delta. |
| P2 | A host crash permanently left its private run outputs behind. | UUID output directories carry process ownership metadata published before output creation. Startup and run preparation reclaim dead owners. Normal completion and cancellation dispose the lease, including per-target snapshots. |
| P2 | Deleting a header-marked generated file triggered automation. | Source tracking retains deleted-file classification. Event handling remembers observed headers through creation, rename and deletion before another baseline; recreating an ordinary file permits testing again. |

## Validation

September 5, 2026, macOS arm64, Node 22.23.1, .NET SDK 10.0.400 and dotnet-coverage 18.1.0:

- `npm test`: TypeScript, both .NET helpers, ESLint and **78/78 unit tests pass**.
- **38 integration tests pass**: the full 37-test run completed in 217.6 seconds, then the newly added real host-crash regression passed separately in 6.5 seconds. The shared-output regression exercises affected mode, run-all mode and disabled coverage; each reports six tests, five passing and the one framework-specific failure. All three global-alias regressions select the failing caller. Repeated excluded timestamp builds complete without invalidation.
- **78/78 unit tests pass on Linux arm64**, Node 22.23.2, in a container with an init process. This includes crash cleanup, concurrent ownership, restoration cancellation and generated-file events.
- Both actual VS Code source-host scenarios pass, including startup, saves, selection, retained coverage, pause/resume, refresh, configuration changes, external linked sources, and observed generated-header rename/deletion.
- The final VSIX contains 236 files, 13.24 MB. All **64 packaged JavaScript/helper runtime files** match the compiled workspace. Both actual VS Code scenarios also pass against the extracted final package (43 seconds).
- `git diff --check` passes. Native Windows execution was not available locally; the existing Windows CI matrix remains necessary.

The real crash reproduction originally retained 224 files and 10,953,332 logical bytes after restart. With ownership metadata, the restarted baseline passes three tests and leaves **zero run-output files and bytes**. The committed regression exercises the engine and real MTP process; the unit test also proves that live owners and unmarked directories are preserved.

## Performance

`node test/performance/cache-membership.cjs` restores valid cache data for 1,000 test files, each with membership in 1,000 sources and one positive-hit source. The final measurement was taken after the other .NET/editor checks completed.

| Measurement | Reviewed version | Fixed version |
| --- | ---: | ---: |
| Source memberships | 1,000,000 | 1,000,000 |
| Total restore | 705.4 ms | 562.9 ms |
| Largest observed 1 ms timer gap | 311.4 ms | 3.2 ms |

These are local synthetic measurements of cache read, worker conversion, installation and pruning. They exclude cache creation, editor rendering, and .NET execution. Timer gaps describe this run, not a guaranteed latency ceiling. Chunking improves responsiveness but does not remove the memory required for source membership; staging temporarily holds both old and new state if a populated store is restored.

Unshared output directories keep the existing preparation path. Shared output directories require an additional private snapshot per target. Global alias parsing runs only when candidate source content changes; a changed alias set conservatively refreshes declaration shapes.

The existing responsiveness probe also passes against the final runtime. Parsing its 2.94 MB report in the worker took 181–227 ms, with maximum 5 ms timer gaps of 5.7–5.9 ms. Restoring 1,000 unchanged output files took 11.5–11.9 ms. Cached selection across 50,000 cases/100 files took 28.8 ms; that selection probe mocks MTP/output I/O. The mocked editor publication probe emitted 5,000 objects across 100 callbacks in 14.7 ms and excludes VS Code IPC.

## Remaining boundaries

The initial attribution baseline still launches a test/collector process per file. The fifth-review 1,200-case benchmark remains the latest end-to-end latency evidence; it was not rerun for this remediation. Large Test Explorer trees, shared project graphs and coverage membership remain useful production profiling targets.

Source-based selection cannot observe changed external services, databases, environment variables or unwatched data; these require a full refresh. Global alias discovery uses evaluated Compile inputs. Source-generator output that never appears as an evaluated input is outside that alias scan.

Output reclamation deliberately preserves unknown/unmarked legacy directories, invalid metadata, inaccessible process owners and reused live PIDs. This avoids deleting another window's files. It does not retroactively identify directories created without ownership metadata by older builds.

No release has been published as part of this remediation.
