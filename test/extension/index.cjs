// @ts-check
// Extension-host test entry: loaded by VS Code through extensionTestsPath. TESTY_TEST_FILES holds a
// comma-separated list of test files (relative to this directory) selected by run.mjs.
const path = require('node:path');
const { runAll } = require('./harness.cjs');

async function run() {
    const files = (process.env.TESTY_TEST_FILES ?? '').split(',').filter(Boolean);
    if (files.length === 0) { throw new Error('TESTY_TEST_FILES is empty.'); }
    for (const file of files) { require(path.resolve(__dirname, file)); }
    const failures = await runAll();
    if (failures > 0) { throw new Error(`${failures} extension test(s) failed.`); }
}

module.exports = { run };
