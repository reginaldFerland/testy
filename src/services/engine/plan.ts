import { isTestTarget } from '../../core/model';
import { testTargetKey } from '../../core/paths';
import { buildOrder, buildRoots, buildSnapshotTargets, prepareBuildPaths } from '../projects';
import type { EngineHost } from './host';
import type { BuildPlan, RunContext } from './types';

/** Projects affected by this run, their build closure, and the test targets to discover. Asynchronous so path
 * resolution for the snapshot plan can avoid blocking the extension host. */
export async function planBuild(host: EngineHost, run: RunContext): Promise<BuildPlan> {
    const { manual, newBaseline, config, changes, previousIndex, baseline } = run;
    const relevant = manual ? new Set(manual.all ? host.projects.map(project => project.file) : [...manual.projects ?? [], ...host.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])
        : newBaseline || config.mode === 'all' ? new Set(host.projects.map(project => project.file)) : host.index.affected(changes);
    if (!manual) {for (const project of previousIndex.affected(changes)) {relevant.add(project);}}
    const anticipated = host.select(changes), anticipatedIds = new Set(anticipated.groups.map(group => group.id));
    for (const group of host.groups) {
        if (!manual && (anticipatedIds.has(group.id) || (baseline && !baseline.completed.has(group.id)))) {relevant.add(group.project);}
    }
    const closure = buildOrder(host.buildGraph, relevant);
    const builds = buildRoots(closure);
    const visibleTargets = new Set(host.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
    const testBuilds = builds.filter(project => isTestTarget(project) && visibleTargets.has(testTargetKey(project.file, project.framework)));
    const normalize = await prepareBuildPaths(closure, run.signal);
    return { anticipated, closure, builds, testBuilds, sharedOutputs: buildSnapshotTargets(closure, builds, normalize), normalize };
}
