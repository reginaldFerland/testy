import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

// Runs only the Windows-specific tests (the only tests CI runs; everything else runs locally before pushing).
//   TypeScript: tests whose name starts with "[windows]" (or "[windows-slow]" with --slow), in test/unit and test/integration.
//   .NET: xUnit tests with [Trait("Platform", "Windows")] in backend/Testy.Backend.Tests (not with --slow).
// Needs an out/ build (npx tsc -p ./) and dist/processhost (npm run build:process-host); see CONTRIBUTING.md.
// --prebuilt runs the .NET tests from an existing Release build (CI builds it first) instead of building Debug.
// Usage: node scripts/test-windows.mjs [--slow] [--prebuilt] [--node-only | --dotnet-only]
const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const slow = args.has('--slow');
const marker = slow ? '[windows-slow]' : '[windows]';
const run = (command, commandArgs, cwd) => {
    const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit' });
    if (result.error) { console.error(result.error.message); }
    return result.status ?? 1;
};

let status = 0;
if (!args.has('--dotnet-only')) {
    const files = ['test/unit', 'test/integration'].flatMap(directory =>
        readdirSync(path.join(root, directory)).filter(name => name.endsWith('.test.cjs')).map(name => `${directory}/${name}`))
        .filter(file => readFileSync(path.join(root, file), 'utf8').includes(`'${marker} `));
    if (files.length === 0) {
        console.error(`No test is named "${marker} ...".`);
        process.exit(1);
    }
    if (!existsSync(path.join(root, 'out'))) {
        console.error('out/ is missing; run `npx tsc -p ./` first.');
        process.exit(1);
    }
    const escaped = marker.replace(/[[\]-]/g, '\\$&');
    status ||= run(process.execPath, ['--test', `--test-name-pattern=^${escaped}`, ...files], root);
}
if (!args.has('--node-only') && !slow) {
    // The runner is Microsoft.Testing.Platform (xunit.v3); --filter-trait is xunit's own name=value filter.
    const build = args.has('--prebuilt') ? ['--configuration', 'Release', '--no-build'] : [];
    status ||= run('dotnet', ['test', '--project', 'Testy.Backend.Tests', ...build, '--filter-trait', 'Platform=Windows'], path.join(root, 'backend'));
}
process.exit(status);
