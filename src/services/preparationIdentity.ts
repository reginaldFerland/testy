import * as path from 'node:path';
import { ProcessOptions } from './process';
import { resolveNodeExecutable } from './executable';
import { preparationToolIdentity } from './preparedOutputCache';

interface PreparationTools extends Pick<ProcessOptions, 'signal' | 'dotnetHost' | 'cleanupDescendants'> {
    readonly dotnet: string;
    readonly coverageTool?: string;
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
        const command = options.coverageTool!;
        // ProcessHost calls CreateProcessW with a null application name. Its
        // bare-name search differs from Node's; explicit existing paths avoid it.
        if (!path.isAbsolute(command) || !path.extname(command) || /["'\0]/.test(command)
            || /^[/\\](?![/\\])/.test(command) || /[. ]$/.test(command)
            || /^[/\\]{2}[?.][/\\]/.test(command)
            || command.replace(/^[a-z]:[/\\]/i, '').includes(':')) {
            throw new Error(`Cannot identify owned preparation executable without an explicit path: ${command}`);
        }
        return asset(command);
    };
    // Drain every admitted identity read before the caller falls back or cleans
    // up. Dotnet remains conservative extra context; the analyzer is file data.
    const results = await Promise.allSettled([
        node(options.dotnet), instrumenter(), asset(options.analyzer),
        owned ? node(options.dotnetHost ?? 'dotnet') : Promise.resolve(undefined),
        owned ? asset(path.join(__dirname, '../../dist/processhost/Testy.ProcessHost.dll')) : Promise.resolve(undefined)
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
