# Performance review

Measurements below describe one Apple M5 machine with 10 logical CPUs and 16 GiB RAM. They distinguish measured component costs from estimates of possible savings. Overlapping stages and parallel worker durations must **not** be added together as expected wall-time improvements.

## Source-analysis reuse in this change

Unchanged full refreshes now reuse successful raw syntax records after validating their source bytes and tool/environment context. Build, Restore, fresh test discovery and project-specific exclusion resolution remain authoritative. Missing, invalid or uncertain records are analyzed again. See [engine.ts:393](../src/services/engine.ts#L393), [analysis.ts:50](../src/services/analysis.ts#L50) and [analysisContext.ts:12](../src/services/analysisContext.ts#L12).

Controlled workflow midpoint timings (two observations per variant):

| Fixture | Initial baseline, before → after | Unchanged full refresh, before → after | First result / analysis cost |
| --- | --- | --- | --- |
| 120 test files / 2,400 cases | 14.050 → 13.641 s | 11.023 → 11.055 s | Repeat first result: 1.817 → 1.779 s; analysis: 288 → 44.5 ms |
| 400 test files / 8,000 cases | 46.812 → 45.249 s | 43.460 → 42.585 s | Repeat first result: 2.564 → 2.227 s; analysis: 671 → 45 ms |

These comparisons use baseline `43f4792`, fresh Node children in ABBA order, and one initial plus one unchanged full baseline per child. They use identical recreated workspace, storage and analyzer paths, with checksums for both analyzer bundles. Runner and concurrency implementations stay at the baseline in both variants to isolate analysis reuse. This measures reuse within one engine, not actual editor restarts.

At 120 files, every current unchanged refresh started zero source-analysis helpers and retained exactly matching raw/resolved source facts. Validation took 43–46 ms. Most previous analysis already overlapped preparation, so the full-refresh result was effectively unchanged (+0.3%); do not infer a cold-start gain from the initial-run timing difference.

At 400 files, the unchanged-refresh first result arrived **337 ms earlier (13.1%)**, with both current observations faster than either baseline observation. Source-analysis helpers fell from one per refresh to zero, with matching test identities, results, coverage, dependencies and raw/resolved shapes. Whole-run throughput is inconclusive: the baseline repeats ranged from 41.128 to 45.791 s amid chronological slowdown, larger than the midpoint difference. The Testing phase, including coverage processing and commits, occupied 39–44 s of those repeats. Initial analysis gained validation overhead (625 → 703 ms) that overlapped preparation; this change targets reuse, not the first baseline.

There is no demonstrated memory or event-loop improvement. At 400 files, sampled repeat process-tree RSS midpoints were 2,632 → 2,754 MiB and maximum timer-gap midpoints were 170 → 174 ms. The 120-file equivalents were 2,200 → 2,227 MiB and 60 → 60 ms. These are small-sample observations, not retained-memory measurements.

## Remaining opportunities

| Priority | Candidate | Evidence and realistic opportunity |
| --- | --- | --- |
| 1 | Parallel DLL instrumentation during primary preparation | **Measured prototype:** cold target ready time **1.111 s → 0.594 s**, about **0.517 s saved**, with four available preparation slots. Not implemented in production. No benefit when the prepared template hits its cache. |
| 2 | Reuse unchanged coverage presentation and decorations | **Unmeasured UI cost.** Existing headless benchmarks do not exercise VS Code rendering. Profile actual extension-host responsiveness and allocations before predicting a wall-time gain. |
| 3 | Retain a validated SDK-support verdict | **Estimate: 30–60 ms per unchanged full refresh.** An earlier controlled comparison measured 64–68 ms for the repeated SDK check; validation overhead reduces the available saving. |
| 4 | Specialize initial coverage-index restoration | **Prior estimate: 20–70 ms** on the 400-trace / 2,001-source fixture. Its approximately 226–227 ms store-installation cost is a component ceiling, not a predicted saving. |
| 5 | Adapt project workers to wider graphs | **Unmeasured.** No demonstrated gain from raising the project limit on Core → App → Infra → Web → one test project. Test independent roots before changing the automatic policy. |

### 1. Parallel DLL instrumentation

[runner.ts:583](../src/services/runner.ts#L583) still instruments each workspace DLL sequentially. The isolated prototype prepared five DLLs with one collector session; instrumentation itself fell from about 0.876 s to 0.357 s. The target-ready measurement above includes preparation and discovery, excludes Build, and assumes spare capacity. It does not establish a 0.517-second whole-workflow saving when analysis or other targets occupy those slots.

Production adoption needs one worker using the target's existing permit, with extra workers borrowing only immediately available shared permits. Waiting for nested permits can deadlock. Private file lanes and deferred upgrades must not borrow unrelated project capacity and exceed the test-file limit. Every admitted process must drain before failed or cancelled preparation removes the template. The prototype checked exact native IDs, coverage and dependencies, repeated collection without bleed, one-slot progress, four simultaneous targets, released analysis capacity, waiter priority, failure rollback and cancellation. Shared-session safety was demonstrated with the pinned collector; custom collectors require separate validation.

### 2. Coverage presentation

[extension.ts:375](../src/extension.ts#L375) scans all summaries on every coverage event, even though it already avoids unchanged `addCoverage` calls by line-array identity. [extension.ts:421](../src/extension.ts#L421) rebuilds a file lookup and visible-line decoration objects. Decoration scheduling already coalesces events for 50 ms.

Cache presentation using immutable summary identity, the active test run and the production-source inventory. Decoration reuse also needs document version, dirty state, configuration and freshness. New test runs must still receive coverage. Measure actual `publishCoverage`, `decorate`, `addCoverage` and `setDecorations` calls and event-loop delays in VS Code. For context, the latest pre-change headless warm runs spent only about 0.69 ms across 123 engine publications at 120 files and 2.45–2.64 ms across 403 at 400 files; these totals exclude UI callbacks.

### 3. SDK checks

[engine.ts:260](../src/services/engine.ts#L260) clears the successful SDK verdict on a new baseline; [engine.ts:711](../src/services/engine.ts#L711) subsequently runs `dotnet --version`. Reuse must validate command resolution, environment, `global.json` and installed SDK inventories. Failed checks must remain retryable. Ordinary warm manual runs often already retain this verdict, so they offer little additional opportunity.

### 4. Coverage restoration

[coverage.ts:182](../src/core/coverage.ts#L182) installs a restored snapshot into a fresh store through machinery that also supports replacement. A specialized initial-load path may reduce temporary membership collections while preserving duplicate-group semantics, zero-hit ownership, historical versions, dependencies, cancellation and atomic installation. Keep the compact [maintenance fingerprints](../src/services/cache.ts#L136) unless measurements justify a memory tradeoff. Benchmark populated restoration separately from test execution and report retained memory as well as first coverage availability.

### 5. Wider project budgets

[concurrency.ts:4](../src/core/concurrency.ts#L4) caps automatic project workers at four; [test-file workers](../src/core/concurrency.ts#L9) already default to available CPUs minus one. Explicit limits exist for both. [engine.ts:361](../src/services/engine.ts#L361) shares the configured MSBuild budget across compatible contexts, and [projects.ts:198](../src/services/projects.ts#L198) already batches compatible build roots.

Compare project limits of four and eight on eight or more independent test roots, holding file workers fixed. Measure first result, wall time, child CPU, memory and cancellation. Preserve SDK-context ordering and output-conflict waves. More cores cannot shorten a dependency chain without independent work, and nested workers must not multiply the configured budget.

## Larger experiments

Fresh test-host startup is a possible larger opportunity, but its removable cost has not been isolated from test execution and collector work. If measurement identified 100–200 ms removable per file, 120 files across nine lanes would imply roughly 1.3–2.7 seconds of lane capacity. This is conditional arithmetic, not a forecast. [MTP requests](../src/services/mtp.ts#L24) currently use fresh processes; retaining a host would also retain static state, fixtures and background threads. A prototype must preserve process isolation or explicitly change that contract, and preserve per-file coverage attribution.

Build already benefits from incremental `bin/obj` outputs and shared root builds. Skipping authoritative Build or Restore would risk stale binaries and generated inputs. Likewise, sharing cached [output manifests](../src/services/preparedOutputCache.ts#L233) across lanes needs a validated immutable build snapshot; timestamps alone cannot establish identical contents. Profile those repeated reads before adding another cache.

Persistent project-evaluation cache hit rates also need measurement across actual editor restarts. Its [context](../src/services/engine.ts#L270) includes the complete environment; earlier real launches differed in `SHLVL` and `VSCODE_PID`. Same-process restart timings do not prove reuse across those launches. Safely narrowing this key needs evidence of which environment inputs evaluation used, since MSBuild can read arbitrary environment properties.

## Methodology and validation

Validation passed: `npm test` (build, lint and 298 unit tests) and `node --test test/integration/*.test.cjs` (110 integration tests, including the six new analysis-reuse cases). Both controlled analysis comparisons and the isolated instrumentation diagnostic passed their correctness and cleanup assertions.

The controlled workflows derive their Core → App → Infra → Web fixtures from the tracked [performance benchmark](../test/performance/benchmark.cjs), using MSTest, .NET 10, coverage enabled, four project workers and nine file workers. The analysis comparison uses 120/400 files with 20 cases per file. The instrumentation diagnostic uses 120 discoverable files with two cases each, then executes four selected files twice using fresh native processes. Its order is serial/parallel/parallel/serial with fresh templates at the same path. It excludes build/download work and uses the pinned `dotnet-coverage` 18.1.0 collector.

All valid timed trials are retained without outlier removal or timing thresholds. Comparisons verify exact native IDs, results, source shapes where applicable, coverage geometry and dependencies, unchanged build-output timestamps, and process/cache-owner cleanup. Process-tree memory is sampled; two trials per variant do not establish a confidence interval. An earlier instrumentation diagnostic failed during its serial control because its manually constructed macOS paths were not canonical; it was corrected before the reported comparison.

Tracked correctness coverage includes [source-analysis integration tests](../test/integration/sourceAnalysisReuse.test.cjs), [provenance and tool-context unit tests](../test/unit/sourceAnalysisProvenance.test.cjs), [coverage reuse tests](../test/unit/coverageReuse.test.cjs), [cache maintenance tests](../test/unit/cacheMaintenance.test.cjs) and [concurrency tests](../test/unit/concurrency.test.cjs). The diagnostic scheduling model is exploratory and is not a substitute for production runner integration tests.
