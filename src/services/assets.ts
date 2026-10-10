import * as path from 'node:path';
import { readFileSync } from 'node:fs';

// Compiled modules live in out/services (tests) or are bundled into dist/
// (the packaged extension). Scripts sit next to the running module either way;
// .NET helpers always live under <extension>/dist.
const bundled = path.basename(__dirname) === 'dist';
const extensionRoot = bundled ? path.dirname(__dirname) : path.resolve(__dirname, '../..');

/** A Node entry point (worker or child script) emitted next to this module. */
export function scriptPath(name: string): string { return path.join(__dirname, `${name}.js`); }

/** A bundled .NET helper file under dist/. */
export function helperPath(...segments: string[]): string { return path.join(extensionRoot, 'dist', ...segments); }

let version: string | undefined;
/** The extension's own version, read once from its package.json. */
export function extensionVersion(): string {
    if (version !== undefined) {return version;}
    try {
        const manifest: unknown = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
        version = typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string' ? manifest.version : 'unknown';
    } catch {version = 'unknown';}
    return version;
}
