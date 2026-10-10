import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compareCodeUnits, contentHash } from '../core/paths';
import { ProcessOptions } from './process';
import { preparationToolIdentity } from './preparationTools';
import { ambiguousWindowsPath, isNativeExecutable, resolveNodeExecutable } from './executable';

/** The Roslyn builds the helper can load: those of every SDK installed beside the host (see
 * RoslynLoader, which picks one). An SDK installed, removed or updated changes the analysis tool, and
 * fingerprints from different Roslyn versions are not interchangeable. Undefined when none exists.
 * TESTY_ROSLYN_DIR names a single Roslyn directory instead. */
export async function roslynInventory(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | undefined> {
    const stat = (file: string): Promise<string | undefined> => fs.stat(file, { bigint: true })
        .then(value => `${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.ino}`, () => undefined);
    const configured = env.TESTY_ROSLYN_DIR;
    const directories = configured ? [path.resolve(configured)]
        : (await fs.readdir(path.join(root, 'sdk')).catch(() => [] as string[])).sort().map(name => path.join(root, 'sdk', name, 'Roslyn', 'bincore'));
    const records = await Promise.all(directories.map(async directory =>
        [directory, await stat(path.join(directory, 'Microsoft.CodeAnalysis.dll')), await stat(path.join(directory, 'Microsoft.CodeAnalysis.CSharp.dll'))]));
    signal?.throwIfAborted();
    const usable = records.filter(([, common, csharp]) => common && csharp);
    return usable.length ? JSON.stringify([await fs.realpath(root), usable]) : undefined;
}

/** Names the Roslyn a direct launch of the helper would load, for keying its long-lived
 * processes. Empty when the host is not an ordinary installation (the helper then
 * still finds its own Roslyn, but nothing can vouch for which). */
export async function roslynIdentity(dotnet: string, options: ProcessOptions): Promise<string> {
    const env = { ...process.env, ...options.env };
    try {
        const host = await resolveNodeExecutable(dotnet, env, options.cwd, options.signal);
        return (host && await roslynInventory(path.dirname(host), env, options.signal)) || '';
    } catch {options.signal?.throwIfAborted(); return '';}
}

/** Testy's syntax helper is pure for its source/alias inputs under an ordinary
 * installed CLR. Treat supported CLR implementation semantics as platform
 * behavior, while detecting host/asset replacements and runtime installations.
 * This does not claim transitive provenance for arbitrary injected CLR code. `identities` (the engine's
 * tool hashes) reuses the helper's asset hashes while their metadata is unchanged. */
export async function sourceAnalysisContext(dotnet: string, analyzer: string, options: ProcessOptions, identities?: Map<string, Promise<string>>): Promise<string | undefined> {
    const env = { ...process.env, ...options.env }, signal = options.signal;
    signal?.throwIfAborted();
    // These mechanisms can load arbitrary code/configuration outside the helper
    // bundle. Fresh analysis remains available without retaining its results.
    if (Object.entries(env).some(([key, value]) => value && /^(?:CORECLR_|COR_|COMPlus_|DOTNET_(?:STARTUP_HOOKS|ADDITIONAL_DEPS|SHARED_STORE|ROOT(?:_|$)|MULTILEVEL_LOOKUP|ROLL_FORWARD|RUNTIME_ID))/i.test(key))) {return undefined;}
    if (Object.entries(env).some(([key, value]) => value && /^(?:LD_(?:PRELOAD|LIBRARY_PATH|AUDIT|ORIGIN_PATH)|DYLD_(?:INSERT_LIBRARIES|(?:FALLBACK_|VERSIONED_)?(?:LIBRARY|FRAMEWORK)_PATH|ROOT_PATH|IMAGE_SUFFIX|SHARED_CACHE_DIR))$/i.test(key))) {return undefined;}
    try {
        // Engine analysis is a direct Node launch. Other callers can use the
        // Windows owner, whose bare-command search does not match libuv.
        let host: string | undefined;
        if (process.platform === 'win32' && options.cleanupDescendants !== false) {
            if (!path.isAbsolute(dotnet) || !path.extname(dotnet) || ambiguousWindowsPath(dotnet)) {return undefined;}
            if (!(await fs.stat(dotnet)).isFile()) {return undefined;}
            host = await fs.realpath(dotnet);
        } else {host = await resolveNodeExecutable(dotnet, env, options.cwd, signal);}
        if (!host || !['dotnet', 'dotnet.exe'].includes(path.basename(host).toLowerCase())) {return undefined;}
        const bytes = await fs.readFile(host, { signal });
        if (!isNativeExecutable(bytes)) {return undefined;}
        const root = path.dirname(host), actualAnalyzer = await fs.realpath(path.resolve(options.cwd, analyzer));
        const base = actualAnalyzer.slice(0, -path.extname(actualAnalyzer).length);
        // Development probing can resolve dependencies from arbitrary external
        // directories. The shipped helper has one ordinary shared framework.
        if (await fs.stat(`${base}.runtimeconfig.dev.json`).then(() => true, (error: unknown) => {
            if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {return false;} throw error;
        })) {return undefined;}
        const runtime = JSON.parse(await fs.readFile(`${base}.runtimeconfig.json`, 'utf8')) as { runtimeOptions?: {
            framework?: { name?: string }; frameworks?: unknown; includedFrameworks?: unknown; additionalProbingPaths?: unknown;
        } };
        const runtimeOptions = runtime.runtimeOptions;
        if (runtimeOptions?.framework?.name !== 'Microsoft.NETCore.App' || runtimeOptions.frameworks
            || runtimeOptions.includedFrameworks || runtimeOptions.additionalProbingPaths) {return undefined;}
        // Only immediate version inventories are needed; no SDK/runtime tree
        // content walk. Canonical paths and directory stamps notice normal
        // installation, removal, replacement, and version-link retargeting.
        const inventories: unknown[] = [];
        for (const relative of ['host/fxr', 'shared/Microsoft.NETCore.App']) {
            const directory = path.join(root, relative), records: unknown[] = [];
            for (const name of (await fs.readdir(directory)).sort()) {
                const file = path.join(directory, name), stat = await fs.stat(file, { bigint: true });
                if (stat.isDirectory()) {records.push([name, await fs.realpath(file), String(stat.dev), String(stat.ino), String(stat.mtimeNs), String(stat.ctimeNs)]);}
            }
            if (!records.length) {return undefined;}
            inventories.push([await fs.realpath(directory), records]);
        }
        // The helper does not ship Roslyn; fingerprints come from the SDK's.
        const roslyn = await roslynInventory(root, env, signal);
        if (!roslyn) {return undefined;}
        const assets = await preparationToolIdentity(actualAnalyzer, env, signal, options.cwd, identities);
        signal?.throwIfAborted();
        return contentHash(JSON.stringify([3, host, contentHash(bytes), assets, inventories, roslyn, await fs.realpath(options.cwd),
            Object.entries(env).sort(([left], [right]) => compareCodeUnits(left, right))]));
    } catch {signal?.throwIfAborted(); return undefined;}
}
