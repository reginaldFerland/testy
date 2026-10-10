import * as path from 'node:path';
import { helperPath } from './assets';
import { ProcessOptions } from './process';
import { ambiguousWindowsPath, resolveNodeExecutable, resolveOwnedCommand } from './executable';
import { preparationToolIdentity } from './preparationTools';

interface PreparationTools extends Pick<ProcessOptions, 'signal' | 'dotnetHost' | 'cleanupDescendants'> {
    readonly dotnet: string;
    readonly coverageTool?: string | undefined;
    readonly analyzer?: string;
}

/** Windows template inputs, not a claim about fresh owned MTP command lookup. */
export async function windowsPreparationTools(options: PreparationTools, env: NodeJS.ProcessEnv, cwd: string,
    identities: Map<string, Promise<string>>): Promise<unknown> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const asset = (file: string | undefined): Promise<string | undefined> => file === undefined ? Promise.resolve(undefined)
        : preparationToolIdentity(path.resolve(cwd, file), env, signal, cwd, identities);
    const node = async (command: string | undefined): Promise<string | undefined> => {
        if (command === undefined) {return undefined;}
        const resolved = await resolveNodeExecutable(command, env, cwd, signal);
        if (!resolved) {throw new Error(`Cannot identify direct preparation executable: ${command}`);}
        return asset(resolved);
    };
    const owned = !!options.coverageTool && options.cleanupDescendants !== false;
    const instrumenter = async (): Promise<string | undefined> => {
        if (!owned) {return node(options.coverageTool);}
        const command = options.coverageTool;
        // ProcessHost passes lpApplicationName explicitly: explicit paths as given, bare
        // names from absolute PATH entries only. That differs from Node's search, so
        // identity stays conservative and requires an explicit existing path.
        if (!path.isAbsolute(command) || !path.extname(command) || /[. ]$/.test(command) || ambiguousWindowsPath(command)) {
            throw new Error(`Cannot identify owned preparation executable without an explicit path: ${command}`);
        }
        return asset(command);
    };
    // Drain every admitted identity read before the caller falls back or cleans
    // up. Dotnet remains conservative extra context; the analyzer is file data.
    const results = await Promise.allSettled([
        node(options.dotnet), instrumenter(), asset(options.analyzer),
        // runProcess launches the owner through resolveOwnedCommand (PATH only, never the cwd).
        owned ? resolveOwnedCommand(options.dotnetHost ?? 'dotnet', env, cwd).then(asset) : Promise.resolve(undefined),
        owned ? asset(helperPath('processhost', 'Testy.ProcessHost.dll')) : Promise.resolve(undefined)
    ]);
    signal?.throwIfAborted();
    const [dotnetNode, collector, analyzerAsset, ownerNode, ownerAsset] = results.map(result => {
        if (result.status === 'rejected') {throw result.reason;} return result.value;
    });
    return {
        instrumentationLaunch: !options.coverageTool ? 'none' : owned ? 'windows-owner-explicit' : 'node',
        commands: { dotnet: options.dotnet, collector: options.coverageTool, analyzer: options.analyzer,
            owner: owned ? options.dotnetHost ?? 'dotnet' : undefined },
        dotnetNode, collector, analyzerAsset, ownerNode, ownerAsset
    };
}
