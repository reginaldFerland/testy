import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EngineConfiguration, isTestTarget, TestFile } from '../../core/model';
import { compareCodeUnits, contentHash, testTargetKey } from '../../core/paths';
import { buildOrder } from '../projects';
import { ProcessOptions } from '../process';
import { RunnerOptions, RunnerSession } from '../runner';
import { resolveShapes, sourceAnalysisBatch, SourceShape } from '../analysis';
import { sourceAnalysisContext } from '../analysisContext';
import { installCoverageTool } from '../coverageTool';
import { RunOutputLease } from '../runOutputs';
import { mapConcurrent, Semaphore } from '../../core/concurrency';
import { EnvironmentError } from '../../core/errors';
import type { EngineHost } from './host';
import type { BuildPlan, BuildResult, PreparedTests, RunContext } from './types';

/** Analyze sources, keeping only analyses whose parsed bytes match the current versions. */
export async function analyzeSources(host: EngineHost, run: RunContext, analysisSlots: number): Promise<ReadonlyMap<string, string | null>> {
    const { config, processOptions, signal } = run, events = host.options.events;
    const started = Date.now(), analysisHashes = host.sources.analysisHashes;
    const allFiles = [...analysisHashes.keys()];
    const context = await sourceAnalysisContext(config.dotnet, host.options.analyzer, processOptions);
    const contextChanged = !context || context !== host.analysisContext;
    const shapeFiles = allFiles.filter(file => contextChanged || !host.analyses.get(file) || analysisHashes.get(file) !== host.analyzedHashes.get(file));
    const candidates = [...host.sources.aliasSources].sort(([a], [b]) => compareCodeUnits(a, b));
    const stamp = contentHash(JSON.stringify(candidates)), aliasesChanged = contextChanged || stamp !== host.aliasStamp;
    let nextAnalyses: ReadonlyMap<string, SourceShape | null>;
    const nextHashes = new Map(contextChanged ? [] : host.analyzedHashes);
    let uncertain = aliasesChanged;
    try {
        const result = await sourceAnalysisBatch(config.dotnet, host.options.analyzer, shapeFiles, host.options.storage, processOptions,
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
            && context !== await sourceAnalysisContext(config.dotnet, host.options.analyzer, processOptions)) {
            uncertain = true; throw new Error('Source analysis tools changed during analysis.');
        }
        signal.throwIfAborted();
        nextAnalyses = result.analyses;
        for (const [file, shape] of nextAnalyses) {
            nextHashes.delete(file);
            if (context && shape) {nextHashes.set(file, result.sourceHashes.get(file)!);}
        }
        host.analysisContext = context;
        host.excludedAliases = result.aliases; host.aliasStamp = stamp;
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
        if (uncertain) {host.analysisContext = undefined;}
    } finally {events.output(`Testy timing: Source analysis ${Date.now() - started}ms (overlaps test preparation)\n`);}
    host.analyses = new Map([...host.analyses, ...nextAnalyses].filter(([file]) => analysisHashes.has(file)));
    host.analyzedHashes = new Map([...nextHashes].filter(([file]) => analysisHashes.has(file)));
    return resolveShapes(host.analyses, host.projects);
}

/** Overlap source analysis with coverage setup, runner preparation and discovery. */
export async function prepareTests(host: EngineHost, run: RunContext, plan: BuildPlan, built: BuildResult, outputLease: RunOutputLease,
    state: { sessions?: RunnerSession; analyzing?: Promise<ReadonlyMap<string, string | null>> }): Promise<PreparedTests> {
    const { config, signal, projectLimit, testLimit, processOptions, full, manual, rootSnapshot, controller } = run;
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
        ? preparationBudget.run(signal, () => analyzeWithBudget(slots - 1)) : analyzeSources(host, run, analysisSlots);
    const analyzing = state.analyzing = analyzeWithBudget(analysisSlots);
    // Discovery may fail before the join; retain/drain the analysis rejection below.
    void analyzing.catch(() => undefined);
    let coverageTool: string | undefined;
    if (config.coverage && builds.some(project => project.isTestProject)) {
        try {
            coverageTool = await preparationBudget.run(signal, () => ensureCoverageTool(host, config, processOptions));
        }
        catch (error) {signal.throwIfAborted(); events.output(`Coverage unavailable; tests will continue with conservative selection. ${String(error)}\n`);}
    }
    const anticipatedTargets = new Set(anticipated.groups.map(group => testTargetKey(group.project, group.framework)));
    const prepared: PreparedTests = { coverageTool, runtimeTreeChanged: false, liveIds: new Set(), currentShapes: new Map(), sessions: undefined! };
    let initialPreparation = true;
    const runnerOptions: RunnerOptions = {
        ...processOptions, dotnet: config.dotnet, storage: path.join(host.options.storage, 'runs'),
        testArguments: config.testArguments, coverageTool, managedCoverageTool: !config.coverageTool,
        assemblies: host.projects.flatMap(project => project.assemblies ?? [project.assembly]), analyzer: host.options.analyzer, identity: host.identity,
        modules: host.projects.flatMap(project => (project.contexts ?? [project]).map(context => ({
            name: context.assemblyName ?? path.basename(context.assembly, path.extname(context.assembly)), project: project.file,
            sources: [...project.sourceFiles, ...project.inputs ?? []]
        }))),
        outputRoot: outputLease.directory, snapshots: built.snapshots,
        preparedOutputCache: host.preparedOutputs,
        preparationToolIdentities: host.toolIdentities,
        // Primary discovery already owns one permit. Additional DLLs
        // may borrow spare capacity only during this preparation stage.
        tryInstrumentation: (workerSignal, work) => initialPreparation ? preparationBudget.tryRun(workerSignal, work) : undefined,
        deferCoverage: !full && !manual && config.mode === 'affected'
            ? target => !anticipatedTargets.has(testTargetKey(target.project, target.framework)) : undefined,
        preparationContexts: new Map(testBuilds.map(project => [testTargetKey(project.file, project.framework), contentHash(JSON.stringify({
            roots: rootSnapshot, configuration: config.configuration, excludes: config.excludes,
            target: project.contextId, sdk: built.sdkByFile.get(project.file),
            contexts: buildOrder(host.buildGraph, new Set([project.file])).map(context => ({
                id: context.contextId, file: context.file, framework: context.framework, assembly: context.assembly,
                properties: Object.entries(context.properties ?? {}).sort(([a], [b]) => compareCodeUnits(a, b))
            }))
        }))])),
        buildInputs: new Map(host.projects.filter(project => project.isTestProject).map(project => [project.file,
            [...new Set(buildOrder(host.projects, new Set([project.file])).flatMap(input => [...input.inputs ?? []]))]])),
        onResult: (group, result, test) => {
            if (host.runtime.observe(group, result, test)) {prepared.runtimeTreeChanged = true;}
            for (const observer of host.resultObservers) {observer(group, result);}
            events.result(group, result);
        }, onStarted: events.started, onPrepared: events.prepared,
        onExpanded: groups => events.selected({ groups, reason: 'Containing files for provider runtime identities', fallback: true }),
        debug: manual?.debug ? events.debug : undefined
    };
    const sessions = prepared.sessions = state.sessions = new RunnerSession(runnerOptions);
    const rebuilt = new Set(testBuilds.map(project => testTargetKey(project.file, project.framework)));
    const targets = new Set(host.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
    const next = host.groups.filter(group => !rebuilt.has(testTargetKey(group.project, group.framework)) && targets.has(testTargetKey(group.project, group.framework)));
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
