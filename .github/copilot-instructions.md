# Copilot instructions

Testy is a VS Code extension that runs affected C# tests through Microsoft.Testing.Platform (MTP) and retains per-test-file coverage. Match the existing code rather than general style guides.

## Layout
- `src/core`: VS Code-independent logic (selection, scheduling, coverage aggregation, concurrency). Keep it free of `vscode` imports so it can be unit tested in Node.
- `src/services`: process, MSBuild, MTP, cache and runner orchestration. `engine.ts` owns run lifecycles.
- VS Code integration layer: `src/extension.ts` (activate/deactivate), `src/controller.ts` (the `Testy` class: commands, runs, wiring) and `src/ui/*` (testTree, coverage, statusBar).
- `backend/`: .NET 10 helpers (Roslyn/MSBuild analyzer, Windows process host, runtime-observer startup hook). They are bundled into `dist/` by `npm run compile`.

## Conventions
- Correctness first: when information is incomplete, fall back to conservative selection (whole project) instead of guessing.
- Thread `AbortSignal` through every asynchronous operation and kill process trees on cancellation.
- Never mutate the user's build outputs or workspace settings; work in private copies and extension storage.
- Bounded caches only; validate identities before reusing anything persisted.
- Keep the existing compact style: classes for stateful services, small pure helpers in `core`.
- Avoid floating promises; use `void` only for deliberate fire-and-forget calls with their own error handling.

## Tests
- Tests are Node `node:test` files in `test/unit` and `test/integration` that `require` the compiled `out/` modules. Run `npm test` (compiles first) and `npm run test:integration`. Unit tests load the UI modules through `test/unit/support/ui.cjs`.
- Add a regression test for every bug fix, named by topic rather than by review round.
- No CI: run `npm test`, `npm run test:integration` and `npm run test:extension` locally before merging.
