import * as path from 'node:path';
import { Project, TestFile, Trace } from './model';
import { isConfigurationFile, isInside, normalizePath } from './paths';

export interface Selection {
    readonly groups: readonly TestFile[];
    readonly reason: string;
    readonly fallback: boolean;
}

/** Project references are traversed in reverse, including cycles and linked files. */
export function affectedProjects(projects: readonly Project[], changes: readonly string[]): Set<string> {
    const owners = new Set<string>();
    for (const change of changes.map(normalizePath)) {
        const exact = projects.filter(project => normalizePath(project.file) === change || project.sourceFiles.some(file => normalizePath(file) === change));
        if (exact.length) {
            exact.forEach(project => owners.add(normalizePath(project.file)));
            continue;
        }
        // New/deleted files need a directory fallback. All matching owners at the
        // deepest level are retained, since projects can share the same directory.
        const parents = projects.filter(project => isInside(change, path.dirname(project.file)));
        const depth = Math.max(-1, ...parents.map(project => path.dirname(project.file).length));
        parents.filter(project => path.dirname(project.file).length === depth).forEach(project => owners.add(normalizePath(project.file)));
        // A solution-wide settings file, or an unknown linked source, can affect
        // every project. We never interpret lack of ownership as no affected tests.
        if (!parents.length) {projects.forEach(project => owners.add(normalizePath(project.file)));}
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const project of projects) {
            const id = normalizePath(project.file);
            if (!owners.has(id) && project.references.some(reference => owners.has(normalizePath(reference)))) {
                owners.add(id);
                changed = true;
            }
        }
    }
    return owners;
}

export function selectTests(
    groups: readonly TestFile[], projects: readonly Project[], traces: ReadonlyMap<string, Trace>,
    changes: readonly string[], mode: 'affected' | 'all', force = false,
    conservativeChanges: ReadonlySet<string> = new Set()
): Selection {
    if (force || mode === 'all') {return { groups: [...groups], reason: force ? 'Full baseline' : 'Run all mode', fallback: false };}
    if (!changes.length) {return { groups: [], reason: 'No pending changes', fallback: false };}
    const selected = new Set<string>();
    let fallback = false;
    for (const change of changes.map(normalizePath)) {
        const projectsForChange = affectedProjects(projects, [change]);
        const candidates = groups.filter(group => projectsForChange.has(normalizePath(group.project)));
        const mapped = candidates.filter(group => normalizePath(group.file ?? group.project) === change || traces.get(group.id)?.dependencies.includes(change));
        const broad = isConfigurationFile(change) || conservativeChanges.has(change) || mapped.length === 0;
        if (broad) {fallback = true;}
        for (const group of candidates) {
            const trace = traces.get(group.id);
            if (broad || mapped.includes(group) || !group.file || !trace?.reliable) {selected.add(group.id);}
            if (!trace?.reliable || !group.file) {fallback = true;}
        }
    }
    return {
        groups: groups.filter(group => selected.has(group.id)),
        reason: fallback ? 'Affected files with conservative project fallback' : 'Files that exercised the changed code',
        fallback
    };
}
