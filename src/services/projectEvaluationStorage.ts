import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Project } from '../core/model';
import type { EvaluationEntry, EvaluationInputs, EvaluationQuery } from './projectEvaluationCache';
import { withLock } from './lock';

export interface EvaluationStorageLimits { readonly maxEntries?: number; readonly maxBytes?: number; }
const maximumEntries = 128, maximumBytes = 32 * 1024 * 1024, maximumItems = 131072, maximumNodes = 4096;
const filename = 'project-evaluations-v1.json';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 32768 && !value.includes('\0');
const absolute = (value: unknown): value is string => text(value) && path.isAbsolute(value);
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const array = <T>(value: unknown, valid: (item: unknown) => item is T, limit = maximumItems): value is T[] => Array.isArray(value) && value.length <= limit && value.every(item => valid(item));
const fields = (value: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(value).every(key => names.includes(key));
const optional = (value: unknown, valid: (item: unknown) => boolean): boolean => value === undefined || valid(value);
const strings = (value: unknown): value is Record<string, string> => record(value) && Object.keys(value).length <= maximumItems && Object.entries(value).every(([key, item]) => text(key) && text(item));

function limits(options: EvaluationStorageLimits): { maxEntries: number; maxBytes: number } {
    const maxEntries = options.maxEntries ?? maximumEntries, maxBytes = options.maxBytes ?? maximumBytes;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > maximumEntries
        || !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > maximumBytes) {throw new Error('Invalid project evaluation storage limits.');}
    return { maxEntries, maxBytes };
}

function validProject(value: unknown, depth = 0): value is Project {
    if (depth > 8 || !record(value) || !fields(value, ['file', 'framework', 'assembly', 'assemblyName', 'assemblies', 'isTestProject', 'isMtp', 'runner',
        'sourceFiles', 'analysisFiles', 'references', 'binaryReferences', 'outputDirectories', 'inputs', 'entryPoint', 'properties', 'contextId', 'contextReferences', 'contexts'])) {return false;}
    return absolute(value.file) && text(value.framework) && absolute(value.assembly) && value.runner === 'mtp'
        && typeof value.isTestProject === 'boolean' && (!value.isTestProject || Number(/^net(\d+)\./.exec(value.framework)?.[1] ?? 0) >= 10)
        && optional(value.isMtp, item => typeof item === 'boolean' && (!value.isTestProject || item))
        && optional(value.assemblyName, text) && array(value.sourceFiles, absolute) && array(value.references, absolute)
        && ['assemblies', 'analysisFiles', 'binaryReferences', 'outputDirectories', 'inputs'].every(key => optional(value[key], item => array(item, absolute)))
        && optional(value.entryPoint, item => typeof item === 'boolean') && optional(value.properties, strings)
        && optional(value.contextId, text) && optional(value.contextReferences, item => array(item, text))
        && optional(value.contexts, item => array(item, (project): project is Project => validProject(project, depth + 1), maximumNodes));
}

function validQuery(value: unknown): value is EvaluationQuery {
    if (!record(value) || !fields(value, ['kind', 'path', 'pattern', 'recursive', 'values']) || !absolute(value.path)
        || typeof value.recursive !== 'boolean' || !(value.pattern === null || text(value.pattern))) {return false;}
    if (['file', 'directory', 'exists', 'mtime'].includes(value.kind as string)) {
        return value.pattern === null && !value.recursive && array(value.values, text, 1) && value.values.length === 1
            && (value.kind === 'mtime' ? /^\d{1,20}$/.test(value.values[0]) : ['true', 'false'].includes(value.values[0]));
    }
    if (!['files', 'directories', 'entries', 'imports'].includes(value.kind as string) || !array(value.values, absolute)) {return false;}
    return value.pattern === null || value.pattern === '*' || (value.kind === 'imports'
        ? /^[^/\\?\0]+$/.test(value.pattern) : /^\*\.[a-z0-9]+$/i.test(value.pattern));
}

function validInputs(value: unknown): value is EvaluationInputs {
    if (!record(value) || !fields(value, ['reusable', 'files', 'hashes', 'queries', 'excludedDirectories', 'sdkDirectory', 'reason'])
        || value.reusable !== true || !array(value.files, absolute) || !value.files.length || !record(value.hashes)
        || Object.keys(value.hashes).length > maximumItems || !array(value.queries, validQuery)
        || !array(value.excludedDirectories, absolute) || !absolute(value.sdkDirectory)
        || !optional(value.reason, item => item === null || text(item))) {return false;}
    const hashes = value.hashes;
    // Disk reuse requires the original bytes actually observed by evaluation;
    // legacy metadata without captured hashes remains eligible only in memory.
    return Object.entries(hashes).every(([file, value]) => absolute(file) && fingerprint(value))
        && value.files.every(file => Object.hasOwn(hashes, file));
}

interface StoredEntry { readonly file: string; readonly graph: readonly number[]; readonly inputs: readonly number[]; readonly context: string; readonly stamp: string; readonly projectInputs: Readonly<Record<string, string>>; }
interface Data { readonly projects: readonly Project[]; readonly inputs: readonly EvaluationInputs[]; readonly entries: readonly StoredEntry[]; }
export interface EvaluationSnapshot { readonly epoch: string; readonly entries: ReadonlyMap<string, EvaluationEntry>; }

function boundEntry(file: string, entry: EvaluationEntry): boolean {
    const evidence = entry.projectInputs;
    if (!record(evidence) || Object.keys(evidence).length > maximumNodes
        || !Object.entries(evidence).every(([file, input]) => absolute(file) && absolute(input))
        || !entry.graph.some(project => project.file === file)) {return false;}
    const covered = (project: Project): boolean => Object.hasOwn(evidence, project.file)
        && entry.inputs.some(input => Object.hasOwn(input.hashes!, evidence[project.file])) && (project.contexts ?? []).every(covered);
    return entry.graph.every(covered);
}

function memoized<T extends object>(valid: (value: unknown) => value is T): (value: unknown) => value is T {
    const known = new WeakMap<object, boolean>();
    return (value: unknown): value is T => {
        if (!record(value)) {return false;}
        const previous = known.get(value); if (previous !== undefined) {return previous;}
        const result = valid(value); known.set(value, result); return result;
    };
}

/** A bounded immutable candidate snapshot. Its epoch never substitutes for input validation. */
export async function readEvaluationSnapshot(storage: string, options: EvaluationStorageLimits = {}, signal?: AbortSignal): Promise<EvaluationSnapshot | undefined> {
    const { maxEntries, maxBytes } = limits(options), file = path.join(storage, filename);
    signal?.throwIfAborted();
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {return undefined;}
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let contents: string;
    try {
        const current = await handle.stat();
        if (!current.isFile() || current.size > maxBytes) {return undefined;}
        // Cap the actual read too: a concurrently growing corrupt file cannot
        // make readFile allocate beyond the metadata limit checked above.
        const bytes = Buffer.alloc(current.size + 1); let count = 0;
        while (count < bytes.length) {
            signal?.throwIfAborted();
            const read = await handle.read(bytes, count, bytes.length - count, count);
            if (!read.bytesRead) {break;} count += read.bytesRead;
        }
        if (count !== current.size) {return undefined;}
        contents = bytes.subarray(0, count).toString('utf8');
    } finally {await handle.close();}
    signal?.throwIfAborted();
    const envelope: unknown = JSON.parse(contents);
    if (!record(envelope) || !fields(envelope, ['version', 'epoch', 'checksum', 'data']) || envelope.version !== 1
        || typeof envelope.epoch !== 'string' || !uuid.test(envelope.epoch) || !fingerprint(envelope.checksum) || !record(envelope.data)
        || hash(JSON.stringify(envelope.data)) !== envelope.checksum) {return undefined;}
    const data = envelope.data;
    if (!fields(data, ['projects', 'inputs', 'entries']) || !array(data.projects, validProject, maximumNodes)
        || !array(data.inputs, validInputs, maximumNodes) || !Array.isArray(data.entries) || data.entries.length > maxEntries) {return undefined;}
    const projects = data.projects, inputs = data.inputs, entries = new Map<string, EvaluationEntry>();
    const indices = (value: unknown, length: number): value is number[] => array(value, (item): item is number => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) < length, maximumNodes) && value.length > 0;
    for (const value of data.entries) {
        signal?.throwIfAborted();
        if (!record(value) || !fields(value, ['file', 'graph', 'inputs', 'context', 'stamp', 'projectInputs']) || !absolute(value.file) || !text(value.context)
            || !fingerprint(value.stamp) || !indices(value.graph, projects.length) || !indices(value.inputs, inputs.length) || entries.has(value.file)) {return undefined;}
        const entry: EvaluationEntry = { graph: value.graph.map(index => projects[index]), inputs: value.inputs.map(index => inputs[index]), context: value.context, stamp: value.stamp,
            projectInputs: value.projectInputs as Readonly<Record<string, string>> };
        if (!boundEntry(value.file, entry)) {return undefined;} entries.set(value.file, entry);
        await yieldTurn();
    }
    signal?.throwIfAborted(); return { epoch: envelope.epoch, entries };
}

async function encode(entries: ReadonlyMap<string, EvaluationEntry>, options: EvaluationStorageLimits, signal?: AbortSignal): Promise<string> {
    const { maxEntries, maxBytes } = limits(options), projects: Project[] = [], inputs: EvaluationInputs[] = [], kept: StoredEntry[] = [];
    const projectIds = new Map<string, number>(), inputIds = new Map<string, number>();
    const projectValid = memoized(validProject), inputValid = memoized(validInputs), identities = new WeakMap<object, { id: string; bytes: number }>();
    let bytes = 256;
    // Recent admissions have priority; shared SDK/input tables are written once.
    for (const [file, entry] of [...entries].reverse()) {
        signal?.throwIfAborted(); if (kept.length === maxEntries) {break;}
        if (!absolute(file) || !text(entry.context) || !fingerprint(entry.stamp) || !array(entry.graph, projectValid, maximumNodes) || !entry.graph.length
            || !array(entry.inputs, inputValid, maximumNodes) || !entry.inputs.length || !boundEntry(file, entry)) {continue;}
        const pendingProjects = new Map<string, { value: Project; bytes: number }>(), pendingInputs = new Map<string, { value: EvaluationInputs; bytes: number }>();
        const identify = <T extends object>(value: T, known: ReadonlyMap<string, number>, pending: Map<string, { value: T; bytes: number }>): string => {
            let identity = identities.get(value);
            if (!identity) {const json = JSON.stringify(value); identity = { id: hash(json), bytes: Buffer.byteLength(json) + 1 }; identities.set(value, identity);}
            if (!known.has(identity.id) && !pending.has(identity.id)) {pending.set(identity.id, { value, bytes: identity.bytes });} return identity.id;
        };
        const graphIds = entry.graph.map(project => identify(project, projectIds, pendingProjects));
        const evaluationIds = entry.inputs.map(input => identify(input, inputIds, pendingInputs));
        const added = [...pendingProjects.values(), ...pendingInputs.values()].reduce((total, item) => total + item.bytes, 0);
        // At most four digits per table index, plus the entry's field framing.
        const entryBytes = Buffer.byteLength(JSON.stringify([file, entry.context, entry.stamp, entry.projectInputs])) + (graphIds.length + evaluationIds.length) * 5 + 128;
        if (bytes + added + entryBytes > maxBytes || projects.length + pendingProjects.size > maximumNodes || inputs.length + pendingInputs.size > maximumNodes) {continue;}
        for (const [id, item] of pendingProjects) {projectIds.set(id, projects.length); projects.push(item.value);}
        for (const [id, item] of pendingInputs) {inputIds.set(id, inputs.length); inputs.push(item.value);}
        kept.push({ file, graph: graphIds.map(id => projectIds.get(id)!), inputs: evaluationIds.map(id => inputIds.get(id)!), context: entry.context, stamp: entry.stamp, projectInputs: entry.projectInputs! });
        bytes += added + entryBytes; await yieldTurn();
    }
    const data: Data = { projects, inputs, entries: kept.reverse() }, body = JSON.stringify(data);
    const result = `{"version":1,"epoch":"${randomUUID()}","checksum":"${hash(body)}","data":${body}}`;
    if (Buffer.byteLength(result) > maxBytes) {throw new Error('Project evaluation snapshot exceeds its size limit.');}
    signal?.throwIfAborted(); return result;
}

/** Last-writer-wins candidates are safe across windows: no saved epoch or
 * checksum skips validation of current evaluation inputs at the point of use. */
export async function writeEvaluationSnapshot(storage: string, entries: ReadonlyMap<string, EvaluationEntry>, options: EvaluationStorageLimits = {}, signal?: AbortSignal): Promise<void> {
    const contents = await encode(entries, options, signal);
    const file = path.join(storage, filename), temporary = `${file}.${randomUUID()}.tmp`;
    await withLock(`${file}.lock`, signal, async () => {
        // Only this format's abandoned temporaries are ours to reclaim. Every
        // writer holds this lock, and unlink never traverses a linked directory.
        for (const name of await fs.readdir(storage)) {
            signal?.throwIfAborted();
            const identity = name.slice(filename.length + 1, -4);
            if (name.startsWith(`${filename}.`) && name.endsWith('.tmp') && uuid.test(identity)) {await fs.unlink(path.join(storage, name)).catch(() => undefined);}
        }
        try {
            await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600, signal });
            signal?.throwIfAborted(); await fs.rename(temporary, file);
        } finally {await fs.unlink(temporary).catch(() => undefined);}
    });
}
