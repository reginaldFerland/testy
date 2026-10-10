import * as path from 'node:path';
import { Project, TestFile, Trace } from './model';
import { isConfigurationFile, isToolingFile } from './paths';

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

interface CauseEntry { kind: SelectionCause['kind']; reason: FallbackReason | undefined; files: string[]; count: number; first: number }
/** A change that falls back to every file of a project (only its untraced files, for `untraced`) except the mapped ones. */
interface SharedCause { readonly change: string; readonly order: number; readonly mapped: ReadonlySet<string> }
type ProjectFiles = (project: string) => { readonly all: readonly TestFile[]; readonly untraced: readonly TestFile[] };

/** Collects the changes behind each selected group, keeping only the first few files. Project-wide fallbacks are
 * recorded once per project and change, and become per-file entries only when the selection is complete. */
class CauseLog {
    private readonly entries = new Map<string, Map<string, CauseEntry>>();
    private readonly shared = new Map<string, Map<FallbackReason, SharedCause[]>>();
    /** By project, reason and file ID: how many of those shared causes mapped the ID instead. */
    private readonly excluded = new Map<string, number>();

    /** `order` is the change's position: earlier entries win ties between causes of equal priority. */
    add(group: TestFile, kind: SelectionCause['kind'], change: string, order: number, reason?: FallbackReason): void {
        let byKind = this.entries.get(group.id);
        if (!byKind) {byKind = new Map(); this.entries.set(group.id, byKind);}
        const key = reason ? `${kind}:${reason}` : kind;
        let entry = byKind.get(key);
        if (!entry) {entry = { kind, reason, files: [], count: 0, first: order }; byKind.set(key, entry);}
        if (entry.files.length < maxCauseFiles) {entry.files.push(change);}
        entry.count++;
    }

    /** `mappedHere`: the mapped IDs that belong to files of this project. */
    share(project: string, reason: FallbackReason, change: string, order: number, mapped: ReadonlySet<string>, mappedHere: Iterable<string>): void {
        let byReason = this.shared.get(project);
        if (!byReason) {byReason = new Map(); this.shared.set(project, byReason);}
        push(byReason, reason, { change, order, mapped });
        for (const id of mappedHere) {const key = `${project}\0${reason}\0${id}`; this.excluded.set(key, (this.excluded.get(key) ?? 0) + 1);}
    }

    /** Files that shared causes select. */
    *sharedFiles(files: ProjectFiles): Generator<TestFile> {
        for (const [project, byReason] of this.shared) {
            const members = files(project);
            for (const reason of byReason.keys()) {yield* reason === 'untraced' ? members.untraced : members.all;}
        }
    }

    build(selected: ReadonlySet<string>, files: ProjectFiles): Map<string, SelectionCause> {
        // Each file walks only its first few unmapped shared causes; files sharing an ID merge in change order.
        const deferred = new Map<string, Map<FallbackReason, { count: number; files: SharedCause[] }>>();
        for (const [project, byReason] of this.shared) {
            const members = files(project);
            for (const [reason, causes] of byReason) {
                for (const group of reason === 'untraced' ? members.untraced : members.all) {
                    const count = causes.length - (this.excluded.get(`${project}\0${reason}\0${group.id}`) ?? 0);
                    if (!count || !selected.has(group.id)) {continue;}
                    let byId = deferred.get(group.id);
                    if (!byId) {byId = new Map(); deferred.set(group.id, byId);}
                    let entry = byId.get(reason);
                    if (!entry) {entry = { count: 0, files: [] }; byId.set(reason, entry);}
                    entry.count += count;
                    let taken = 0;
                    for (const cause of causes) {
                        if (taken === maxCauseFiles) {break;}
                        if (!cause.mapped.has(group.id)) {entry.files.push(cause); taken++;}
                    }
                }
            }
        }
        const causes = new Map<string, SelectionCause>();
        for (const id of new Set([...this.entries.keys(), ...deferred.keys()])) {
            if (!selected.has(id)) {continue;}
            const candidates = [...this.entries.get(id)?.values() ?? []];
            for (const [reason, { count, files: shared }] of deferred.get(id) ?? []) {
                const first = shared.length > maxCauseFiles || shared.some((cause, index) => index && cause.order < shared[index - 1]!.order)
                    ? [...shared].sort((a, b) => a.order - b.order).slice(0, maxCauseFiles) : shared;
                candidates.push({ kind: 'fallback', reason, files: first.map(cause => cause.change), count, first: first[0]!.order });
            }
            let best: CauseEntry | undefined;
            for (const entry of candidates) {
                if (!best || causePriority[entry.kind] < causePriority[best.kind] || (causePriority[entry.kind] === causePriority[best.kind] && entry.first < best.first)) {best = entry;}
            }
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
    /** Affected closures by seed set: every file of a project, or of a directory, shares its owner set. */
    private readonly closures = new WeakMap<object, ReadonlySet<string>>();
    private static readonly noSeeds: readonly string[] = [];

    /** `evaluated`: owned inputs that project evaluation itself read, such as imports with other extensions. */
    constructor(readonly projects: readonly Project[], private readonly evaluated: ReadonlySet<string> = new Set()) {
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

    /** A change that requires project evaluation again: a file found by name (see isConfigurationFile) or read while evaluating. */
    isConfiguration(file: string): boolean { return isConfigurationFile(file) || this.evaluated.has(file); }

    /** A file no project owns, outside every project directory. */
    isOutsideProjects(file: string): boolean { return !this.owners.has(file) && !this.directoryOwners(file); }

    affected(changes: readonly string[]): Set<string> {
        const affected = new Set<string>();
        for (const file of changes) {for (const owner of this.seeds(file)) {affected.add(owner);}}
        return this.close(affected);
    }

    /** `affected([file])`, computed once per owning project or directory. */
    affectedBy(file: string): ReadonlySet<string> {
        const seeds = this.seeds(file);
        let closure = this.closures.get(seeds);
        if (!closure) {closure = this.close(new Set(seeds)); this.closures.set(seeds, closure);}
        return closure;
    }

    private seeds(file: string): Iterable<string> {
        // Above every project, configuration (a new Directory.Build.props or nuget.config) can affect all of them, and so can
        // an unknown file that tests read at runtime, such as shared test data. Only well-known non-.NET tooling is ignored.
        return this.owners.get(file) ?? this.directoryOwners(file) ?? (isToolingFile(file) && !isConfigurationFile(file) ? ProjectIndex.noSeeds : this.projectIds);
    }

    private close(affected: Set<string>): Set<string> {
        const queue = [...affected];
        for (const project of queue) {
            for (const dependent of this.dependents.get(project) ?? []) {
                if (!affected.has(dependent)) {affected.add(dependent); queue.push(dependent);}
            }
        }
        return affected;
    }

    /** Projects whose directory contains the file, nearest first. */
    private directoryOwners(file: string): ReadonlySet<string> | undefined {
        let directory = path.dirname(file);
        let owners = this.directories.get(directory);
        while (!owners && path.dirname(directory) !== directory) {
            directory = path.dirname(directory); owners = this.directories.get(directory);
        }
        return owners;
    }

    private add(index: Map<string, Set<string>>, key: string, value: string): void {
        const values = index.get(key) ?? new Set<string>(); values.add(value); index.set(key, values);
    }
}

export function affectedProjects(projects: readonly Project[], changes: readonly string[]): Set<string> {
    return new ProjectIndex(projects).affected(changes);
}

/** Test files indexed once per selection, so each change visits only the files it can affect. */
class FileIndex {
    readonly byProject = new Map<string, { readonly all: TestFile[]; readonly untraced: TestFile[] }>();
    readonly byId = new Map<string, TestFile[]>();
    private readonly byFile = new Map<string, TestFile[]>();
    private byDependency: Map<string, string[]> | undefined;
    private byModule: Map<string, string[]> | undefined;

    constructor(private readonly groups: readonly TestFile[], private readonly traces: ReadonlyMap<string, Trace>) {
        for (const group of groups) {
            push(this.byId, group.id, group); push(this.byFile, group.file ?? group.project, group);
            let members = this.byProject.get(group.project);
            if (!members) {members = { all: [], untraced: [] }; this.byProject.set(group.project, members);}
            members.all.push(group);
            if (!group.file || !traces.get(group.id)?.reliable) {members.untraced.push(group);}
        }
    }

    /** Files whose own file is the change, or whose ID is a coarse or dependent one. */
    matching(change: string, coarse: ReadonlySet<string>, dependents: Iterable<string>): TestFile[] {
        const found = new Set(this.byFile.get(change));
        for (const ids of [coarse, dependents]) {for (const id of ids) {for (const group of this.byId.get(id) ?? []) {found.add(group);}}}
        return [...found];
    }

    /** Files whose trace depends on the file, when no observed dependency index is supplied. */
    dependents(file: string): readonly string[] {
        if (!this.byDependency) {
            this.byDependency = new Map();
            for (const group of this.groups) {for (const dependency of new Set(this.traces.get(group.id)?.dependencies)) {push(this.byDependency, dependency, group.id);}}
        }
        return this.byDependency.get(file) ?? [];
    }

    /** Files whose trace loaded the project's whole module, when no module index is supplied. */
    moduleGroups(project: string): readonly string[] {
        if (!this.byModule) {
            this.byModule = new Map();
            for (const group of this.groups) {for (const module of new Set(this.traces.get(group.id)?.moduleProjects)) {push(this.byModule, module, group.id);}}
        }
        return this.byModule.get(project) ?? [];
    }
}

function push<T>(index: Map<string, T[]>, key: string, value: T): void {
    const values = index.get(key);
    if (values) {values.push(value);} else {index.set(key, [value]);}
}

export function selectTests(
    groups: readonly TestFile[], projects: readonly Project[], traces: ReadonlyMap<string, Trace>,
    changes: readonly string[], mode: 'affected' | 'all', force = false,
    conservativeChanges: ReadonlySet<string> = new Set(), index = new ProjectIndex(projects),
    dependencies?: (file: string) => ReadonlySet<string>, modules?: (project: string) => ReadonlySet<string>
): Selection {
    if (force || mode === 'all') {return { groups: [...groups], reason: force ? 'Full baseline' : 'Run all mode', fallback: false, causes: uniformCauses(groups, force ? 'baseline' : 'all') };}
    if (!changes.length) {return { groups: [], reason: 'No pending changes', fallback: false, causes: new Map() };}
    const selected = new Set<string>(), log = new CauseLog(), files = new FileIndex(groups, traces);
    const moduleGroups = new Map<string, Iterable<string>>();
    let fallback = false;
    for (const [order, change] of changes.entries()) {
        // Observed runtime edges are authoritative even without ProjectReference.
        const observed = dependencies?.(change);
        const projectsForChange = new Set(index.affectedBy(change));
        const coarse = new Set<string>();
        for (const project of projectsForChange) {
            let ids = moduleGroups.get(project);
            if (!ids) {ids = modules?.(project) ?? files.moduleGroups(project); moduleGroups.set(project, ids);}
            for (const id of ids) {coarse.add(id);}
        }
        const mapped = files.matching(change, coarse, observed ?? files.dependents(change));
        if (coarse.size) {fallback = true;}
        for (const group of mapped) {projectsForChange.add(group.project);}
        // Non-.NET tooling configuration outside every project directory (see isToolingFile) cannot change a build or a trace.
        if (!mapped.length && !projectsForChange.size) {continue;}
        const configuration = index.isConfiguration(change);
        const broad = configuration || conservativeChanges.has(change) || mapped.length === 0;
        const broadReason: FallbackReason = configuration ? 'configuration' : conservativeChanges.has(change) ? 'unanalyzed' : 'unmapped';
        if (broad) {fallback = true;}
        for (const group of mapped) {log.add(group, (group.file ?? group.project) === change ? 'edited' : 'covers', change, order);}
        if (broad && ![...projectsForChange].some(project => files.byProject.has(project))) {
            // An unobserved dynamically loaded component can have no static
            // test-project edge. Unknown impact must not become a green empty run.
            for (const group of groups) {selected.add(group.id); log.add(group, 'fallback', change, order, 'unobserved');}
        }
        const mappedIds = new Set(mapped.map(group => group.id));
        for (const id of mappedIds) {selected.add(id);}
        // Mapped IDs by project, so that their files are excluded from the project's fallback.
        const mappedByProject = new Map<string, Set<string>>();
        for (const id of mappedIds) {for (const group of files.byId.get(id) ?? []) {
            let ids = mappedByProject.get(group.project);
            if (!ids) {ids = new Set(); mappedByProject.set(group.project, ids);}
            ids.add(id);
        }}
        for (const project of projectsForChange) {
            const members = files.byProject.get(project);
            if (!members) {continue;}
            // A narrow change selects, besides its mapped files, only files without a reliable trace of their own.
            if (broad || members.untraced.length) {log.share(project, broad ? broadReason : 'untraced', change, order, mappedIds, mappedByProject.get(project) ?? []);}
            if (members.untraced.length) {fallback = true;}
        }
    }
    const members = (project: string): NonNullable<ReturnType<ProjectFiles>> => files.byProject.get(project)!;
    for (const group of log.sharedFiles(members)) {selected.add(group.id);}
    return {
        groups: groups.filter(group => selected.has(group.id)),
        reason: fallback ? 'Affected files with conservative project fallback' : 'Files that exercised the changed code',
        fallback, causes: log.build(selected, members)
    };
}
