// Removes build output and local artifacts: out/, dist/, *.vsix, coverage output and benchmark results.
// Usage: node scripts/clean.mjs [--all]   (--all also removes .vscode-test/, the downloaded VS Code and workspaces)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['out', 'dist', 'coverage', '.nyc_output', '.benchmarks'];
if (process.argv.includes('--all')) { targets.push('.vscode-test'); }

for (const entry of fs.readdirSync(root)) {
    if (entry.endsWith('.vsix')) { targets.push(entry); }
}
for (const target of targets) {
    const full = path.join(root, target);
    if (fs.existsSync(full)) {
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`removed ${target}`);
    }
}
