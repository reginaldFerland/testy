// @ts-check
// A minimal suite/suiteSetup/test runner for the extension host (mocha-style `this.timeout()`).
// Suites and tests run strictly in registration order; a failing suiteSetup skips its suite's tests.
const DEFAULT_TIMEOUT = 120000;

/** @typedef {{ timeout(ms: number): void }} Context */
/** @typedef {(this: Context) => unknown} Body */
/** @typedef {{ name: string, setups: { fn: Body }[], tests: { name: string, fn: Body }[] }} Suite */

/** @type {Suite[]} */
const suites = [];
/** @type {Suite | undefined} */
let current;

/** @param {string} name @param {() => void} define */
function suite(name, define) {
    current = { name, setups: [], tests: [] };
    suites.push(current);
    try { define(); } finally { current = undefined; }
}

/** @param {Body} fn */
function suiteSetup(fn) {
    if (!current) { throw new Error('suiteSetup must be called inside suite().'); }
    current.setups.push({ fn });
}

/** @param {string} name @param {Body} fn */
function test(name, fn) {
    if (!current) { throw new Error('test must be called inside suite().'); }
    current.tests.push({ name, fn });
}

/** @param {Body} fn @param {string} label */
async function runWithTimeout(fn, label) {
    let limit = DEFAULT_TIMEOUT;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const context = { timeout(/** @type {number} */ ms) { limit = ms; } };
    const started = Date.now();
    // Starting the body synchronously lets it call this.timeout() before the deadline timer is armed.
    const work = (async () => fn.call(context))();
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout of ${limit}ms exceeded: ${label}`)), limit);
    });
    try { await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
    return Date.now() - started;
}

/** @param {unknown} error */
function indent(error) {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return text.split('\n').map(line => `       ${line}`).join('\n');
}

/** Runs every registered suite; resolves to the number of failures. */
async function runAll() {
    let passed = 0;
    let failed = 0;
    for (const s of suites) {
        console.log(`\n${s.name}`);
        let ready = true;
        for (const setup of s.setups) {
            try { await runWithTimeout(setup.fn, 'suiteSetup'); } catch (error) {
                failed++; ready = false;
                console.error(`  FAIL suiteSetup\n${indent(error)}`);
                break;
            }
        }
        if (!ready) { continue; }
        for (const t of s.tests) {
            try {
                const ms = await runWithTimeout(t.fn, t.name);
                passed++;
                console.log(`  ok   ${t.name} (${ms}ms)`);
            } catch (error) {
                failed++;
                console.error(`  FAIL ${t.name}\n${indent(error)}`);
            }
        }
    }
    console.log(`\n${passed} passing, ${failed} failing`);
    return failed;
}

module.exports = { suite, suiteSetup, test, runAll };
