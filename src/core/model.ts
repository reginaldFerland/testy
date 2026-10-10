export interface Project {
    readonly file: string;
    readonly framework: string;
    readonly assembly: string;
    readonly assemblyName?: string;
    readonly assemblies?: readonly string[];
    readonly isTestProject: boolean;
    readonly runner: 'mtp';
    readonly sourceFiles: readonly string[];
    /** Compile inputs retained for semantic analysis, including ignored outputs. */
    readonly analysisFiles?: readonly string[];
    readonly references: readonly string[];
    readonly binaryReferences?: readonly string[];
    /** Evaluated output and intermediate directories used to avoid competing builds. */
    readonly outputDirectories?: readonly string[];
    /** Evaluated imports, resources and other build inputs across reference contexts. */
    readonly inputs?: readonly string[];
    readonly entryPoint?: boolean | undefined;
    readonly properties?: Readonly<Record<string, string>>;
    /** SDK graph node identity and exact edges, before merging file ownership. */
    readonly contextId?: string;
    readonly contextReferences?: readonly string[];
    /** Individual evaluated producers retained when ownership is merged. */
    readonly contexts?: readonly Project[];
    /** Why a test project cannot run under Testy (VSTest, or older than .NET 10). */
    readonly unsupported?: string;
}

export interface DiscoveredTest {
    readonly id: string;
    readonly name: string;
    readonly fullyQualifiedName: string;
    readonly file?: string | undefined;
    readonly line: number;
    /** Last line of the test's declaration, when the provider reports it. */
    readonly endLine?: number;
    /** Provider traits and categories, offered as Test Explorer tags. */
    readonly traits?: readonly { readonly key: string; readonly value: string }[];
    /** Preserve provider properties required when sending a selected test back. */
    readonly node: Readonly<Record<string, unknown>>;
}

export interface TestFile {
    readonly id: string;
    readonly project: string;
    readonly framework: string;
    readonly assembly: string;
    readonly file?: string | undefined;
    readonly tests: readonly DiscoveredTest[];
    /** Explicit manual exclusions must also constrain runtime identity fallback. */
    readonly excludedTestIds?: readonly string[] | undefined;
    /** Rows whose file cannot be identified; manual fallback covers the project. */
    readonly runtimeOnly?: boolean;
}

export interface CoveredLine {
    readonly line: number;
    readonly hits: number;
}

/** A method's source span from the coverage report, in 1-based inclusive lines. */
export interface Declaration {
    readonly name: string;
    readonly start: number;
    readonly end: number;
}

export interface FileCoverage {
    readonly file: string;
    readonly hash: string;
    readonly lines: readonly CoveredLine[];
    /** Method spans; geometry like the lines, so equal for every test of one source version. */
    readonly declarations?: readonly Declaration[];
}

export interface Trace {
    readonly groupId: string;
    readonly dependencies: readonly string[];
    /** Whole-module dependencies observed outside the instrumented private copy. */
    readonly moduleProjects?: readonly string[] | undefined;
    readonly coverage: readonly FileCoverage[];
    /** Only complete, successful runs can narrow subsequent selections. */
    readonly reliable: boolean;
    readonly timestamp: number;
    /** Source versions that produced this contribution, including the test file. */
    readonly inputs?: Readonly<Record<string, string>>;
    readonly stale?: boolean;
    /** An aggregate partially superseded by file runs cannot become fresh again. */
    readonly historical?: boolean;
}

export interface TestResult {
    readonly id: string;
    readonly name: string;
    readonly fullyQualifiedName: string;
    readonly outcome: 'passed' | 'failed' | 'skipped' | 'errored';
    readonly duration: number;
    readonly message?: string | undefined;
    readonly stack?: string | undefined;
    /** Assertion values for a diff, when the framework reports them. */
    readonly expected?: string;
    readonly actual?: string;
    readonly output?: string;
    readonly node?: Readonly<Record<string, unknown>>;
}

/** A test project Testy can discover and run: an MTP entry point on .NET 10 or later. */
export function isTestTarget(project: Project): boolean {
    return project.isTestProject && project.entryPoint !== false && !project.unsupported;
}

export interface EngineConfiguration {
    readonly dotnet: string;
    readonly configuration: string;
    readonly mode: 'affected' | 'all';
    readonly coverage: boolean;
    readonly excludes: readonly string[];
    readonly testArguments: readonly string[];
    readonly timeout: number;
    readonly coverageTool?: string | undefined;
    readonly maxParallelProjects?: number;
    readonly maxParallelTestFiles?: number;
    /** Optional .sln, .slnx or .slnf limiting the workspace's entry-point projects. */
    readonly solution?: string | undefined;
    /** Solutions that limit only the entry points inside their workspace folder (folder-level `testy.solution`). */
    readonly solutions?: readonly { readonly file: string; readonly root: string }[] | undefined;
    /** Entry-point project globs; exclusions win over inclusions. */
    readonly projects?: { readonly include: readonly string[]; readonly exclude: readonly string[] };
}
