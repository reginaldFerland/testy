# Performance review

Measurements below describe one Apple M5 machine with 10 logical CPUs and 16 GiB RAM. They distinguish measured component costs from estimates of possible savings. Overlapping stages and parallel worker durations must **not** be added together as expected wall-time improvements.

## Parallel instrumentation

The bundled collector now instruments independent workspace DLLs concurrently during initial preparation. Each target keeps one worker and borrows only immediately available project workers. Queued preparation keeps priority, private test-file workers retain their existing limit, and every admitted process drains before rollback or cancellation removes outputs. Custom collectors retain sequential instrumentation. See [runner.ts](../src/services/runner.ts), [engine.ts](../src/services/engine.ts) and [concurrency.ts](../src/core/concurrency.ts).

Controlled production comparisons against `a55138d` (two observations per variant):

| Fixture | Primary instrumentation, before → after | Preparing tests, before → after | First result, before → after |
| --- | --- | --- | --- |
| 120 test files / 2,400 cases | 1.068 → 0.574 s | 1.412 → 0.936 s | 3.960 → 3.309 s |
| 400 test files / 8,000 cases | 1.337 → 0.864 s | 1.775 → 1.314 s | 4.508 → 4.065 s |

The 400-file first result arrived **442 ms earlier (9.8%)**, with both current observations faster than either baseline. Initial Build midpoints were similar (798 → 808 ms). At 120 files, the 651 ms first-result difference also includes material Build variation (baseline samples 1,379/638 ms versus current 771/874 ms); the approximately 495 ms instrumentation reduction is the better estimate of the changed component.

There is no demonstrated whole-suite throughput gain. The 400-file initial totals were 45.009 → 44.905 s amid chronological Testing slowdown; unchanged repeat totals were 41.900 → 41.977 s. Warm templates required zero instrumentation in both variants, and repeat first-result timing actually increased by 145 ms in this small comparison. The intended benefit is preparation when a template must be created.

These are fresh Node children in ABBA order, with unchanged analyzer/collector bundles and only the engine, runner and semaphore scheduling changed between variants. The actual managed collector is pinned to 18.1.0. Source analysis shares the four-worker project budget: primary instrumentation peaked at four processes on the smaller fixture and three on the larger fixture as analysis released capacity. Private instrumentation peaked at eight and total owned processes at nine, consistent with the nine-file-worker limit. Exact test identities, results, coverage, dependencies, source facts, original DLL/PDB timestamps and cleanup assertions passed. This native validation ran on macOS; Windows/Linux collector concurrency still needs native execution coverage.

A separate 120-file ABBA comparison changed a declared copied text resource after the initial run. C# source bytes and DLL/PDB bytes and timestamps stayed unchanged, source analysis was reused, and all nine prepared templates missed as expected. Primary instrumentation fell **765 → 351 ms**, Preparing tests fell **1,092 → 717 ms**, and the first result arrived **276 ms earlier** (2.578 → 2.302 s). Both modes still ran 45 instrumentation commands. The whole operation was **13.759 → 14.253 s**, so this comparison also does not establish a throughput gain. Exact resource contents in built/acquired outputs, current trace input hashes, native results and coverage were verified. Cross-phase comparisons normalized only the one independently checked changed resource hash.

## Source-analysis reuse

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
| 1 | Reuse unchanged coverage decorations | **Measured avoidable submissions:** 621 identical `setDecorations` calls consumed 62.7 ms in one real-editor warm run. **Estimate: 40–70 ms of host work** for this fixture; whole-run/renderer benefit unmeasured. |
| 2 | Retain a validated SDK-support verdict | **Estimate: 30–60 ms per unchanged full refresh.** An earlier controlled comparison measured 64–68 ms for the repeated SDK check; validation overhead reduces the available saving. |
| 3 | Specialize initial coverage-index restoration | **Estimate: 20–70 ms** on the 400-trace / 2,001-source fixture. Its approximately 226–227 ms store-installation cost is a component ceiling, not a predicted saving. |
| 4 | Preserve sparse coverage through ingestion | **Measured component saving: 21–32 ms** per modeled 120-report batch; **estimated whole-run opportunity: 0–30 ms**. More promising for fewer temporary allocations than startup latency. |
| 5 | Adapt project workers to wider graphs | **Unmeasured.** No demonstrated gain from raising the project limit on Core → App → Infra → Web → one test project. Test independent roots before changing the automatic policy. |

### 1. Coverage presentation

[extension.ts:375](../src/extension.ts#L375) scans all summaries on every coverage event, even though it already avoids unchanged `addCoverage` calls by line-array identity. [extension.ts:421](../src/extension.ts#L421) rebuilds a file lookup and visible-line decoration objects. Decoration scheduling already coalesces events for 50 ms.

Cache presentation using immutable summary identity, the active test run and the production-source inventory. Decoration reuse also needs document version, dirty state, configuration and freshness. New test runs must still receive coverage. Measure actual `publishCoverage`, `decorate`, `addCoverage` and `setDecorations` calls and event-loop delays in VS Code. For context, the latest pre-change headless warm runs spent only about 0.69 ms across 123 engine publications at 120 files and 2.45–2.64 ms across 403 at 400 files; these totals exclude UI callbacks.

A real VS Code extension-host diagnostic now confirms repeated work. The 120-file / 2,400-case fixture opened three source editors, including one file with 401 executable lines. Its unchanged full run made 123 publication calls (18.4 ms synchronous elapsed time), 69 decoration passes (82.1 ms async elapsed total), and **621 decoration submissions, all identical to each editor's previous payload**. Those API calls consumed 62.7 ms of synchronous elapsed time. The diagnostic's payload hashing added another 7.1 ms inside decoration timing, so it must not be counted as production work or added to nested timings.

Skipping unchanged submissions is a concrete next implementation candidate: allow roughly 40–70 ms less extension-host work in this fixture after cache checks, with an estimated 0–70 ms whole-run opportunity (under 0.5% of its 14.65 s warm run). This is an estimate from one instrumented host, not a before/after benchmark or CPU attribution from async timings. Inspector samples independently attributed about 45 ms to the real `setDecorations` implementation. Renderer paint and user-visible responsiveness were not measured; the largest warm decoration pass was only 1.75 ms. The initial run made 630 submissions, 626 identical; dirty-edit, revert and hide/show controls verified that genuinely changed payloads still reached the real API. Native identities, coverage and dependencies matched across full runs, the warm run performed zero instrumentation, and UI-only controls launched no native work. Larger files/more editors may increase the opportunity, but need measurement.

### 2. SDK checks

[engine.ts:260](../src/services/engine.ts#L260) clears the successful SDK verdict on a new baseline; [engine.ts:711](../src/services/engine.ts#L711) subsequently runs `dotnet --version`. Reuse must validate command resolution, environment, `global.json` and installed SDK inventories. Failed checks must remain retryable. Ordinary warm manual runs often already retain this verdict, so they offer little additional opportunity.

### 3. Coverage restoration

[coverage.ts:182](../src/core/coverage.ts#L182) installs a restored snapshot into a fresh store through machinery that also supports replacement. A specialized initial-load path may reduce temporary membership collections while preserving duplicate-group semantics, zero-hit ownership, historical versions, dependencies, cancellation and atomic installation. Keep the compact [maintenance fingerprints](../src/services/cache.ts#L136) unless measurements justify a memory tradeoff. Benchmark populated restoration separately from test execution and report retained memory as well as first coverage availability.

### 4. Sparse coverage ingestion

[coverageReader.ts](../src/services/coverageReader.ts) recreates an object for every reported line from the worker's numeric response. [coverage.ts](../src/core/coverage.ts) immediately packs those objects into shared numeric geometry plus positive hits. Keeping geometry numeric through this boundary can avoid temporary objects for zero-hit lines while preserving complete uncovered-line information.

An isolated prototype with 120 reports, 601 source records and 20 lines per record saved 21–32 ms of decoding plus actual store packing across 0%, approximately 1%, approximately 10% and 100% hit densities. At approximately 1% hits it constructed about 99% fewer line objects. This excludes XML parsing, transfer and test execution, and uses generated report geometry. It does not establish a whole-extension memory saving; at 100% hits the separate geometry array increased one retained-response heap observation. Budget 0–30 ms of direct full-run opportunity for that modeled geometry, with overlap capable of hiding it. Do not extrapolate linearly to 400 files.

The integration must preserve source hashes, zero-hit ownership, runtime-observed dependencies, dense public adapters, cancellation and atomic durable deltas. The first native result precedes coverage ingestion, so measure committed coverage and subsequent file admission instead.

### 5. Wider project budgets

[concurrency.ts:4](../src/core/concurrency.ts#L4) caps automatic project workers at four; [test-file workers](../src/core/concurrency.ts#L9) already default to available CPUs minus one. Explicit limits exist for both. [engine.ts:361](../src/services/engine.ts#L361) shares the configured MSBuild budget across compatible contexts, and [projects.ts:198](../src/services/projects.ts#L198) already batches compatible build roots.

Compare project limits of four and eight on eight or more independent test roots, holding file workers fixed. Measure first result, wall time, child CPU, memory and cancellation. Preserve SDK-context ordering and output-conflict waves. More cores cannot shorten a dependency chain without independent work, and nested workers must not multiply the configured budget.

## Larger experiments

**Retain instrumentation across eligible resource-only changes.** The resource comparison above exposes a useful targeted cache opportunity: changing a copied text file triggers all 45 DLL instrumentation commands despite unchanged binaries and symbols. After the current parallelization, primary instrumentation still costs about **350 ms**, and each of eight private lanes spends about **1.4 s** instrumenting. Those are component ceilings, not a predicted speedup; the private lanes overlap. This merits a prototype before broader concurrency changes.

The safe unit of reuse is the same exclusively owned target/lane, preserving its collector session and exact paths. Validate the complete preparation context and original assembly, symbol, runtime/dependency inputs and all collector-modified sidecars. Stage new copied resources from pristine inputs with the validated instrumentation changes, then atomically refresh the template and `PreparedOutput` repair state. Fresh discovery and current resource dependencies remain required. A text extension or CopyToOutputDirectory declaration alone does not prove that an arbitrary collector ignores the payload; initially prove eligibility for the pinned collector and fall back on uncertainty. Validate additions/deletions, mode changes, dynamic discovery that reads the resource, tool/symbol changes, tampering, cancellation and restart adoption before estimating elapsed gains.

Fresh test-host startup is a possible larger opportunity, but its removable cost has not been isolated from test execution and collector work. If measurement identified 100–200 ms removable per file, 120 files across nine lanes would imply roughly 1.3–2.7 seconds of lane capacity. This is conditional arithmetic, not a forecast. [MTP requests](../src/services/mtp.ts#L24) currently use fresh processes; retaining a host would also retain static state, fixtures and background threads. A prototype must preserve process isolation or explicitly change that contract, and preserve per-file coverage attribution.

Build already benefits from incremental `bin/obj` outputs and shared root builds. Skipping authoritative Build or Restore would risk stale binaries and generated inputs. Likewise, sharing cached [output manifests](../src/services/preparedOutputCache.ts#L233) across lanes needs a validated immutable build snapshot; timestamps alone cannot establish identical contents. Profile those repeated reads before adding another cache.

Persistent project-evaluation cache hit rates also need measurement across actual editor restarts. Its [context](../src/services/engine.ts#L270) includes the complete environment; earlier real launches differed in `SHLVL` and `VSCODE_PID`. Same-process restart timings do not prove reuse across those launches. Safely narrowing this key needs evidence of which environment inputs evaluation used, since MSBuild can read arbitrary environment properties.

Source-analysis reuse has a separate Windows eligibility issue: [analysisContext.ts](../src/services/analysisContext.ts) reads `PATH`/`PATHEXT` from a plain environment object, which can contain `Path` instead. That safely falls back to fresh analysis, but misses reuse. Matching actual Windows command resolution could recover the existing analysis saving; no Windows timing is established. CLR override environments, including `DOTNET_ROOT`, currently decline reuse intentionally and need a validated hosting model before broadening support.

## Methodology and validation

Validation passed: `npm test` (build, lint and 316 unit tests) and `node --test test/integration/*.test.cjs` (113 integration tests, including three new managed-instrumentation cases). The six provenance unit cases also passed after fixture portability fixes. Both controlled analysis comparisons, all three production instrumentation comparisons and the real-editor diagnostic passed their correctness and cleanup assertions. The full integration suite completed in 513 seconds with no failures, skips or cancellations on macOS.

The controlled workflows derive their Core → App → Infra → Web fixtures from the tracked [performance benchmark](../test/performance/benchmark.cjs), using MSTest, .NET 10, coverage enabled, four project workers and nine file workers. Both production comparisons use 120/400 files with 20 cases per file; the copied-resource comparison uses 120. Collector installation is outside controlled timing, and Build/Restore/discovery are inside. Variant source hashes, including the cache worker's semaphore module, are checked throughout. The real-editor profile uses the current implementation with three visible editors and an additional 400 zero-hit executable lines in a shared file. Its isolated copied artifact records inspector profiles and decoration counters without changing repository production code.

All valid timed trials are retained without outlier removal or timing thresholds. Comparisons verify exact native IDs, results, source shapes where applicable, coverage geometry and dependencies, unchanged build-output timestamps, and process/cache-owner cleanup. Process-tree memory is sampled; two trials per variant do not establish a confidence interval. An earlier instrumentation diagnostic failed during its serial control because its manually constructed macOS paths were not canonical; it was corrected before the reported comparison.

Tracked correctness coverage includes [real managed-instrumentation integration tests](../test/integration/instrumentationBudget.test.cjs), [runner scheduling and rollback tests](../test/unit/runnerInstrumentation.test.cjs), [semaphore borrowing tests](../test/unit/semaphoreBorrow.test.cjs), [source-analysis integration tests](../test/integration/sourceAnalysisReuse.test.cjs), [provenance and tool-context unit tests](../test/unit/sourceAnalysisProvenance.test.cjs), [coverage reuse tests](../test/unit/coverageReuse.test.cjs), [cache maintenance tests](../test/unit/cacheMaintenance.test.cjs) and [concurrency tests](../test/unit/concurrency.test.cjs).
