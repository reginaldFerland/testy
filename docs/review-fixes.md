# Review remediation

Scope: all findings from the review of `eba23e5`, including lifecycle issues and the stated validation gaps. Completion requires targeted regressions, scale measurements, integration tests, and a packaged-extension smoke test.

- [x] Preserve failed data rows and explicit retry semantics; reconcile MTP exit codes.
- [x] Conservatively handle code excluded from instrumentation, including aliases and hidden regions.
- [x] Honor runtime and binary-reference dependencies in selection and build planning.
- [x] Complete skipped/initialization-failing files without aborting the rest of the suite.
- [x] Version retained contributions by test/dependency inputs and expose stale coverage.
- [x] Preserve valid impact information across manual runs without coverage.
- [x] Expand directory rename/delete events in save mode.
- [x] Store sparse contributions, cache aggregates, and avoid global work on keystrokes/results.
- [x] Index ownership/dependencies; consolidate hashing and support cancellation.
- [x] Reuse safe output preparation, restrict instrumentation, and batch unattributed runs.
- [x] Checkpoint completed baseline files and resume across cancellation.
- [x] Update workspace roots and validate each project's SDK context.
- [x] Preserve and rerun runtime-only test identities.
- [x] Build the analyzer in the F5 task chain.
- [x] Cover retries, multi-target/linked-source graphs, initialization failure, cache corruption/concurrent windows, collector setup cancellation, symlinks, and process teardown.
- [x] Verify representative MTP frameworks/platform paths and realistic scale; record exact limits of evidence.
- [x] Rebuild and smoke-test the final VSIX; update documentation and validation evidence.

Validation: 34 unit tests, 12 real .NET integration tests, macOS and Linux arm64 execution, three MTP frameworks, a 1,200-case generated suite, synthetic coverage/ownership measurements, and a VSIX host smoke test. See [exact evidence and limits](1.0-validation.md). Native Windows is covered by the added CI matrix but has not been run locally; its taskkill coordination path is unit-tested with controlled processes.
