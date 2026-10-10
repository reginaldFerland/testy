import * as path from 'node:path';
import { contentHash, testTargetKey } from '../../core/paths';
import { buildWaves, buildProjects, sdkContextGroups } from '../projects';
import { Cancelled } from '../process';
import { RunOutputLease } from '../runOutputs';
import { copyOutput } from '../output';
import { mapConcurrent } from '../../core/concurrency';
import type { EngineHost } from './host';
import type { BuildPlan, BuildResult, RunContext } from './types';

/** Build in conflict-free waves, snapshotting test outputs that a later context could overwrite. */
export async function build(host: EngineHost, run: RunContext, plan: BuildPlan, outputLease: RunOutputLease, beforeBuild: ReadonlyMap<string, string>): Promise<BuildResult> {
    const { signal, config, processOptions, projectLimit, manual, manualOperation } = run;
    const { closure, builds, testBuilds, sharedOutputs, normalize } = plan;
    const snapshots = new Map<string, string>();
    const builtInputs = [...new Set(closure.flatMap(project => [...project.analysisFiles ?? project.sourceFiles, ...project.inputs ?? []]))];
    const revision = host.sources.revision;
    const buildContexts = await sdkContextGroups([...new Set(builds.map(project => project.file))], signal);
    const sdkByFile = new Map(buildContexts.flatMap(context => context.files.map(file => [file, context.key] as const)));
    for (const wave of buildWaves(closure, builds, sdkByFile, normalize)) {
        const contexts = await sdkContextGroups([...new Set(wave.map(project => project.file))], signal);
        const workers = Math.min(projectLimit, contexts.length);
        await mapConcurrent(contexts, projectLimit, signal, async (context, _index, workerSignal) => {
            const options = { ...processOptions, cwd: context.cwd, signal: workerSignal };
            await host.sdk.ensure(config.dotnet, options, context.key);
            const roots = wave.filter(project => context.files.includes(project.file));
            await buildProjects(config.dotnet, roots, config.configuration, options, Math.max(1, Math.floor(projectLimit / workers)));
            for (const project of roots) {
                const key = testTargetKey(project.file, project.framework);
                if (testBuilds.includes(project) && sharedOutputs.has(key)) {
                    const snapshot = path.join(outputLease.directory, 'snapshots', contentHash(key));
                    await copyOutput(path.dirname(project.assembly), snapshot, workerSignal); snapshots.set(key, snapshot);
                }
            }
        });
        if (builds.length > wave.length) {host.options.events.output(`Build wave complete: ${wave.length} roots; dependency or output conflicts require ordered waves.\n`);}
    }
    const changedDuringBuild = await host.sources.refresh(builtInputs, signal);
    const obsoleteBuild = changedDuringBuild.some(file => !host.sources.isGenerated(file) && beforeBuild.get(file) !== host.hashes.get(file));
    if (obsoleteBuild && !manual && !manualOperation) {host.options.events.invalidated(changedDuringBuild); throw new Cancelled();}
    // A target can add a generated header to a pre-existing placeholder.
    // Exclude its old hash from analysis and coverage attribution as well.
    const before = changedDuringBuild.some(file => host.sources.isGenerated(file))
        ? new Map([...beforeBuild].filter(([file]) => !host.sources.isGenerated(file))) : beforeBuild;
    return { revision, obsoleteBuild, before, snapshots, sdkByFile };
}
