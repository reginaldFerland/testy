// The local pre-push check: builds once, then runs every static check and test suite, in parallel where they
// do not contend, and prints a timing table. Exits non-zero when any step fails.
// Usage: node scripts/verify.mjs [--skip-extension] [--skip-integration] [--only <step>[,<step>...]] [--list]
// --only runs the named steps and the build steps they need. Each step's output goes to a log file;
// the logs of failed steps are summarized at the end.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';

// npm_execpath is set when this runs through `npm run verify`; otherwise npm is found on PATH.
const npmCli = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : undefined;
const npm = (...args) => npmCli ? [process.execPath, npmCli, ...args] : [windows ? 'npm.cmd' : 'npm', ...args];
const node = (...args) => [process.execPath, ...args];

/** Hashes of the files under l10n/, to see whether the export changed any. */
function l10nState() {
    const directory = path.join(root, 'l10n'), state = new Map();
    for (const name of fs.readdirSync(directory).sort()) {state.set(name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex'));}
    return state;
}
let l10nBefore;
const helpers = ['build:analyzer', 'build:process-host', 'build:observer'], built = ['tsc', 'bundle', ...helpers];

/**
 * @typedef {{ name: string, after?: string[], wait?: string[], command?: string[], env?: Record<string, string>, before?: () => void, check?: () => string | undefined }} Step
 * `after` names the steps a step needs: they run with it and their failure skips it. `wait` only orders: a step starts once those
 * of the named steps that are selected have finished, whatever their result. `before` runs just before the command and `check`
 * just after a successful one; `check` returns a failure message.
 * @type {Step[]}
 */
const steps = [
    // Build once. The three .NET helpers are independent projects, so they build side by side.
    { name: 'tsc', command: node('node_modules/typescript/bin/tsc', '-p', './') },
    { name: 'bundle', command: npm('run', 'bundle') },
    { name: 'build:analyzer', command: npm('run', 'build:analyzer') },
    { name: 'build:process-host', command: npm('run', 'build:process-host') },
    { name: 'build:observer', command: npm('run', 'build:observer') },
    // Static checks. lint and the test type check read the declarations in out/; the VSIX listing needs dist/.
    { name: 'lint', after: ['tsc'], command: npm('run', 'lint') },
    { name: 'typecheck:tests', after: ['tsc'], command: npm('run', 'typecheck:tests') },
    { name: 'audit', command: npm('audit', '--omit=dev', '--audit-level=high') },
    { name: 'audit:signatures', command: npm('audit', 'signatures') },
    { name: 'l10n', command: npm('run', 'l10n:export'), before: () => {l10nBefore = l10nState();},
        check: () => {
            const after = l10nState(), names = new Set([...l10nBefore.keys(), ...after.keys()]);
            const changed = [...names].filter(name => l10nBefore.get(name) !== after.get(name));
            return changed.length ? `npm run l10n:export changed ${changed.map(name => `l10n/${name}`).join(', ')}; commit the regenerated files.` : undefined;
        } },
    { name: 'changelog', command: npm('run', 'check:changelog') },
    { name: 'vsix', after: built, command: npm('run', 'check:vsix') },
    // Test suites. dotnet test restores the helper projects again, so it waits for their Release builds.
    { name: 'unit', after: built, command: npm('run', 'test:unit:only') },
    { name: 'dotnet', after: helpers, command: npm('run', 'test:dotnet') },
    { name: 'integration', after: built, command: npm('run', 'test:integration:only') },
    // The extension scenarios allow fixed times for file system events and runs, which the integration suite's
    // full CPU load can exceed, so they run after the other suites.
    { name: 'extension', after: built, wait: ['lint', 'typecheck:tests', 'unit', 'dotnet', 'integration'], command: npm('run', 'test:extension:only') }
];

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv.includes('--list')) {
    console.log('Usage: node scripts/verify.mjs [--skip-extension] [--skip-integration] [--only <step>[,<step>...]]\nSteps:');
    for (const step of steps) {console.log(`  ${step.name}${step.after?.length ? `  (needs ${step.after.join(', ')})` : ''}${step.wait?.length ? `  (waits for ${step.wait.join(', ')})` : ''}`);}
    process.exit(0);
}
const only = argv.flatMap((value, index) => argv[index - 1] === '--only' ? value.split(',') : value.startsWith('--only=') ? value.slice(7).split(',') : []).filter(Boolean);
const skipped = new Set(argv.filter(value => value.startsWith('--skip-')).map(value => value.slice(7)));
const known = new Set(steps.map(step => step.name));
const unknownArguments = argv.filter((value, index) => !(value === '--only' || value.startsWith('--only=') || argv[index - 1] === '--only' || value.startsWith('--skip-')));
const unknownSteps = [...only, ...skipped].filter(name => !known.has(name));
if (unknownArguments.length || unknownSteps.length) {
    console.error(`Unknown ${unknownArguments.length ? `argument ${unknownArguments.join(' ')}` : `step ${unknownSteps.join(', ')}`}. Run with --list for the steps.`);
    process.exit(2);
}
// --only keeps the named steps and every step they need.
const wanted = new Set();
const want = name => {if (wanted.has(name)) {return;} wanted.add(name); for (const dependency of steps.find(step => step.name === name)?.after ?? []) {want(dependency);}};
for (const step of steps) {if ((!only.length || only.includes(step.name)) && !skipped.has(step.name)) {want(step.name);}}
const selected = steps.filter(step => wanted.has(step.name));

const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'testy-verify-'));
const started = Date.now();
const seconds = milliseconds => `${(milliseconds / 1000).toFixed(1)}s`;
/** @type {Map<string, { status: 'pass' | 'fail' | 'skip', start: number, end: number, message?: string }>} */
const results = new Map();
/** @type {Map<string, Promise<boolean>>} */
const running = new Map();
const children = new Set();

function run(step) {
    return new Promise(resolve => {
        const log = fs.createWriteStream(path.join(logs, `${step.name.replace(/[^\w.-]/g, '_')}.log`));
        const [command, ...args] = step.command;
        log.write(`$ ${step.command.join(' ')}\n\n`);
        // npm.cmd needs a shell on Windows; every other command is an executable path.
        const child = spawn(command, args, { cwd: root, env: { ...process.env, ...step.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
            shell: windows && command.endsWith('.cmd'), windowsHide: true });
        children.add(child);
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        child.once('error', error => {log.write(`\n${String(error)}\n`);});
        child.once('close', (code, signal) => {
            children.delete(child);
            log.end(() => resolve(code === 0 ? undefined : `exited with ${signal ?? `code ${code}`}`));
        });
    });
}

async function execute(step) {
    // Every step is registered before any looks up the steps it needs.
    await Promise.resolve();
    const dependencies = await Promise.all((step.after ?? []).filter(name => wanted.has(name)).map(name => running.get(name)));
    await Promise.all((step.wait ?? []).filter(name => wanted.has(name)).map(name => running.get(name)));
    const start = Date.now() - started;
    if (dependencies.includes(false)) {results.set(step.name, { status: 'skip', start, end: start, message: 'a step it needs failed' }); return false;}
    console.log(`[${seconds(start)}] start ${step.name}`);
    let message;
    try {step.before?.(); message = await run(step); message ??= step.check?.();}
    catch (error) {message = String(error);}
    const end = Date.now() - started;
    results.set(step.name, { status: message ? 'fail' : 'pass', start, end, message });
    console.log(`[${seconds(end)}] ${message ? 'FAIL' : 'pass'} ${step.name} (${seconds(end - start)})${message ? `: ${message}` : ''}`);
    return !message;
}

const interrupt = () => {for (const child of children) {child.kill();} process.exit(130);};
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

console.log(`Verifying ${selected.map(step => step.name).join(', ')}\nLogs: ${logs}\n`);
for (const step of selected) {running.set(step.name, execute(step));}
await Promise.all(running.values());

const total = Date.now() - started;
const rows = selected.map(step => {const result = results.get(step.name); return [step.name, result.status.toUpperCase(), seconds(result.end - result.start), seconds(result.start), seconds(result.end)];});
const header = ['step', 'result', 'time', 'start', 'end'];
const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
const line = row => row.map((cell, column) => column === 0 || column === 1 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join('  ');
console.log(`\n${line(header)}\n${widths.map(width => '-'.repeat(width)).join('  ')}\n${rows.map(line).join('\n')}\n`);

const failed = selected.filter(step => results.get(step.name).status !== 'pass');
for (const step of failed.filter(step => results.get(step.name).status === 'fail')) {
    const file = path.join(logs, `${step.name.replace(/[^\w.-]/g, '_')}.log`);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/) : [];
    console.log(`--- ${step.name}: last ${Math.min(40, text.length)} lines of ${file}\n${text.slice(-40).join('\n')}\n`);
}
if (failed.length) {
    console.log(`FAILED in ${seconds(total)}: ${failed.map(step => `${step.name}${results.get(step.name).status === 'skip' ? ' (skipped: a step it needs failed)' : ''}`).join(', ')}`);
    process.exitCode = 1;
} else {
    console.log(`PASSED: ${selected.length} steps in ${seconds(total)}`);
    fs.rmSync(logs, { recursive: true, force: true });
}
