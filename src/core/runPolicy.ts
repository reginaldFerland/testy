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

/** Whether changes made while a batch runs are known to affect it, so finishing it would be wasted: a change of a non-C# file
 * (configuration, project or data, which select whole projects), of a test file of the batch, or of a file its earlier coverage
 * reached. Only an early answer: the commit of a finished batch still requires its own inputs to be current (see commitIsCurrent). */
export function batchAffected(groups: readonly Pick<TestFile, 'id' | 'file'>[], changes: readonly string[], trace: (id: string) => Pick<Trace, 'dependencies'> | undefined): boolean {
    if (changes.some(file => !/\.cs$/i.test(file))) {return true;}
    return groups.some(group => {
        const reached = new Set(trace(group.id)?.dependencies);
        return changes.some(file => file === group.file || reached.has(file));
    });
}

/** A completed file run may be committed only if nothing it was built and attributed against has changed since. A superseded
 * run (`superseded`) finishes the files that newer changes cannot affect: their commits need only their own inputs current, and
 * a later run decides from the committed traces what those changes select, as for changes made just after a commit. */
export function commitIsCurrent(run: { readonly topology: number; readonly revision: number; readonly obsoleteBuild: boolean; readonly superseded?: boolean }, current: { readonly topology: number; readonly revision: number },
    trace: Pick<Trace, 'inputs'>, hashes: ReadonlyMap<string, string>): boolean {
    return run.topology === current.topology && !run.obsoleteBuild && (run.revision === current.revision || !!run.superseded) && traceIsCurrent(trace, hashes);
}

/** Unselected stale traces whose inputs match the build's source versions are fresh again. Fresh and
 * historical traces cannot change, so only stale traces' inputs are compared. */
export function freshTraces(traces: ReadonlyMap<string, Trace>, selected: ReadonlySet<string>, before: ReadonlyMap<string, string>): Set<string> {
    const fresh = new Set<string>();
    for (const [id, trace] of traces) {if (trace.stale && !trace.historical && !selected.has(id) && traceIsCurrent(trace, before)) {fresh.add(id);}}
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

/** `responsiveness` reports the likeliest failures soonest; `throughput` finishes the whole selection soonest. */
export type SchedulingPriority = 'responsiveness' | 'throughput';

/** Large runs (a baseline, run-all mode, a manual run of everything) want the whole result; the others want the first failure. */
export function schedulingPriority(run: { readonly baseline: boolean; readonly mode: 'affected' | 'all'; readonly all: boolean }): SchedulingPriority {
    return run.baseline || run.mode === 'all' || run.all ? 'throughput' : 'responsiveness';
}

/** The order in which a run starts its files, from the run time each file last took (`elapsed`; unknown for a file that never
 * ran completely). For responsiveness: files whose latest results include a failure, then files without a known time (usually
 * new ones), then the shortest first. For throughput: the longest first, so no long file is left to finish alone at the end;
 * a file without a known time counts as the average. Ties keep the given order. */
export function scheduleOrder(groups: readonly TestFile[], priority: SchedulingPriority, failing: (id: string) => boolean, elapsed: (id: string) => number | undefined): TestFile[] {
    const keyed = groups.map((group, position) => ({ group, position, failing: failing(group.id), time: elapsed(group.id) }));
    const known = keyed.flatMap(item => item.time === undefined ? [] : [item.time]);
    const typical = known.length ? known.reduce((sum, time) => sum + time, 0) / known.length : 0;
    keyed.sort(priority === 'responsiveness'
        ? (a, b) => Number(b.failing) - Number(a.failing) || Number(a.time !== undefined) - Number(b.time !== undefined) || (a.time ?? 0) - (b.time ?? 0) || a.position - b.position
        : (a, b) => (b.time ?? typical) - (a.time ?? typical) || a.position - b.position);
    return keyed.map(item => item.group);
}

/** For a throughput run on several workers: the files long enough to hold up its end, each split into parts of its tests that
 * workers can run side by side; every other file stays whole (one part). A file is long when its learned time is at least
 * `minimum` and at least each worker's share of the whole run. Its tests are dealt longest first to the part with the least
 * expected time, by their own durations (unknown ones count as the file's average), and keep their order within a part. */
export function splitLongFiles<T extends { readonly id: string; readonly tests: readonly { readonly id: string }[] }>(groups: readonly T[], workers: number, elapsed: (id: string) => number | undefined,
    duration: (groupId: string, testId: string) => number | undefined, eligible: (group: T) => boolean, minimum = 2000): T[][] {
    const known = groups.flatMap(group => {const time = elapsed(group.id); return time === undefined ? [] : [time];});
    const typical = known.length ? known.reduce((sum, time) => sum + time, 0) / known.length : 0;
    const share = groups.reduce((sum, group) => sum + (elapsed(group.id) ?? typical), 0) / Math.max(1, workers);
    return groups.map(group => {
        const time = elapsed(group.id);
        if (workers < 2 || time === undefined || time < minimum || time < share || group.tests.length < 2 || !eligible(group)) {return [group];}
        const count = Math.min(workers, group.tests.length, Math.ceil(time / Math.max(share, minimum / 2)));
        if (count < 2) {return [group];}
        const average = time / group.tests.length;
        const weighted = group.tests.map((test, index) => ({ test, index, weight: duration(group.id, test.id) ?? average })).sort((a, b) => b.weight - a.weight || a.index - b.index);
        const parts = Array.from({ length: count }, () => ({ load: 0, tests: [] as typeof weighted }));
        for (const item of weighted) {const part = parts.reduce((least, candidate) => candidate.load < least.load ? candidate : least); part.load += item.weight; part.tests.push(item);}
        return parts.filter(part => part.tests.length).map(part => ({ ...group, tests: part.tests.sort((a, b) => a.index - b.index).map(item => item.test) }));
    });
}

/** How much of a batch's run time each of its files takes: shared by test count, since a batch reports one time for all of them. */
export function shareElapsed(groups: readonly Pick<TestFile, 'id' | 'tests'>[], elapsed: number): Map<string, number> {
    const tests = groups.reduce((sum, group) => sum + group.tests.length, 0);
    return new Map(groups.map(group => [group.id, tests ? Math.round(elapsed * group.tests.length / tests) : Math.round(elapsed / groups.length)]));
}

/** Expected time left for queued and running batches over `workers`, or undefined while no batch has an expected time. */
export function remainingTime(batches: readonly { readonly expected: number | undefined; readonly started?: number | undefined; readonly finished: boolean }[], workers: number, now: number): number | undefined {
    const known = batches.flatMap(batch => batch.expected === undefined ? [] : [batch.expected]);
    if (!known.length) {return undefined;}
    const typical = known.reduce((sum, time) => sum + time, 0) / known.length;
    let total = 0, left = 0;
    for (const batch of batches) {
        if (batch.finished) {continue;}
        const expected = batch.expected ?? typical;
        total += batch.started === undefined ? expected : Math.max(0, expected - (now - batch.started)); left++;
    }
    return left ? Math.round(total / Math.max(1, Math.min(workers, left))) : 0;
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

/** One file's latest outcomes as saved: its test ids listed under their outcome, empty lists omitted, the run time in
 * milliseconds it took when it last ran completely (see TestOutcomes.recordElapsed), and each test's own duration as the
 * framework reported it (see TestOutcomes.duration). */
export type StoredOutcomes = { readonly groupId: string; readonly elapsed?: number; readonly durations?: Readonly<Record<string, number>> }
    & { readonly [outcome in TestOutcome]?: readonly string[] };

/** Files whose outcomes to save, and files whose saved outcomes to delete. */
export interface OutcomeDelta { readonly saved: readonly StoredOutcomes[]; readonly removed: readonly string[]; }

/** The latest outcome of every test, by file and by the `group:test` id the tree uses, so results survive a restart;
 * failures also feed `failing`. Files changed since the last `take` are saved next. */
export class TestOutcomes {
    readonly failing = new FailingTests();
    private readonly files = new Map<string, Map<string, TestOutcome>>();
    private readonly tests = new Map<string, TestOutcome>();
    /** By file: how long its latest complete runs took, smoothed (see recordElapsed). */
    private readonly times = new Map<string, number>();
    /** By file and test: how long the test itself took by the framework's measure, smoothed like file times. */
    private readonly durations = new Map<string, Map<string, number>>();
    private readonly changed = new Set<string>();

    /** Every outcome by `group:test`. */
    get byTest(): ReadonlyMap<string, TestOutcome> { return this.tests; }

    /** How long the file's latest complete runs took, in milliseconds; unknown until one finished. */
    elapsed(groupId: string): number | undefined { return this.times.get(groupId); }

    /** Every known run time by file. */
    get elapsedByFile(): ReadonlyMap<string, number> { return this.times; }

    /** A complete run of the file took `elapsed` milliseconds. Averaged with the previous time, so one slow outlier (a cold
     * disk, a busy machine) moves the order only halfway. Saved with the file's outcomes once it has any. */
    recordElapsed(groupId: string, elapsed: number): void {
        if (!Number.isFinite(elapsed) || elapsed < 0) {return;}
        const previous = this.times.get(groupId), next = Math.round(previous === undefined ? elapsed : (previous + elapsed) / 2);
        if (next === previous) {return;}
        this.times.set(groupId, next); this.changed.add(groupId);
    }

    record(groupId: string, result: Pick<TestResult, 'id' | 'outcome'> & { readonly duration?: number }): void {
        this.failing.record(groupId, result);
        if (this.set(groupId, result.id, result.outcome)) {this.changed.add(groupId);}
        // A skipped test, or an errored batch that never ran it, reports no duration of its own.
        if (result.duration && Number.isFinite(result.duration) && result.duration > 0 && result.outcome !== 'skipped') {
            let tests = this.durations.get(groupId);
            if (!tests) {tests = new Map(); this.durations.set(groupId, tests);}
            const previous = tests.get(result.id), next = Math.round(previous === undefined ? result.duration : (previous + result.duration) / 2);
            if (next !== previous) {tests.set(result.id, next); this.changed.add(groupId);}
        }
    }

    /** How long the test took by the framework's measure in its latest runs, in milliseconds; unknown until it ran. */
    duration(groupId: string, testId: string): number | undefined { return this.durations.get(groupId)?.get(testId); }

    /** The tests with the longest known durations, longest first. */
    slowestTests(limit = 50): { readonly groupId: string; readonly testId: string; readonly duration: number }[] {
        return [...this.durations].flatMap(([groupId, tests]) => [...tests].map(([testId, duration]) => ({ groupId, testId, duration })))
            .sort((a, b) => b.duration - a.duration).slice(0, limit);
    }

    /** After a complete run or a rediscovery of a file: tests it no longer reports no longer exist. */
    settle(groupId: string, reported: ReadonlySet<string>): void {
        this.failing.settle(groupId, reported);
        const tests = this.files.get(groupId);
        for (const id of tests?.keys() ?? []) {if (!reported.has(id)) {tests!.delete(id); this.tests.delete(`${groupId}:${id}`); this.changed.add(groupId);}}
        if (tests && !tests.size) {this.files.delete(groupId);}
        const durations = this.durations.get(groupId);
        for (const id of durations?.keys() ?? []) {if (!reported.has(id)) {durations!.delete(id); this.changed.add(groupId);}}
        if (durations && !durations.size) {this.durations.delete(groupId);}
    }

    /** Forget files that no longer exist. */
    retain(groupIds: ReadonlySet<string>): void {
        this.failing.retain(groupIds);
        for (const id of [...this.files.keys()]) {if (!groupIds.has(id)) {this.forget(id);}}
    }

    clear(): void { this.failing.clear(); for (const id of [...this.files.keys()]) {this.forget(id);} this.times.clear(); this.durations.clear(); }

    /** Adopt saved outcomes, as after a restart; outcomes recorded meanwhile are newer and kept. */
    restore(saved: readonly StoredOutcomes[]): void {
        for (const stored of saved) {
            for (const outcome of testOutcomes) {for (const id of stored[outcome] ?? []) {
                if (this.files.get(stored.groupId)?.has(id)) {continue;}
                this.failing.record(stored.groupId, { id, outcome }); this.set(stored.groupId, id, outcome);
            }}
            if (stored.elapsed !== undefined && !this.times.has(stored.groupId)) {this.times.set(stored.groupId, stored.elapsed);}
            if (stored.durations && !this.durations.has(stored.groupId)) {this.durations.set(stored.groupId, new Map(Object.entries(stored.durations)));}
        }
    }

    /** What changed since the previous call, to save. */
    take(): OutcomeDelta {
        const saved: StoredOutcomes[] = [], removed: string[] = [];
        for (const groupId of this.changed) {
            const tests = this.files.get(groupId);
            if (!tests) {removed.push(groupId); continue;}
            const lists: { [outcome in TestOutcome]?: string[] } = {}, elapsed = this.times.get(groupId), durations = this.durations.get(groupId);
            for (const [id, outcome] of tests) {(lists[outcome] ??= []).push(id);}
            saved.push({ groupId, ...elapsed === undefined ? {} : { elapsed }, ...durations?.size ? { durations: Object.fromEntries(durations) } : {}, ...lists });
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
        this.files.delete(groupId); this.times.delete(groupId); this.durations.delete(groupId); this.changed.add(groupId);
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
