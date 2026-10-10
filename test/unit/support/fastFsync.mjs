// Preloaded by the unit-test scripts (`node --import`). Unit tests never lose power, so durability
// flushes only cost time; on macOS each one is a full device cache flush (F_FULLFSYNC) that serializes
// across every test process. Tests of flush ordering wrap `handle.sync` per handle, so they still see
// every call. storageDurability.test.cjs keeps real flushes to exercise them on this platform.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

if (path.basename(process.argv[1] ?? '') !== 'storageDurability.test.cjs') {
    const handle = await fs.open(fileURLToPath(import.meta.url), 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    prototype.sync = prototype.datasync = async function () {};
}
