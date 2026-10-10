// Runs the extension-host tests: one VS Code instance per configuration, each on its own workspace copy.
// Usage: node test/extension/run.mjs [scenarios|commands|xunit|nunit ...]   (or TESTY_CONFIG=name[,name])
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = path.resolve(import.meta.dirname, '../..');
const cacheDir = path.join(root, '.vscode-test');
const workspaces = path.join(cacheDir, 'workspaces');

const configurations = [
    // The save/pause/watcher scenarios mutate their workspace, so they keep one to themselves.
    { label: 'scenarios', files: 'extension.test.cjs', fixture: 'ImpactDemo' },
    { label: 'commands', files: 'commands.test.cjs', fixture: 'ImpactDemo' },
    { label: 'xunit', files: 'frameworks.test.cjs', fixture: 'XunitDemo' },
    { label: 'nunit', files: 'frameworks.test.cjs', fixture: 'NUnitDemo' }
];

const requested = [...process.argv.slice(2), ...(process.env.TESTY_CONFIG ?? '').split(',')].filter(Boolean);
const unknown = requested.filter(name => !configurations.some(c => c.label === name));
if (unknown.length > 0) {
    console.error(`Unknown configuration: ${unknown.join(', ')}. Choose from ${configurations.map(c => c.label).join(', ')}.`);
    process.exit(2);
}
const selected = configurations.filter(c => requested.length === 0 || requested.includes(c.label));

// Workspaces are git-ignored, rebuilt each run and removed on exit.
await fs.rm(workspaces, { recursive: true, force: true });
process.on('exit', () => fsSync.rmSync(workspaces, { recursive: true, force: true }));

async function workspaceFor(name, fixture) {
    const workspace = path.join(workspaces, name);
    await fs.cp(path.join(root, 'test/fixtures', fixture), workspace, {
        recursive: true,
        filter: file => !/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)
    });
    await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
        'testy.debounceTime': 100,
        ...(process.env.TESTY_COVERAGE_TOOL ? { 'testy.coverageToolPath': process.env.TESTY_COVERAGE_TOOL } : {})
    }));
    return workspace;
}

const vscodeExecutablePath = process.env.TESTY_VSCODE_PATH
    ?? await downloadAndUnzipVSCode({ cachePath: cacheDir, version: process.env.TESTY_VSCODE_VERSION });

const failed = [];
for (const configuration of selected) {
    console.log(`\n=== ${configuration.label} ===`);
    const workspace = await workspaceFor(configuration.label, configuration.fixture);
    try {
        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath: process.env.TESTY_EXTENSION_PATH ?? root,
            extensionTestsPath: path.join(root, 'test/extension/index.cjs'),
            extensionTestsEnv: { TESTY_TEST_FILES: configuration.files },
            // VS Code's IPC socket path must stay under ~103 characters; set TESTY_USER_DATA_DIR to a short
            // directory when the repository sits deep in the file system.
            launchArgs: [
                workspace, '--disable-extensions', '--disable-workspace-trust',
                ...(process.env.TESTY_USER_DATA_DIR ? [`--user-data-dir=${process.env.TESTY_USER_DATA_DIR}`] : [])
            ]
        });
    } catch (error) {
        console.error(`Configuration '${configuration.label}' failed: ${error instanceof Error ? error.message : error}`);
        failed.push(configuration.label);
    }
}

if (failed.length > 0) {
    console.error(`\nFailed configurations: ${failed.join(', ')}`);
    process.exitCode = 1;
}
