# Third review remediation

The nine findings from the September 5 review are fixed. The implementation retains affected-file execution, cancellation after a superseding change, retained coverage, and manual execution.

| Finding | Change and regression evidence |
| --- | --- |
| Shared build inputs | The selected SDK evaluates imports, resources, content and additional files through an MSBuild graph task. Ownership is retained across property contexts and old/new graphs. Input versions participate in coverage freshness. The shared-import reproduction now finds the failing consumer; a shared resource also selects its consumer. Known inputs outside the usual extension pattern receive watchers. |
| Manual selection | File, project and workspace requests retain their scope until after discovery. Individual cases and explicit exclusions remain exact. Real integration tests add a failing method and a new test file while idle; both are discovered and executed by their selected containers. UI scope capture has a separate regression. |
| Reference properties | MSBuild builds project references in their own property contexts. The extension merges contextual ownership and assembly names and explicitly orders workspace binary producers. `AdditionalProperties` now yields the same three passing results as the CLI, and an external source included only in that context is tracked and selects two failures after an edit. |
| Incomplete runs | Missing or unfinished outcomes become errors. The batch throws before coverage publication or baseline checkpointing while retaining completed results. Runtime rows may replace one known discovered method; ambiguous replacements and unfinished sibling rows are rejected. Controlled transport tests and real MSTest/xUnit deferred cases pass. |
| Output permissions | Restore makes owned directories traversable, replaces changed read-only files and reapplies original directory permissions. Cleanup repairs inaccessible owned directories without following symlinks, including after cancellation or root replacement. Linux validation exposed same-size writes within one timestamp tick; a content comparison for the newest timestamp cohort now catches these without hashing every output file. A deterministic frozen-clock regression covers this path. |
| Discovery cancellation | The recursive project walk checks cancellation before and after directory reads and between entries. The original delayed-filesystem reproduction now stops after one read, about 14 ms after abort, instead of 21 reads and 454 ms. |
| Large cache entries | The reader accepts the same entries the writer produces, including a valid 22.9 MB / one-million-line trace. Restore retains its 100 source records. Unreadable records warn and suppress destructive orphan pruning. |
| Cache responsiveness | A worker parses, validates and canonicalizes cache records, hashing once per covered file rather than per line. Typed buffers transfer large numeric arrays; conversion yields in chunks. Cancellation terminates the worker and leaves the destination store untouched. Concurrent-writer and geometry-memo regressions still pass. |
| Live result classification | Each discovered file has an ID set. The real engine callback no longer scans its entire test array for each result. The benchmark throws if this scan returns and verifies that discovered results do not become runtime-only nodes. |

## Validation

- TypeScript, both .NET helper builds and ESLint pass.
- 56 unit tests and 24 real MTP integration tests pass on macOS arm64, .NET 10.0.400 / Node 22.23.1 / dotnet-coverage 18.1.0. The final completeness tightening also passes the targeted MSTest and xUnit deferred-theory integrations.
- Both VS Code host scenarios pass from the workspace and the extracted VSIX. The package contains both workers and both .NET helpers; 59 compiled files match the working tree byte for byte. The final output-restoration change is also checked in the rebuilt VSIX.
- The same 56 unit and 24 integration tests pass on Linux arm64 with a separate npm installation and .NET 10.0.400 SDK container. Linux packaging also passes.
- Native Windows execution remains unverified locally; the repository's platform CI matrix must provide that evidence.

## Measurements

`node test/performance/cache-and-results.cjs` exercises actual cache persistence and restore; its result-callback probe uses the real engine with runner/process I/O mocked and excludes UI rendering.

| Workload | Previous review | After fix |
| --- | ---: | ---: |
| 500,000 positive lines / 1,000 files: restore | 282 ms | 222 ms |
| Same cache: largest 5 ms timer gap | 253 ms | 6.3 ms |
| Same cache: main-thread SHA-256 calls | 503,000 | 1,000 |
| 1,000,000 positive lines / 1,000 files: restore | Not recorded | 317 ms; 6.0 ms maximum timer gap |
| Live classification, 20,000 cases in one file | 342 ms | 2.3 ms |

The large valid cache regression additionally verifies timer progress, intact geometry, and cancellation before publication. The final 1,200-case workload measured 23.0 s for baseline learning, 3.0 s for 20 affected cases and 6.1 s for a batched full refresh. Tracking evaluated build inputs increases the retained cache to about 1.16 MiB. After the timestamp/permission repair, the 1,000-file unchanged-output probe measured 18–21 ms during concurrent validation. These are measured development workloads, not latency guarantees for arbitrary repositories.

Reproduce with `npm test`, `npm run test:integration`, `node test/performance/cache-and-results.cjs`, `npm run benchmark`, and `npm run package`. The editor and packaged-host commands are documented in [1.0 validation](1.0-validation.md).
