import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ProjectIndex, selectTests, Selection, uniformCauses } from '../../core/selection';
import { contentHash } from '../../core/paths';
import { reachesChangedMember } from '../../core/memberImpact';
import { narrowTests } from '../../core/testCoverage';
import { baselineOrder, conservativeChanges, freshTraces, mergeImpact, scheduleOrder, schedulingPriority } from '../../core/runPolicy';
import type { EngineHost, RanAgainst } from './host';
import type { EngineConfiguration, TestFile } from '../../core/model';
import type { BuildResult, PreparedTests, RunContext, SelectedRun } from './types';
import { selectManual } from './selectManual';

/** Choose the files to run: a manual selection, the remaining baseline, or the affected impact, in the order they should start
 * (see scheduleOrder). The engine applies the returned checkpoint and announces the selection. */
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
    const proven = new Map<string, Set<string>>();
    const unaffected = config.granularity === 'file' || run.explicit ? undefined : (change: string, id: string): boolean => {
        if (!unaffectedByEdit(host, before, change, id)) {return false;}
        let files = proven.get(id);
        if (!files) {files = new Set(); proven.set(id, files);}
        files.add(change); return true;
    };
    const impactFrom = (index: ProjectIndex): Selection => selectTests(host.groups, host.projects, host.coverage.traces, impactChanges, config.mode, false, conservative, index,
        file => host.coverage.dependentGroups([file]), project => host.coverage.dependentProjects([project]), unaffected);
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
        const pending = host.groups.filter(group => affected.has(group.id) || !baseline.completed.has(group.id));
        const completed = host.groups.filter(group => baseline.completed.has(group.id) && !affected.has(group.id)).length;
        // A resumed baseline vouches for the files saved coverage still describes; the rest is what changed or was never learned.
        const reason = baseline.resumed ? `Changes since the saved coverage (${completed}/${host.groups.length} files current)` : `Baseline (${completed}/${host.groups.length} files complete)`;
        selection = { groups: pending, reason, fallback: false, causes: uniformCauses(pending, 'baseline') };
    } else {
        selection = impact;
        if (config.mode === 'affected' && previousIndex === host.index && !run.explicit && host.ranAgainst.size) {
            const select = (files: readonly string[]): Selection => selectTests(host.groups, host.projects, host.coverage.traces, files, config.mode, false,
                conservativeChanges(files, currentShapes, host.shapes), host.index, file => host.coverage.dependentGroups([file]), project => host.coverage.dependentProjects([project]),
                config.granularity === 'file' ? undefined : (change, id) => unaffectedByEdit(host, before, change, id));
            const current = alreadyRan(host, impactChanges, before, selection.groups, select);
            if (current.size) {
                selection = { ...selection, groups: selection.groups.filter(group => !current.has(group.id)) };
                host.options.events.output(`${current.size} selected test file${current.size === 1 ? '' : 's'} already ran against these changes in a superseded run; not running ${current.size === 1 ? 'it' : 'them'} again.\n`);
            }
        }
    }
    if (run.scope && !baseline) {
        const scoped = selectManual(selection.groups, run.scope, group => host.knownTests(group));
        selection = { ...selection, groups: scoped, reason: `${selection.reason} (continuous run scope: ${scoped.length} of ${selection.groups.length} files)` };
    }
    if (manual) {const groups = await sessions.resolveSelection(selection.groups); selection = { ...selection, groups, causes: uniformCauses(groups, 'manual') };}
    let narrowed: Map<string, ReadonlySet<string>> | undefined;
    if (!manual && !baseline && config.granularity === 'test' && !run.explicit) {
        // Test granularity: a covered file runs only the tests whose own coverage executed an edited body.
        const found = narrowed = new Map();
        const context = { versions: before, conservative, geometry: (file: string, hash: string) => host.coverage.versionGeometry(file, hash), layouts: (file: string, hash: string) => host.members.get(file, hash) };
        selection = { ...selection, groups: selection.groups.map(group => {
            const trace = host.coverage.traces.get(group.id);
            const tests = trace && narrowTests(group, host.testCoverage.get(group.id), impactChanges, { ...context, trace });
            if (!tests) {return group;}
            found.set(group.id, tests);
            host.options.events.output(`Narrowed ${path.basename(group.file ?? group.project)} to ${tests.size} of ${group.tests.length} tests, by their own coverage of the changes.\n`);
            return { ...group, tests: group.tests.filter(test => tests.has(test.id)) };
        }) };
    }
    if (!manual && !baseline && !run.scope) {selection = withAlwaysRun(host, config, selection, narrowed);}
    const priority = schedulingPriority({ baseline: !!baseline && !manual, mode: config.mode, all: !!manual?.all });
    const ordered = scheduleOrder(selection.groups, priority, id => host.failing.has(id), id => host.elapsed(id));
    // During learning, unaffected files finish before the files that ongoing edits keep cancelling.
    selection = { ...selection, groups: baseline && !manual ? baselineOrder(ordered, affected) : ordered };
    host.coverage.markStale(freshTraces(host.coverage.traces, new Set(selection.groups.map(group => group.id)), before), false);
    const selectedIds = new Set(selection.groups.map(group => group.id));
    const unaffectedFiles = !manual && !baseline ? new Map([...proven].filter(([id]) => !selectedIds.has(id))) : undefined;
    return { selection, priority, ...narrowed?.size ? { narrowed } : {}, currentShapes, checkpoint: baseline ? { invalidated: [...affected], shapes: currentShapes, inputs: checkpointInputs } : undefined, unaffected: unaffectedFiles };
}

/** Whether the test file's trace proves that it executed no body the edit changed (see core/memberImpact): it ran against the
 * built version already, or every body it reached is unchanged. Unknown layouts and traces that cannot narrow prove nothing. */
export function unaffectedByEdit(host: Pick<EngineHost, 'coverage' | 'members'>, versions: ReadonlyMap<string, string>, change: string, id: string): boolean {
    const recorded = host.coverage.fileHits(id, change), version = versions.get(change);
    if (!recorded || version === undefined) {return false;}
    if (recorded.hash === version) {return true;}
    const previous = host.members.get(change, recorded.hash), current = host.members.get(change, version);
    return !!previous && !!current && !reachesChangedMember(previous, current, recorded);
}

/** The selected files an earlier automatic run already committed against versions these changes include (see
 * EngineHost.ranAgainst), which nothing changed since selects again. Only tracked source changes qualify: a change the source
 * versions do not describe (configuration, files outside every project) keeps every file. */
export function alreadyRan(host: Pick<EngineHost, 'ranAgainst' | 'topology'>, changes: readonly string[], before: ReadonlyMap<string, string>,
    selected: readonly Pick<TestFile, 'id'>[], select: (files: readonly string[]) => { readonly groups: readonly Pick<TestFile, 'id'>[] }): Set<string> {
    const current = new Set<string>(), selections = new Map<RanAgainst, ReadonlySet<string>>();
    for (const group of selected) {
        const entry = host.ranAgainst.get(group.id);
        if (!entry || entry.topology !== host.topology || !changes.every(file => before.has(file) || entry.versions.has(file))) {continue;}
        let since = selections.get(entry);
        if (!since) {
            const files = [...new Set([...before.keys(), ...entry.versions.keys()])].filter(file => before.get(file) !== entry.versions.get(file));
            since = new Set(files.length ? select(files).groups.map(item => item.id) : []);
            selections.set(entry, since);
        }
        if (!since.has(group.id)) {current.add(group.id);}
    }
    return current;
}

/** An automatic run also runs the pinned test items (see EngineHost.pinned) and, with `testy.alwaysRunFailing`, every file whose
 * latest results include a failure. A pinned test of a file the changes selected joins that file's tests, narrowed or not. */
export function withAlwaysRun(host: Pick<EngineHost, 'groups' | 'pinned' | 'failing' | 'knownTests'>, config: Pick<EngineConfiguration, 'alwaysRunFailing'>,
    selection: Selection, narrowed?: Map<string, ReadonlySet<string>>): Selection {
    const pinned = host.pinned ? selectManual(host.groups, host.pinned, group => host.knownTests(group)) : [];
    const failing = config.alwaysRunFailing ? host.groups.filter(group => host.failing.has(group.id)) : [];
    if (!pinned.length && !failing.length) {return selection;}
    const groups = new Map(selection.groups.map(group => [group.id, group])), causes = new Map(selection.causes);
    const add = (group: TestFile, kind: 'pinned' | 'failing'): void => {
        const existing = groups.get(group.id);
        if (!existing) {groups.set(group.id, group); causes.set(group.id, { kind, files: [], more: 0 }); return;}
        const ids = new Set(existing.tests.map(test => test.id)), extra = group.tests.filter(test => !ids.has(test.id));
        if (!extra.length) {return;}
        const original = host.groups.find(item => item.id === group.id), wanted = new Set([...ids, ...extra.map(test => test.id)]);
        groups.set(group.id, { ...existing, tests: (original ?? group).tests.filter(test => wanted.has(test.id)) });
        if (narrowed?.has(group.id)) {narrowed.set(group.id, wanted);}
    };
    for (const group of pinned) {add(group, 'pinned');}
    for (const group of failing) {add(group, 'failing');}
    const added = groups.size - selection.groups.length;
    return { ...selection, groups: [...groups.values()], causes, ...added ? { reason: `${selection.reason} (+${added} pinned or failing file${added === 1 ? '' : 's'})` } : {} };
}
