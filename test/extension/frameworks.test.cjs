// @ts-check
// The discovery and selection scenario on the xUnit and NUnit fixtures. The same
// file runs once per workspace (see .vscode-test.mjs); the workspace's test
// project tells which framework this run is for.
const { suite, suiteSetup, test } = require('./harness.cjs');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const path = require('node:path');
const { until, workspaceRoot, establishBaseline, activate } = require('./support.cjs');

suite('Testy on xUnit and NUnit projects in VS Code', () => {
    /** @type {() => any} */
    let snapshot = () => undefined;
    suiteSetup(async function () {
        this.timeout(300000);
        ({ snapshot } = await activate());
        await establishBaseline();
    });

    test('discovers both test files, runs every test with coverage and keeps theory rows distinct', async () => {
        assert.equal(snapshot().summary.tests, 3);
        assert.equal(snapshot().summary.passed, 3);
        assert.equal(snapshot().groups.length, 2);
        assert.equal(snapshot().summary.coverageAvailable, true);
        const names = snapshot().groups.map((/** @type {{file:string}} */group) => path.basename(group.file)).sort();
        assert.deepEqual(names, ['CalculatorTests.cs', 'GreetingTests.cs']);
        assert.match(snapshot().status, /3 passed/);
        const greeting = snapshot().coverage.find((/** @type {{file:string}} */entry) => entry.file.endsWith('/Greeting.cs'));
        assert.ok(greeting?.covered > 0);
        assert.equal(greeting.stale, false);
    });

    test('a save selects only the tests that cover the changed file', async () => {
        const file = vscode.Uri.joinPath(workspaceRoot(), 'ImpactDemo', 'Arithmetic.cs');
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document);
        const original = document.getText();
        const replace = async (/** @type {string} */text) => {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
            assert.equal(await vscode.workspace.applyEdit(edit), true);
            assert.equal(await document.save(), true);
        };
        try {
            await until(() => !snapshot().running && !/waiting/.test(snapshot().status), 'baseline to settle');
            let previous = snapshot().summary;
            await replace(original.replace('a + b', 'a + b + 1'));
            await until(() => snapshot().summary !== previous && !snapshot().running, 'affected failing run');
            assert.equal(snapshot().error, '', snapshot().error);
            assert.equal(snapshot().summary.files, 1);
            assert.equal(snapshot().summary.tests, 2, 'both theory rows run');
            assert.equal(snapshot().summary.failed, 2);
            assert.match(snapshot().status, /2 failed/);
            previous = snapshot().summary;
            await replace(original);
            await until(() => snapshot().summary !== previous && snapshot().summary.failed === 0 && !snapshot().running, 'recovery run');
            assert.match(snapshot().status, /3 passed/);
        } finally {
            if (document.getText() !== original) {await replace(original);}
        }
    });
});
