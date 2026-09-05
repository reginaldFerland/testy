# Local development

1. Run `npm ci` with Node 22 and .NET SDK 10 or later installed.
2. Open this repository in VS Code and press F5. The launch task builds the analyzer and starts the TypeScript watcher.
3. Open `test/fixtures/ImpactDemo` in the Extension Development Host and trust the workspace.
4. Wait for the baseline, edit `ImpactDemo/Arithmetic.cs`, and save. Check Test Explorer, coverage gutters, and **Testy: Show Output**.
5. Restart the debug session after changing the .NET helper. TypeScript changes compile automatically; reload the host to activate them.

Run `npm test`, `npm run test:integration`, and `npm run test:extension` for automated checks. Use `TESTY_COVERAGE_TOOL` to reuse an installed collector, and `TESTY_VSCODE_PATH` to reuse VS Code.

Run `npm run package`, then **Extensions: Install from VSIX…** to test the local installable package. Nothing is published by packaging or installing a VSIX.
