// @ts-check
// Testy's palette and context-menu commands, run against a fresh copy of ImpactDemo.
// The commands ask questions and show notifications through vscode.window; the
// tests answer those with withWindow() instead of leaving a dialog open.
const { suite, suiteSetup, test } = require('./harness.cjs');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { until, workspaceRoot, establishBaseline, withWindow, activate } = require('./support.cjs');

/** A Test Explorer item as the commands read it: only `id` and `label` matter. */
const item = (/** @type {string} */id, /** @type {string} */label) => /** @type {vscode.TestItem} */ (/** @type {unknown} */ ({ id, label }));

/** The first discovered test file's project, as the Test Explorer names it. */
const projectItem = (/** @type {any} */snapshot) => {
    const [group] = snapshot.groups;
    assert.ok(group?.project, 'a discovered test file');
    return item(`project:${group.project}`, path.basename(group.project, '.csproj'));
};

/** Settles the extension: no run in progress and nothing queued. */
const settled = (/** @type {() => any} */snapshot, /** @type {string} */what) =>
    until(() => !snapshot().running && !/waiting/.test(snapshot().status), what);

suite('Testy commands in VS Code', () => {
    /** @type {() => any} */
    let snapshot = () => undefined;
    suiteSetup(async function () {
        this.timeout(300000);
        ({ snapshot } = await activate());
        await establishBaseline();
        assert.equal(snapshot().summary.tests, 3);
    });

    for (const [format, quickPickLabel, expectedFile, check] of /** @type {const} */ ([
        ['LCOV', 'LCOV', 'coverage.lcov', (/** @type {string} */text, /** @type {string} */root) => {
            assert.match(text, /^SF:ImpactDemo\/Greeting\.cs$/m);
            assert.match(text, /^DA:\d+,\d+$/m);
            assert.doesNotMatch(text, /^SF:(\/|[A-Za-z]:)/m, 'source files are relative');
            assert.ok(!text.includes(root), 'the workspace path is not written');
        }],
        ['Cobertura', 'Cobertura XML', 'coverage.cobertura.xml', (/** @type {string} */text, /** @type {string} */root) => {
            assert.match(text, /<coverage[\s>]/);
            assert.match(text, /filename="ImpactDemo\/Greeting\.cs"/);
            assert.doesNotMatch(text, /filename="(\/|[A-Za-z]:)/, 'source files are relative');
            // Cobertura resolves relative filenames against <sources>, which is where the root belongs.
            assert.match(text, /<source>[^<]*<\/source>/);
            assert.ok(!text.replace(/<sources>[\s\S]*?<\/sources>/, '').includes(root), 'the workspace path appears only in <sources>');
        }]
    ])) {
        test(`exportCoverage writes ${format} with workspace-relative paths`, async () => {
            const target = await fs.mkdtemp(path.join(os.tmpdir(), 'testy export '));
            const output = path.join(target, 'nested', expectedFile);
            /** @type {string[]} */
            const messages = [];
            try {
                await withWindow({
                    showQuickPick: async (/** @type {readonly vscode.QuickPickItem[]} */items) => items.find(entry => entry.label === quickPickLabel),
                    showSaveDialog: async () => vscode.Uri.file(output),
                    showInformationMessage: async (/** @type {string} */message) => { messages.push(message); return undefined; },
                    showWarningMessage: async (/** @type {string} */message) => { messages.push(message); return undefined; }
                }, async () => { await vscode.commands.executeCommand('testy.exportCoverage'); });
                const text = await fs.readFile(output, 'utf8');
                check(text, workspaceRoot().fsPath);
                assert.ok(messages.some(message => message.includes(output)), `an export notice: ${messages.join(' | ')}`);
            } finally {
                await fs.rm(target, { recursive: true, force: true });
            }
        });
    }

    test('hovering a covered line shows its covering test files with run and show links', async () => {
        const greeting = snapshot().coverage.find((/** @type {{file: string}} */file) => file.file.endsWith('/Greeting.cs'));
        assert.ok(greeting, 'retained coverage of Greeting.cs');
        const line = greeting.lines.find((/** @type {{line: number, hits: number}} */entry) => entry.hits > 0);
        assert.ok(line, 'a covered line');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(greeting.file));
        await vscode.window.showTextDocument(document);
        /** @type {string} */
        let text = '';
        // The hover reads coverage asynchronously; poll the providers until it answers.
        for (let attempt = 0; attempt < 50 && !/Covered by/.test(text); attempt++) {
            if (attempt) {await new Promise(resolve => setTimeout(resolve, 100));}
            const hovers = /** @type {vscode.Hover[]} */ (await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(line.line - 1, 0)));
            text = hovers.flatMap(hover => hover.contents).map(content => typeof content === 'string' ? content : content.value).join('\n');
        }
        assert.match(text, /Covered by/);
        assert.match(text, /command:testy\.runCoveringTests\?/);
        assert.match(text, /command:testy\.showTest\?/);
    });

    test('exportCoverage writes nothing when the save dialog is dismissed', async () => {
        let asked = false;
        await withWindow({
            showQuickPick: async (/** @type {readonly vscode.QuickPickItem[]} */items) => items[0],
            showSaveDialog: async () => { asked = true; return undefined; }
        }, async () => { await vscode.commands.executeCommand('testy.exportCoverage'); });
        assert.equal(asked, true);
    });

    test('explainSelection reports why a project was or was not selected', async () => {
        const target = projectItem(snapshot());
        /** @type {string[]} */
        const messages = [];
        await withWindow({
            showInformationMessage: async (/** @type {string} */message) => { messages.push(message); return undefined; }
        }, async () => {
            await vscode.commands.executeCommand('testy.explainSelection', target);
            await until(() => messages.length, 'the explanation');
        });
        assert.equal(messages.length, 1);
        assert.ok(messages[0]?.startsWith(target.label), messages[0]);
        assert.match(messages[0] ?? '', /selected|no Testy run/);
    });

    test('runFile runs the tests affected by a file, as if it had been saved', async () => {
        const file = vscode.Uri.joinPath(workspaceRoot(), 'ImpactDemo', 'Arithmetic.cs');
        await settled(snapshot, 'previous run to settle');
        const previous = snapshot().summary;
        await vscode.commands.executeCommand('testy.runFile', file);
        await until(() => snapshot().summary !== previous && !snapshot().running, 'run for the file');
        assert.equal(snapshot().error, '', snapshot().error);
        assert.equal(snapshot().summary.files, 1, 'only the tests that cover Arithmetic.cs run');
        assert.equal(snapshot().summary.tests, 2);
        assert.match(snapshot().status, /3 passed/, 'the unselected Greeting outcome is retained');
    });

    test('resetCaches keeps everything when the confirmation is declined', async () => {
        await settled(snapshot, 'previous run to settle');
        const previous = snapshot().summary, coverage = JSON.stringify(snapshot().coverage);
        /** @type {unknown[]} */
        const questions = [];
        await withWindow({
            showWarningMessage: async (/** @type {string} */message, /** @type {unknown} */options) => { questions.push([message, options]); return undefined; }
        }, async () => { await vscode.commands.executeCommand('testy.resetCaches'); });
        assert.equal(questions.length, 1);
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(snapshot().summary, previous, 'no new run starts');
        assert.equal(JSON.stringify(snapshot().coverage), coverage);
    });

    test('resetCaches discards learned state and establishes a new baseline', async () => {
        await settled(snapshot, 'previous run to settle');
        const previous = snapshot().summary;
        await withWindow({
            showWarningMessage: async (/** @type {string} */_message, /** @type {unknown} */_options, /** @type {string} */reset) => reset
        }, async () => { await vscode.commands.executeCommand('testy.resetCaches'); });
        await until(() => snapshot().summary !== previous && !snapshot().running && !/waiting/.test(snapshot().status), 'new baseline after the reset');
        assert.equal(snapshot().error, '', snapshot().error);
        assert.equal(snapshot().summary.tests, 3, 'a full baseline, not an affected subset');
        assert.equal(snapshot().summary.files, 2);
        assert.equal(snapshot().summary.coverageAvailable, true);
        const greeting = snapshot().coverage.find((/** @type {{file:string}} */entry) => entry.file.endsWith('/Greeting.cs'));
        assert.ok(greeting?.covered > 0 && greeting.stale === false, 'coverage is learned again');
    });

    // Last: excluding the test project leaves the workspace with nothing to run.
    test('excludeProject adds the project to testy.projects.exclude and it disappears', async () => {
        await settled(snapshot, 'previous run to settle');
        const target = projectItem(snapshot());
        const settings = vscode.workspace.getConfiguration('testy');
        const before = settings.inspect('projects.exclude')?.workspaceValue;
        /** @type {string[]} */
        const messages = [];
        try {
            await withWindow({
                showInformationMessage: async (/** @type {string} */message) => { messages.push(message); return undefined; }
            }, async () => { await vscode.commands.executeCommand('testy.excludeProject', target); });
            const excluded = /** @type {string[]|undefined} */ (vscode.workspace.getConfiguration('testy').get('projects.exclude'));
            assert.ok(excluded?.includes('ImpactDemo.Tests/ImpactDemo.Tests.csproj'), JSON.stringify(excluded));
            assert.ok(messages.some(message => message.includes(target.label)), messages.join(' | '));
            await until(() => snapshot().groups.length === 0 && !snapshot().running && !/waiting/.test(snapshot().status), 'the excluded project to leave discovery');
        } finally {
            await settings.update('projects.exclude', before, vscode.ConfigurationTarget.Workspace);
        }
        await until(() => snapshot().groups.length === 2 && !snapshot().running && !/waiting/.test(snapshot().status), 'the project to return when no longer excluded');
    });
});
