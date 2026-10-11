import { isTestTarget } from '../../core/model';
import { testTargetKey } from '../../core/paths';
import { conservativeChanges } from '../../core/runPolicy';
import { selectTests, Selection } from '../../core/selection';
import { buildOrder, buildRoots, buildSnapshotTargets, prepareBuildPaths } from '../projects';
import type { EngineHost } from './host';
import { analyzeSources } from './prepare';
import { unaffectedByEdit } from './select';
import type { BuildPlan, RunContext } from './types';

/** Projects affected by this run, their build closure, and the test targets to discover. Asynchronous so path
 * resolution for the snapshot plan can avoid blocking the extension host. */
export async function planBuild(host: EngineHost, run: RunContext): Promise<BuildPlan> {
    const { manual, discoverAll, config, changes, previousIndex, baseline } = run;
    const narrowed = await narrowedImpact(host, run);
    let relevant: Set<string>, anticipated: Selection;
    if (narrowed) {
        // Every affected project builds as before (a test can run another project's output, for example in a child process),
        // except test targets that run nothing: they would only be instrumented and discovered again.
        anticipated = narrowed;
        const targets = new Set(host.projects.filter(isTestTarget).map(project => project.file)), selected = new Set(narrowed.groups.map(group => group.project));
        relevant = new Set([...host.index.affected(changes)].filter(project => !targets.has(project) || selected.has(project)));
        for (const project of selected) {relevant.add(project);}
    } else {
        relevant = manual ? new Set(manual.all ? host.projects.map(project => project.file) : [...manual.projects ?? [], ...host.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])
            : discoverAll || config.mode === 'all' ? new Set(host.projects.map(project => project.file)) : host.index.affected(changes);
        if (!manual) {for (const project of previousIndex.affected(changes)) {relevant.add(project);}}
        anticipated = host.select(changes);
        const anticipatedIds = new Set(anticipated.groups.map(group => group.id));
        for (const group of host.groups) {
            if (!manual && (anticipatedIds.has(group.id) || (baseline && !baseline.completed.has(group.id)))) {relevant.add(group.project);}
        }
    }
    const closure = buildOrder(host.buildGraph, relevant);
    const builds = buildRoots(closure);
    const visibleTargets = new Set(host.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
    const testBuilds = builds.filter(project => isTestTarget(project) && visibleTargets.has(testTargetKey(project.file, project.framework)));
    const normalize = await prepareBuildPaths(closure, run.signal);
    return { anticipated, closure, builds, testBuilds, sharedOutputs: buildSnapshotTargets(closure, builds, normalize), normalize, narrowed: !!narrowed };
}

/** For plain C# edits, the selection the run will make, computed before the build: test targets that depend on an edited project
 * but run none of its tests are then neither built, instrumented nor discovered; other dependents still build. Only body edits qualify: they cannot change what
 * a dependent compiles against, and the next run that selects a skipped target builds and discovers it again. The analysis this
 * needs (only of the edited files) is the one preparation would otherwise make. Undefined when a change could need more, or no
 * test target could be left out. */
async function narrowedImpact(host: EngineHost, run: RunContext): Promise<Selection | undefined> {
    const { manual, discoverAll, config, changes, baseline, structural } = run;
    if (manual || discoverAll || baseline || structural || run.scope || run.explicit || config.mode !== 'affected' || config.granularity === 'file' || !config.coverage
        || !host.narrowBuilds || !changes.length) {return undefined;}
    if (!changes.every(file => /\.cs$/i.test(file) && host.index.hasSource(file) && !host.index.isConfiguration(file) && host.hashes.has(file))) {return undefined;}
    const targets = new Set(host.projects.filter(isTestTarget).map(project => project.file));
    if (![...host.index.affected(changes)].some(project => targets.has(project))) {return undefined;}
    const { state, shapes } = await analyzeSources(host, run, run.projectLimit);
    host.applyAnalysis(state);
    // A declaration edit can break the compilation of any dependent, which must then report it.
    const conservative = conservativeChanges(changes, shapes, host.shapes);
    if (conservative.size) {return undefined;}
    return selectTests(host.groups, host.projects, host.coverage.traces, changes, 'affected', false, conservative, host.index,
        file => host.coverage.dependentGroups([file]), project => host.coverage.dependentProjects([project]), (change, id) => unaffectedByEdit(host, host.hashes, change, id));
}
