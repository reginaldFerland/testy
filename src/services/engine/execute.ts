import * as path from 'node:path';
import { TestFile, TestResult } from '../../core/model';
import { testTargetKey } from '../../core/paths';
import { commitIsCurrent, completesCheckpoint, requestsComplete, TargetReports } from '../../core/runPolicy';
import { Cancelled } from '../process';
import { FileRun, projectCoverageId } from '../runner';
import { mapConcurrentByKey, SerialQueue } from '../../core/concurrency';
import { isAbortError } from '../../core/errors';
import type { EngineHost } from './host';
import type { BuildResult, PreparedTests, RunContext, SelectedRun, TestedRun } from './types';

/** Run the selected batches, committing each contribution in order as it completes. */
export async function executeSelection(host: EngineHost, run: RunContext, built: BuildResult, prepared: PreparedTests, selected: SelectedRun): Promise<TestedRun> {
    const { signal, config, configured, manual, manualOperation, baseline, changes, testLimit, topology, controller, identity } = run;
    const { before, revision, obsoleteBuild } = built, { coverageTool, sessions, liveIds } = prepared, { selection } = selected;
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
    const results: TestResult[] = [];
    const executedFiles = new Set<string>();
    const targetFiles = (key: string): readonly string[] => projectGroups.get(key)?.map(group => group.id) ?? [];
    const runtimeResults = baseline?.reports(targetFiles) ?? new TargetReports(new Map(), targetFiles);
    let available = !!coverageTool, failedBatches = 0;
    const commits = new SerialQueue();
    let completed = 0, active = 0;
    const allowSecondary = !manual || (!manual.exclude && !manual.tests && ![...manual.groups].some(id => host.runtime.containers.has(id)));
    const progress = (): void => events.phase({ kind: 'testing', completed, total: batches.length, active, ...baseline ? { learned: baseline.completed.size, learnedTotal: host.groups.length } : {} });
    // A baseline commits many files in quick succession; the engine publishes the final state when the run ends.
    const publisher = new CoveragePublisher(next => host.publishCoverage(next), signal, baseline ? baselinePublishInterval : 0, commits);
    /** Dependencies some commit of this run has read since the build snapshot; each commit reads only the others (dirty files
     * are always reread). A later edit of a checked file that is reported (any edit in `fileSystem` trigger mode, an editor save
     * in `save` mode) bumps the revision this run's commits require, or marks an already committed trace stale like any edit
     * after a commit. An unreported edit, such as one made outside the editor in `save` mode, is found by the next run's full
     * sweep, which selects the files it affects. */
    const checked = new Set<string>();
    /** target: the batch's first requested file; the executed groups share its project and framework. */
    const commit = async (target: TestFile, groups: readonly TestFile[], run: FileRun): Promise<void> => {
        signal.throwIfAborted();
        for (const group of groups) {executedFiles.add(group.id);}
        results.push(...run.results); available &&= run.coverageAvailable;
        signal.throwIfAborted();
        const unchecked = run.trace.dependencies.filter(file => !checked.has(file));
        await host.sources.refresh(unchecked, signal);
        for (const file of unchecked) {checked.add(file);}
        if (!commitIsCurrent({ topology, revision, obsoleteBuild }, { topology: host.topology, revision: host.sources.revision }, run.trace, host.hashes)) {
            host.coverage.markStale(new Set(groups.map(group => group.id)));
            if (!manual && !manualOperation) {events.invalidated(changes); throw new Cancelled();}
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
            await host.commitCoverage({ ...run.trace, identity, ...config.configuration !== configured.configuration ? { reliable: false } : {} }, liveIds, signal);
            if (revision !== host.sources.revision) {host.coverage.markStale(new Set([run.trace.groupId]));}
            const aggregate = projectCoverageId(target);
            if (groups.length === 1 && host.coverage.traces.has(aggregate)
                && projectGroups.get(key)!.every(group => {
                    const trace = host.coverage.traces.get(group.id); return trace && !trace.stale;
                })) {
                liveIds.delete(aggregate); host.pruneCoverage(liveIds);
            }
        } else if (!manual) {host.retainCoverage(groups, liveIds);}
        if (completesCheckpoint(complete, { configuration: config.configuration, configured, manual: !!manual }, run.coverageAvailable)) {baseline?.complete(groups.map(group => group.id));}
        // Publish each contribution (throttled during a baseline); saves completing close together share one locked write.
        await publisher.publish(); host.scheduleSave();
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
        await mapConcurrentByKey(batches, testLimit, signal, groups => testTargetKey(groups[0].project, groups[0].framework), async (requestedGroups, _index, _workerSignal, worker) => {
            active++; progress();
            const reported = new Set<string>();
            const unsubscribe = observeResults(host, requestedGroups, reported);
            try {
                let outcome: FileRun;
                try {outcome = await sessions.run(requestedGroups, before, allowSecondary ? worker + 1 : 0);}
                catch (error) {
                    if (signal.aborted || error instanceof Cancelled || isAbortError(error)) {throw error;}
                    await commits.run(() => fail(requestedGroups, error, reported));
                    completed++; return;
                } finally {unsubscribe();}
                await commits.run(() => commit(requestedGroups[0], outcome.executedGroups, outcome));
                completed++;
            } finally {active--; progress();}
        }, () => controller.abort(), groups => allowSecondary && sessions.canRunParallel(groups));
    } catch (error) {
        // Whatever was committed stays visible; a successful run is published by the engine at once.
        await publisher.flush(); throw error;
    } finally {publisher.cancel();}
    return { results, executedFiles, available, failedBatches };
}

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
