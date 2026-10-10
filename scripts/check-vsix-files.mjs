// Compares `vsce ls` output with scripts/vsix-files.txt so unintended files never ship.
// Usage: node scripts/check-vsix-files.mjs [--update] [--vsix <file>]
// With --vsix the entries of that built package are compared instead of the `vsce ls` preview,
// so release automation verifies exactly the file it publishes.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'scripts', 'vsix-files.txt');
const windows = process.platform === 'win32';
const vsixIndex = process.argv.indexOf('--vsix');

// Names of the files under extension/ in a VSIX (a zip), read from its central directory.
function vsixEntries(file) {
    const zip = fs.readFileSync(file);
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) { throw new Error(`${file} is not a zip archive.`); }
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    const names = [];
    for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) { throw new Error(`${file} has a corrupt central directory.`); }
        const nameLength = zip.readUInt16LE(offset + 28);
        names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
        offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    // vsce stores these three under normalized names; `vsce ls` shows the repository names.
    const stored = new Map([['readme.md', 'README.md'], ['changelog.md', 'CHANGELOG.md'], ['LICENSE.txt', 'LICENSE']]);
    return names.filter(name => name.startsWith('extension/') && !name.endsWith('/'))
        .map(name => name.slice('extension/'.length)).map(name => stored.get(name) ?? name);
}

let actual;
if (vsixIndex >= 0) {
    const file = process.argv[vsixIndex + 1];
    if (!file) { console.error('--vsix needs a file path.'); process.exit(2); }
    actual = vsixEntries(path.resolve(file)).sort();
} else {
    const listing = execFileSync(windows ? 'npx.cmd' : 'npx', ['vsce', 'ls', '--no-dependencies'], { cwd: root, encoding: 'utf8', shell: windows });
    actual = listing.split(/\r?\n/).map(line => line.trim().replace(/\\/g, '/')).filter(Boolean).sort();
}

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
