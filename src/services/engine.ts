import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CoverageStore } from '../core/coverage';
import { Project, TestFile, TestResult, Trace } from '../core/model';
import { ChangeBatch } from '../core/scheduler';
import { affectedProjects, selectTests, Selection } from '../core/selection';
import { defaultExcludes, isConfigurationFile } from '../core/paths';
import { evaluateProject, findProjects } from './projects';
import { Cancelled, ProcessOptions, requireSuccess, runProcess } from './process';
import { discover, RunnerOptions, runTestFile, sourceHashes } from './runner';
import { sourceShapes } from './analysis';

export interface EngineConfiguration {
    readonly dotnet: string;
    readonly configuration: string;
    readonly mode: 'affected' | 'all';
    readonly coverage: boolean;
    readonly excludes: readonly string[];
    readonly testArguments: readonly string[];
    readonly timeout: number;
    readonly coverageTool?: string;
}
export interface EngineEvents {
    readonly output: (text: string) => void;
    readonly phase: (message: string) => void;
    readonly discovered: (groups: readonly TestFile[]) => void;
    readonly selected: (selection: Selection) => void;
    readonly result: (group: TestFile, result: TestResult) => void;
    readonly started: (group: TestFile, id: string) => void;
    readonly coverage: () => void;
    readonly invalidated: (files: readonly string[]) => void;
}
export interface EngineOptions {
    readonly roots: readonly string[];
    readonly storage: string;
    readonly tools: string;
    readonly analyzer: string;
    readonly configuration: () => EngineConfiguration;
    readonly events: EngineEvents;
}
export interface RunSummary {
    readonly files: number;
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly duration: number;
    readonly coverageAvailable: boolean;
}
export interface ManualSelection {
    readonly groups: ReadonlySet<string>;
    readonly tests?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly coverage?: boolean;
}

export class TestEngine {
    readonly coverage = new CoverageStore();
    projects: readonly Project[] = [];
    groups: readonly TestFile[] = [];
    hashes: ReadonlyMap<string, string> = new Map();
    private initialized = false;
    private coverageFailed = false;
    private shapes: ReadonlyMap<string, string | null> = new Map();

    constructor(private readonly options: EngineOptions) {}

    async markChanged(): Promise<void> {
        this.hashes = await sourceHashes(this.projects);
        this.options.events.coverage();
    }

    async run(batch: ChangeBatch, signal: AbortSignal, manual?: ManualSelection): Promise<RunSummary> {
        const began = Date.now();
        const configured = this.options.configuration();
        const config = { ...configured, coverage: manual?.coverage ?? configured.coverage };
        const reserved = ['--server', '--client-port', '--client-host', '--list-tests', '--filter-uid', '--filter', '--treenode-filter', '--results-directory', '--ignore-exit-code', '--help', '--info'];
        if (config.testArguments.some(argument => reserved.some(option => argument === option || argument.startsWith(`${option}=`)))) {
            throw new Error('testy.testArguments contains an option reserved for test discovery, selection, or communication. Remove runner/filter options from that setting.');
        }
        const events = this.options.events;
        const processOptions: ProcessOptions = { cwd: this.options.roots[0], signal, output: events.output, timeoutMs: config.timeout };
        const full = batch.full || !this.initialized;
        const structural = full || batch.files.some(file => isConfigurationFile(file) || !this.projects.some(project => project.sourceFiles.includes(file)));
        const version = requireSuccess(await runProcess(config.dotnet, ['--version'], { ...processOptions, output: undefined }), 'Finding the .NET SDK').stdout.trim();
        if (Number(version.split('.')[0]) < 10) {throw new Error(`Testy requires .NET SDK 10 or later; this workspace selects ${version}. Check global.json.`);}
        if (full) {this.coverageFailed = false;}
        if (structural) {
            events.phase('Preparing projects');
            const projectFiles = await findProjects(this.options.roots, [...defaultExcludes, ...config.excludes]);
            const projects: Project[] = [];
            for (const file of projectFiles) {
                requireSuccess(await runProcess(config.dotnet, ['restore', file, `-property:Configuration=${config.configuration}`, '--nologo'], processOptions), `Restoring ${path.basename(file)}`);
                projects.push(...await evaluateProject(config.dotnet, file, config.configuration, processOptions));
            }
            this.projects = projects;
        }
        const relevant = full || config.mode === 'all' ? new Set(this.projects.map(project => project.file)) : affectedProjects(this.projects, batch.files);
        if (manual) {
            for (const group of this.groups) {if (manual.groups.has(group.id)) {relevant.add(group.project);}}
        }
        const buildProjects = this.projects.filter(project => project.isTestProject && relevant.has(project.file));
        const before = await sourceHashes(this.projects);
        this.hashes = before;
        events.coverage();
        events.phase('Building');
        for (const project of buildProjects) {
            requireSuccess(await runProcess(config.dotnet, ['build', project.file, '--framework', project.framework, '--configuration', config.configuration, '--no-restore', '--nologo'], processOptions), `Building ${path.basename(project.file)}`);
        }
        await this.ensureUnchanged(before, signal);
        const shapeFiles = [...before.keys()].filter(file => full || !this.shapes.has(file) || batch.files.includes(file));
        let nextShapes: ReadonlyMap<string, string | null>;
        try {
            nextShapes = await sourceShapes(config.dotnet, this.options.analyzer, shapeFiles, this.options.storage, processOptions);
        } catch (error) {
            signal.throwIfAborted();
            events.output(`Source analysis unavailable; using project fallback. ${String(error)}\n`);
            nextShapes = new Map(shapeFiles.map(file => [file, null]));
        }
        const conservativeChanges = new Set(batch.files.filter(file => !nextShapes.get(file) || nextShapes.get(file) !== this.shapes.get(file)));
        let coverageTool: string | undefined;
        if (config.coverage && buildProjects.length && !this.coverageFailed) {
            try { coverageTool = await this.ensureCoverageTool(config, processOptions); }
            catch (error) {
                signal.throwIfAborted(); this.coverageFailed = true;
                events.output(`Coverage unavailable; tests will continue with conservative selection. ${String(error)}\n`);
            }
        }
        const runner: RunnerOptions = {
            ...processOptions, dotnet: config.dotnet, storage: path.join(this.options.storage, 'runs'),
            testArguments: config.testArguments, coverageTool, onResult: events.result, onStarted: events.started
        };
        events.phase('Discovering tests');
        const next = this.groups.filter(group => !buildProjects.some(project => project.file === group.project && project.framework === group.framework)
            && this.projects.some(project => project.file === group.project && project.framework === group.framework));
        for (const project of buildProjects) {next.push(...await discover(project, runner));}
        const changedGroups = new Set(next.filter(group => {
            const previous = this.groups.find(item => item.id === group.id);
            return previous && previous.tests.map(test => test.id).sort().join('\0') !== group.tests.map(test => test.id).sort().join('\0');
        }).map(group => group.id));
        this.coverage.invalidate(changedGroups);
        this.groups = next;
        this.coverage.replace([], new Set(next.map(group => group.id)));
        events.discovered(this.groups);
        this.hashes = before;
        // Disabling coverage must not keep narrowing execution with an aging map.
        if (!coverageTool) {this.coverage.invalidate(new Set(this.groups.map(group => group.id)));}
        const selection = manual
            ? { groups: this.groups.filter(group => manual.groups.has(group.id)).map(group => ({
                ...group, tests: group.tests.filter(test => !manual.tests?.has(group.id) || manual.tests.get(group.id)!.has(test.id))
            })).filter(group => group.tests.length > 0), reason: 'Manual run', fallback: false }
            : selectTests(this.groups, this.projects, this.coverage.traces, batch.files, config.mode, full, conservativeChanges);
        events.selected(selection);
        const traces: Trace[] = [];
        const results: TestResult[] = [];
        for (let index = 0; index < selection.groups.length; index++) {
            const group = selection.groups[index];
            events.phase(`Testing ${index + 1}/${selection.groups.length} files`);
            const run = await runTestFile(group, before, runner);
            results.push(...run.results);
            // Coverage off keeps previous contributions visible, clearly stale if
            // their source version has changed, and disables precise selection.
            // A manually selected single case must not replace the complete
            // test-file contribution and erase coverage from its sibling cases.
            if (group.tests.length !== this.groups.find(item => item.id === group.id)?.tests.length) {continue;}
            traces.push(coverageTool ? run.trace : {
                ...run.trace, coverage: this.coverage.traces.get(group.id)?.coverage ?? [],
                dependencies: this.coverage.traces.get(group.id)?.dependencies ?? run.trace.dependencies
            });
        }
        await this.ensureUnchanged(before, signal);
        signal.throwIfAborted();
        this.coverage.replace(traces, new Set(this.groups.map(group => group.id)));
        // A partial manual run cannot establish a new project-wide baseline.
        if (!manual) {this.shapes = new Map([...this.shapes, ...nextShapes].filter(([file]) => before.has(file)));}
        this.initialized = true;
        events.coverage();
        await this.save();
        return {
            files: selection.groups.length, tests: results.length,
            passed: results.filter(result => result.outcome === 'passed').length,
            failed: results.filter(result => result.outcome === 'failed' || result.outcome === 'errored').length,
            skipped: results.filter(result => result.outcome === 'skipped').length,
            duration: Date.now() - began, coverageAvailable: !!coverageTool
        };
    }

    async restore(): Promise<void> {
        try {
            const saved = JSON.parse(await fs.readFile(path.join(this.options.storage, 'coverage.json'), 'utf8'));
            if (saved.version !== 1 || !Array.isArray(saved.traces)) {return;}
            const traces = saved.traces.filter((trace: Trace) => typeof trace.groupId === 'string'
                && Array.isArray(trace.dependencies) && trace.dependencies.every(file => typeof file === 'string')
                && Array.isArray(trace.coverage) && trace.coverage.every(file => typeof file.file === 'string' && typeof file.hash === 'string'
                    && Array.isArray(file.lines) && file.lines.every((line: { line: number; hits: number }) => Number.isInteger(line.line) && Number.isFinite(line.hits))));
            // Always rebuild the baseline on open, even when cached coverage exists.
            this.coverage.restore(traces);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {this.options.events.output('Ignoring an unreadable Testy coverage cache.\n');}
        }
    }

    private async ensureUnchanged(snapshot: ReadonlyMap<string, string>, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        const current = await sourceHashes(this.projects);
        const changed = [...new Set([...snapshot.keys(), ...current.keys()])].filter(file => snapshot.get(file) !== current.get(file));
        if (changed.length) {
            this.hashes = current;
            this.options.events.coverage();
            this.options.events.invalidated(changed);
            throw new Cancelled();
        }
    }

    private async ensureCoverageTool(config: EngineConfiguration, processOptions: ProcessOptions): Promise<string> {
        if (config.coverageTool) {return config.coverageTool;}
        const directory = path.join(this.options.tools, 'coverage-18.1.0');
        const executable = path.join(directory, process.platform === 'win32' ? 'dotnet-coverage.exe' : 'dotnet-coverage');
        try { await fs.access(executable); return executable; } catch { /* First use. */ }
        this.options.events.phase('Setting up coverage');
        await fs.mkdir(directory, { recursive: true });
        requireSuccess(await runProcess(config.dotnet, ['tool', 'install', 'dotnet-coverage', '--version', '18.1.0', '--tool-path', directory], processOptions), 'Installing the coverage collector');
        return executable;
    }

    private async save(): Promise<void> {
        await fs.mkdir(this.options.storage, { recursive: true });
        const file = path.join(this.options.storage, 'coverage.json');
        const temporary = `${file}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ version: 1, traces: [...this.coverage.traces.values()] }));
        await fs.rename(temporary, file);
    }
}
