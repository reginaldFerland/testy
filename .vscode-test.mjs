import { defineConfig } from '@vscode/test-cli';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'testy-editor-'));
await fs.cp(path.resolve('test/fixtures/ImpactDemo'), workspace, {
    recursive: true,
    filter: file => !/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)
});
await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'testy.debounceTime': 100,
    ...(process.env.TESTY_COVERAGE_TOOL ? { 'testy.coverageToolPath': process.env.TESTY_COVERAGE_TOOL } : {})
}));
export default defineConfig({
    ...(process.env.TESTY_EXTENSION_PATH ? { extensionDevelopmentPath: process.env.TESTY_EXTENSION_PATH } : {}),
    ...(process.env.TESTY_VSCODE_PATH ? { useInstallation: { fromPath: process.env.TESTY_VSCODE_PATH } } : {}),
    files: 'test/extension/**/*.test.cjs',
    workspaceFolder: workspace,
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
    mocha: { timeout: 120000 }
});
