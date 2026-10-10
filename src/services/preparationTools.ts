import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileHash } from './output';
import { outputManifest } from './preparedOutputCache';
import { hashMemoTiming } from './hashMemo';

/** A file's real path and content hash. With `identities` (the engine's tool hashes, which survive across runs) the
 * hash is reused while the file's metadata is unchanged; the metadata is read before the bytes, and a file changed
 * too recently to trust its timestamps is not remembered, so an entry never vouches for newer content. */
export async function fileIdentity(file: string, signal?: AbortSignal, identities?: Map<string, Promise<string>>): Promise<string> {
    const actual = await fs.realpath(file);
    const read = async (): Promise<string> => `${actual}\0${createHash('sha256').update(await fs.readFile(actual, { signal })).digest('hex')}`;
    if (!identities) {return read();}
    const stat = await fs.stat(actual, { bigint: true }), readAt = Date.now();
    const key = `file\0${actual}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const known = identities.get(key);
    if (known) {return known;}
    const pending = read();
    if (readAt - Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs)) > hashMemoTiming.racyMs) {
        identities.set(key, pending);
        void pending.catch(() => {if (identities.get(key) === pending) {identities.delete(key);}});
    }
    return pending;
}

/** Hash commands by their resolved bytes, and tool-store dependencies when present. */
export async function preparationToolIdentity(command: string | undefined, env: NodeJS.ProcessEnv, signal?: AbortSignal, cwd = process.cwd(),
    identities?: Map<string, Promise<string>>): Promise<string | undefined> {
    if (!command) {return undefined;}
    const hasDirectory = command.includes(path.sep) || command.includes('/');
    const searchPath = !path.isAbsolute(command) && !hasDirectory;
    // POSIX '..' traverses symlinks before its parent; lexical normalization
    // could fingerprint a different file from the process launcher.
    const fromCwd = (file: string): string => path.isAbsolute(file) ? file : `${cwd}/${file}`;
    const candidates = path.isAbsolute(command) ? [command] : hasDirectory
        ? [process.platform === 'win32' ? path.resolve(cwd, command) : fromCwd(command)]
        : process.platform === 'win32'
            ? (env.PATH ?? '').split(path.delimiter).flatMap(directory => ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
                .map(extension => path.resolve(cwd, directory, command + extension)))
            // Missing PATH uses platform-specific launch defaults; do not guess cwd.
            : env.PATH === undefined ? [] : env.PATH.split(path.delimiter).map(directory => `${fromCwd(directory)}/${command}`);
    for (const candidate of candidates) {
        try {
            const resolved = await fs.realpath(candidate);
            if (!(await fs.stat(resolved)).isFile()) {continue;}
            if (searchPath && process.platform !== 'win32') {
                try {await fs.access(resolved, constants.X_OK);} catch {continue;}
            }
            // Resolve each command in its actual working directory before sharing bytes.
            // Relative PATH entries can name different tools in different projects.
            // The cache can outlive a run, so a metadata stamp detects reinstalls.
            const key = identities ? `${resolved}\0${await toolStamp(resolved)}` : resolved;
            let identity = identities?.get(key);
            if (!identity) {
                identity = hashPreparationTool(resolved, signal);
                identities?.set(key, identity);
                const pending = identity, cache = identities;
                if (cache) {void pending.catch(() => {if (cache.get(key) === pending) {cache.delete(key);}});}
            }
            return await identity;
        } catch (error) {
            signal?.throwIfAborted();
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}
        }
    }
    // A command without a verifiable executable must not produce a reusable entry.
    throw new Error(`Cannot identify preparation tool: ${command}`);
}

/** Cheap metadata covering the files hashPreparationTool reads: the command,
 * its managed siblings, and each tool-store package directory. */
async function toolStamp(resolved: string): Promise<string> {
    const stat = async (file: string): Promise<string> => fs.stat(file, { bigint: true })
        .then(value => `${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.ino}`, () => 'missing');
    const directory = path.dirname(resolved), base = path.basename(resolved, path.extname(resolved));
    const parts = [await stat(resolved), ...await Promise.all(['.dll', '.deps.json', '.runtimeconfig.json'].map(extension => stat(path.join(directory, base + extension))))];
    const store = path.join(directory, '.store');
    const packages = await fs.readdir(store).catch(() => [] as string[]);
    parts.push(await stat(store), ...await Promise.all(packages.sort().map(async name => `${name}=${await stat(path.join(store, name))}`)));
    return parts.join('|');
}

async function hashPreparationTool(resolved: string, signal?: AbortSignal): Promise<string> {
    const parts = [resolved, await fileHash(resolved, signal)];
    // A .NET tool shim can stay unchanged when its managed payload changes.
    const store = path.join(path.dirname(resolved), '.store');
    if (await fs.stat(store).then(stat => stat.isDirectory(), () => false)) {parts.push((await outputManifest(store, signal)).hash);}
    // Custom managed collectors may keep their runtime assets beside the executable.
    for (const extension of ['.dll', '.deps.json', '.runtimeconfig.json']) {
        const sibling = path.join(path.dirname(resolved), path.basename(resolved, path.extname(resolved)) + extension);
        if (sibling !== resolved && await fs.stat(sibling).then(stat => stat.isFile(), () => false)) {parts.push(sibling, await fileHash(sibling, signal));}
    }
    const deps = path.join(path.dirname(resolved), path.basename(resolved, path.extname(resolved)) + '.deps.json');
    if (await fs.stat(deps).then(stat => stat.isFile(), () => false)) {
        const assets = JSON.parse(await fs.readFile(deps, 'utf8')) as { targets?: Record<string, Record<string, Record<string, unknown>>> };
        const files = new Set<string>();
        for (const target of Object.values(assets.targets ?? {})) {for (const library of Object.values(target)) {
            for (const kind of ['runtime', 'native', 'resources', 'runtimeTargets']) {
                const references = library[kind];
                if (references && typeof references === 'object') {for (const name of Object.keys(references)) {
                    for (const relative of [name, path.basename(name)]) {
                        const file = path.resolve(path.dirname(resolved), relative);
                        if (file.startsWith(path.dirname(resolved) + path.sep) && await fs.stat(file).then(stat => stat.isFile(), () => false)) {files.add(file);}
                    }
                }}
            }
        }}
        for (const file of [...files].sort()) {parts.push(file, await fileHash(file, signal));}
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
