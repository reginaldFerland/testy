// Preloaded into every integration test process (see the test:integration scripts): installs Microsoft's coverage collector once into a
// shared directory, which every fixture's engine then finds already installed (installCoverageTool locks and checks it, so concurrent
// test processes wait for one install). NuGet failures are retried; if every attempt fails, fixtures fall back to their own install.
// TESTY_INTEGRATION_TOOLS chooses the directory; it defaults to one in the OS temp directory, kept between runs.
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installCoverageTool } = require('../../../out/services/coverageTool.js');
const directory = process.env.TESTY_INTEGRATION_TOOLS ||= path.join(os.tmpdir(), 'testy-integration-tools');
let failure;
for (let attempt = 1; attempt <= 3; attempt++) {
    try {await installCoverageTool('dotnet', directory, { cwd: process.cwd(), timeoutMs: 300_000 }); failure = undefined; break;}
    catch (error) {failure = error; await new Promise(resolve => setTimeout(resolve, 2000 * attempt));}
}
if (failure) {
    delete process.env.TESTY_INTEGRATION_TOOLS;
    console.warn(`Could not preinstall the coverage collector; each fixture installs its own. ${String(failure)}`);
}
