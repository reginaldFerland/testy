import { isTestTarget } from '../../core/model';
import { testTargetKey } from '../../core/paths';
import { buildOrder, buildRoots, buildSnapshotTargets } from '../projects';
import type { EngineHost } from './host';
import type { BuildPlan, RunContext } from './types';

/** Projects affected by this run, their build closure, and the test targets to discover. */
export function planBuild(host: EngineHost, run: RunContext): BuildPlan {
    const { manual, newBaseline, config, changes, previousIndex, baseline } = run;
    const relevant = manual ? new Set(manual.all ? host.projects.map(project => project.file) : [...manual.projects ?? [], ...host.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])
        : newBaseline || config.mode === 'all' ? new Set(host.projects.map(project => project.file)) : host.index.affected(changes);
    if (!manual) {for (const project of previousIndex.affected(changes)) {relevant.add(project);}}
    const anticipated = host.select(changes);
    for (const group of host.groups) {
        if (!manual && (anticipated.groups.includes(group) || (baseline && !baseline.completed.has(group.id)))) {relevant.add(group.project);}
    }
    const closure = buildOrder(host.buildGraph, relevant);
    const builds = buildRoots(closure);
    const visibleTargets = new Set(host.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
    const testBuilds = builds.filter(project => isTestTarget(project) && visibleTargets.has(testTargetKey(project.file, project.framework)));
    return { anticipated, closure, builds, testBuilds, sharedOutputs: buildSnapshotTargets(closure, builds) };
}
