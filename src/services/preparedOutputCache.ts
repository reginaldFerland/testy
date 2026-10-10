import * as fs from 'node:fs/promises';
import { Stats } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Semaphore, walkTree } from '../core/concurrency';
import { fileHash, PreparedOutput, removeOutput } from './output';
import { claimRunOutputs, RunOutputLease } from './runOutputs';
import { claimPreparedStorage, PreparedStorageLease, PreparedStorageShrink, Retention } from './preparedStorage';
import { uuidPattern as uuid } from '../core/paths';
import { HashMemo } from './hashMemo';

const readers = new Semaphore(8);
interface Manifest { readonly hash: string; readonly bytes: number; }
/** What a retained preparation costs against the byte budget: its template and its working copy. */
const footprint = (template: Manifest): number => template.bytes * 2;

/** Hashes remembered within one session, by real path, so a preparation does not read unchanged files again. */
async function memoizedHash(file: string, stat: Stats, memo: HashMemo | undefined, signal?: AbortSignal): Promise<string> {
    const known = memo?.get(file, stat);
    if (known !== undefined) {return known;}
    const hashedAt = Date.now(), hash = await fileHash(file, signal);
    // The metadata read before hashing is kept: a later write changes it, so the entry cannot vouch for newer bytes.
    memo?.set(file, stat, hash, hashedAt);
    return hash;
}

/** Follow the same links and exclusions as copyOutput, including executable modes. */
export async function outputManifest(directory: string, signal?: AbortSignal, followLinks = true, memo?: HashMemo): Promise<Manifest> {
    const records: string[] = [];
    let bytes = 0;
    /** `link` is known for listed entries, whose parent is a real path; only links and the root need resolving. */
    interface Job { readonly file: string; readonly relative: string; readonly ancestors: ReadonlySet<string>; readonly link?: boolean; }
    const visit = async ({ file, relative, ancestors, link }: Job): Promise<Job[]> => {
        signal?.throwIfAborted();
        link ??= (await fs.lstat(file)).isSymbolicLink();
        if (!followLinks && link) {throw new Error('A retained preparation contains a symbolic link.');}
        const real = link || !relative ? await fs.realpath(file) : file, stat = await fs.stat(real);
        if (stat.isDirectory()) {
            if (ancestors.has(real)) {throw new Error(`A cycle in the build output prevents safe test isolation: ${file}`);}
            records.push(JSON.stringify([relative, 'directory', stat.mode]));
            const next = new Set([...ancestors, real]);
            return (await fs.readdir(real, { withFileTypes: true })).filter(entry => entry.name !== 'TestResults')
                .map(entry => ({ file: path.join(real, entry.name), relative: path.join(relative, entry.name), ancestors: next, link: entry.isSymbolicLink() }));
        } else if (stat.isFile()) {
            const hash = await memoizedHash(real, stat, memo, signal);
            bytes += stat.size;
            records.push(JSON.stringify([relative, 'file', stat.mode, stat.size, hash]));
            return [];
        } else {throw new Error(`Unsupported build output: ${file}`);}
    };
    // Metadata operations share the same bound as reads across all concurrent manifests.
    await walkTree([{ file: directory, relative: '', ancestors: new Set<string>() }], visit, readers, signal);
    records.sort();
    return { hash: createHash('sha256').update(records.join('\n')).digest('hex'), bytes };
}

export interface PreparedArtifact {
    readonly root: string;
    readonly output: PreparedOutput;
    readonly session: string;
    readonly coverage: boolean;
    /** Discovery-only template that may be instrumented by its exclusive owner. */
    readonly coveragePending?: boolean | undefined;
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
    readonly slot?: string | undefined;
    artifact: PreparedArtifact;
    template: Manifest;
    bytes: number;
    active: boolean;
    retired: boolean;
    used: number;
    released: Promise<void>;
    finish: () => void;
    uninitialized?: boolean;
}
export interface PreparedOutputLimits {
    readonly maxEntries?: number; readonly maxBytes?: number; readonly persist?: boolean;
    /** Diagnostics for optional caching steps that fall back silently. */
    readonly log?: (text: string) => void;
}
interface StoredEntry {
    readonly directory: string;
    readonly key: string;
    readonly slot?: string | undefined;
    readonly template: Manifest;
    readonly used: number;
    readonly session: string;
    readonly coverage: boolean;
    readonly coveragePending?: boolean | undefined;
    readonly instrumented: readonly string[];
}
const sha256 = /^[0-9a-f]{64}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const relativeFile = (value: unknown): value is string => typeof value === 'string' && !!value && !path.isAbsolute(value)
    && !value.split(/[/\\]/).some(part => part === '..' || part === '.' || !part) && !/^[a-z]:/i.test(value);

function storedEntries(snapshot: unknown): readonly StoredEntry[] {
    if (!object(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) {throw new Error('Unsupported prepared-output snapshot.');}
    const directories = new Set<string>(), slots = new Set<string>();
    for (const entry of snapshot.entries) {
        if (!object(entry) || typeof entry.directory !== 'string' || !(uuid.test(entry.directory) || sha256.test(entry.directory))
            || typeof entry.key !== 'string' || !sha256.test(entry.key) || typeof entry.session !== 'string' || !uuid.test(entry.session)
            || typeof entry.coverage !== 'boolean' || (entry.coveragePending !== undefined && typeof entry.coveragePending !== 'boolean')
            || !object(entry.template) || typeof entry.template.hash !== 'string' || !sha256.test(entry.template.hash)
            || !Number.isSafeInteger(entry.template.bytes) || (entry.template.bytes as number) < 0 || (entry.template.bytes as number) > Number.MAX_SAFE_INTEGER / 2
            || !Number.isSafeInteger(entry.used) || (entry.used as number) < 0
            || !Array.isArray(entry.instrumented) || !entry.instrumented.every(relativeFile)
            || (entry.slot !== undefined && (typeof entry.slot !== 'string' || !entry.slot
                || createHash('sha256').update(entry.slot).digest('hex') !== entry.directory || slots.has(entry.slot)))
            || directories.has(entry.directory)) {throw new Error('Invalid prepared-output snapshot.');}
        directories.add(entry.directory);
        if (typeof entry.slot === 'string') {slots.add(entry.slot);}
    }
    return snapshot.entries as readonly StoredEntry[];
}

/** Drop the least recently used entries until the snapshot fits the target, as eviction does in memory. */
function shrinkSnapshot(snapshot: unknown, target: Retention): PreparedStorageShrink | undefined {
    let entries: readonly StoredEntry[];
    try {entries = storedEntries(snapshot);} catch {return undefined;}
    const kept = new Set(entries);
    let bytes = entries.reduce((total, entry) => total + footprint(entry.template), 0);
    for (const entry of [...entries].sort((left, right) => left.used - right.used)) {
        if (kept.size <= target.entries && bytes <= target.bytes) {break;}
        kept.delete(entry); bytes -= footprint(entry.template);
    }
    const retained = entries.filter(entry => kept.has(entry));
    return { snapshot: { version: 1, entries: retained }, retention: { entries: retained.length, bytes },
        removed: entries.filter(entry => !kept.has(entry)).map(entry => entry.directory) };
}

/** Slots shaped like [target, lane] are lanes of one target; any other slot stands alone. */
function targetOf(slot: string | undefined): string {
    try {
        const parts: unknown = JSON.parse(slot ?? 'null');
        if (Array.isArray(parts) && typeof parts[0] === 'string') {return parts[0];}
    } catch { /* an opaque slot name */ }
    return slot ?? '';
}

/** Exclusive artifacts; clean shutdown can park validated templates for another engine. */
export class PreparedOutputCache {
    private readonly entries = new Set<Entry>();
    private readonly claimedSlots = new Set<string>();
    private readonly hashes = new HashMemo(50_000);
    /** Source walks in flight, so the lanes of one target share a walk; `sequence` orders their starts. */
    private readonly walks = new Map<string, { readonly started: number; readonly manifest: Promise<Manifest> }>();
    private sequence = 0;
    private readonly pending = new Set<Promise<unknown>>();
    private owner: Promise<RunOutputLease | PreparedStorageLease> | undefined;
    private closed = false;
    private disposal?: Promise<void>;
    private clock = 0;
    private maxEntries: number;
    private readonly maxBytes: number;
    private readonly persist: boolean;
    private readonly log: (text: string) => void;
    constructor(private readonly storage: string, private readonly identity: string, limits: PreparedOutputLimits = {}) {
        this.log = limits.log ?? (() => undefined);
        this.maxEntries = limits.maxEntries ?? 16;
        this.maxBytes = limits.maxBytes ?? 512 * 1024 * 1024;
        this.persist = limits.persist ?? false;
        if (![this.maxEntries, this.maxBytes].every(value => Number.isSafeInteger(value) && value >= 0)) {throw new Error('Invalid prepared output cache limit.');}
    }

    /** Retain the run's possible private slots; the byte budget still bounds storage. */
    ensureCapacity(entries: number): Promise<void> {
        if (this.closed) {return Promise.reject(new Error('The prepared output cache has been disposed.'));}
        if (!Number.isSafeInteger(entries) || entries < 0) {return Promise.reject(new Error('Invalid prepared output cache limit.'));}
        this.maxEntries = Math.max(this.maxEntries, entries);
        return this.track((async () => {
            const owner = await this.owner;
            if (owner && 'reserveEntries' in owner) {owner.reserveEntries(this.maxEntries);}
        })());
    }

    /** A sequence mark: a source walk started after it reads every build output written before it was taken. */
    mark(): number { return this.sequence; }

    /** `after`: a mark taken once the build of `source` completed (see mark), so a walk of an older build is never joined. */
    async acquire(source: string, context: string, create: (root: string) => Promise<PreparedArtifact>, signal?: AbortSignal, slot?: string, after = -1): Promise<PreparedArtifactLease | undefined> {
        if (this.closed) {throw new Error('The prepared output cache has been disposed.');}
        const pending = this.acquireArtifact(source, context, create, signal, slot, after);
        return this.track(pending);
    }

    private track<T>(pending: Promise<T>): Promise<T> {
        this.pending.add(pending);
        void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
        return pending;
    }

    private async acquireArtifact(source: string, context: string, create: (root: string) => Promise<PreparedArtifact>, signal?: AbortSignal, slot?: string, after = -1): Promise<PreparedArtifactLease | undefined> {
        let sourceManifest: Manifest | undefined, root: string;
        // A claimed slot is refused before any directory is read.
        if (slot && this.claimedSlots.has(slot)) {return undefined;}
        if (slot) {this.claimedSlots.add(slot);}
        let held = false;
        try {
            try {
                this.owner ??= this.claimOwner(signal).catch((error: unknown) => {this.owner = undefined; throw error;});
                root = (await this.owner).directory;
            } catch (error) {signal?.throwIfAborted(); this.log(`Prepared output storage unavailable; preparing without the cache. ${String(error)}\n`); return undefined;}
            try {sourceManifest = await this.sourceManifest(source, signal, after);}
            catch (error) {signal?.throwIfAborted(); this.log(`Build output could not be fingerprinted; its preparation will not be reused. ${String(error)}\n`);}
            const lease = await this.acquireOwnedArtifact(source, context, sourceManifest, root, create, signal, slot);
            held = !!lease;
            return lease;
        } finally {if (slot && !held) {this.claimedSlots.delete(slot);}}
    }
    /** Walk a build output, joining a walk another lane started. Only walks that began after `after`
     * (a sequence mark) qualify, since earlier ones may predate changes the caller must observe. */
    private async sourceManifest(source: string, signal?: AbortSignal, after = -1): Promise<Manifest> {
        let walk = this.walks.get(source);
        if (!walk || walk.started <= after) {
            const manifest = outputManifest(source, signal, true, this.hashes);
            const own = walk = { started: ++this.sequence, manifest };
            this.walks.set(source, own);
            const forget = (): void => {if (this.walks.get(source) === own) {this.walks.delete(source);}};
            manifest.then(forget, forget);
            return manifest;
        }
        try {return await walk.manifest;}
        catch {
            // The shared walk may have been cut short by another lane's signal.
            signal?.throwIfAborted();
            if (this.walks.get(source) === walk) {this.walks.delete(source);}
            return outputManifest(source, signal, true, this.hashes);
        }
    }

    private async claimOwner(signal?: AbortSignal): Promise<RunOutputLease | PreparedStorageLease> {
        if (!this.persist) {return claimRunOutputs(path.join(this.storage, 'prepared'), this.identity, signal, this.log);}
        const owner = await claimPreparedStorage(path.join(this.storage, 'prepared-v2'), signal,
            { maxEntries: this.maxEntries, maxBytes: this.maxBytes, shrink: shrinkSnapshot, log: this.log });
        try {
            if (owner.snapshot !== undefined) {
                let saved: readonly StoredEntry[];
                try {saved = storedEntries(owner.snapshot);}
                catch (error) {
                    this.log(`Retained preparations from a previous session were discarded. ${String(error)}\n`);
                    // Only extension-owned contents of the exclusively claimed container are removed.
                    for (const name of await fs.readdir(owner.directory)) {await removeOutput(path.join(owner.directory, name));}
                    return owner;
                }
                const entries = saved.map(value => {
                    const root = path.join(owner.directory, value.directory), directory = path.join(root, 'assembly');
                    const artifact: PreparedArtifact = { root, output: new PreparedOutput(path.join(root, 'template'), directory),
                        session: value.session, coverage: value.coverage, coveragePending: value.coveragePending,
                        instrumented: value.instrumented.map(file => path.join(directory, file)), reusable: true };
                    return { key: value.key, slot: value.slot, artifact, template: value.template, bytes: footprint(value.template),
                        active: false, retired: false, used: value.used, released: Promise.resolve(), finish: () => undefined, uninitialized: true };
                });
                for (const entry of entries) {this.entries.add(entry); this.clock = Math.max(this.clock, entry.used);}
            }
            return owner;
        } catch (error) {await owner.dispose(); throw error;}
    }

    private async acquireOwnedArtifact(source: string, context: string, sourceManifest: Manifest | undefined, root: string,
        create: (root: string) => Promise<PreparedArtifact>, signal?: AbortSignal, slot?: string): Promise<PreparedArtifactLease | undefined> {
        const key = createHash('sha256').update(context).update(sourceManifest?.hash ?? randomUUID()).digest('hex');
        for (const entry of this.entries) {
            if (entry.slot !== slot || entry.active) {continue;}
            if (entry.retired || entry.key !== key) {
                // A slot names one directory; until its previous contents are gone,
                // this preparation proceeds outside the cache instead of failing.
                if (slot && !await this.tryRemove(entry, signal)) {return undefined;}
                continue;
            }
            this.reserve(entry);
            try {
                if (entry.uninitialized) {
                    const directory = await fs.lstat(entry.artifact.root);
                    if (!directory.isDirectory() || directory.isSymbolicLink()) {throw new Error('Invalid retained preparation directory.');}
                }
                if ((await outputManifest(entry.artifact.output.template, signal, !entry.uninitialized, this.hashes)).hash !== entry.template.hash) {throw new Error('Prepared output template changed.');}
                if (entry.uninitialized) {
                    await removeOutput(entry.artifact.output.directory);
                    await entry.artifact.output.initialize(signal);
                    entry.uninitialized = false;
                } else {await entry.artifact.output.restore(signal);}
                return this.lease(entry, true);
            } catch (error) {
                // An interrupted validation leaves the entry as it was found; the next acquire revalidates it.
                if (signal?.aborted) {entry.active = false; entry.finish(); signal.throwIfAborted();}
                this.log(`Discarding a retained preparation: ${String(error)}\n`);
                if (!await this.tryRemove(entry, signal) && slot) {return undefined;}
            }
        }
        const directory = path.join(root, slot ? createHash('sha256').update(slot).digest('hex') : randomUUID());
        try {await fs.mkdir(directory);}
        catch (error) {signal?.throwIfAborted(); this.log(`Prepared output slot unavailable; preparing without the cache. ${String(error)}\n`); return undefined;}
        let artifact: PreparedArtifact;
        try {artifact = await create(directory);} catch (error) {await removeOutput(directory); throw error;}
        let template: Manifest, unchanged = false;
        const mark = this.sequence;
        try {
            template = await outputManifest(artifact.output.template, signal, true, this.hashes);
            // Files the first manifest hashed are not read again unless they changed since.
            unchanged = !!sourceManifest && (await this.sourceManifest(source, signal, mark)).hash === sourceManifest.hash;
        } catch (error) {
            if (signal?.aborted) {await removeOutput(directory); throw error;}
            return this.temporary(artifact, slot);
        }
        const entry: Entry = { key, slot, artifact: unchanged ? artifact : { ...artifact, reusable: false }, template,
            bytes: footprint(template), active: false, retired: false, used: ++this.clock, released: Promise.resolve(), finish: () => undefined };
        this.reserve(entry); this.entries.add(entry);
        await this.trim();
        return this.lease(entry, false);
    }

    /** Removal can fail on Windows while a lingering process holds a file. */
    private async tryRemove(entry: Entry, signal?: AbortSignal): Promise<boolean> {
        try {await this.remove(entry); return true;}
        catch (error) {
            signal?.throwIfAborted();
            this.log(`A stale prepared output could not be removed yet; it will be retried. ${String(error)}\n`);
            return false;
        }
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
                    try {entry.template = await outputManifest(artifact.output.template, signal, true, this.hashes); entry.bytes = footprint(entry.template);}
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
            if (!reusable || !entry.artifact.reusable || entry.retired || (this.closed && !this.persist)) {await this.remove(entry); return;}
            // Reports, result attachments and observer payloads never enter retained storage.
            for (const name of await fs.readdir(entry.artifact.root)) {
                if (name !== 'template' && name !== 'assembly') {await removeOutput(path.join(entry.artifact.root, name));}
            }
            await entry.artifact.output.restore();
            unclaim();
            entry.active = false; entry.used = ++this.clock;
            await this.trim();
        } catch (error) {
            this.log(`A prepared output could not be retained. ${String(error)}\n`);
            await this.tryRemove(entry);
        }
        finally {unclaim(); finish();}
    }

    private async remove(entry: Entry): Promise<void> {
        const claimed = !!entry.slot && !this.claimedSlots.has(entry.slot);
        if (claimed) {this.claimedSlots.add(entry.slot);}
        this.entries.delete(entry);
        try {await removeOutput(entry.artifact.root);}
        catch (error) {
            // Keep failed deletions counted and retry them during later trimming or disposal.
            // Their templates may have been partially removed, so they cannot be reused.
            entry.retired = true; this.entries.add(entry); throw error;
        } finally {
            if (claimed) {this.claimedSlots.delete(entry.slot);}
            entry.active = false; entry.finish();
        }
    }

    /** Remove every idle prepared output; active leases are unaffected. */
    evictIdle(signal?: AbortSignal): Promise<void> {
        if (this.closed) {return Promise.resolve();}
        return this.track((async () => {
            for (const entry of [...this.entries]) {
                if (entry.active || (entry.slot && this.claimedSlots.has(entry.slot)) || !this.entries.has(entry)) {continue;}
                signal?.throwIfAborted();
                await this.tryRemove(entry, signal);
            }
        })());
    }

    /** Active leases cannot be evicted, so idle entries share what they leave of the byte budget. When
     * the leases alone exhaust it, the newest idle entry per target still survives (while those fit the
     * budget together), instead of every release evicting everything the next run could reuse. */
    private async trim(): Promise<void> {
        const idle = [...this.entries].filter(entry => !entry.active).sort((left, right) => left.used - right.used);
        const newest = new Map<string, Entry>();
        for (const entry of idle) {if (!entry.retired) {newest.set(targetOf(entry.slot), entry);}}
        let sparedBytes = 0;
        const spared = new Set<Entry>();
        for (const entry of [...newest.values()].sort((left, right) => right.used - left.used)) {
            if (sparedBytes + entry.bytes > this.maxBytes) {continue;}
            sparedBytes += entry.bytes; spared.add(entry);
        }
        const overBudget = (): boolean => {
            let active = 0, retained = 0;
            for (const entry of this.entries) {if (entry.active) {active += entry.bytes;} else {retained += entry.bytes;}}
            return retained > Math.max(this.maxBytes - active, sparedBytes);
        };
        for (const entry of idle) {
            if (entry.active || (entry.slot && this.claimedSlots.has(entry.slot)) || !this.entries.has(entry)) {continue;}
            const crowded = this.entries.size > this.maxEntries;
            if (!crowded && !overBudget()) {break;}
            // The entry limit is firm; only byte pressure from active leases spares an entry.
            if (!crowded && spared.has(entry)) {continue;}
            // Eviction cannot invalidate a newly admitted or concurrently reacquired lease.
            await this.tryRemove(entry);
        }
    }

    dispose(): Promise<void> {
        this.closed = true;
        return this.disposal ??= (async () => {
            while (this.pending.size) {await Promise.allSettled(this.pending);}
            await Promise.allSettled([...this.entries].filter(entry => entry.active).map(entry => entry.released));
            while (this.pending.size) {await Promise.allSettled(this.pending);}
            const owner = await this.owner;
            if (owner && 'park' in owner) {
                const retained: StoredEntry[] = [];
                try {
                    await this.trim();
                    for (const entry of [...this.entries]) {
                        if (!entry.artifact.reusable || entry.retired) {await this.remove(entry); continue;}
                        const directory = await fs.lstat(entry.artifact.root).catch(() => undefined);
                        if (!directory?.isDirectory() || directory.isSymbolicLink()) {await this.remove(entry); continue;}
                        // Never retain executed working copies, reports, or runtime observations.
                        for (const name of await fs.readdir(entry.artifact.root)) {
                            if (name !== 'template') {await removeOutput(path.join(entry.artifact.root, name));}
                        }
                        retained.push({ directory: path.basename(entry.artifact.root), key: entry.key, slot: entry.slot,
                            template: entry.template, used: entry.used, session: entry.artifact.session, coverage: entry.artifact.coverage,
                            coveragePending: entry.artifact.coveragePending,
                            instrumented: entry.artifact.instrumented.map(file => path.relative(entry.artifact.output.directory, file)) });
                    }
                    const snapshot = { version: 1, entries: retained };
                    storedEntries(snapshot);
                    const directories = new Set(retained.map(entry => entry.directory));
                    for (const name of await fs.readdir(owner.directory)) {
                        if (!directories.has(name)) {await removeOutput(path.join(owner.directory, name));}
                    }
                    if (retained.length) {await owner.park(snapshot, { entries: retained.length, bytes: retained.reduce((sum, entry) => sum + footprint(entry.template), 0) });}
                    else {await owner.dispose();}
                    this.entries.clear();
                    return;
                } catch (error) {
                    // Persistence is optional; a failed handoff removes the owned output below.
                    this.log(`Prepared outputs could not be retained for the next session. ${String(error)}\n`);
                }
            }
            const removed = await Promise.allSettled([...this.entries].map(entry => this.remove(entry)));
            const owners = await Promise.allSettled([Promise.resolve().then(async () => owner?.dispose())]);
            const errors = [...removed, ...owners].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result): unknown => result.reason);
            if (errors.length) {throw new AggregateError(errors, `Prepared output cleanup failed: ${errors.map(String).join('; ')}`);}
        })();
    }
}
