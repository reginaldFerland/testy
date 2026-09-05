export interface Project {
    readonly file: string;
    readonly framework: string;
    readonly assembly: string;
    readonly assemblies?: readonly string[];
    readonly isTestProject: boolean;
    readonly runner: 'mtp';
    readonly sourceFiles: readonly string[];
    readonly references: readonly string[];
    readonly binaryReferences?: readonly string[];
    /** Evaluated imports, resources and other build inputs across reference contexts. */
    readonly inputs?: readonly string[];
    readonly entryPoint?: boolean;
    readonly properties?: Readonly<Record<string, string>>;
}

export interface DiscoveredTest {
    readonly id: string;
    readonly name: string;
    readonly fullyQualifiedName: string;
    readonly file?: string;
    readonly line: number;
    /** Preserve provider properties required when sending a selected test back. */
    readonly node: Readonly<Record<string, unknown>>;
}

export interface TestFile {
    readonly id: string;
    readonly project: string;
    readonly framework: string;
    readonly assembly: string;
    readonly file?: string;
    readonly tests: readonly DiscoveredTest[];
}

export interface CoveredLine {
    readonly line: number;
    readonly hits: number;
}

export interface FileCoverage {
    readonly file: string;
    readonly hash: string;
    readonly lines: readonly CoveredLine[];
}

export interface Trace {
    readonly groupId: string;
    readonly dependencies: readonly string[];
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
    readonly message?: string;
    readonly stack?: string;
    readonly output?: string;
    readonly node?: Readonly<Record<string, unknown>>;
}
