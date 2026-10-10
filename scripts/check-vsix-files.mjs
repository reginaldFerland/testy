// Compares `vsce ls` output with scripts/vsix-files.txt so unintended files never ship.
// Usage: node scripts/check-vsix-files.mjs [--update]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'scripts', 'vsix-files.txt');
const windows = process.platform === 'win32';
const listing = execFileSync(windows ? 'npx.cmd' : 'npx', ['vsce', 'ls', '--no-dependencies'], { cwd: root, encoding: 'utf8', shell: windows });
const actual = listing.split(/\r?\n/).map(line => line.trim().replace(/\\/g, '/')).filter(Boolean).sort();

if (process.argv.includes('--update')) {
    fs.writeFileSync(snapshotPath, actual.join('\n') + '\n');
    console.log(`Wrote ${actual.length} entries to ${path.relative(root, snapshotPath)}`);
    process.exit(0);
}

const expected = fs.readFileSync(snapshotPath, 'utf8').split(/\r?\n/).filter(Boolean).sort();
const added = actual.filter(file => !expected.includes(file));
const removed = expected.filter(file => !actual.includes(file));
if (added.length || removed.length) {
    for (const file of added) { console.error(`+ ${file} (unexpected in VSIX)`); }
    for (const file of removed) { console.error(`- ${file} (missing from VSIX)`); }
    console.error('VSIX file list differs from scripts/vsix-files.txt. Run `node scripts/check-vsix-files.mjs --update` if the change is intended.');
    process.exit(1);
}
console.log(`VSIX file list matches snapshot (${actual.length} files).`);
