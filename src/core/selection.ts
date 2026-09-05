import * as path from 'node:path';
import { Project, TestFile, Trace } from './model';
import { isConfigurationFile } from './paths';

export interface Selection {
    readonly groups: readonly TestFile[];
    readonly reason: string;
    readonly fallback: boolean;
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
    dependencies?: (file: string) => ReadonlySet<string>
): Selection {
    if (force || mode === 'all') {return { groups: [...groups], reason: force ? 'Full baseline' : 'Run all mode', fallback: false };}
    if (!changes.length) {return { groups: [], reason: 'No pending changes', fallback: false };}
    const selected = new Set<string>();
    let fallback = false;
    for (const change of changes) {
        // Observed runtime edges are authoritative even without ProjectReference.
        const observed = dependencies?.(change);
        const mapped = groups.filter(group => (group.file ?? group.project) === change
            || (observed ? observed.has(group.id) : traces.get(group.id)?.dependencies.includes(change)));
        const projectsForChange = index.affected([change]);
        for (const group of mapped) {projectsForChange.add(group.project);}
        const broad = isConfigurationFile(change) || conservativeChanges.has(change) || mapped.length === 0;
        if (broad) {fallback = true;}
        if (broad && !groups.some(group => projectsForChange.has(group.project))) {
            // An unobserved dynamically loaded component can have no static
            // test-project edge. Unknown impact must not become a green empty run.
            for (const group of groups) {selected.add(group.id);}
        }
        const mappedIds = new Set(mapped.map(group => group.id));
        for (const group of groups) {
            if (!projectsForChange.has(group.project)) {continue;}
            const trace = traces.get(group.id);
            if (broad || mappedIds.has(group.id) || !group.file || !trace?.reliable) {selected.add(group.id);}
            if (!trace?.reliable || !group.file) {fallback = true;}
        }
    }
    return {
        groups: groups.filter(group => selected.has(group.id)),
        reason: fallback ? 'Affected files with conservative project fallback' : 'Files that exercised the changed code',
        fallback
    };
}
