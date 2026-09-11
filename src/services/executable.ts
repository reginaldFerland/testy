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
        const ambiguousPath = (value: string): boolean => /["'\0]/.test(value)
            || /^[/\\]{2}[?.][/\\]/.test(value)
            || /^[a-z]:(?![/\\])/i.test(value) || /^[/\\](?![/\\])/.test(value)
            || value.replace(/^[a-z]:[/\\]/i, '').includes(':');
        if (ambiguousPath(command) || ambiguousPath(cwd) || !path.isAbsolute(cwd)
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
            if (directories.some(ambiguousPath)) {return undefined;}
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
