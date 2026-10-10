import { readFileSync } from 'node:fs';

// Release gate: CHANGELOG.md must have a "## <version>" (or "## [<version>]") section for the package.json version.
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (!new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`, 'm').test(changelog)) {
    console.error(`CHANGELOG.md has no "## ${version}" section; move the Unreleased entries under it before tagging.`);
    process.exit(1);
}
console.log(`CHANGELOG.md has a section for ${version}.`);
