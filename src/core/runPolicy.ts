import { TestFile, TestResult, Trace } from './model';
import { isConfigurationFile, isRestoreInput, sourceVersion } from './paths';
import { ProjectIndex, Selection } from './selection';

/** Pure decisions behind one run; services/engine applies them. */

/** A change that needs projects found and evaluated again: configuration, or a file no evaluated project owns or tracks yet.
 * A non-C# file outside every project directory that no project owns, such as shared test data or tooling configuration, is not:
 * selection already treats it conservatively, so evaluating again could only narrow that. A C# file there can be a linked source. */
export function isStructuralChange(file: string, index: ProjectIndex, hashes: ReadonlyMap<string, string>): boolean {
    if (index.isConfiguration(file)) {return true;}
    if (index.isOutsideProjects(file) && !/\.cs$/i.test(file)) {return false;}
    return !index.hasSource(file) || !hashes.has(file);
}

/** A change that can alter what Restore produces, so restores and SDK checks are repeated. Evaluated
 * imports count even with other extensions; test-platform and compiler configuration does not. */
export function invalidatesRestore(file: string, index: ProjectIndex): boolean {
    return isRestoreInput(file) || (index.isConfiguration(file) && !isConfigurationFile(file));
}

/** Whether a run must stat every known input instead of only the changes it was given. File-system events
 * are authoritative only in `fileSystem` trigger mode; full, first, structural and manual runs always sweep,
 * which also observes changes made while the editor was closed. */
export function needsSourceSweep(run: { readonly full: boolean; readonly structureDirty: boolean; readonly manual: boolean; readonly trigger?: 'save' | 'fileSystem' | undefined }): boolean {
    return run.full || run.structureDirty || run.manual || run.trigger !== 'fileSystem';
}

/** Whether a completed automatic run consumed its changes and declaration shapes. A manual run did not select by impact,
 * and a scoped run left affected files outside its scope unexecuted; their changes stay pending for a full run. */
export function consumesChanges(run: { readonly manual: boolean; readonly scoped: boolean; readonly baseline: boolean }): boolean {
    return !run.manual && !(run.scoped && !run.baseline);
}

/** Every recorded input still has the version the trace was produced from; a missing file is a version too. */
export function traceIsCurrent(trace: Pick<Trace, 'inputs'>, hashes: ReadonlyMap<string, string>): boolean {
    return Object.entries(trace.inputs ?? {}).every(([file, hash]) => sourceVersion(hashes, file) === hash);
}

/** A completed file run may be committed only if nothing it was built and attributed against has changed since. */
export function commitIsCurrent(run: { readonly topology: number; readonly revision: number; readonly obsoleteBuild: boolean }, current: { readonly topology: number; readonly revision: number },
    trace: Pick<Trace, 'inputs'>, hashes: ReadonlyMap<string, string>): boolean {
    return run.topology === current.topology && !run.obsoleteBuild && run.revision === current.revision && traceIsCurrent(trace, hashes);
}

/** Unselected traces whose inputs match the build's source versions are fresh again. */
export function freshTraces(traces: ReadonlyMap<string, Trace>, selected: ReadonlySet<string>, before: ReadonlyMap<string, string>): Set<string> {
    const fresh = new Set<string>();
    for (const [id, trace] of traces) {if (!selected.has(id) && traceIsCurrent(trace, before)) {fresh.add(id);}}
    return fresh;
}

/** Changes whose declaration shape is unknown or differs from the previous analysis cannot use narrow traces. */
export function conservativeChanges(changes: readonly string[], current: ReadonlyMap<string, string | null>, previous: ReadonlyMap<string, string | null>): Set<string> {
    return new Set(changes.filter(file => !current.get(file) || current.get(file) !== previous.get(file)));
}

/** Impact from the indexes before and after a structural refresh: a change can leave the graph as well as enter it. */
export function mergeImpact(previous: Selection, next: Selection): Selection {
    return { ...next, groups: [...new Map([...previous.groups, ...next.groups].map(group => [group.id, group])).values()],
        causes: new Map([...previous.causes ?? [], ...next.causes ?? []]) };
}

/** Whether a run requested every test of each group, as originally discovered. */
export function requestsComplete(groups: readonly TestFile[], original: ReadonlyMap<string, TestFile>): boolean {
    return groups.every(group => {
        const requested = new Set(group.tests.map(test => test.id));
        return original.get(group.id)?.tests.every(test => requested.has(test.id)) ?? false;
    });
}

/** Whether a committed file run completes its baseline checkpoint. Another build configuration, or a manual
 * coverage run that collected nothing, has not learned the configured coverage. */
export function completesCheckpoint(complete: boolean, run: { readonly configuration: string; readonly configured: { readonly configuration: string; readonly coverage: boolean }; readonly manual: boolean }, coverageAvailable: boolean): boolean {
    return complete && run.configuration === run.configured.configuration && (!run.manual || !run.configured.coverage || coverageAvailable);
}

/** During learning, finish unaffected files before returning to files that ongoing edits keep cancelling. */
export function baselineOrder(pending: readonly TestFile[], affected: ReadonlySet<string>): TestFile[] {
    return [...pending].sort((a, b) => Number(affected.has(a.id)) - Number(affected.has(b.id)));
}

/** Files whose latest results include a failure run first; otherwise the order is kept. */
export function failingFirst(groups: readonly TestFile[], failing: (id: string) => boolean): TestFile[] {
    return [...groups.filter(group => failing(group.id)), ...groups.filter(group => !failing(group.id))];
}

/** The latest outcome of each test by file: which files still have a failing or errored test. */
export class FailingTests {
    private readonly failures = new Map<string, Set<string>>();

    record(groupId: string, result: Pick<TestResult, 'id' | 'outcome'>): void {
        const failed = result.outcome === 'failed' || result.outcome === 'errored';
        let tests = this.failures.get(groupId);
        if (failed) {if (!tests) {tests = new Set(); this.failures.set(groupId, tests);} tests.add(result.id);}
        else if (tests?.delete(result.id) && !tests.size) {this.failures.delete(groupId);}
    }

    has(groupId: string): boolean { return this.failures.has(groupId); }

    /** After a complete run of a file: tests it no longer reports no longer exist. */
    settle(groupId: string, reported: ReadonlySet<string>): void {
        const tests = this.failures.get(groupId);
        for (const test of tests ?? []) {if (!reported.has(test)) {tests!.delete(test);}}
        if (tests && !tests.size) {this.failures.delete(groupId);}
    }

    /** Forget files that no longer exist. */
    retain(groupIds: ReadonlySet<string>): void { for (const id of this.failures.keys()) {if (!groupIds.has(id)) {this.failures.delete(id);}} }

    clear(): void { this.failures.clear(); }
}

export type TestOutcome = TestResult['outcome'];
const testOutcomes: readonly TestOutcome[] = ['passed', 'failed', 'errored', 'skipped'];

/** One file's latest outcomes as saved: its test ids listed under their outcome, empty lists omitted. */
export type StoredOutcomes = { readonly groupId: string } & { readonly [outcome in TestOutcome]?: readonly string[] };

/** Files whose outcomes to save, and files whose saved outcomes to delete. */
export interface OutcomeDelta { readonly saved: readonly StoredOutcomes[]; readonly removed: readonly string[]; }

/** The latest outcome of every test, by file and by the `group:test` id the tree uses, so results survive a restart;
 * failures also feed `failing`. Files changed since the last `take` are saved next. */
export class TestOutcomes {
    readonly failing = new FailingTests();
    private readonly files = new Map<string, Map<string, TestOutcome>>();
    private readonly tests = new Map<string, TestOutcome>();
    private readonly changed = new Set<string>();

    /** Every outcome by `group:test`. */
    get byTest(): ReadonlyMap<string, TestOutcome> { return this.tests; }

    record(groupId: string, result: Pick<TestResult, 'id' | 'outcome'>): void {
        this.failing.record(groupId, result);
        if (this.set(groupId, result.id, result.outcome)) {this.changed.add(groupId);}
    }

    /** After a complete run or a rediscovery of a file: tests it no longer reports no longer exist. */
    settle(groupId: string, reported: ReadonlySet<string>): void {
        this.failing.settle(groupId, reported);
        const tests = this.files.get(groupId);
        for (const id of tests?.keys() ?? []) {if (!reported.has(id)) {tests!.delete(id); this.tests.delete(`${groupId}:${id}`); this.changed.add(groupId);}}
        if (tests && !tests.size) {this.files.delete(groupId);}
    }

    /** Forget files that no longer exist. */
    retain(groupIds: ReadonlySet<string>): void {
        this.failing.retain(groupIds);
        for (const id of [...this.files.keys()]) {if (!groupIds.has(id)) {this.forget(id);}}
    }

    clear(): void { this.failing.clear(); for (const id of [...this.files.keys()]) {this.forget(id);} }

    /** Adopt saved outcomes, as after a restart; outcomes recorded meanwhile are newer and kept. */
    restore(saved: readonly StoredOutcomes[]): void {
        for (const stored of saved) {for (const outcome of testOutcomes) {for (const id of stored[outcome] ?? []) {
            if (this.files.get(stored.groupId)?.has(id)) {continue;}
            this.failing.record(stored.groupId, { id, outcome }); this.set(stored.groupId, id, outcome);
        }}}
    }

    /** What changed since the previous call, to save. */
    take(): OutcomeDelta {
        const saved: StoredOutcomes[] = [], removed: string[] = [];
        for (const groupId of this.changed) {
            const tests = this.files.get(groupId);
            if (!tests) {removed.push(groupId); continue;}
            const lists: { [outcome in TestOutcome]?: string[] } = {};
            for (const [id, outcome] of tests) {(lists[outcome] ??= []).push(id);}
            saved.push({ groupId, ...lists });
        }
        this.changed.clear(); return { saved, removed };
    }

    /** A failed save: its files are saved, from their current outcomes, next time. */
    retry(delta: OutcomeDelta): void { for (const id of [...delta.saved.map(stored => stored.groupId), ...delta.removed]) {this.changed.add(id);} }

    private set(groupId: string, id: string, outcome: TestOutcome): boolean {
        let tests = this.files.get(groupId);
        if (tests?.get(id) === outcome) {return false;}
        if (!tests) {tests = new Map(); this.files.set(groupId, tests);}
        tests.set(id, outcome); this.tests.set(`${groupId}:${id}`, outcome); return true;
    }

    private forget(groupId: string): void {
        for (const id of this.files.get(groupId)?.keys() ?? []) {this.tests.delete(`${groupId}:${id}`);}
        this.files.delete(groupId); this.changed.add(groupId);
    }
}

/** The union of the rows each file of a test target last reported, kept current as files report, so a commit
 * need not rebuild it from every file. Reports change only through `set` while this view exists. */
export class TargetReports {
    private readonly targets = new Map<string, { readonly files: ReadonlySet<string>; reported: number; readonly counts: Map<string, number>; readonly rows: Set<string> }>();

    constructor(private readonly reports: Map<string, ReadonlySet<string>>, private readonly files: (target: string) => readonly string[]) {}

    get(id: string): ReadonlySet<string> | undefined { return this.reports.get(id); }

    set(target: string, id: string, rows: ReadonlySet<string>): void {
        const state = this.targets.get(target), previous = this.reports.get(id);
        this.reports.set(id, rows);
        if (!state?.files.has(id)) {return;}
        if (previous) {for (const row of previous) {this.count(state, row, -1);}} else {state.reported++;}
        for (const row of rows) {this.count(state, row, 1);}
    }

    /** Every row the target's files reported, once each of them has reported; a live view. */
    target(target: string): ReadonlySet<string> | undefined {
        let state = this.targets.get(target);
        if (!state) {
            state = { files: new Set(this.files(target)), reported: 0, counts: new Map(), rows: new Set() }; this.targets.set(target, state);
            for (const id of state.files) {
                const report = this.reports.get(id); if (!report) {continue;}
                state.reported++; for (const row of report) {this.count(state, row, 1);}
            }
        }
        return state.reported === state.files.size ? state.rows : undefined;
    }

    private count(state: { readonly counts: Map<string, number>; readonly rows: Set<string> }, row: string, delta: number): void {
        const count = (state.counts.get(row) ?? 0) + delta;
        if (count > 0) {state.counts.set(row, count); state.rows.add(row);} else {state.counts.delete(row); state.rows.delete(row);}
    }
}
