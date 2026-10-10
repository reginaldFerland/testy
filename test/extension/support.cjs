// @ts-check
// Helpers shared by the extension-host tests. Not a test file: the runner only
// loads files matching *.test.cjs.
const assert = require('node:assert/strict');
const vscode = require('vscode');

/**
 * Polls until `predicate` returns something truthy, and returns it.
 * @template T
 * @param {() => T} predicate
 * @param {string} description
 * @param {number} [timeout]
 */
async function until(predicate, description, timeout = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const result = predicate();
        if (result) {return result;}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}`);
}

/** The extension's API; `snapshot()` reports its state for these tests. */
async function activate() {
    const extension = vscode.extensions.getExtension('reginaldFerland.testy');
    assert.ok(extension);
    const api = await extension.activate();
    assert.ok(api?.snapshot);
    return { api, snapshot: /** @returns {any} */ () => api.snapshot() };
}

/** The test workspace's folder. */
function workspaceRoot() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The extension tests need a workspace folder.');
    return folder.uri;
}

/**
 * A new workspace asks before its first baseline (a prompt nobody answers here);
 * a manual run also starts it. Resolves once the baseline has finished.
 */
async function establishBaseline() {
    const { snapshot } = await activate();
    await until(() => snapshot().awaitingBaseline || snapshot().summary || snapshot().error, 'baseline question');
    if (snapshot().awaitingBaseline) {await vscode.commands.executeCommand('testy.runAffected');}
    await until(() => (snapshot().summary || snapshot().error) && !snapshot().running, 'initial baseline');
    assert.equal(snapshot().error, '', snapshot().error);
    return snapshot();
}

/**
 * Replaces `vscode.window` members for the duration of `body`, so commands that ask
 * questions or show notifications can be driven without anyone to answer them.
 * @template T
 * @param {Record<string, (...args: any[]) => unknown>} replacements
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withWindow(replacements, body) {
    /** @type {any} */
    const target = vscode.window;
    const originals = Object.keys(replacements).map(name => /** @type {const} */ ([name, target[name]]));
    for (const [name] of originals) {target[name] = replacements[name];}
    try {return await body();}
    finally {for (const [name, original] of originals) {target[name] = original;}}
}

module.exports = { until, activate, workspaceRoot, establishBaseline, withWindow };
