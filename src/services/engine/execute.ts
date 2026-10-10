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
    const { signal, config, configured, manual, manualOperation, baseline, changes, testLimit, topology, controller } = run;
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
    /** target: the batch's first requested file; the executed groups share its project and framework. */
    const commit = async (target: TestFile, groups: readonly TestFile[], run: FileRun): Promise<void> => {
        signal.throwIfAborted();
        for (const group of groups) {executedFiles.add(group.id);}
        results.push(...run.results); available &&= run.coverageAvailable;
        signal.throwIfAborted();
        await host.sources.refresh(run.trace.dependencies, signal);
        if (!commitIsCurrent({ topology, revision, obsoleteBuild }, { topology: host.topology, revision: host.sources.revision }, run.trace, host.hashes)) {
            host.coverage.markStale(new Set(groups.map(group => group.id)));
            if (!manual && !manualOperation) {events.invalidated(changes); throw new Cancelled();}
            return;
        }
        const complete = requestsComplete(groups, originalGroups);
        const key = testTargetKey(target.project, target.framework);
        if (complete) {
            const reported = new Set(run.results.map(result => result.id));
            for (const group of groups) {runtimeResults.set(key, group.id, reported); host.lastOutcomes.settle(group.id, reported);}
            // Containers are retired only once every file of the target has completed.
            prepared.runtimeTreeChanged ||= host.runtime.retireUnreported(groups, reported, runtimeResults.target(key));
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
                host.coverage.markHistorical(new Set([projectCoverageId(target)]));
            }
            // Another configuration can compile different code (#if DEBUG, optimizations), so
            // what it covered cannot narrow later selections: keep the trace, but not its trust.
            await host.coverage.replaceAsync([config.configuration !== configured.configuration ? { ...run.trace, reliable: false } : run.trace], liveIds, signal);
            if (revision !== host.sources.revision) {host.coverage.markStale(new Set([run.trace.groupId]));}
            const aggregate = projectCoverageId(target);
            if (groups.length === 1 && host.coverage.traces.has(aggregate)
                && projectGroups.get(key)!.every(group => {
                    const trace = host.coverage.traces.get(group.id); return trace && !trace.stale;
                })) {
                liveIds.delete(aggregate); host.coverage.replace([], liveIds);
            }
        } else if (!manual) {retainWithoutCoverage(host, groups, liveIds);}
        if (completesCheckpoint(complete, { configuration: config.configuration, configured, manual: !!manual }, run.coverageAvailable)) {baseline?.complete(groups.map(group => group.id));}
        // Publish each contribution at once; saves completing close together share one locked write.
        await host.publishCoverage(signal); host.scheduleSave();
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
                results.push(result); host.lastOutcomes.record(group.id, result); events.result(group, result);
            }
        }
        // Nothing was learned. Retain earlier coverage, and complete the baseline
        // for these files so a persistent failure cannot hold it open forever.
        if (!manual) {retainWithoutCoverage(host, groups, liveIds);}
        if (!manual) {baseline?.complete(groups.map(group => group.id));}
        await host.publishCoverage(signal); host.scheduleSave();
    };
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
    return { results, executedFiles, available, failedBatches };
}

/** Track results reported for a batch so a later failure only fills in the rest. */
export function observeResults(host: EngineHost, groups: readonly TestFile[], reported: Set<string>): () => void {
    const ids = new Set(groups.map(group => group.id));
    const observer = (group: TestFile, result: TestResult): void => {if (ids.has(group.id) || group.runtimeOnly) {reported.add(result.id);}};
    host.resultObservers.add(observer);
    return () => {host.resultObservers.delete(observer);};
}

/** Preserve previous coverage and its freshness state; without collection no
 * narrowing information was learned, so a new file gets a conservative trace. */
export function retainWithoutCoverage(host: EngineHost, groups: readonly TestFile[], liveIds: ReadonlySet<string>): void {
    for (const group of groups) {
        if (host.coverage.traces.has(group.id)) {host.coverage.invalidate(new Set([group.id]), false);}
        else {host.coverage.replace([{ groupId: group.id, dependencies: group.file ? [group.file] : [], coverage: [], reliable: false, timestamp: Date.now(), inputs: {} }], liveIds);}
    }
}
