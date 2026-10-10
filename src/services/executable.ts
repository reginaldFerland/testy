import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';

/** Match child_process.spawn's environment-key precedence without mutating it. */
export function processEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    if (process.platform !== 'win32') {return env[name];}
    // Node selects a key before omitting undefined values. An undefined PATH
    // therefore suppresses Path, after which libuv can inherit the parent PATH.
    const keys: string[] = [];
    // Node deliberately includes enumerable inherited environment properties.
    for (const key in env) {keys.push(key);}
    const key = keys.sort().find(key => key.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
}

/** Windows path forms whose meaning depends on more than the string: quotes or
 * NUL, device namespaces (\\?\, \\.\), drive- or root-relative paths, and
 * alternate data streams. Identity checks decline these instead of guessing. */
export function ambiguousWindowsPath(value: string): boolean {
    return /["'\0]/.test(value)
        || /^[/\\]{2}[?.][/\\]/.test(value)
        || /^[a-z]:(?![/\\])/i.test(value) || /^[/\\](?![/\\])/.test(value)
        || value.replace(/^[a-z]:[/\\]/i, '').includes(':');
}

/** PE, ELF, and Mach-O (thin and universal) headers identify a native host binary. */
export function isNativeExecutable(bytes: Buffer): boolean {
    const magic = bytes.subarray(0, 4).toString('hex');
    return magic.startsWith('4d5a') || ['7f454c46', 'cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic);
}

/** Resolve ordinary shell:false Node launches, never a ProcessHost-owned command.
 * Unsupported Windows search forms decline identity; callers may still launch.
 * Node/libuv ignores PATHEXT and tries .com before .exe in each directory.
 * https://github.com/libuv/libuv/blob/v1.x/src/win/process.c#L229 */
export async function resolveNodeExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string,
    signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    if (!command) {return undefined;}
    let candidates: string[];
    if (process.platform === 'win32') {
        // Per-drive current directories and quoted PATH parsing require extra
        // platform evidence. Keep those uncommon cases outside this cache guard.
        if (ambiguousWindowsPath(command) || ambiguousWindowsPath(cwd) || !path.isAbsolute(cwd)
            || /[. ]$/.test(command)) {return undefined;}
        const name = path.basename(command), dot = name.indexOf('.');
        const hasExtension = dot >= 0 && dot < name.length - 1;
        const hasDirectory = /[/\\]/.test(command) || path.isAbsolute(command);
        // libuv versions/flags differ for exact extensionless explicit paths.
        if (hasDirectory && !hasExtension) {return undefined;}
        const names = hasExtension ? [name, `${name}.com`, `${name}.exe`] : [`${name}.com`, `${name}.exe`];
        if (hasDirectory) {
            const directory = path.dirname(path.resolve(cwd, command));
            candidates = names.map(name => path.join(directory, name));
        } else {
            // NeedCurrentDirectoryForExePathW consults the launching process,
            // not its child's options.env. Decline when that policy is changed.
            if (processEnvironmentValue(process.env, 'NoDefaultCurrentDirectoryInExePath') !== undefined) {return undefined;}
            const search = processEnvironmentValue(env, 'PATH') ?? processEnvironmentValue(process.env, 'PATH');
            if (search === undefined || /["'\0]/.test(search)) {return undefined;}
            const directories = search.split(';').filter(Boolean);
            if (directories.some(ambiguousWindowsPath)) {return undefined;}
            candidates = [cwd, ...directories.map(directory => path.resolve(cwd, directory))]
                .flatMap(directory => names.map(name => path.join(directory, name)));
        }
    } else {
        // Empty PATH entries mean cwd; an absent PATH uses platform-specific
        // defaults that this identity guard does not guess. Backslashes are
        // ordinary filename characters for shell:false POSIX launches.
        if (!command.includes('/') && env.PATH === undefined) {return undefined;}
        // Preserve '..' until filesystem traversal: a preceding symlink can
        // make lexical path normalization select a different executable.
        const fromCwd = (file: string): string => path.isAbsolute(file) ? file : `${cwd}/${file}`;
        candidates = command.includes('/') ? [fromCwd(command)]
            : env.PATH!.split(path.delimiter).map(directory => `${fromCwd(directory)}/${command}`);
    }
    for (const candidate of candidates) {
        signal?.throwIfAborted();
        let linked = false;
        try {
            if (process.platform === 'win32') {
                const stat = await fs.lstat(candidate);
                if (stat.isDirectory()) {continue;}
                linked = stat.isSymbolicLink();
                if (!stat.isFile() && !linked) {return undefined;}
            } else {
                await fs.access(candidate, constants.X_OK);
                if (!(await fs.stat(candidate)).isFile()) {continue;}
                const resolved = await fs.realpath(candidate);
                signal?.throwIfAborted();
                return resolved;
            }
        } catch (error) {
            signal?.throwIfAborted();
            if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EACCES') {return undefined;}
            if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {continue;}
            throw error;
        }
        // Once a candidate exists, a failed realpath/read must not select a
        // different later executable. The caller can decline reuse on failure.
        const resolved = await fs.realpath(candidate);
        if (linked && !(await fs.stat(resolved)).isFile()) {return undefined;}
        signal?.throwIfAborted();
        return resolved;
    }
    signal?.throwIfAborted();
    return undefined;
}

/** Successful owned-command resolutions, keyed by command and search path. Each test host
 * resolves several commands, so a short expiry still removes most repeated PATH scans
 * while a reinstalled or moved tool is found again within seconds. */
const ownedCommands = new Map<string, { readonly resolved: Promise<string>; readonly expires: number }>();
const ownedCommandLimit = 32, ownedCommandTtlMs = 30_000;

/** Resolve a bare command for a launch that must never search the workspace: the
 * Windows owner's CreateProcess would try the current directory before PATH.
 * Explicit paths pass through; bare names resolve on PATH alone. */
export function resolveOwnedCommand(command: string, env: NodeJS.ProcessEnv | undefined, cwd: string): Promise<string> {
    if (process.platform !== 'win32' || /[/\\]/.test(command) || path.isAbsolute(command)) {return Promise.resolve(command);}
    const effective = { ...process.env, ...env };
    const search = processEnvironmentValue(effective, 'PATH') ?? '';
    const key = JSON.stringify([command, search, processEnvironmentValue(effective, 'PATHEXT') ?? null]), now = Date.now();
    const cached = ownedCommands.get(key);
    if (cached && cached.expires > now) {return cached.resolved;}
    const resolved = searchOwnedCommand(command, search, cwd);
    ownedCommands.delete(key); ownedCommands.set(key, { resolved, expires: now + ownedCommandTtlMs });
    if (ownedCommands.size > ownedCommandLimit) {ownedCommands.delete(ownedCommands.keys().next().value!);}
    // A failure is reported to its callers only; the next launch searches again.
    void resolved.catch(() => {if (ownedCommands.get(key)?.resolved === resolved) {ownedCommands.delete(key);}});
    return resolved;
}

async function searchOwnedCommand(command: string, search: string, cwd: string): Promise<string> {
    const dot = command.indexOf('.', 1);
    const names = dot >= 0 && dot < command.length - 1 ? [command] : [`${command}.com`, `${command}.exe`];
    for (const directory of search.split(path.delimiter)) {
        // Relative entries would resolve against the workspace.
        if (!directory || !path.isAbsolute(directory)) {continue;}
        for (const name of names) {
            const candidate = path.join(directory, name);
            try {if ((await fs.stat(candidate)).isFile()) {return candidate;}} catch { /* Try the next candidate. */ }
        }
    }
    throw new Error(`Cannot find ${command} on PATH; the working directory ${cwd} is not searched. Configure an absolute path.`);
}
