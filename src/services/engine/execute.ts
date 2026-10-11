import * as path from 'node:path';
import { TestFile, TestResult } from '../../core/model';
import { sourceVersion, testTargetKey } from '../../core/paths';
import { rebaseRecords } from '../../core/testCoverage';
import { batchResources } from '../../core/traits';
import { batchAffected, commitIsCurrent, completesCheckpoint, remainingTime, requestsComplete, splitLongFiles, TargetReports } from '../../core/runPolicy';
import { Superseded } from '../../core/scheduler';
import { QueueEntry, settleQueue } from '../../core/queue';
import { Cancelled } from '../process';
import { FileRun, mergeCoverage, projectCoverageId } from '../runner';
import { mapConcurrentByKey, SerialQueue } from '../../core/concurrency';
import { isAbortError } from '../../core/errors';
import type { EngineHost } from './host';
import type { BuildResult, PreparedTests, RunContext, SelectedRun, TestedRun } from './types';

/** Run the selected batches, committing each contribution in order as it completes. */
export async function executeSelection(host: EngineHost, run: RunContext, built: BuildResult, prepared: PreparedTests, selected: SelectedRun): Promise<TestedRun> {
    const { signal, config, configured, manual, manualOperation, baseline, changes, testLimit, topology, controller, identity, superseded } = run;
    const { before, revision, obsoleteBuild } = built, { coverageTool, sessions, liveIds } = prepared, { selection, priority } = selected;
    const events = host.options.events;
    // Each batch is one test target (project and framework), with at least one file.
    const batches: [TestFile, ...TestFile[]][] = [];
    const originalGroups = new Map(host.groups.map(group => [group.id, group]));
    const projectGroups = new Map<string, TestFile[]>();
    for (const group of host.groups) {const key = testTargetKey(group.project, group.framework); const groups = projectGroups.get(key) ?? []; groups.push(group); projectGroups.set(key, groups);}
    const completeFiles = new Set(selection.groups.filter(group => requestsComplete([group], originalGroups)).map(group => group.id));
    const completeProjects = new Set(selection.groups.map(group => testTargetKey(group.project, group.framework)));
    for (const group of host.groups) {if (!completeFiles.has(group.id)) {completeProjects.delete(testTargetKey(group.project, group.framework));}}
    for (const group of selection.groups) {
        // A partial project run needs separate contributions; replacing its
        // aggregate would erase the coverage of unselected files.
        const key = testTargetKey(group.project, group.framework);
        const batchProjects = !coverageTool || (config.mode === 'all' && completeProjects.has(key));
        const existing = batchProjects ? batches.find(items => testTargetKey(items[0].project, items[0].framework) === key) : undefined;
        if (existing) {existing.push(group);} else {batches.push([group]);}
    }
    // A throughput run splits each long file into parts that workers run side by side (see core/runPolicy splitLongFiles), and
    // commits the file once every part has finished, as one complete run of it.
    const splits = new Map<readonly TestFile[], Split>();
    if (priority === 'throughput' && testLimit > 1 && coverageTool && allowSecondaryFor(manual, host) && config.splitLongTestFiles !== false) {
        const singles = batches.filter(groups => groups.length === 1).map(groups => groups[0]);
        const plan = splitLongFiles(singles, testLimit, id => host.elapsed(id), (groupId, testId) => host.testDuration(groupId, testId),
            group => completeFiles.has(group.id) && sessions.canRunParallel([group]) && !batchResources([group], config.exclusiveTraits ?? [], config.serialTraits ?? [], { inclusive: config.inclusiveTraits, workers: config.workerTraits }));
        const replaced = new Map(plan.filter(parts => parts.length > 1).map(parts => [parts[0]!.id, parts]));
        if (replaced.size) {
            const next: [TestFile, ...TestFile[]][] = [];
            for (const groups of batches) {
                const parts = groups.length === 1 ? replaced.get(groups[0].id) : undefined;
                if (!parts) {next.push(groups); continue;}
                const split: Split = { original: originalGroups.get(groups[0].id) ?? groups[0], parts: parts.length, runs: [], failed: false, settled: 0 };
                for (const part of parts) {const batch: [TestFile] = [part]; splits.set(batch, split); next.push(batch);}
            }
            batches.splice(0, batches.length, ...next);
            events.output(`Testy split ${replaced.size} long test file${replaced.size === 1 ? '' : 's'} into ${[...replaced.values()].reduce((sum, parts) => sum + parts.length, 0)} parts that run side by side: ${[...replaced.values()].map(parts => `${path.basename(parts[0]!.file ?? parts[0]!.project)} (${parts.length})`).join(', ')}.\n`);
        }
    }
    const results: TestResult[] = [];
    const executedFiles = new Set<string>();
    const targetFiles = (key: string): readonly string[] => projectGroups.get(key)?.map(group => group.id) ?? [];
    const runtimeResults = baseline?.reports(targetFiles) ?? new TargetReports(new Map(), targetFiles);
    let available = !!coverageTool, failedBatches = 0;
    const commits = new SerialQueue();
    let completed = 0, active = 0;
    const allowSecondary = allowSecondaryFor(manual, host);
    // What each batch is expected to take, from its files' learned run times; a batch with an unknown file counts as typical.
    const timing = batches.map(groups => {
        const split = splits.get(groups);
        if (split) {
            const time = host.elapsed(split.original.id);
            const tests = groups[0].tests.map(test => host.testDuration(groups[0].id, test.id) ?? (time ?? 0) / Math.max(1, split.original.tests.length));
            return { expected: time === undefined ? undefined : Math.round(tests.reduce((sum, value) => sum + value, 0)), started: undefined as number | undefined, finished: false };
        }
        const times = groups.map(group => host.elapsed(group.id));
        return { expected: times.every(time => time !== undefined) ? times.reduce((sum, time) => sum + time, 0) : undefined, started: undefined as number | undefined, finished: false };
    });
    // Test files that share an external resource, named by their traits (see core/traits batchResources).
    const resources = new Map(batches.flatMap(groups => {
        const needs = batchResources(groups, config.exclusiveTraits ?? [], config.serialTraits ?? [], { inclusive: config.inclusiveTraits, workers: config.workerTraits });
        return needs ? [[groups, needs] as const] : [];
    }));
    if (resources.size && testLimit > 1) {
        const serial = [...resources.values()].filter(needs => needs.serial).length, names = [...new Set([...resources.values()].flatMap(needs => [...needs.exclusive, ...needs.inclusive ?? []]))];
        const heavy = [...resources.values()].filter(needs => (needs.workers ?? 1) > 1).length;
        events.output(`Testy resources: ${resources.size} test batch${resources.size === 1 ? '' : 'es'} wait for shared resources${names.length ? ` (${names.join(', ')})` : ''}${serial ? `, ${serial} run alone` : ''}${heavy ? `, ${heavy} take several workers` : ''}.\n`);
    }
    /** A batch on its worker's timeline lane (preparation, the test process and the commit), with its test process inside it when the
     * runner measured one. */
    const recordBatch = (groups: readonly TestFile[], worker: number, started: number, outcome: BatchOutcome | undefined): void => {
        const ended = Date.now(), name = groups.map(group => path.basename(group.file ?? group.project)).join(', ');
        host.timeline.record({ name, category: 'batch', lane: worker + 1, start: started, end: ended,
            details: { files: groups.length, tests: groups.reduce((sum, group) => sum + group.tests.length, 0), ...outcome ? { results: outcome.results, failed: outcome.failed } : { completed: false } } });
        if (outcome?.elapsed !== undefined) {host.timeline.record({ name: 'Test process', category: 'process', lane: worker + 1, start: Math.max(started, outcome.ranAt - outcome.elapsed), end: outcome.ranAt });}
    };
    // What the queue view shows: each batch, in the order it may start, with its state.
    const partIndex = new Map<readonly TestFile[], { index: number; count: number }>();
    for (const [groups, split] of splits) {partIndex.set(groups, { index: [...splits].filter(([, other]) => other === split).findIndex(([batch]) => batch === groups) + 1, count: split.parts });}
    const queue: QueueEntry[] = batches.map((groups, index) => ({ id: groups[0].id, name: groups.map(group => path.basename(group.file ?? group.project)).join(', '),
        part: partIndex.get(groups), state: 'queued', tests: groups.reduce((sum, group) => sum + group.tests.length, 0), expected: timing[index]!.expected,
        cause: selected.selection.causes?.get(groups[0].id) }));
    const publishQueue = (): void => {events.queue?.([...queue]);};
    const progress = (): void => {
        publishQueue();
        const remaining = remainingTime(timing, testLimit, Date.now());
        events.phase({ kind: 'testing', completed, total: batches.length, active, ...remaining === undefined ? {} : { remaining },
            ...baseline ? { learned: baseline.completed.size, learnedTotal: host.groups.length } : {} });
    };
    // A baseline commits many files in quick succession; the engine publishes the final state when the run ends.
    const publisher = new CoveragePublisher(next => host.publishCoverage(next), signal, baseline ? baselinePublishInterval : 0, commits);
    /** Dependencies some commit of this run has read since the build snapshot; each commit reads only the others (dirty files
     * are always reread). A later edit of a checked file that is reported (any edit in `fileSystem` trigger mode, an editor save
     * in `save` mode) bumps the revision this run's commits require, or marks an already committed trace stale like any edit
     * after a commit. An unreported edit, such as one made outside the editor in `save` mode, is found by the next run's full
     * sweep, which selects the files it affects. */
    const checked = new Set<string>();
    /** Newer changes superseded this run (see RunContext.superseded): no further batch starts, and running batches finish, unless
     * the changes are known to affect every one of them, which stops the run at once. A finished batch the changes did affect commits
     * only if its own inputs are still current (see commitIsCurrent). The deadline is the scheduler's. */
    const drain = new AbortController(), running = new Map<number, readonly TestFile[]>();
    let stopWatching: (() => void) | undefined;
    const supersede = (): void => {
        const reason: unknown = superseded?.reason;
        const check = (files: readonly string[]): void => {
            const batches = [...running.values()];
            if (batches.length && batches.every(groups => batchAffected(groups, files, id => host.coverage.traces.get(id)))) {controller.abort(new Cancelled());}
        };
        check(reason instanceof Superseded ? reason.files : ['']);
        if (reason instanceof Superseded) {stopWatching = reason.onChange(check);}
        if (!signal.aborted && running.size) {events.output(`A change arrived; finishing ${running.size} running test batch${running.size === 1 ? '' : 'es'} before the next run.\n`);}
        drain.abort();
    };
    superseded?.addEventListener('abort', supersede, { once: true });
    if (superseded?.aborted) {supersede();}
    /** target: the batch's first requested file; the executed groups share its project and framework. */
    const commit = async (target: TestFile, groups: readonly TestFile[], run: FileRun): Promise<void> => {
        signal.throwIfAborted();
        for (const group of groups) {executedFiles.add(group.id);}
        results.push(...run.results); available &&= run.coverageAvailable;
        signal.throwIfAborted();
        const unchecked = run.trace.dependencies.filter(file => !checked.has(file));
        await host.sources.refresh(unchecked, signal);
        for (const file of unchecked) {checked.add(file);}
        if (!commitIsCurrent({ topology, revision, obsoleteBuild, superseded: drain.signal.aborted }, { topology: host.topology, revision: host.sources.revision }, run.trace, host.hashes)) {
            host.coverage.markStale(new Set(groups.map(group => group.id)));
            // A superseded run is ending anyway, and its changes stay pending; its other running batches may still commit.
            if (!manual && !manualOperation && !drain.signal.aborted) {events.invalidated(changes); throw new Cancelled();}
            return;
        }
        const complete = requestsComplete(groups, originalGroups);
        const key = testTargetKey(target.project, target.framework);
        if (complete) {
            const reported = new Set(run.results.map(result => result.id));
            for (const group of groups) {runtimeResults.set(key, group.id, reported);}
            prepared.runtimeTreeChanged = host.settleCompleted(groups, reported, runtimeResults.target(key)) || prepared.runtimeTreeChanged;
        } else {
            // A partial manual run may reveal another deferred row, but
            // cannot retire rows from an earlier complete checkpoint.
            for (const group of groups) {
                const previous = runtimeResults.get(group.id);
                if (previous) {runtimeResults.set(key, group.id, new Set([...previous, ...run.results.map(result => result.id)]));}
            }
        }
        if (prepared.runtimeTreeChanged) {prepared.runtimeTreeChanged = false; await events.discovered(host.displayGroups);}
        if (run.coverageAvailable && complete) {
            if (groups.length > 1) {for (const group of groups) {liveIds.delete(group.id);}}
            else {
                // The old aggregate cannot be split into file ownership.
                // Retain it as history while publishing the new file trace.
                host.markHistorical(new Set([projectCoverageId(target)]));
            }
            // Another configuration can compile different code (#if DEBUG, optimizations), so
            // what it covered cannot narrow later selections: keep the trace, but not its trust.
            const trusted = config.configuration === configured.configuration;
            await host.commitCoverage({ ...run.trace, identity, ...trusted ? {} : { reliable: false } }, liveIds, signal);
            if (revision !== host.sources.revision) {host.coverage.markStale(new Set([run.trace.groupId]));}
            if (trusted) {ranAgainst(groups);}
            // Each test's own coverage describes the same versions as the trace just committed, or nothing does.
            if (groups.length === 1) {
                if (run.testCoverage && trusted && run.trace.reliable) {host.testCoverage.set(run.trace.groupId, run.testCoverage);} else {host.testCoverage.delete(run.trace.groupId);}
            }
            const aggregate = projectCoverageId(target);
            if (groups.length === 1 && host.coverage.traces.has(aggregate)
                && projectGroups.get(key)!.every(group => {
                    const trace = host.coverage.traces.get(group.id); return trace && !trace.stale;
                })) {
                liveIds.delete(aggregate); host.pruneCoverage(liveIds);
            }
        } else if (run.coverageAvailable && !manual && groups.length === 1 && selected.narrowed?.has(groups[0]!.id) && await completeNarrowed(groups[0]!, run)) {
            // The tests that did not run kept their coverage, moved to the built versions; the file's coverage is current again.
            ranAgainst(groups);
        } else if (!manual) {host.retainCoverage(groups, liveIds);}
        if (completesCheckpoint(complete, { configuration: config.configuration, configured, manual: !!manual }, run.coverageAvailable)) {baseline?.complete(groups.map(group => group.id));}
        // Publish each contribution (throttled during a baseline); saves completing close together share one locked write.
        await publisher.publish(); host.scheduleSave();
    };
    /** An automatic run's committed files ran against the built versions, whether or not it consumes its changes (see
     * EngineHost.ranAgainst); a completed run forgets them again. */
    const ranAgainst = (groups: readonly TestFile[]): void => {
        if (manual || manualOperation || baseline) {return;}
        const entry = { versions: before, topology };
        for (const group of groups) {host.ranAgainst.set(group.id, entry);}
    };
    /** A file narrowed to some of its tests (see core/testCoverage narrowTests) ran only those: their new coverage and the others'
     * coverage, moved to the built versions they provably did not execute the edits of, make the file's coverage complete again.
     * False when that is not possible, for example when a test's coverage cannot move; the file then keeps its stale trace. */
    const completeNarrowed = async (group: TestFile, run: FileRun): Promise<boolean> => {
        const records = host.testCoverage.get(group.id), previous = host.coverage.traces.get(group.id);
        if (!records || !run.testCoverage || !previous?.reliable || previous.historical || !run.trace.reliable || config.configuration !== configured.configuration) {return false;}
        const changed = changes.filter(file => before.has(file));
        // A deleted file has no built version for the others' coverage to move to.
        if (changes.some(file => !before.has(file) && previous.coverage.some(entry => entry.file === file))) {host.testCoverage.delete(group.id); return false;}
        const others = [...records.keys()].filter(id => !run.testCoverage!.has(id));
        const moved = rebaseRecords(records, others, changed, before, (file, hash) => host.coverage.versionGeometry(file, hash), (file, hash) => host.members.get(file, hash));
        if (!moved) {host.testCoverage.delete(group.id); return false;}
        const all = new Map([...moved, ...run.testCoverage]);
        const dependencies = [...new Set([...previous.dependencies, ...run.trace.dependencies])];
        await host.commitCoverage({ ...run.trace, groupId: group.id, identity, coverage: mergeCoverage([...all.values()]), dependencies,
            moduleProjects: [...new Set([...previous.moduleProjects ?? [], ...run.trace.moduleProjects ?? []])],
            inputs: Object.fromEntries(dependencies.map(file => [file, sourceVersion(before, file)])) }, liveIds, signal);
        if (revision !== host.sources.revision) {host.coverage.markStale(new Set([group.id]));}
        host.testCoverage.set(group.id, all);
        return true;
    };
    /** A part of a split file finished (`run`) or failed. Once every part has, the file commits as one complete run, unless a part
     * failed or ran other files than its own: then its results stand, and its earlier coverage is kept. Call inside the queue. */
    const settlePart = async (split: Split, run?: FileRun): Promise<void> => {
        split.settled++;
        if (run) {
            if (run.executedGroups.length === 1 && run.executedGroups[0]!.id === split.original.id) {split.runs.push(run);}
            else {split.failed = true; results.push(...run.results); for (const group of run.executedGroups) {executedFiles.add(group.id);}}
        }
        if (split.settled < split.parts) {return;}
        if (split.failed || split.runs.length !== split.parts) {
            for (const part of split.runs) {results.push(...part.results);}
            executedFiles.add(split.original.id);
            if (!manual) {host.retainCoverage([split.original], liveIds);}
            await publisher.publish(); host.scheduleSave();
            return;
        }
        const merged = mergeRuns(split.original, split.runs);
        await commit(split.original, [split.original], merged);
        if (merged.elapsed !== undefined && !manual?.debug) {host.recordElapsed([split.original], merged.elapsed);}
    };
    /** A batch that could not run reports its tests as errored; other batches continue. */
    const fail = async (groups: readonly TestFile[], error: unknown, reported: ReadonlySet<string>): Promise<void> => {
        signal.throwIfAborted();
        failedBatches++;
        const message = error instanceof Error ? error.message : String(error);
        events.output(`Test batch failed for ${groups.map(group => path.basename(group.file ?? group.project)).join(', ')}: ${message}\n`);
        for (const group of groups) {
            executedFiles.add(group.id);
            for (const test of group.tests) {
                if (reported.has(test.id)) {continue;}
                const result: TestResult = { id: test.id, name: test.name, fullyQualifiedName: test.fullyQualifiedName, outcome: 'errored', duration: 0, message, node: test.node };
                results.push(result); host.reportErrored(group, result);
            }
        }
        // Nothing was learned. Retain earlier coverage, and complete the baseline
        // for these files so a persistent failure cannot hold it open forever.
        if (!manual) {host.retainCoverage(groups, liveIds);}
        if (!manual) {baseline?.complete(groups.map(group => group.id));}
        await publisher.publish(); host.scheduleSave();
    };
    try {
        await mapConcurrentByKey(batches, testLimit, signal, groups => testTargetKey(groups[0].project, groups[0].framework), async (requestedGroups, index, _workerSignal, worker) => {
            const started = Date.now();
            active++; timing[index]!.started = started; queue[index] = { ...queue[index]!, state: 'running', started }; progress(); running.set(index, requestedGroups);
            const reported = new Set<string>();
            let batchOutcome: BatchOutcome | undefined, ranAt = 0;
            const unsubscribe = observeResults(host, requestedGroups, reported);
            try {
                let outcome: FileRun;
                const split = splits.get(requestedGroups);
                try {outcome = await sessions.run(requestedGroups, before, allowSecondary ? worker + 1 : 0, !!split); ranAt = Date.now();}
                catch (error) {
                    if (signal.aborted || error instanceof Cancelled || isAbortError(error)) {throw error;}
                    await commits.run(async () => {if (split) {split.failed = true;} await fail(requestedGroups, error, reported); if (split) {await settlePart(split);}});
                    completed++; return;
                } finally {unsubscribe();}
                if (split) {
                    await commits.run(() => settlePart(split, outcome));
                    batchOutcome = { results: outcome.results.length, failed: outcome.results.filter(result => result.outcome === 'failed' || result.outcome === 'errored').length, elapsed: outcome.elapsed, ranAt };
                    completed++; return;
                }
                await commits.run(() => commit(requestedGroups[0], outcome.executedGroups, outcome));
                // A debugged host waits at breakpoints, and a partial run says nothing about the whole file.
                if (outcome.elapsed !== undefined && !manual?.debug && requestsComplete(outcome.executedGroups, originalGroups)) {host.recordElapsed(outcome.executedGroups, outcome.elapsed);}
                batchOutcome = { results: outcome.results.length, failed: outcome.results.filter(result => result.outcome === 'failed' || result.outcome === 'errored').length, elapsed: outcome.elapsed, ranAt };
                completed++;
            } finally {
                const failed = batchOutcome?.failed;
                queue[index] = { ...queue[index], state: batchOutcome ? (failed ? 'failed' : 'passed') : signal.aborted ? 'stopped' : 'failed', elapsed: Date.now() - started, ...failed === undefined ? {} : { failed } };
                active--; timing[index]!.finished = true; progress(); running.delete(index);
                recordBatch(requestedGroups, worker, started, batchOutcome);
            }
        // A throughput order starts the longest files first; one worker then takes the shortest, so results still arrive early.
        }, { onFailure: () => controller.abort(), parallelEligible: groups => allowSecondary && sessions.canRunParallel(groups, splits.has(groups)), fastLane: priority === 'throughput' && testLimit > 1,
            resources: groups => resources.get(groups), drain: drain.signal,
            // Gaps on a worker lane: its next files wait for a shared resource or for their busy test project.
            onWait: (worker, start, end) => {if (end - start >= 5) {host.timeline.record({ name: 'Waiting', category: 'wait', lane: worker + 1, start, end });}} });
        // A superseded run did not run everything it selected: it ends cancelled, keeping what it committed.
        if (drain.signal.aborted) {throw new Cancelled();}
    } catch (error) {
        // Whatever was committed stays visible; a successful run is published by the engine at once.
        await publisher.flush(); throw error;
    } finally {
        publisher.cancel(); superseded?.removeEventListener('abort', supersede); stopWatching?.();
        events.queue?.(settleQueue(queue, Date.now()));
    }
    return { results, executedFiles, available, failedBatches };
}

/** A file a throughput run split into parts (see executeSelection): what its parts reported so far. */
interface Split { readonly original: TestFile; readonly parts: number; readonly runs: FileRun[]; failed: boolean; settled: number }

/** Whether a run may use secondary runner lanes at all (see executeSelection's allowSecondary). */
function allowSecondaryFor(manual: RunContext['manual'], host: EngineHost): boolean {
    return !manual || (!manual.exclude && !manual.tests && ![...manual.groups].some(id => host.runtime.containers.has(id)));
}

/** The parts of one split file as one complete run of it: their results, the sum of their coverage and each test's own coverage,
 * the union of their dependencies, and the total time they took. Every part ran against the same build. */
export function mergeRuns(group: TestFile, runs: readonly FileRun[]): FileRun {
    const traces = runs.map(run => run.trace), dependencies = [...new Set(traces.flatMap(trace => trace.dependencies))];
    const moduleProjects = [...new Set(traces.flatMap(trace => trace.moduleProjects ?? []))];
    const testCoverage = runs.every(run => run.testCoverage) ? new Map(runs.flatMap(run => [...run.testCoverage!])) : undefined;
    const elapsed = runs.every(run => run.elapsed !== undefined) ? runs.reduce((sum, run) => sum + run.elapsed!, 0) : undefined;
    return {
        results: runs.flatMap(run => run.results), coverageAvailable: runs.every(run => run.coverageAvailable), executedGroups: [group],
        ...elapsed === undefined ? {} : { elapsed }, ...testCoverage ? { testCoverage } : {},
        trace: { groupId: group.id, dependencies, ...moduleProjects.length ? { moduleProjects } : {}, coverage: mergeCoverage(traces.map(trace => trace.coverage)),
            reliable: traces.every(trace => trace.reliable), timestamp: Math.max(...traces.map(trace => trace.timestamp)),
            inputs: Object.assign({}, ...traces.map(trace => trace.inputs ?? {})) as Record<string, string> }
    };
}

/** What a completed batch reported, for its timeline span. */
interface BatchOutcome { readonly results: number; readonly failed: number; readonly elapsed: number | undefined; readonly ranAt: number }

/** Track results reported for a batch so a later failure only fills in the rest. */
export function observeResults(host: EngineHost, groups: readonly TestFile[], reported: Set<string>): () => void {
    const ids = new Set(groups.map(group => group.id));
    return host.watchResults((group, result) => {if (ids.has(group.id) || group.runtimeOnly) {reported.add(result.id);}});
}

/** How often a baseline publishes coverage while files commit. */
export const baselinePublishInterval = 250;

/** Publishes coverage at most once per interval, with a trailing publication so the latest commit is always shown.
 * Publications run in the commit queue, so none overlaps a commit. An interval of 0 publishes every time. */
export class CoveragePublisher {
    private last = Number.NEGATIVE_INFINITY;
    private trailing: NodeJS.Timeout | undefined;
    constructor(private readonly publishCoverage: (signal?: AbortSignal) => Promise<void>, private readonly signal: AbortSignal,
        private readonly interval: number, private readonly queue: SerialQueue, private readonly now = Date.now) {}

    /** Call from inside the queue: publishes now when the interval has passed, and otherwise schedules a trailing publication. */
    async publish(): Promise<void> {
        const wait = this.last + this.interval - this.now();
        if (wait <= 0) {this.cancel(); this.last = this.now(); await this.publishCoverage(this.signal); return;}
        this.trailing ??= setTimeout(() => {
            this.trailing = undefined; this.last = this.now();
            void this.queue.run(() => this.publishCoverage(this.signal)).catch(() => undefined);
        }, wait);
    }

    /** Publish a pending trailing publication now, even for a cancelled run, so whatever it committed stays visible. */
    async flush(): Promise<void> {
        if (!this.trailing) {return;}
        this.cancel();
        await this.publishCoverage().catch(() => undefined);
    }

    cancel(): void { clearTimeout(this.trailing); this.trailing = undefined; }
}
