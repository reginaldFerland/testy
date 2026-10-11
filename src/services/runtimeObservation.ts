import * as fs from 'node:fs/promises';
import { helperPath } from './assets';
import * as path from 'node:path';
import { normalizePath, pathNormalizer } from '../core/paths';

export interface RuntimeModule { readonly name: string; readonly project?: string; readonly sources: readonly string[]; }

/** Observe module loads that static coverage in private output cannot see. */
export class RuntimeObservation {
    private constructor(readonly env: NodeJS.ProcessEnv, private readonly directory: string,
        private readonly assembly: string, private readonly modules: readonly RuntimeModule[], private readonly instrumented: ReadonlySet<string>) {}

    static async start(directory: string, assembly: string, modules: readonly RuntimeModule[], instrumented: readonly string[], env?: NodeJS.ProcessEnv): Promise<RuntimeObservation> {
        const hook = helperPath('observer', 'Testy.RuntimeObserver.dll');
        await fs.access(hook);
        await fs.mkdir(directory, { recursive: true });
        const manifest = path.join(directory, 'manifest.txt');
        await fs.writeFile(manifest, [directory, assembly, ...new Set(modules.map(module => module.name))].map(value => Buffer.from(value).toString('base64')).join('\n'));
        const hooks = env?.DOTNET_STARTUP_HOOKS ?? process.env.DOTNET_STARTUP_HOOKS;
        return new RuntimeObservation({ ...env, DOTNET_STARTUP_HOOKS: [hook, hooks].filter(Boolean).join(path.delimiter), TESTY_RUNTIME_OBSERVATION: manifest },
            directory, normalizePath(assembly), modules, new Set(instrumented.map(normalizePath)));
    }

    /** The workspace sources and projects the observed processes loaded outside the instrumented copies. `live`: the test host is
     * still running (a reused host, see RunnerOptions.reuseHosts), so its log has no completion record yet; every whole line so far
     * counts, which is everything it loaded up to now. */
    async dependencies(signal?: AbortSignal, live = false): Promise<{ files: readonly string[]; projects: readonly string[] }> {
        const normalize = pathNormalizer(), byName = new Map<string, RuntimeModule[]>();
        for (const module of this.modules) {
            const name = module.name.toLowerCase(), modules = byName.get(name) ?? [];
            modules.push(module); byName.set(name, modules);
        }
        let host = false;
        const hostEntry = (first: string): boolean => {
            try {return normalize(decodeText(first.slice('ready\t'.length))) === this.assembly;} catch {return false;}
        };
        const dependencies = new Set<string>();
        const projects = new Set<string>();
        for (const file of await fs.readdir(this.directory)) {
            signal?.throwIfAborted();
            if (!file.endsWith('.log')) {continue;}
            const report = path.join(this.directory, file);
            if ((await fs.stat(report)).size > 8 * 1024 * 1024) {throw new Error('Runtime observation exceeded its report limit.');}
            const text = await fs.readFile(report, { encoding: 'utf8', signal });
            // A live writer may be in the middle of a line; only whole lines count.
            const lines = (live && !text.endsWith('\n') ? text.slice(0, text.lastIndexOf('\n') + 1) : text).trimEnd().split(/\r?\n/);
            const liveHost = live && lines.at(-1)?.startsWith('complete\t') !== true && lines[0]?.startsWith('ready\t') === true && hostEntry(lines[0]);
            if (!liveHost && (lines.at(-1) !== 'complete\ttrue' || !lines[0]?.startsWith('ready\t'))) {
                // Other .NET processes in the owned tree (the collector, MSBuild nodes,
                // compiler servers) write logs too, and may be killed before completing.
                // Only the test host's log must be whole; the host check below covers its absence.
                let entry: string | undefined;
                try {entry = decodeText(lines[0]?.slice('ready\t'.length) ?? '');} catch { /* Not a readable log. */ }
                if (lines[0]?.startsWith('ready\t') && entry !== undefined && normalize(entry) === this.assembly) {throw new Error('A runtime observation was incomplete.');}
                continue;
            }
            const entry = decodeText(lines[0]!.slice('ready\t'.length));
            host ||= !!entry && normalize(entry) === this.assembly;
            for (const line of lines.slice(1, liveHost ? undefined : -1)) {
                const [kind, name, location] = line.split('\t');
                if (kind !== 'module' || name === undefined || location === undefined) {throw new Error('Invalid runtime observation.');}
                const modules = byName.get(decodeText(name).toLowerCase());
                if (!modules) {throw new Error('Unknown module in runtime observation.');}
                const loaded = decodeText(location);
                if (loaded && this.instrumented.has(normalize(loaded))) {continue;}
                for (const module of modules) {
                    for (const source of module.sources) {dependencies.add(source);}
                    if (module.project) {projects.add(module.project);}
                }
            }
        }
        if (!host) {throw new Error('The test host did not provide a runtime observation.');}
        return { files: [...dependencies], projects: [...projects] };
    }
}

/** A base64 field of an observation log, which must round-trip exactly. */
function decodeText(value: string): string {
    const bytes = Buffer.from(value, 'base64'), text = bytes.toString('utf8');
    if (bytes.toString('base64') !== value || !Buffer.from(text).equals(bytes)) {throw new Error('Invalid runtime observation text.');}
    return text;
}
