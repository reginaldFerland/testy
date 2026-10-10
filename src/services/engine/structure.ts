import * as path from 'node:path';
import { isTestTarget, Project } from '../../core/model';
import { environmentIdentity } from '../../core/environment';
import { ProjectIndex } from '../../core/selection';
import { contentHash, defaultExcludes, isConfigurationFile, isExcluded, testTargetKey } from '../../core/paths';
import { mergeProjects, evaluateProjects, restoreProjects, filterEntryPoints, findProjects, refreshProjectSnapshotBatches, sdkContextGroups, sdkConfigurationFiles } from '../projects';
import { Cancelled } from '../process';
import { evaluationToolContext } from '../projectEvaluationCache';
import { mapConcurrent } from '../../core/concurrency';
import { EnvironmentError } from '../../core/errors';
import type { EngineHost } from './host';
import type { RunContext } from './types';

/** Find, restore and evaluate projects, then reconcile the test inventory. */
export async function refreshStructure(host: EngineHost, run: RunContext): Promise<void> {
    const { config, signal, manual, newBaseline, rootSnapshot, processOptions, projectLimit, changes, baseline } = run;
    const events = host.options.events;
    if (newBaseline || changes.some(isConfigurationFile)) {host.sdk.forget(); host.restored.clear();}
    const selected = manual && !manual.all ? [...new Set([...manual.projects ?? [], ...host.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])] : undefined;
    const filter = await filterEntryPoints(await findProjects(rootSnapshot, [...defaultExcludes, ...config.excludes], signal, 16,
        (directory, error) => events.output(`Skipping unreadable directory ${directory}: ${error.message}\n`)),
    { solution: config.solution, solutions: config.solutions, include: config.projects?.include, exclude: config.projects?.exclude }, rootSnapshot, signal);
    const entryPoints = filter.entryPoints;
    // SDK selection can fail before MSBuild can describe any inputs.
    // Keep its candidate paths observable so a corrected pin can recover.
    host.setInputs([...host.inputs, ...filter.inputs, ...entryPoints, ...entryPoints.flatMap(sdkConfigurationFiles)
        .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot))]);
    host.projectEvaluations.retain(entryPoints);
    const toolContext = await evaluationToolContext(config.dotnet, host.options.analyzer, entryPoints.map(file => path.dirname(file)), signal);
    // Launch-specific variables (VSCODE_PID, SHLVL, ...) would otherwise invalidate every saved evaluation on restart.
    const evaluationContextFor = (key: string | undefined): string => contentHash(JSON.stringify([key, config.dotnet, config.configuration, host.options.analyzer, rootSnapshot,
        config.excludes, environmentIdentity(process.env)]));
    const evaluationContext = evaluationContextFor(toolContext?.key);
    const snapshots = await refreshProjectSnapshotBatches(host.projectSnapshots, entryPoints, selected, async files => {
        let currentToolContext = toolContext, currentEvaluationContext = evaluationContext;
        let reused = newBaseline || !toolContext ? new Map<string, readonly Project[]>() : await host.projectEvaluations.get(files, evaluationContext, signal);
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
                for (const file of missing) {host.restored.add(key(file));}
            }
        }
        // A fresh baseline still runs Restore, which can create or remove
        // evaluated imports and sources. Only its completed outputs may
        // validate an older graph; every miss receives normal inspection.
        if (newBaseline) {
            currentToolContext = await evaluationToolContext(config.dotnet, host.options.analyzer, entryPoints.map(file => path.dirname(file)), signal);
            currentEvaluationContext = evaluationContextFor(currentToolContext?.key);
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
    host.projectSnapshots = snapshots;
    const evaluated = [...snapshots.values()].flat();
    // Exclusions control inventory and watching. MSBuild still writes
    // required excluded dependencies, so their conflicts stay in its plan.
    host.buildGraph = mergeProjects(evaluated);
    host.projects = mergeProjects(evaluated.filter(project => !isExcluded(project.file, config.excludes, rootSnapshot)));
    reportUnsupported(host);
    host.index = new ProjectIndex(host.projects); host.structureDirty = !!manual;
    host.sources.setFiles(host.projects.flatMap(project => [...project.sourceFiles, ...project.inputs ?? []])
        .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot)),
    host.projects.flatMap(project => project.analysisFiles ?? project.sourceFiles));
    host.setInputs([...host.sources.files, ...filter.inputs, ...host.projects.map(project => project.file)]);
    await host.sources.refresh(host.sources.files, signal);
    const eligible = new Set(host.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
    const retained = host.groups.filter(group => eligible.has(testTargetKey(group.project, group.framework)));
    if (retained.length !== host.groups.length || [...host.runtime.containers.values()].some(group => !eligible.has(testTargetKey(group.project, group.framework)))) {
        // A library/reference can remain in the build graph without
        // remaining a test target. Retire it even if the next build fails.
        await host.reconcileGroups(retained, baseline);
        await host.save(signal);
    }
}

/** Unsupported test projects are skipped with a warning; a workspace with
 * nothing runnable reports why instead of silently showing no tests. */
export function reportUnsupported(host: EngineHost): void {
    const reasons = [...new Set(host.projects.flatMap(project => project.isTestProject && project.entryPoint !== false && project.unsupported ? [project.unsupported] : []))].sort();
    const report = reasons.join('\n');
    if (reasons.length && !host.projects.some(isTestTarget)) {
        throw new EnvironmentError('no-test-project', `No test project can run under Testy.\n${report}`);
    }
    if (report !== host.unsupportedReport && reasons.length) {
        host.options.events.output(`Skipping ${reasons.length} unsupported test target${reasons.length === 1 ? '' : 's'}:\n${report}\n`);
    }
    host.unsupportedReport = report;
}
