import * as fs from 'node:fs/promises';
import { ProjectIndex, selectTests, Selection, uniformCauses } from '../../core/selection';
import { contentHash } from '../../core/paths';
import { baselineOrder, conservativeChanges, failingFirst, freshTraces, mergeImpact } from '../../core/runPolicy';
import type { EngineHost } from './host';
import type { BuildResult, PreparedTests, RunContext, SelectedRun } from './types';
import { selectManual } from './selectManual';

/** Choose the files to run: a manual selection, the remaining baseline, or the affected impact, previously failing files first.
 * The engine applies the returned checkpoint and announces the selection. */
export async function selectRun(host: EngineHost, run: RunContext, built: BuildResult, prepared: PreparedTests): Promise<SelectedRun> {
    const { baseline, changes, signal, config, manual, previousIndex } = run;
    const { before } = built, { currentShapes, sessions } = prepared;
    const conservative = conservativeChanges(changes, currentShapes, baseline?.shapes ?? host.shapes);
    const checkpointInputs = new Map(before);
    if (baseline) {for (const file of changes) {
        if (checkpointInputs.has(file)) {continue;}
        try {checkpointInputs.set(file, contentHash(await fs.readFile(file, { signal })));}
        catch (error) {signal.throwIfAborted(); if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;} checkpointInputs.set(file, 'missing-or-directory');}
    }}
    const impactChanges = baseline ? changes.filter(file => !baseline.inputs.has(file) || baseline.inputs.get(file) !== checkpointInputs.get(file)) : changes;
    const impactFrom = (index: ProjectIndex): Selection => selectTests(host.groups, host.projects, host.coverage.traces, impactChanges, config.mode, false, conservative, index,
        file => host.coverage.dependentGroups([file]), project => host.coverage.dependentProjects([project]));
    // The indexes differ only after a structural refresh.
    const impact = previousIndex === host.index ? impactFrom(host.index) : mergeImpact(impactFrom(previousIndex), impactFrom(host.index));
    const affected = new Set(impact.groups.map(group => group.id));
    let selection: Selection;
    if (manual?.discoverOnly) {
        selection = { groups: [], reason: 'Discovery only', fallback: false, causes: new Map() };
    } else if (manual) {
        const groups = selectManual(host.displayGroups, manual, group => host.knownTests(group));
        selection = { groups, reason: 'Manual run', fallback: false, causes: uniformCauses(groups, 'manual') };
        if ((manual.groups.size || manual.projects?.size) && !manual.exclude && !selection.groups.length) {throw new Error('The selected tests changed during discovery. Select them again from the refreshed Test Explorer.');}
    } else if (baseline) {
        // Affected files are learned again once the engine applies the checkpoint below.
        const pending = baselineOrder(host.groups.filter(group => affected.has(group.id) || !baseline.completed.has(group.id)), affected);
        const completed = host.groups.filter(group => baseline.completed.has(group.id) && !affected.has(group.id)).length;
        // A resumed baseline vouches for the files saved coverage still describes; the rest is what changed or was never learned.
        const reason = baseline.resumed ? `Changes since the saved coverage (${completed}/${host.groups.length} files current)` : `Baseline (${completed}/${host.groups.length} files complete)`;
        selection = { groups: pending, reason, fallback: false, causes: uniformCauses(pending, 'baseline') };
    } else {selection = { ...impact, groups: failingFirst(impact.groups, id => host.failing.has(id)) };}
    if (run.scope && !baseline) {
        const scoped = selectManual(selection.groups, run.scope, group => host.knownTests(group));
        selection = { ...selection, groups: scoped, reason: `${selection.reason} (continuous run scope: ${scoped.length} of ${selection.groups.length} files)` };
    }
    if (manual) {const groups = await sessions.resolveSelection(selection.groups); selection = { ...selection, groups, causes: uniformCauses(groups, 'manual') };}
    host.coverage.markStale(freshTraces(host.coverage.traces, new Set(selection.groups.map(group => group.id)), before), false);
    return { selection, currentShapes, checkpoint: baseline ? { invalidated: [...affected], shapes: currentShapes, inputs: checkpointInputs } : undefined };
}
