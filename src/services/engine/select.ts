import * as fs from 'node:fs/promises';
import { ProjectIndex, selectTests, Selection, uniformCauses } from '../../core/selection';
import { contentHash, sourceVersion } from '../../core/paths';
import type { EngineHost } from './host';
import type { BuildResult, PreparedTests, RunContext, SelectedRun } from './types';
import { selectManual } from './selectManual';

/** Choose the files to run: a manual selection, the remaining baseline, or the affected impact. */
export async function selectRun(host: EngineHost, run: RunContext, built: BuildResult, prepared: PreparedTests): Promise<SelectedRun> {
    const { baseline, changes, signal, config, manual, previousIndex } = run;
    const { before } = built, { currentShapes, sessions } = prepared;
    const previousShapes = baseline?.shapes ?? host.shapes;
    const conservative = new Set(changes.filter(file => !currentShapes.get(file) || currentShapes.get(file) !== previousShapes.get(file)));
    const checkpointInputs = new Map(before);
    if (baseline) {for (const file of changes) {
        if (checkpointInputs.has(file)) {continue;}
        try {checkpointInputs.set(file, contentHash(await fs.readFile(file, { signal })));}
        catch (error) {signal.throwIfAborted(); if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;} checkpointInputs.set(file, 'missing-or-directory');}
    }}
    const impactChanges = baseline ? changes.filter(file => !baseline.inputs.has(file) || baseline.inputs.get(file) !== checkpointInputs.get(file)) : changes;
    // Both indexes matter: a change can leave the graph as well as enter it.
    const impactFrom = (index: ProjectIndex): Selection => selectTests(host.groups, host.projects, host.coverage.traces, impactChanges, config.mode, false, conservative, index,
        file => host.coverage.dependentGroups([file]), project => host.coverage.dependentProjects([project]));
    const oldImpact = impactFrom(previousIndex), nextImpact = impactFrom(host.index);
    const impact = { ...nextImpact, groups: [...new Map([...oldImpact.groups, ...nextImpact.groups].map(group => [group.id, group])).values()],
        causes: new Map([...oldImpact.causes ?? [], ...nextImpact.causes ?? []]) };
    if (baseline) {
        for (const group of impact.groups) {baseline.completed.delete(group.id); baseline.runtimeResults.delete(group.id);}
        baseline.shapes = currentShapes; baseline.inputs = checkpointInputs;
    }
    let selection: Selection;
    if (manual?.discoverOnly) {
        selection = { groups: [], reason: 'Discovery only', fallback: false, causes: new Map() };
    } else if (manual) {
        const groups = selectManual(host.displayGroups, manual, group => host.knownTests(group));
        selection = { groups, reason: 'Manual run', fallback: false, causes: uniformCauses(groups, 'manual') };
        if ((manual.groups.size || manual.projects?.size) && !manual.exclude && !selection.groups.length) {throw new Error('The selected tests changed during discovery. Select them again from the refreshed Test Explorer.');}
    } else if (baseline) {
        const affected = new Set(impact.groups.map(group => group.id));
        const pending = host.groups.filter(group => !baseline.completed.has(group.id));
        // During learning, finish unaffected files before returning to a file
        // that ongoing edits keep cancelling.
        pending.sort((a, b) => Number(affected.has(a.id)) - Number(affected.has(b.id)));
        selection = { groups: pending, reason: `Baseline (${baseline.completed.size}/${host.groups.length} files complete)`, fallback: false, causes: uniformCauses(pending, 'baseline') };
    } else {selection = impact;}
    if (run.scope && !baseline) {
        const scoped = selectManual(selection.groups, run.scope, group => host.knownTests(group));
        selection = { ...selection, groups: scoped, reason: `${selection.reason} (continuous run scope: ${scoped.length} of ${selection.groups.length} files)` };
    }
    if (manual) {const groups = await sessions.resolveSelection(selection.groups); selection = { ...selection, groups, causes: uniformCauses(groups, 'manual') };}
    const selectedIds = new Set(selection.groups.map(group => group.id));
    const fresh = new Set([...host.coverage.traces].filter(([id, trace]) => !selectedIds.has(id)
        && Object.entries(trace.inputs ?? {}).every(([file, hash]) => sourceVersion(before, file) === hash)).map(([id]) => id));
    host.coverage.markStale(fresh, false);
    host.options.events.selected(selection); await host.publishCoverage(signal);
    return { selection, currentShapes };
}
