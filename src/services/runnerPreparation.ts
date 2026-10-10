import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Project, TestFile } from '../core/model';
import { compareCodeUnits, contentHash, testTargetKey } from '../core/paths';
import { stableEnvironment } from '../core/environment';
import { requestTests, TestNode } from './mtp';
import { requireSuccess, runProcess } from './process';
import { copyOutput, fileHash, PreparedOutput, removeOutput } from './output';
import { PreparedArtifact, PreparedArtifactLease } from './preparedOutputCache';
import { preparationToolIdentity } from './preparationTools';
import { windowsPreparationTools } from './preparationIdentity';
import { discover, nodeKey } from './runnerDiscovery';
import { assemblyName, instrumentWithSpareCapacity, workspaceOutputs } from './runnerInstrumentation';
import type { RunnerOptions } from './runnerTypes';

export interface Preparation {
    readonly root: string; output: PreparedOutput; readonly session: string; coverage: boolean; coveragePending?: boolean | undefined;
    nodes: readonly TestNode[]; nativeById: ReadonlyMap<string, TestNode>;
    byKey: ReadonlyMap<string, readonly TestNode[]>; instrumented?: readonly string[]; groups?: readonly TestFile[]; runs: number;
    readonly lease?: PreparedArtifactLease | undefined;
    /** An in-place coverage upgrade did not finish; the template must not be retained. */
    interrupted?: { readonly error: unknown };
    /** A collector using this instrumentation session was stopped or failed. Its
     * session may retain partial state, so the template is not reused. */
    collectorInterrupted?: boolean;
}

/** Prepares each test target of one runner session once: a private output, optionally
 * instrumented and cached, with its native discovery inventory. */
export class RunnerPreparations {
    readonly prepared = new Map<string, Preparation>();
    private readonly preparations = new Map<string, Promise<Preparation>>();
    readonly toolContexts: Map<string, Promise<string>>;
    readonly toolIdentities: Map<string, Promise<string>>;
    constructor(private readonly options: RunnerOptions, private readonly outputRoot: () => Promise<string>,
        private readonly projects: ReadonlyMap<string, Project>) {
        this.toolContexts = options.preparationTools ?? new Map<string, Promise<string>>();
        this.toolIdentities = options.preparationToolIdentities ?? new Map<string, Promise<string>>();
    }

    /** Preparations still in progress, which disposal must drain. */
    pending(): Promise<Preparation>[] { return [...this.preparations.values()]; }

    /** Cancelled or failed runs keep templates that were only discovered or
     * whose executions completed: reacquiring a lease revalidates the
     * template bytes. Interrupted upgrades and collector sessions are discarded. */
    releases(): (() => Promise<void>)[] {
        return [...this.prepared.values()].map(preparation => () => preparation.lease
            ? preparation.lease.release(!preparation.interrupted && !preparation.collectorInterrupted) : removeOutput(preparation.root));
    }

    async prepare(group: TestFile): Promise<Preparation> {
        const key = testTargetKey(group.project, group.framework);
        const existing = this.prepared.get(key); if (existing) {return existing;}
        const preparing = this.preparations.get(key); if (preparing) {return preparing;}
        const pending = this.prepareTarget(group);
        this.preparations.set(key, pending);
        try {return await pending;}
        finally {this.preparations.delete(key);}
    }

    /** Processes for a target run in its project directory. */
    private projectOptions(group: Pick<TestFile, 'project'>): RunnerOptions { return { ...this.options, cwd: path.dirname(group.project) }; }

    /** The build output a target is prepared from: its snapshot when one was taken. */
    private outputSource(group: Pick<TestFile, 'project' | 'framework' | 'assembly'>): string {
        return this.options.snapshots?.get(testTargetKey(group.project, group.framework)) ?? path.dirname(group.assembly);
    }

    private async prepareTarget(group: TestFile): Promise<Preparation> {
        const key = testTargetKey(group.project, group.framework);
        const options = this.projectOptions(group);
        const source = this.outputSource(group);
        let lease: PreparedArtifactLease | undefined;
        if (options.preparedOutputCache) {
            let context: string | undefined;
            try {context = await this.preparationContext(group);}
            catch (error) {options.signal?.throwIfAborted(); options.output?.(`Prepared output caching unavailable for ${path.basename(group.project)}: ${String(error)}\n`);}
            lease = await options.preparedOutputCache.acquire(source, context ?? randomUUID(), async root => {
                const artifact = await this.createArtifact(group, source, root);
                return context ? artifact : { ...artifact, reusable: false };
            }, options.signal, JSON.stringify([key, options.preparationLane ?? 0]), options.preparedAfter);
            options.output?.(`Prepared output cache ${lease?.hit ? 'hit' : 'miss'} for ${path.basename(group.project)} (${group.framework}).\n`);
        }
        let artifact: PreparedArtifact;
        if (lease) {artifact = lease.artifact;}
        else {
            const root = path.join(await this.outputRoot(), contentHash(key));
            await fs.mkdir(root, { recursive: true });
            try {artifact = await this.createArtifact(group, source, root);}
            catch (error) {await removeOutput(root); throw error;}
        }
        const root = artifact.root;
        try {
            if (artifact.coveragePending && !options.deferCoverage?.(group)) {
                artifact = await this.upgradeArtifact(group, source, artifact);
                await lease?.update(artifact, options.signal);
            }
            const { output, session, coverage, coveragePending, instrumented } = artifact;
            const prepared = { root, output, session, coverage, coveragePending, ...await this.discoverArtifact(group, output), instrumented, lease, runs: 0 };
            this.prepared.set(key, prepared); options.onPrepared?.(group.project);
            return prepared;
        } catch (error) {
            if (lease) {await lease.release(false);} else {await removeOutput(root);}
            throw error;
        }
    }

    private async discoverArtifact(group: TestFile, output: PreparedOutput): Promise<Pick<Preparation, 'nodes' | 'nativeById' | 'byKey'>> {
        const options = this.projectOptions(group);
        const nodes = await requestTests({ ...options, assembly: path.join(output.directory, path.basename(group.assembly)), args: options.testArguments }, 'discover');
        // Discovery can also execute user code and mutate assets.
        await output.restore(options.signal);
        const nativeById = new Map<string, TestNode>(), byKey = new Map<string, TestNode[]>();
        let work = 0;
        for (const node of nodes) {
            nativeById.set(node.uid, node);
            const key = nodeKey(node); const matching = byKey.get(key) ?? []; matching.push(node); byKey.set(key, matching);
            if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
        }
        return { nodes, nativeById, byKey };
    }

    async prepareSelectedCoverage(group: TestFile, preparation: Preparation): Promise<void> {
        const source = this.outputSource(group);
        this.options.output?.(`Preparing coverage for selected ${path.basename(group.project)} (${group.framework}).\n`);
        const artifact = await this.upgradeArtifact(group, source, { root: preparation.root, output: preparation.output,
            session: preparation.session, coverage: preparation.coverage, coveragePending: true, instrumented: preparation.instrumented ?? [],
            reusable: preparation.lease?.artifact.reusable ?? true });
        await preparation.lease?.update(artifact, this.options.signal);
        Object.assign(preparation, artifact, await this.discoverArtifact(group, artifact.output));
        // Providers may derive IDs from the rewritten binary. Resolve selections only
        // against this refreshed inventory, retaining the ordinary ambiguity guards.
        const project = this.projects.get(testTargetKey(group.project, group.framework));
        if (project) {
            preparation.groups = (await discover({ ...project, assembly: path.join(artifact.output.directory, path.basename(project.assembly)) }, this.options, preparation.nodes))
                .map(item => ({ ...item, assembly: project.assembly }));
        }
    }

    async preparationContext(group: TestFile): Promise<string> {
        const options = this.options;
        const cwd = path.dirname(group.project);
        let toolContext = this.toolContexts.get(cwd);
        if (!toolContext) {const pending = toolContext = (async () => {
            const env = this.preparationEnvironment();
            let tools: unknown;
            if (process.platform === 'win32') {tools = await windowsPreparationTools(options, env, cwd, this.toolIdentities);}
            else {
                const identities = await Promise.allSettled([options.dotnet, options.coverageTool, options.analyzer]
                    .map(command => preparationToolIdentity(command, env, options.signal, cwd, this.toolIdentities)));
                tools = identities.map(identity => {if (identity.status === 'rejected') {throw identity.reason;} return identity.value;});
            }
            return contentHash(JSON.stringify({ tools, env: Object.entries(env).sort(([left], [right]) => compareCodeUnits(left, right)),
                arguments: options.testArguments, assemblies: [...(options.assemblies ?? [])].sort(), modules: options.modules,
                runtime: process.version, platform: process.platform, architecture: process.arch }));
        })(); this.toolContexts.set(cwd, pending);
        // A failed or cancelled identification must not be reused by later preparations.
        void pending.catch(() => {if (this.toolContexts.get(cwd) === pending) {this.toolContexts.delete(cwd);}});}
        // Bump when preparation semantics change; retained templates can cross editor lifetimes.
        // 4/5: identity keys are ordered by code units instead of the host locale.
        return JSON.stringify({ version: process.platform === 'win32' ? 5 : 4, tools: await toolContext, project: group.project, framework: group.framework,
            assembly: group.assembly, context: options.preparationContexts?.get(testTargetKey(group.project, group.framework)) });
    }

    private preparationEnvironment(): NodeJS.ProcessEnv {
        const env = { ...process.env, ...this.options.env };
        return this.options.managedCoverageTool ? stableEnvironment(env) : env;
    }

    private async createArtifact(group: TestFile, source: string, root: string): Promise<PreparedArtifact> {
        const options = this.projectOptions(group);
        const template = path.join(root, 'template');
        const session = randomUUID();
        try {
            await copyOutput(source, template, options.signal);
            const coveragePending = !!options.coverageTool && !!options.deferCoverage?.(group);
            if (coveragePending) {options.output?.(`Deferring coverage preparation for ${path.basename(group.project)} (${group.framework}) until selection.\n`);}
            const { coverage, instrumented } = coveragePending ? { coverage: false, instrumented: [] }
                : await this.instrumentTemplate(group, source, template, root, session);
            const output = new PreparedOutput(template, path.join(root, 'assembly'));
            await output.initialize(options.signal);
            return { root, output, session, coverage, coveragePending, instrumented, reusable: coveragePending || coverage === !!options.coverageTool };
        } catch (error) {await removeOutput(root); throw error;}
    }

    private async upgradeArtifact(group: TestFile, source: string, artifact: PreparedArtifact): Promise<PreparedArtifact> {
        const { coverage, instrumented } = await this.instrumentTemplate(group, source, artifact.output.template, artifact.root, artifact.session);
        const output = new PreparedOutput(artifact.output.template, artifact.output.directory);
        await removeOutput(output.directory);
        await output.initialize(this.options.signal);
        return { ...artifact, output, coverage, coveragePending: false, instrumented, reusable: artifact.reusable && coverage === !!this.options.coverageTool };
    }

    private async instrumentTemplate(group: TestFile, source: string, template: string, root: string, session: string): Promise<{ coverage: boolean; instrumented: string[] }> {
        const options = { ...this.projectOptions(group), env: this.options.managedCoverageTool ? this.preparationEnvironment() : this.options.env };
        let coverage = !!options.coverageTool;
        const instrumented: string[] = [];
        if (coverage) {
            const assemblies = new Set((options.assemblies ?? [group.assembly]).map(assemblyName));
            const files = await workspaceOutputs(template, assemblies, options.signal);
            const instrument = async (assembly: string, signal: AbortSignal | undefined): Promise<string | undefined> => {
                const before = await fileHash(assembly, signal);
                requireSuccess(await runProcess(options.coverageTool!, ['instrument', assembly, '--session-id', session, '--nologo'],
                    { ...options, signal }), `Instrumenting ${path.basename(assembly)}`);
                // The collector can exit 0 after skipping a module (for
                // example, no_symbols). An unchanged DLL must retain its
                // whole-module dependency when the observer sees it load.
                if (await fileHash(assembly, signal) !== before) {
                    return path.join(root, 'assembly', path.relative(template, assembly));
                }
                options.output?.(`No instrumentation change in ${path.basename(assembly)}; retaining module dependencies.\n`);
                return undefined;
            };
            try {
                if (options.managedCoverageTool && options.tryInstrumentation) {
                    const results = await instrumentWithSpareCapacity(files, options.signal, options.tryInstrumentation, instrument);
                    instrumented.push(...results.filter((assembly): assembly is string => assembly !== undefined));
                } else {
                    for (const assembly of files) {const result = await instrument(assembly, options.signal); if (result) {instrumented.push(result);}}
                }
            } catch (error) {
                options.signal?.throwIfAborted(); coverage = false; instrumented.length = 0;
                options.output?.(`Coverage preparation failed; running tests without collection. ${String(error)}\n`);
                // All sibling commands have drained before restoring the pristine template.
                await removeOutput(template);
                await copyOutput(source, template, options.signal);
            }
        }
        return { coverage, instrumented };
    }
}
