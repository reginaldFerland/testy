# Review remediation at ca03044

The September 5 full review identified ten behavior defects and five performance/scaling issues. The implementation addresses those findings while preserving the initial full baseline, affected-file execution, retained coverage, immediate cancellation and debounced restart, .NET 10+/MTP, and manual execution.

## Behavior

- [x] **Partial coverage exclusions:** the analyzer returns incremental syntax records; exclusion resolution uses each project's source context. A type or partial-member attribute in another declaration makes the affected body conservative. Ordinary partial types retain narrow selection. Analyzer cases cover namespaces, generics, nested types and project isolation; a real mixed-file regression now finds the previously missed failing test.
- [x] **xUnit selected runs:** discovery and execution share a stable private path within each engine, with isolated paths across engines. Exact provider IDs remain stable even when row names collide. The hang was traced to Unicode JSON request framing; escaping Unicode on the wire preserves values and lets selected Unicode/long-name cases complete. Full projects use unfiltered requests. Unresolved runtime/ambiguous identities expand to freshly discovered containing-file nodes; they never submit guessed IDs. Real xUnit tests cover colliding names, Unicode, passing/failing individual reruns, and deferred rows sharing an ID. A controlled runner test covers providers that emit separate runtime-only IDs. Timeouts and early exits now preserve their process diagnostics.
- [x] **Manual subset coverage:** only complete projects replace project aggregates. Manual file subsets collect separate contributions and retain the unselected aggregate as explicitly stale history. Matching hashes cannot refresh superseded history. Interrupted all-to-affected learning keeps this history until every file contribution is collected. Both paths have real integration regressions.
- [x] **Checkpoint cancellation:** cache locking and I/O receive the run's cancellation signal; aborted writes retain their delta for retry. A real engine checkpoint aborts while another writer still holds the lock, then resumes the remaining file and persists both contributions.
- [x] **External linked files:** filesystem watchers include evaluated source directories, deduplicate overlapping roots, reuse unchanged registrations, and dispose obsolete registrations. Host tests exercise actual external edits, rename/project updates, deletion/build failure, and recreation/recovery.
- [x] **Manual build scope:** only selected projects and required dependencies are built/evaluated for a manual request. Unrelated edits remain pending. A broken independent project no longer blocks a selected test file; the following automatic run still observes that pending error.
- [x] **Excluded required dependencies:** MSBuild builds a required reference that is absent from Testy's tracked graph. A clean-checkout regression succeeds with the production dependency excluded from discovery.
- [x] **Owned descendants:** POSIX process groups are cleaned on normal exit and cancellation. Windows uses a suspended-start Job Object owner, a cancellation/EOF control channel and kill-on-close; forced taskkill remains a fallback. Build commands can retain shared compiler servers. Tests cover normal and cancelled descendant cleanup, ignored/inherited output and argument round trips; controlled Windows transport tests check cancellation and waiting for fallback completion. A final Windows casing regression also verifies that normalized assembly identities still match mixed-case output filenames for instrumentation. Native Windows execution remains a CI validation requirement, not a locally verified result.
- [x] **Zero-hit freshness:** all geometry contributors participate in invalidation, including reports with no positive hits. Tests cover changed test inputs, refreshed contributions and restored stale caches.
- [x] **Unrelated outcomes:** saves preserve historical outcomes until the final selection is known; only selected outcomes are cleared/enqueued. The host regression retains all three results after a two-test affected rerun.

## Performance

- [x] **Coverage parsing:** one reusable worker per runner session parses XML and transfers compact line buffers. Materialization yields periodically; cancellation terminates parsing. A 150,000-line unit case checks progress and recovery after abort.
- [x] **Identity lookup:** preparation caches native-ID and metadata indexes once per project. Completeness checks use sets.
- [x] **Coverage publication:** stable line arrays and per-run publication state suppress unchanged FileCoverage allocations while sending each new run's initial snapshot.
- [x] **Output isolation:** one global eight-job copy pool bounds wide-tree concurrency. Restoration reuses its first scan and restats only repaired files. Mutation/deletion, symlink/cycle and bounded-copy tests pass.
- [x] **Cache geometry:** per-writer geometry memoization avoids rereading shared geometry on every checkpoint. An atomic epoch published before mutation invalidates other writers' memos, including after interruption. Tests cover repeated saves, concurrent geometry expansion, pruning and recreation.

Measured on macOS arm64, Node 22.23.1, .NET SDK 10.0.400, dotnet-coverage 18.1.0:

| Probe | Before | After |
| --- | ---: | ---: |
| 2.9 MB XML, 1,000 files × 100 lines | 171–205 ms synchronous parsing | 177–223 ms worker elapsed; largest observed 5 ms timer gap 5.8 ms |
| Cached private-ID selection, 50,000 cases / 100 files | 2.61 s | 25.6 ms |
| Unchanged 1,000-file output restore | About 20 ms | 9.5–10.4 ms |
| 100 unchanged callbacks / 5,000 coverage files | 500,000 publications | 5,000 publications |
| Real MTP baseline / affected 20 cases / all 1,200 cases | 23.0 / 2.5 / 6.2 s | 21.1 / 2.8 / 5.6 s |

Identity and publication probes invoke the actual methods with process/output or VS Code APIs mocked; publication timings exclude IPC. Worker timing measures event-loop responsiveness separately from parser throughput. The generated MTP workload contains short tests; the small affected-run difference is not evidence of improved latency. Its attribution cache is 451 KiB, with peak sampled Node heap/RSS of 23.6/127.8 MiB; child processes and worker heaps are outside the heap figure.

## Validation

- [x] Final checks: 48 unit cases and 21 real MTP integration cases passed on macOS arm64 and Linux arm64 (Linux ran its final added unit case separately). Both packaged VS Code host scenarios passed on macOS in 37 seconds. Packaging succeeded on both platforms; packaged JavaScript/helpers match the final compiled tree. TypeScript, both .NET helpers, ESLint and whitespace checks pass. Full scope, commands, measurements and native Windows limits are recorded in [validation evidence](1.0-validation.md).

Remaining product boundaries are explicit: source impact tracking cannot observe changes in external services, environment variables or unwatched data. Missing/ambiguous symbols retain conservative selection. Custom MSBuild graph metadata, network filesystems, native Windows locks/UNC paths and remote watcher delivery warrant representative compatibility testing beyond the local fixtures.
