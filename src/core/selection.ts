import * as path from 'node:path';
import { Project, TestFile, Trace } from './model';
import { isConfigurationFile } from './paths';

export interface Selection {
    readonly groups: readonly TestFile[];
    readonly reason: string;
    readonly fallback: boolean;
    /** Why each selected group runs, by group ID. Absent for selections made without per-group causes. */
    readonly causes?: ReadonlyMap<string, SelectionCause>;
}

/** Why a group was selected: `covers` (a coverage trace links the changed files to it), `edited` (its own
 * file changed), `fallback` (conservative project selection, see `reason`), or a run-wide cause. */
export interface SelectionCause {
    readonly kind: 'covers' | 'edited' | 'fallback' | 'baseline' | 'manual' | 'all';
    /** The first few triggering files; `more` counts the rest, so large selections stay cheap. */
    readonly files: readonly string[];
    readonly more: number;
    readonly reason?: FallbackReason;
}
export type FallbackReason = 'configuration' | 'unanalyzed' | 'unmapped' | 'untraced' | 'unobserved';

const maxCauseFiles = 3;
const causePriority: Readonly<Record<SelectionCause['kind'], number>> = { covers: 0, edited: 1, fallback: 2, baseline: 3, manual: 3, all: 3 };

/** The same cause for every group, for run-wide reasons such as a baseline or a manual run. */
export function uniformCauses(groups: readonly TestFile[], kind: SelectionCause['kind']): Map<string, SelectionCause> {
    const cause: SelectionCause = { kind, files: [], more: 0 };
    return new Map(groups.map(group => [group.id, cause]));
}

interface CauseEntry { kind: SelectionCause['kind']; reason?: FallbackReason; files: string[]; count: number }

/** Collects the changes behind each selected group, keeping only the first few files. */
class CauseLog {
    private readonly entries = new Map<string, Map<string, CauseEntry>>();

    add(group: TestFile, kind: SelectionCause['kind'], change: string, reason?: FallbackReason): void {
        let byKind = this.entries.get(group.id);
        if (!byKind) {byKind = new Map(); this.entries.set(group.id, byKind);}
        const key = reason ? `${kind}:${reason}` : kind;
        let entry = byKind.get(key);
        if (!entry) {entry = { kind, reason, files: [], count: 0 }; byKind.set(key, entry);}
        if (entry.files.length < maxCauseFiles) {entry.files.push(change);}
        entry.count++;
    }

    build(selected: ReadonlySet<string>): Map<string, SelectionCause> {
        const causes = new Map<string, SelectionCause>();
        for (const [id, byKind] of this.entries) {
            if (!selected.has(id)) {continue;}
            let best: CauseEntry | undefined;
            for (const entry of byKind.values()) {if (!best || causePriority[entry.kind] < causePriority[best.kind]) {best = entry;}}
            if (best) {causes.set(id, { kind: best.kind, files: best.files, more: best.count - best.files.length, ...best.reason ? { reason: best.reason } : {} });}
        }
        return causes;
    }
}

/** Input paths are canonicalized at the filesystem boundary, never in this index. */
export class ProjectIndex {
    private readonly owners = new Map<string, Set<string>>();
    private readonly directories = new Map<string, Set<string>>();
    private readonly dependents = new Map<string, Set<string>>();
    private readonly projectIds: ReadonlySet<string>;

    constructor(readonly projects: readonly Project[]) {
        this.projectIds = new Set(projects.map(project => project.file));
        const assemblies = new Map(projects.flatMap(project => (project.assemblies ?? [project.assembly]).map(assembly => [assembly, project.file] as const)));
        for (const project of projects) {
            for (const file of [project.file, ...project.sourceFiles, ...project.inputs ?? []]) {this.add(this.owners, file, project.file);}
            this.add(this.directories, path.dirname(project.file), project.file);
            const references = [...project.references, ...(project.binaryReferences ?? []).map(file => assemblies.get(file)).filter((file): file is string => !!file)];
            for (const reference of references) {this.add(this.dependents, reference, project.file);}
        }
    }

    hasSource(file: string): boolean { return this.owners.has(file); }

    affected(changes: readonly string[]): Set<string> {
        const affected = new Set<string>();
        for (const file of changes) {
            const exact = this.owners.get(file);
            if (exact) {for (const owner of exact) {affected.add(owner);} continue;}
            let directory = path.dirname(file);
            let owners = this.directories.get(directory);
            while (!owners && path.dirname(directory) !== directory) {
                directory = path.dirname(directory); owners = this.directories.get(directory);
            }
            for (const owner of owners ?? this.projectIds) {affected.add(owner);}
        }
        const queue = [...affected];
        for (let index = 0; index < queue.length; index++) {
            for (const dependent of this.dependents.get(queue[index]) ?? []) {
                if (!affected.has(dependent)) {affected.add(dependent); queue.push(dependent);}
            }
        }
        return affected;
    }

    private add(index: Map<string, Set<string>>, key: string, value: string): void {
        const values = index.get(key) ?? new Set<string>(); values.add(value); index.set(key, values);
    }
}

export function affectedProjects(projects: readonly Project[], changes: readonly string[]): Set<string> {
    return new ProjectIndex(projects).affected(changes);
}

export function selectTests(
    groups: readonly TestFile[], projects: readonly Project[], traces: ReadonlyMap<string, Trace>,
    changes: readonly string[], mode: 'affected' | 'all', force = false,
    conservativeChanges: ReadonlySet<string> = new Set(), index = new ProjectIndex(projects),
    dependencies?: (file: string) => ReadonlySet<string>, modules?: (project: string) => ReadonlySet<string>
): Selection {
    if (force || mode === 'all') {return { groups: [...groups], reason: force ? 'Full baseline' : 'Run all mode', fallback: false, causes: uniformCauses(groups, force ? 'baseline' : 'all') };}
    if (!changes.length) {return { groups: [], reason: 'No pending changes', fallback: false, causes: new Map() };}
    const selected = new Set<string>(), log = new CauseLog();
    let fallback = false;
    for (const change of changes) {
        // Observed runtime edges are authoritative even without ProjectReference.
        const observed = dependencies?.(change);
        const projectsForChange = index.affected([change]);
        const coarse = new Set<string>();
        for (const project of projectsForChange) {
            for (const id of modules?.(project) ?? groups.filter(group => traces.get(group.id)?.moduleProjects?.includes(project)).map(group => group.id)) {coarse.add(id);}
        }
        const mapped = groups.filter(group => (group.file ?? group.project) === change
            || coarse.has(group.id) || (observed ? observed.has(group.id) : traces.get(group.id)?.dependencies.includes(change)));
        if (coarse.size) {fallback = true;}
        for (const group of mapped) {projectsForChange.add(group.project);}
        const broad = isConfigurationFile(change) || conservativeChanges.has(change) || mapped.length === 0;
        const broadReason: FallbackReason = isConfigurationFile(change) ? 'configuration' : conservativeChanges.has(change) ? 'unanalyzed' : 'unmapped';
        if (broad) {fallback = true;}
        for (const group of mapped) {log.add(group, (group.file ?? group.project) === change ? 'edited' : 'covers', change);}
        if (broad && !groups.some(group => projectsForChange.has(group.project))) {
            // An unobserved dynamically loaded component can have no static
            // test-project edge. Unknown impact must not become a green empty run.
            for (const group of groups) {selected.add(group.id); log.add(group, 'fallback', change, 'unobserved');}
        }
        const mappedIds = new Set(mapped.map(group => group.id));
        for (const group of groups) {
            if (!projectsForChange.has(group.project)) {continue;}
            const trace = traces.get(group.id);
            if (broad || mappedIds.has(group.id) || !group.file || !trace?.reliable) {selected.add(group.id);}
            if (!mappedIds.has(group.id)) {
                if (broad) {log.add(group, 'fallback', change, broadReason);}
                else if (!group.file || !trace?.reliable) {log.add(group, 'fallback', change, 'untraced');}
            }
            if (!trace?.reliable || !group.file) {fallback = true;}
        }
    }
    return {
        groups: groups.filter(group => selected.has(group.id)),
        reason: fallback ? 'Affected files with conservative project fallback' : 'Files that exercised the changed code',
        fallback, causes: log.build(selected)
    };
}
