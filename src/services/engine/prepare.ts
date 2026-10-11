import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EngineConfiguration, isTestTarget, TestFile } from '../../core/model';
import { compareCodeUnits, contentHash, testTargetKey } from '../../core/paths';
import { buildOrder } from '../projects';
import { ProcessOptions } from '../process';
import { RunnerOptions } from '../runner';
import { resolveShapes, sourceAnalysisBatch, SourceShape, suppressionSettings } from '../analysis';
import { sourceAnalysisContext } from '../analysisContext';
import { installCoverageTool } from '../coverageTool';
import { RunOutputLease } from '../runOutputs';
import { mapConcurrent, Semaphore } from '../../core/concurrency';
import { EnvironmentError } from '../../core/errors';
import { schedulingPriority } from '../../core/runPolicy';
import type { EngineHost } from './host';
import type { AnalysisState, BuildPlan, BuildResult, PreparedTests, RunContext, RunState } from './types';

/** Analyze sources, keeping only analyses whose parsed bytes match the current versions. The engine adopts the
 * returned state as soon as analysis settles, even if discovery later fails. */
export async function analyzeSources(host: EngineHost, run: RunContext, analysisSlots: number): Promise<{ readonly state: AnalysisState; readonly shapes: ReadonlyMap<string, string | null> }> {
    const { config, processOptions, signal } = run, events = host.options.events;
    const started = Date.now(), analysisHashes = host.sources.analysisHashes;
    const allFiles = [...analysisHashes.keys()];
    const context = await sourceAnalysisContext(config.dotnet, host.options.analyzer, processOptions, host.toolIdentities);
    const contextChanged = !context || context !== host.analysisContext;
    const shapeFiles = allFiles.filter(file => contextChanged || !host.analyses.get(file) || analysisHashes.get(file) !== host.analyzedHashes.get(file));
    const candidates = [...host.sources.aliasSources].sort(([a], [b]) => compareCodeUnits(a, b));
    const stamp = contentHash(JSON.stringify(candidates)), aliasesChanged = contextChanged || stamp !== host.aliasStamp;
    let nextAnalyses: ReadonlyMap<string, SourceShape | null>;
    const nextHashes = new Map(contextChanged ? [] : host.analyzedHashes);
    let uncertain = aliasesChanged;
    let { analysisContext, excludedAliases, aliasStamp } = host;
    try {
        const result = await sourceAnalysisBatch(config.dotnet, host.options.analyzer, shapeFiles, host.options.storage, { ...processOptions, analyzerServers: host.analyzerServers },
            host.excludedAliases, analysisSlots, aliasesChanged ? { sources: candidates.map(([, content]) => content), allFiles } : undefined, true);
        if (!result.sourceHashes) {uncertain = true; throw new Error('Source analysis did not provide parsed-byte provenance.');}
        const mismatched = [...result.analyses.keys()].filter(file => result.sourceHashes!.get(file) !== analysisHashes.get(file));
        if (mismatched.length) {
            // An edit can also introduce an alias in a previously
            // ordinary source. Retry the complete alias inventory.
            host.sources.mark(mismatched); uncertain = true;
            throw new Error('Source inputs changed during analysis.');
        }
        if (context && (result.analyses.size || (aliasesChanged && candidates.length))
            && context !== await sourceAnalysisContext(config.dotnet, host.options.analyzer, processOptions, host.toolIdentities)) {
            uncertain = true; throw new Error('Source analysis tools changed during analysis.');
        }
        signal.throwIfAborted();
        nextAnalyses = result.analyses;
        for (const [file, shape] of nextAnalyses) {
            nextHashes.delete(file);
            if (context && shape) {nextHashes.set(file, result.sourceHashes.get(file)!);}
        }
        analysisContext = context;
        excludedAliases = result.aliases; aliasStamp = stamp;
        const reused = allFiles.length - nextAnalyses.size;
        if (reused > 0) {events.output(`Reused ${reused} unchanged source analyses.\n`);}
    }
    catch (error) {
        signal.throwIfAborted(); events.output(`Source analysis unavailable; using project fallback. ${String(error)}\n`);
        // An unresolved alias edit can affect every otherwise unchanged
        // declaration. Do not retain narrow signatures or mark a failed
        // analysis as current; the next operation must retry it.
        const failedFiles = uncertain ? allFiles : shapeFiles;
        nextAnalyses = new Map(failedFiles.map(file => [file, null]));
        for (const file of failedFiles) {nextHashes.delete(file);}
        if (uncertain) {analysisContext = undefined;}
    } finally {
        const ended = Date.now();
        events.output(`Testy timing: Source analysis ${ended - started}ms (overlaps test preparation)\n`);
        host.timeline.record({ name: 'Source analysis', category: 'analysis', lane: 0, start: started, end: ended, details: { files: allFiles.length } });
    }
    const analyses = new Map([...host.analyses, ...nextAnalyses].filter(([file]) => analysisHashes.has(file)));
    const state: AnalysisState = { analyses, analyzedHashes: new Map([...nextHashes].filter(([file]) => analysisHashes.has(file))), analysisContext, aliasStamp, excludedAliases };
    return { state, shapes: resolveShapes(analyses, host.projects) };
}

/** Overlap source analysis with coverage setup, runner preparation and discovery. */
export async function prepareTests(host: EngineHost, run: RunContext, plan: BuildPlan, built: BuildResult, outputLease: RunOutputLease,
    state: RunState): Promise<PreparedTests> {
    const { config, signal, projectLimit, testLimit, processOptions, full, manual, rootSnapshot, controller } = run;
    const throughput = schedulingPriority({ baseline: !!run.baseline && !manual, mode: config.mode, all: !!manual?.all }) === 'throughput';
    const { builds, testBuilds, anticipated } = plan;
    const events = host.options.events;
    // Each target may eventually use every file worker as other targets finish.
    // Grow retention to that finite slot budget while retaining its byte limit.
    await host.preparedOutputs.ensureCapacity(Math.max(16, Math.min(Number.MAX_SAFE_INTEGER, testLimit * testBuilds.length)));
    const preparationBudget = new Semaphore(projectLimit);
    const analysisSlots = Math.max(1, projectLimit - testBuilds.length);
    // Reserve analysis threads before admitting one-slot discovery jobs.
    // Other preparation work only borrows spare slots without waiting,
    // so these nested reservations cannot deadlock.
    const analyzeWithBudget = (slots: number): Promise<ReadonlyMap<string, string | null>> => slots
        ? preparationBudget.run(signal, () => analyzeWithBudget(slots - 1))
        : analyzeSources(host, run, analysisSlots).then(({ state, shapes }) => {host.applyAnalysis(state); return shapes;});
    const analyzing = state.analyzing = analyzeWithBudget(analysisSlots);
    // Discovery may fail before the join; retain/drain the analysis rejection below.
    void analyzing.catch(() => undefined);
    let coverageTool: string | undefined;
    if (config.coverage && builds.some(project => project.isTestProject)) {
        try {
            coverageTool = await preparationBudget.run(signal, () => ensureCoverageTool(host, config, processOptions));
        }
        catch (error) {
            signal.throwIfAborted(); events.output(`Coverage unavailable; tests will continue with conservative selection. ${String(error)}\n`);
            events.coverageUnavailable?.(String(error));
        }
    }
    const anticipatedTargets = new Set(anticipated.groups.map(group => testTargetKey(group.project, group.framework)));
    const prepared: PreparedTests = { coverageTool, runtimeTreeChanged: false, liveIds: new Set(), currentShapes: new Map(), sessions: undefined! };
    let initialPreparation = true;
    // `// testy: no coverage` members stay uninstrumented: their patterns become collector settings, part of each preparation context.
    const suppressions = coverageTool ? await host.coverageSuppressions(signal) : [];
    let coverageSettings: string | undefined;
    if (suppressions.length) {
        const settings = suppressionSettings(suppressions), directory = path.join(host.options.storage, 'coverage-settings');
        coverageSettings = path.join(directory, `${contentHash(settings)}.xml`);
        await fs.mkdir(directory, { recursive: true }); await fs.writeFile(coverageSettings, settings);
        events.output(`Testy coverage: ${suppressions.length} function pattern${suppressions.length === 1 ? '' : 's'} from \`// testy: no coverage\` stay uninstrumented.\n`);
    }
    const runnerOptions: RunnerOptions = {
        ...processOptions, dotnet: config.dotnet, storage: path.join(host.options.storage, 'runs'),
        testArguments: config.testArguments, coverageTool, managedCoverageTool: !config.coverageTool,
        testTimeoutMs: manual?.debug ? undefined : config.testTimeout, isolatedTraits: config.isolatedTraits, testProcessMemoryLimit: config.testProcessMemoryLimit, coverageSettings,
        assemblies: host.projects.flatMap(project => project.assemblies ?? [project.assembly]), analyzer: host.options.analyzer, analyzerServers: host.analyzerServers, identity: host.identity,
        modules: host.projects.flatMap(project => (project.contexts ?? [project]).map(context => ({
            name: context.assemblyName ?? path.basename(context.assembly, path.extname(context.assembly)), project: project.file,
            sources: [...project.sourceFiles, ...project.inputs ?? []]
        }))),
        outputRoot: outputLease.directory, snapshots: built.snapshots,
        preparedOutputCache: host.preparedOutputs, preparedAfter: host.preparedOutputs.mark(),
        preparationToolIdentities: host.toolIdentities,
        // Primary discovery already owns one permit. Additional DLLs
        // may borrow spare capacity only during this preparation stage.
        tryInstrumentation: (workerSignal, work) => initialPreparation ? preparationBudget.tryRun(workerSignal, work) : undefined,
        deferCoverage: !full && !manual && config.mode === 'affected'
            ? target => !anticipatedTargets.has(testTargetKey(target.project, target.framework)) : undefined,
        preparationContexts: new Map(testBuilds.map(project => [testTargetKey(project.file, project.framework), contentHash(JSON.stringify({
            roots: rootSnapshot, configuration: config.configuration, excludes: config.excludes, ...suppressions.length ? { suppressions } : {},
            target: project.contextId, sdk: built.sdkByFile.get(project.file),
            contexts: buildOrder(host.buildGraph, new Set([project.file])).map(context => ({
                id: context.contextId, file: context.file, framework: context.framework, assembly: context.assembly,
                properties: Object.entries(context.properties ?? {}).sort(([a], [b]) => compareCodeUnits(a, b))
            }))
        }))])),
        buildInputs: new Map(host.projects.filter(project => project.isTestProject).map(project => [project.file,
            [...new Set(buildOrder(host.projects, new Set([project.file])).flatMap(input => [...input.inputs ?? []]))]])),
        onResult: (group, result, test) => {if (host.reportResult(group, result, test)) {prepared.runtimeTreeChanged = true;}}, onStarted: events.started, onPrepared: events.prepared,
        onExpanded: groups => events.selected({ groups, reason: 'Containing files for provider runtime identities', fallback: true }),
        debug: manual?.debug ? events.debug : undefined,
        reuseHosts: !!config.reuseTestHosts && !manual?.debug,
        // Each test's own coverage costs a snapshot per test. It is learned lazily: by the runs that edits start, and in other runs
        // only kept current for files that already have it, so a baseline or a run of everything stays fast.
        perTestCoverage: config.granularity === 'test' && !!coverageTool && !manual?.debug
            ? (throughput ? id => !!host.testCoverage.get(id) : () => true) : undefined
    };
    // A session the previous run kept carries its prepared outputs, discoveries and reused hosts over, when nothing it was prepared
    // from changed (see TestEngine.takeSession); otherwise it is released before this run prepares its own.
    const retentionKey = contentHash(JSON.stringify([run.identity, run.topology, config.configuration, config.coverage, coverageTool ?? null, config.testArguments,
        config.testTimeout ?? null, config.isolatedTraits ?? [], config.testProcessMemoryLimit ?? 0, config.granularity ?? null, rootSnapshot, suppressions,
        [...runnerOptions.preparationContexts ?? []].sort(([a], [b]) => compareCodeUnits(a, b))]));
    const kept = !manual?.debug && config.reuseTestHosts && !built.snapshots.size ? await host.takeSession(retentionKey, runnerOptions, signal) : (await host.releaseSession(false), undefined);
    const sessions = prepared.sessions = state.sessions = kept ?? host.createSession(runnerOptions);
    state.retentionKey = retentionKey;
    if (kept) {events.output('Reusing the test hosts, prepared outputs and discovery of the previous run: nothing they were prepared from changed.\n');}
    const rebuilt = new Set(testBuilds.map(project => testTargetKey(project.file, project.framework)));
    const targets = new Set(host.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
    const next = host.discovered.filter(group => !rebuilt.has(testTargetKey(group.project, group.framework)) && targets.has(testTargetKey(group.project, group.framework)));
    let discoveredProjects = 0, activeDiscoveries = 0;
    const discoveryProgress = (): void => events.phase({ kind: 'preparingTests', completed: discoveredProjects, total: testBuilds.length, active: activeDiscoveries });
    let inventories: readonly (readonly TestFile[])[];
    try {
        inventories = await mapConcurrent(testBuilds, projectLimit, signal, async project => {
            return preparationBudget.run(signal, async () => {
                activeDiscoveries++; discoveryProgress();
                try {const groups = await sessions.discover(project); discoveredProjects++; return groups;}
                finally {activeDiscoveries--; discoveryProgress();}
            });
        }, () => controller.abort());
    } finally {initialPreparation = false;}
    prepared.currentShapes = await analyzing;
    next.push(...inventories.flat());
    prepared.liveIds = await host.reconcileGroups(next, run.baseline);
    return prepared;
}

export async function ensureCoverageTool(host: EngineHost, config: EngineConfiguration, options: ProcessOptions): Promise<string> {
    if (config.coverageTool) {
        // Launches run in each project's directory, so a relative path would name a different file per project.
        if (!path.isAbsolute(config.coverageTool)) {throw new EnvironmentError('configuration', `testy.coverageToolPath must be an absolute path: ${config.coverageTool}`);}
        await fs.access(config.coverageTool); return config.coverageTool;
    }
    host.options.events.phase({ kind: 'settingUpCoverage' });
    return installCoverageTool(config.dotnet, host.options.tools, options);
}
