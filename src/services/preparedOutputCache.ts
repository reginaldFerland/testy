import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Semaphore } from '../core/concurrency';
import { fileHash, PreparedOutput, removeOutput } from './output';
import { claimRunOutputs, RunOutputLease } from './runOutputs';

const readers = new Semaphore(8);
interface Manifest { readonly hash: string; readonly bytes: number; }

/** Follow the same links and exclusions as copyOutput, including executable modes. */
export async function outputManifest(directory: string, signal?: AbortSignal): Promise<Manifest> {
    const records: string[] = [];
    let bytes = 0;
    interface Job { readonly file: string; readonly relative: string; readonly ancestors: ReadonlySet<string>; }
    const queued: Job[] = [{ file: directory, relative: '', ancestors: new Set() }];
    const visit = async ({ file, relative, ancestors }: Job): Promise<Job[]> => {
        signal?.throwIfAborted();
        const real = await fs.realpath(file), stat = await fs.stat(real);
        if (stat.isDirectory()) {
            if (ancestors.has(real)) {throw new Error(`A cycle in the build output prevents safe test isolation: ${file}`);}
            records.push(JSON.stringify([relative, 'directory', stat.mode]));
            const next = new Set([...ancestors, real]);
            return (await fs.readdir(real)).filter(name => name !== 'TestResults')
                .map(name => ({ file: path.join(real, name), relative: path.join(relative, name), ancestors: next }));
        } else if (stat.isFile()) {
            const hash = await fileHash(real, signal);
            bytes += stat.size;
            records.push(JSON.stringify([relative, 'file', stat.mode, stat.size, hash]));
            return [];
        } else {throw new Error(`Unsupported build output: ${file}`);}
    };
    // Metadata operations share the same bound as reads across all concurrent manifests.
    await new Promise<void>((resolve, reject) => {
        let active = 0, failed = false, failure: unknown;
        const pump = (): void => {
            if (failed) {queued.length = 0;}
            while (active < 8 && queued.length) {
                const job = queued.pop()!; active++;
                void readers.run(signal, () => visit(job)).then(children => {if (!failed) {for (const child of children) {queued.push(child);}}})
                    .catch(error => {if (!failed) {failed = true; failure = error;}})
                    .finally(() => {active--; pump();});
            }
            if (!active && !queued.length) {if (failed) {reject(failure);} else {resolve();}}
        };
        pump();
    });
    records.sort();
    return { hash: createHash('sha256').update(records.join('\n')).digest('hex'), bytes };
}

/** Hash commands by their resolved bytes, and tool-store dependencies when present. */
export async function preparationToolIdentity(command: string | undefined, env: NodeJS.ProcessEnv, signal?: AbortSignal, cwd = process.cwd(),
    identities?: Map<string, Promise<string>>): Promise<string | undefined> {
    if (!command) {return undefined;}
    const searchPath = !path.isAbsolute(command) && !command.includes(path.sep);
    const candidates = path.isAbsolute(command) ? [command] : command.includes(path.sep) ? [path.resolve(cwd, command)]
        : (env.PATH ?? '').split(path.delimiter).flatMap(directory => process.platform === 'win32'
            ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')].map(extension => path.resolve(cwd, directory, command + extension))
            : [path.resolve(cwd, directory, command)]);
    for (const candidate of candidates) {
        try {
            const resolved = await fs.realpath(candidate);
            if (!(await fs.stat(resolved)).isFile()) {continue;}
            if (searchPath && process.platform !== 'win32') {
                try {await fs.access(resolved, constants.X_OK);} catch {continue;}
            }
            // Resolve each command in its actual working directory before sharing bytes.
            // Relative PATH entries can name different tools in different projects.
            let identity = identities?.get(resolved);
            if (!identity) {
                identity = hashPreparationTool(resolved, signal);
                identities?.set(resolved, identity);
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

export interface PreparedArtifact {
    readonly root: string;
    readonly output: PreparedOutput;
    readonly session: string;
    readonly coverage: boolean;
    /** Discovery-only template that may be instrumented by its exclusive owner. */
    readonly coveragePending?: boolean;
    readonly instrumented: readonly string[];
    readonly reusable: boolean;
}
export interface PreparedArtifactLease {
    readonly artifact: PreparedArtifact;
    readonly hit: boolean;
    update(artifact: PreparedArtifact, signal?: AbortSignal): Promise<void>;
    release(reusable?: boolean): Promise<void>;
}
interface Entry {
    readonly key: string;
    readonly slot?: string;
    artifact: PreparedArtifact;
    template: Manifest;
    bytes: number;
    active: boolean;
    retired: boolean;
    used: number;
    released: Promise<void>;
    finish: () => void;
}
export interface PreparedOutputLimits { readonly maxEntries?: number; readonly maxBytes?: number; }

/** Engine-owned artifacts only; no executable output is reused across extension lifetimes. */
export class PreparedOutputCache {
    private readonly entries = new Set<Entry>();
    private readonly claimedSlots = new Set<string>();
    private readonly pending = new Set<Promise<unknown>>();
    private owner?: Promise<RunOutputLease>;
    private closed = false;
    private disposal?: Promise<void>;
    private clock = 0;
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    constructor(private readonly storage: string, private readonly identity: string, limits: PreparedOutputLimits = {}) {
        this.maxEntries = limits.maxEntries ?? 16;
        this.maxBytes = limits.maxBytes ?? 512 * 1024 * 1024;
        if (![this.maxEntries, this.maxBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {throw new Error('Invalid prepared output cache limit.');}
    }

    async acquire(source: string, context: string, create: (root: string) => Promise<PreparedArtifact>, signal?: AbortSignal, slot?: string): Promise<PreparedArtifactLease | undefined> {
        if (this.closed) {throw new Error('The prepared output cache has been disposed.');}
        const pending = this.acquireArtifact(source, context, create, signal, slot);
        return this.track(pending);
    }

    private track<T>(pending: Promise<T>): Promise<T> {
        this.pending.add(pending);
        void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
        return pending;
    }

    private async acquireArtifact(source: string, context: string, create: (root: string) => Promise<PreparedArtifact>, signal?: AbortSignal, slot?: string): Promise<PreparedArtifactLease | undefined> {
        let sourceManifest: Manifest | undefined, root: string;
        try {
            this.owner ??= claimRunOutputs(path.join(this.storage, 'prepared'), this.identity, signal).catch(error => {this.owner = undefined; throw error;});
            root = (await this.owner).directory;
        } catch {signal?.throwIfAborted(); return undefined;}
        try {sourceManifest = await outputManifest(source, signal);} catch {signal?.throwIfAborted();}
        if (slot && this.claimedSlots.has(slot)) {return undefined;}
        if (slot) {this.claimedSlots.add(slot);}
        try {
            const lease = await this.acquireOwnedArtifact(source, context, sourceManifest, root, create, signal, slot);
            if (!lease && slot) {this.claimedSlots.delete(slot);}
            return lease;
        }
        catch (error) {if (slot) {this.claimedSlots.delete(slot);} throw error;}
    }

    private async acquireOwnedArtifact(source: string, context: string, sourceManifest: Manifest | undefined, root: string,
        create: (root: string) => Promise<PreparedArtifact>, signal?: AbortSignal, slot?: string): Promise<PreparedArtifactLease | undefined> {
        const key = createHash('sha256').update(context).update(sourceManifest?.hash ?? randomUUID()).digest('hex');
        for (const entry of this.entries) {
            if (entry.slot !== slot || entry.active) {continue;}
            if (entry.retired) {
                if (slot) {try {await this.remove(entry);} catch {signal?.throwIfAborted(); return undefined;}}
                continue;
            }
            if (entry.key !== key) {if (slot) {await this.remove(entry);} continue;}
            this.reserve(entry);
            try {
                if ((await outputManifest(entry.artifact.output.template, signal)).hash !== entry.template.hash) {throw new Error('Prepared output template changed.');}
                await entry.artifact.output.restore(signal);
                return this.lease(entry, true);
            } catch (error) {
                await this.remove(entry);
                signal?.throwIfAborted();
            }
        }
        const directory = path.join(root, slot ? createHash('sha256').update(slot).digest('hex') : randomUUID());
        try {await fs.mkdir(directory);} catch {signal?.throwIfAborted(); return undefined;}
        let artifact: PreparedArtifact;
        try {artifact = await create(directory);} catch (error) {await removeOutput(directory); throw error;}
        let template: Manifest, unchanged = false;
        try {
            template = await outputManifest(artifact.output.template, signal);
            unchanged = !!sourceManifest && (await outputManifest(source, signal)).hash === sourceManifest.hash;
        } catch (error) {
            if (signal?.aborted) {await removeOutput(directory); throw error;}
            return this.temporary(artifact, slot);
        }
        const entry: Entry = { key, slot, artifact: unchanged ? artifact : { ...artifact, reusable: false }, template,
            bytes: template.bytes * 2, active: false, retired: false, used: ++this.clock, released: Promise.resolve(), finish: () => undefined };
        this.reserve(entry); this.entries.add(entry);
        await this.trim();
        return this.lease(entry, false);
    }

    private reserve(entry: Entry): void {
        entry.active = true;
        entry.released = new Promise(resolve => {entry.finish = resolve;});
    }

    private temporary(artifact: PreparedArtifact, slot?: string): PreparedArtifactLease {
        // Track uncached artifacts as active entries too, so dispose waits for their owners.
        const entry: Entry = { key: '', slot, artifact: { ...artifact, reusable: false }, template: { hash: '', bytes: 0 }, bytes: 0,
            active: false, retired: false, used: ++this.clock, released: Promise.resolve(), finish: () => undefined };
        this.reserve(entry); this.entries.add(entry);
        return this.lease(entry, false);
    }

    private lease(entry: Entry, hit: boolean): PreparedArtifactLease {
        let release: Promise<void> | undefined, updating: Promise<void> | undefined;
        return { get artifact() {return entry.artifact;}, hit,
            update: (artifact, signal) => {
                if (release || updating) {return Promise.reject(new Error('The prepared output lease is already updating or releasing.'));}
                updating = this.track((async () => {
                    if (artifact.root !== entry.artifact.root || artifact.output.directory !== entry.artifact.output.directory
                        || artifact.output.template !== entry.artifact.output.template) {throw new Error('A prepared output upgrade must preserve its private paths.');}
                    entry.artifact = { ...artifact, reusable: entry.artifact.reusable && artifact.reusable };
                    try {entry.template = await outputManifest(artifact.output.template, signal); entry.bytes = entry.template.bytes * 2;}
                    catch (error) {entry.retired = true; throw error;}
                })());
                return updating;
            },
            release: (reusable = true) => release ??= this.track((async () => {
                if (updating) {try {await updating;} catch {reusable = false;}}
                await this.release(entry, reusable);
            })()) };
    }

    private async release(entry: Entry, reusable: boolean): Promise<void> {
        const finish = entry.finish;
        let claimed = !!entry.slot;
        const unclaim = (): void => {if (claimed) {this.claimedSlots.delete(entry.slot!); claimed = false;}};
        try {
            if (!reusable || !entry.artifact.reusable || entry.retired || this.closed) {await this.remove(entry); return;}
            // Reports, result attachments and observer payloads never enter retained storage.
            for (const name of await fs.readdir(entry.artifact.root)) {
                if (name !== 'template' && name !== 'assembly') {await removeOutput(path.join(entry.artifact.root, name));}
            }
            await entry.artifact.output.restore();
            unclaim();
            entry.active = false; entry.used = ++this.clock;
            await this.trim();
        } catch {await this.remove(entry);}
        finally {unclaim(); finish();}
    }

    private async remove(entry: Entry): Promise<void> {
        const claimed = !!entry.slot && !this.claimedSlots.has(entry.slot);
        if (claimed) {this.claimedSlots.add(entry.slot!);}
        this.entries.delete(entry);
        try {await removeOutput(entry.artifact.root);}
        catch (error) {
            // Keep failed deletions counted and retry them during later trimming or disposal.
            // Their templates may have been partially removed, so they cannot be reused.
            entry.retired = true; this.entries.add(entry); throw error;
        } finally {
            if (claimed) {this.claimedSlots.delete(entry.slot!);}
            entry.active = false; entry.finish();
        }
    }

    private async trim(): Promise<void> {
        let bytes = [...this.entries].reduce((total, entry) => total + entry.bytes, 0);
        for (const entry of [...this.entries].filter(entry => !entry.active).sort((left, right) => left.used - right.used)) {
            if (entry.active || (entry.slot && this.claimedSlots.has(entry.slot)) || !this.entries.has(entry)) {continue;}
            if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) {break;}
            try {await this.remove(entry); bytes -= entry.bytes;}
            catch { /* Eviction cannot invalidate a newly admitted or concurrently reacquired lease. */ }
        }
    }

    dispose(): Promise<void> {
        this.closed = true;
        return this.disposal ??= (async () => {
            while (this.pending.size) {await Promise.allSettled(this.pending);}
            await Promise.allSettled([...this.entries].filter(entry => entry.active).map(entry => entry.released));
            while (this.pending.size) {await Promise.allSettled(this.pending);}
            const removed = await Promise.allSettled([...this.entries].map(entry => this.remove(entry)));
            const owner = await Promise.allSettled([Promise.resolve().then(async () => (await this.owner)?.dispose())]);
            const errors = [...removed, ...owner].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
            if (errors.length) {throw new AggregateError(errors, `Prepared output cleanup failed: ${errors.map(String).join('; ')}`);}
        })();
    }
}
