import * as path from 'node:path';

// Compiled modules live in out/services (tests) or are bundled into dist/
// (the packaged extension). Scripts sit next to the running module either way;
// .NET helpers always live under <extension>/dist.
const bundled = path.basename(__dirname) === 'dist';
const extensionRoot = bundled ? path.dirname(__dirname) : path.resolve(__dirname, '../..');

/** A Node entry point (worker or child script) emitted next to this module. */
export function scriptPath(name: string): string { return path.join(__dirname, `${name}.js`); }

/** A bundled .NET helper file under dist/. */
export function helperPath(...segments: string[]): string { return path.join(extensionRoot, 'dist', ...segments); }
