import * as path from 'node:path';
import { isTestTarget, Project } from '../../core/model';
import { environmentIdentity } from '../../core/environment';
import { ProjectIndex } from '../../core/selection';
import { contentHash, defaultExcludes, defaultWatcherPattern, isConfigurationFile, isExcluded, isToolingFile, matchesPattern, normalizePathsAsync, testTargetKey } from '../../core/paths';
import { invalidatesRestore } from '../../core/runPolicy';
import { mergeProjects, evaluateProjects, restoreProjects, filterEntryPoints, findProjects, refreshProjectSnapshotBatches, sdkContextGroups, sdkConfigurationFiles } from '../projects';
import { Cancelled } from '../process';
import { evaluationInputs, evaluationToolContext } from '../projectEvaluationCache';
import { mapConcurrent } from '../../core/concurrency';
import { EnvironmentError } from '../../core/errors';
import type { EngineHost } from './host';
import { assetVersions } from './untracked';
import type { RunContext } from './types';

/** Find, restore and evaluate projects, then reconcile the test inventory. */
export async function refreshStructure(host: EngineHost, run: RunContext): Promise<void> {
    const { config, signal, manual, rootSnapshot, processOptions, projectLimit, changes, baseline, previousIndex } = run;
    // A new baseline, like the first run of a session, restores before trusting any saved evaluation.
    const fresh = run.discoverAll;
    const events = host.options.events;
    if (fresh || changes.some(file => invalidatesRestore(file, previousIndex))) {host.forgetRestores();}
    const selected = manual && !manual.all ? [...new Set([...manual.projects ?? [], ...host.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])] : undefined;
    // Files outside every project that the watcher reports (see ProjectIndex.seeds; tooling selects nothing): a restart compares them.
    const pattern = config.pattern ?? defaultWatcherPattern, unowned: string[] = [];
    const filter = await filterEntryPoints(await findProjects(rootSnapshot, [...defaultExcludes, ...config.excludes], signal, 16,
        (directory, error) => events.output(`Skipping unreadable directory ${directory}: ${error.message}\n`),
        file => {if (matchesPattern(file, pattern, rootSnapshot) && (!isToolingFile(file) || isConfigurationFile(file))) {unowned.push(file);}}),
    { solution: config.solution, solutions: config.solutions, include: config.projects?.include, exclude: config.projects?.exclude }, rootSnapshot, signal);
    const entryPoints = filter.entryPoints;
    // SDK selection can fail before MSBuild can describe any inputs.
    // Keep its candidate paths observable so a corrected pin can recover.
    host.setInputs([...host.inputs, ...filter.inputs, ...entryPoints, ...entryPoints.flatMap(sdkConfigurationFiles)
        .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot))]);
    host.projectEvaluations.retain(entryPoints);
    const toolContext = await evaluationToolContext(config.dotnet, host.options.analyzer, entryPoints.map(file => path.dirname(file)), signal, host.toolIdentities);
    // Launch-specific variables (VSCODE_PID, SHLVL, ...) would otherwise invalidate every saved evaluation on restart.
    const evaluationContextFor = (key: string | undefined): string => contentHash(JSON.stringify([key, config.dotnet, config.configuration, host.options.analyzer, rootSnapshot,
        config.excludes, environmentIdentity(process.env)]));
    const evaluationContext = evaluationContextFor(toolContext?.key);
    let toolKey = toolContext?.key;
    const snapshots = await refreshProjectSnapshotBatches(host.projectSnapshots, entryPoints, selected, async files => {
        let currentToolContext = toolContext, currentEvaluationContext = evaluationContext;
        let reused = fresh || !toolContext ? new Map<string, readonly Project[]>() : await host.projectEvaluations.get(files, evaluationContext, signal);
        const pending = files.filter(file => !reused.has(file));
        let contexts = await sdkContextGroups(pending, signal);
        const key = (file: string): string => `${config.dotnet}\0${config.configuration}\0${file}`;
        // SDK contexts may restore the same physical dependency. Each
        // restore graph parallelizes internally without competing writers.
        for (const context of contexts) {
            const options = { ...processOptions, cwd: context.cwd };
            await host.sdk.ensure(config.dotnet, options, context.key);
            const missing = context.files.filter(file => !host.restored.has(key(file)));
            if (missing.length) {
                await restoreProjects(config.dotnet, missing, config.configuration, options, projectLimit);
                host.recordRestored(missing.map(key));
            }
        }
        // A fresh baseline still runs Restore, which can create or remove
        // evaluated imports and sources. Only its completed outputs may
        // validate an older graph; every miss receives normal inspection.
        if (fresh) {
            currentToolContext = await evaluationToolContext(config.dotnet, host.options.analyzer, entryPoints.map(file => path.dirname(file)), signal, host.toolIdentities);
            currentEvaluationContext = evaluationContextFor(currentToolContext?.key); toolKey = currentToolContext?.key;
            reused = currentToolContext ? await host.projectEvaluations.get(files, currentEvaluationContext, signal) : new Map<string, readonly Project[]>();
            // Restore can also change the SDK selected by a project.
            contexts = await sdkContextGroups(files.filter(file => !reused.has(file)), signal);
            for (const context of contexts) {await host.sdk.ensure(config.dotnet, { ...processOptions, cwd: context.cwd }, context.key);}
        }
        if (reused.size) {events.output(`Reusing ${reused.size} validated project evaluation${reused.size === 1 ? '' : 's'}.\n`);}
        if (!contexts.length) {return reused;}
        const workers = Math.min(projectLimit, contexts.length);
        const graphs = await mapConcurrent(contexts, projectLimit, signal, async (context, _index, workerSignal) => {
            const graph = await evaluateProjects(config.dotnet, context.files, config.configuration,
                { ...processOptions, cwd: context.cwd, signal: workerSignal }, host.options.analyzer, Math.max(1, Math.floor(projectLimit / workers)), path.join(host.options.storage, 'digests'));
            return [...graph];
        });
        const evaluated = new Map(graphs.flat());
        if (currentToolContext) {await host.projectEvaluations.put(evaluated, currentEvaluationContext, signal, currentToolContext.root);}
        return new Map([...reused, ...evaluated]);
    });
    if (run.topology !== host.topology) {throw new Cancelled();}
    const evaluated = [...snapshots.values()].flat();
    // Exclusions control inventory and watching. MSBuild still writes
    // required excluded dependencies, so their conflicts stay in its plan.
    const projects = mergeProjects(evaluated.filter(project => !isExcluded(project.file, config.excludes, rootSnapshot)));
    const unsupportedReport = reportUnsupported(host, projects);
    const index = new ProjectIndex(projects, evaluatedInputs(snapshots, projects));
    const outside = (await normalizePathsAsync(unowned, signal)).filter(file => index.isOutsideProjects(file));
    const assets = await assetVersions(projects, host.assetHashes, signal);
    if (run.topology !== host.topology) {throw new Cancelled();}
    host.applyStructure({ projectSnapshots: snapshots, buildGraph: mergeProjects(evaluated), projects,
        index, structureDirty: !!manual, unowned: outside, assets, toolchain: contentHash(JSON.stringify([toolKey ?? null, host.sdk.resolved])),
        sourceFiles: projects.flatMap(project => [...project.sourceFiles, ...project.inputs ?? []])
            .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot)),
        analysisFiles: projects.flatMap(project => project.analysisFiles ?? project.sourceFiles) }, unsupportedReport);
    host.setInputs([...host.sources.files, ...filter.inputs, ...host.projects.map(project => project.file)]);
    await host.sources.refresh(host.sources.files, signal);
    const eligible = new Set(host.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
    const retained = host.discovered.filter(group => eligible.has(testTargetKey(group.project, group.framework)));
    if (retained.length !== host.discovered.length || [...host.runtime.containers.values()].some(group => !eligible.has(testTargetKey(group.project, group.framework)))) {
        // A library/reference can remain in the build graph without
        // remaining a test target. Retire it even if the next build fails.
        await host.reconcileGroups(retained, baseline);
        await host.save(signal);
    }
}

/** Unsupported test projects are skipped with a warning; a workspace with
 * nothing runnable reports why instead of silently showing no tests. Returns the report to retain. */
export function reportUnsupported(host: EngineHost, projects: readonly Project[]): string {
    const reasons = [...new Set(projects.flatMap(project => project.isTestProject && project.entryPoint !== false && project.unsupported ? [project.unsupported] : []))].sort();
    const report = reasons.join('\n');
    if (reasons.length && !projects.some(isTestTarget)) {
        throw new EnvironmentError('no-test-project', `No test project can run under Testy.\n${report}`);
    }
    if (report !== host.unsupportedReport && reasons.length) {
        host.options.events.output(`Skipping ${reasons.length} unsupported test target${reasons.length === 1 ? '' : 's'}:\n${report}\n`);
    }
    return report;
}

/** Owned inputs that evaluation itself read, such as imports with unusual extensions. MSBuild reports full paths
 * built from the canonical project paths; a spelling that still differs is only missed by this refinement. */
export function evaluatedInputs(snapshots: ReadonlyMap<string, readonly Project[]>, projects: readonly Project[]): ReadonlySet<string> {
    const spelling = (file: string): string => process.platform === 'win32' ? file.replace(/\\/g, '/').toLowerCase() : file;
    const read = new Set<string>();
    for (const graph of snapshots.values()) {for (const input of evaluationInputs.get(graph) ?? []) {for (const file of input.files) {read.add(spelling(file));}}}
    return new Set(projects.flatMap(project => project.inputs ?? []).filter(file => read.has(file)));
}
