# Fifth review remediation

The six confirmed findings are addressed. Tests remain limited to opened workspace folders, and a build failure still stops the entire batch.

| Finding | Change and regression evidence |
| --- | --- |
| Missed callers under source mapping | The analyzer retains bodies for files containing ordinary or enhanced `#line` directives. Such edits use conservative project selection. Analyzer cases cover both mapping forms; a real MTP case mixes mapped and ordinary methods in one physical file and confirms the affected run finds the previously omitted failing caller. |
| Generated-header cancellation loops | Save events, disk events and source tracking share a classifier over the first 2,048 UTF-8 bytes. Generated outputs have no tracked content hash; build-time header transitions also remove their old hashes from attribution. Unit cases cover rewrites, creation, deletion, header removal and Unicode prefixes. A real build adds a header to a placeholder, rewrites it on subsequent baselines, and still responds to changes in its declared generator data. |
| False contextual project cycles | SDK graph nodes carry stable identities derived from file paths and global properties, plus exact context edges. Build ordering uses these nodes while impact ownership retains file unions. Root selection avoids redundant default builds that could disturb alternate binary outputs. Real tests cover A → B → A in distinct valid contexts, alternate assembly producers, AdditionalProperties, and multiple target frameworks; a unit case still rejects an actual context cycle. |
| Unchanged manual graph fan-out | Refreshed snapshots are compared by evaluated content, independent of serialization order. Other roots refresh only when shared graph information changes. Existing removal/reversed-edge regressions remain, and an unchanged leaf request now evaluates only its selected root. |
| Synchronous editor aggregation | Decoration work awaits cancellable asynchronous summaries, coalesces pending editors, and stops on extension disposal. The regression invokes the actual editor method during shared-file aggregation, verifies timer progress and correct stale markers, forbids synchronous summary reads, and checks disposal prevents late writes. |
| Test processes surviving host failure | An independent POSIX supervisor owns the target process group, handles cancellation and host-control-pipe EOF, and scans inherited ownership markers for detached descendants. It uses the extension host's runtime, including VS Code's Node mode. Tests kill a separate host with SIGKILL, verify its child and detached grandchild exit, and verify an unrelated process survives. Existing normal completion, cancellation, timeout and argument-preservation tests remain. |

POSIX ownership follows the inherited marker. Programs that deliberately strip it and detach, or delegate work to external services, must manage that work themselves. Normal successful builds may retain shared compiler servers. Process environments inspected during cleanup are neither logged nor persisted.

## Validation

On macOS arm64 with .NET SDK 10.0.400, Node 22.23.1 and dotnet-coverage 18.1.0:

- TypeScript, both .NET helper builds, ESLint and **75/75 unit tests** pass.
- **31/31 real MTP integration tests** pass, including the four new real-project regressions (173.5 seconds in the final rerun).
- Both source-host scenarios passed. The final extracted VSIX also passes both actual VS Code host scenarios.
- The VSIX contains 235 files (13.24 MB); all **63 packaged runtime files** match the compiled working tree, including the new supervisor.
- **75/75 unit tests** also pass in a Linux arm64 Node 22.23 Alpine container with an init process. This includes real host-death, detached-child, cancellation and protocol-peer execution. The .NET integration suite was not rerun on Linux for this revision.
- `git diff --check` passes. No commit was made.

The full integration run exposed an extra default-context build that disturbed a contextual binary producer. Root selection was corrected; its focused regressions and the subsequent complete integration suite pass. More validation detail is in [1.0 validation](1.0-validation.md). Native Windows execution remains unavailable locally; its existing owner implementation and CI coverage remain in place.

## Performance evidence

An unchanged manual leaf run after a baseline in an eight-test-project workspace now performs **one graph evaluation**, down from nine. The local real MTP probe took **1.08 seconds**, compared with **2.84 seconds** in the review, and executed exactly one selected test. Times include CLI work and exclude editor debounce.

`node test/performance/editor.cjs` invokes the actual decoration method with mocked VS Code APIs while real coverage aggregation is already in progress. It uses one 1,000-line file with 1,000, 5,000 and 10,000 contributing test files. In the final remediation probe, the immediate editor call took **0.35–0.59 ms**, compared with **31.5–237.5 ms** in the review; the largest observed 1 ms timer gap was **1.46 ms**. All 1,000 stale markers were published. Aggregation still does the necessary work asynchronously; these numbers exclude rendering and IPC and are not a latency guarantee.

The independent supervisor adds a runtime launch to each POSIX command. After the other validation jobs finished, the existing four-project / 60-test-file / 1,200-case benchmark measured **25.63 s** for its initial baseline, **3.33 s** for the **20 affected cases**, and **6.72 s** for run-all. The previous recorded workload measured 23.0 s, 3.0 s and 6.1 s respectively. The current result includes all analysis, build, MTP and ownership work. The cache was **1.16 MiB**; sampled main Node heap/RSS peaked at **24.2/140.1 MiB**, excluding separate supervisors and .NET processes. Large Test Explorer tree reconstruction and retained graph/coverage memory remain profiling opportunities outside these six fixes.
