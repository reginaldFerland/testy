import type { QueueEntry } from '../../core/queue';
import { EngineConfiguration, Project, TestFile, TestResult } from '../../core/model';
import type { SchedulingPriority } from '../../core/runPolicy';
import { ProjectIndex, Selection } from '../../core/selection';
import { ProcessOptions } from '../process';
import { RunnerSession } from '../runner';
import type { RunnerOptions } from '../runnerTypes';
import type { SourceShape } from '../analysis';
import type { AnalyzerServers } from '../analyzerServer';
import type { CoverageCache } from '../cache';
import type { PreparedOutputCache } from '../preparedOutputCache';
import type { ProjectEvaluationCache } from '../projectEvaluationCache';
import type { Baseline } from './baseline';

/** Progress of the current run stage; the extension formats and localizes it. */
export interface RunPhase {
    readonly kind: 'preparingProjects' | 'building' | 'preparingTests' | 'testing' | 'settingUpCoverage';
    readonly completed?: number;
    readonly total?: number;
    readonly active?: number;
    /** Baseline progress: test files learned so far, out of `learnedTotal`. */
    readonly learned?: number;
    readonly learnedTotal?: number;
    /** Testing: the expected milliseconds left, from the files' learned run times; absent while none is known. */
    readonly remaining?: number;
}
/** English names of the run stages in `Testy timing:` output lines. */
export const phaseTimingNames: Readonly<Record<RunPhase['kind'], string>> = {
    preparingProjects: 'Preparing projects', building: 'Building', preparingTests: 'Preparing tests', testing: 'Testing', settingUpCoverage: 'Setting up coverage'
};
export interface EngineEvents {
    readonly output: (text: string) => void;
    readonly phase: (phase: RunPhase) => void;
    readonly inputsChanged?: () => void;
    /** The cache restored saved state, such as `outcomes`. */
    readonly restored?: () => void;
    readonly discovered: (groups: readonly TestFile[]) => void | Promise<void>;
    readonly selected: (selection: Selection) => void;
    readonly result: (group: TestFile, result: TestResult) => void;
    readonly started: (group: TestFile, id: string) => void;
    readonly coverage: () => void;
    readonly invalidated: (files: readonly string[]) => void;
    readonly prepared?: (project: string) => void;
    /** The coverage collector could not be installed or started; the run continues without coverage. `reason` is the error. */
    readonly coverageUnavailable?: (reason: string) => void;
    /** Attach a debugger to a waiting test host; required for debug runs. */
    readonly debug?: (processId: number) => Promise<void>;
    /** The test batches of the testing run and their states, whenever one starts or finishes (see core/queue). */
    readonly queue?: (entries: readonly QueueEntry[]) => void;
}
export interface EngineOptions {
    readonly roots: readonly string[];
    readonly storage: string;
    readonly tools: string;
    readonly analyzer: string;
    readonly configuration: () => EngineConfiguration;
    readonly events: EngineEvents;
}
/** The collaborators an engine owns and disposes. Each one defaults to the production
 * implementation for the engine's storage; tests inject their own. */
export interface EngineServices {
    readonly coverageCache: CoverageCache;
    readonly preparedOutputs: PreparedOutputCache;
    readonly projectEvaluations: ProjectEvaluationCache;
    /** Long-lived analyzer processes, stopped when the engine is disposed. */
    readonly analyzerServers: AnalyzerServers;
    /** Creates the runner session of one run; the run disposes it. */
    readonly createSession: (options: RunnerOptions) => RunnerSession;
}
export interface RunSummary {
    readonly files: number;
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly duration: number;
    readonly coverageAvailable: boolean;
    /** Batches that could not run; their tests are reported as errored. */
    readonly failedBatches?: number;
}
export interface ManualSelection {
    readonly groups: ReadonlySet<string>;
    readonly all?: boolean;
    readonly projects?: ReadonlySet<string>;
    readonly exclude?: Omit<ManualSelection, 'exclude' | 'coverage'> | undefined;
    readonly tests?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly coverage?: boolean;
    /** Run without collection, one host at a time, each waiting for a debugger. */
    readonly debug?: boolean;
    /** Build and discover only; no tests run. */
    readonly discoverOnly?: boolean;
    /** MSBuild configuration for this run only, instead of `EngineConfiguration.configuration`. */
    readonly configuration?: string;
}
/** Test items an automatic run may execute, in the form of a manual selection. */
export type RunScope = Omit<ManualSelection, 'coverage' | 'debug' | 'discoverOnly' | 'configuration'>;

/** Resolved state shared by the phases of one run. */
export interface RunContext {
    readonly controller: AbortController;
    readonly signal: AbortSignal;
    readonly began: number;
    readonly topology: number;
    readonly configured: EngineConfiguration;
    readonly config: EngineConfiguration;
    readonly projectLimit: number;
    readonly testLimit: number;
    readonly manual?: ManualSelection | undefined;
    readonly manualOperation: boolean;
    /** Automatic runs limited to the items of a continuous run. */
    readonly scope?: RunScope | undefined;
    readonly full: boolean;
    readonly newBaseline: boolean;
    readonly baseline?: Baseline | undefined;
    /** Build and discover every project: a new baseline, or the first runs of a session (see TestEngine.restore). */
    readonly discoverAll: boolean;
    /** What this run's traces are learned under (see engine/identity). */
    readonly identity: string;
    readonly rootSnapshot: readonly string[];
    readonly processOptions: ProcessOptions;
    readonly changes: readonly string[];
    /** The user asked to run what these changes affect (see ChangeBatch): every file whose coverage reached them runs. */
    readonly explicit?: boolean;
    /** Versions of the untracked files a restart compares (see engine/untracked), taken before the build; set once structure is known. */
    readonly untracked?: ReadonlyMap<string, string> | undefined;
    readonly previousIndex: ProjectIndex;
    readonly structural: boolean;
    /** Aborts, with a Superseded reason, when newer changes supersede this automatic run (see Scheduler): before testing the run
     * stops at once; while testing it starts no further batch, finishes those the changes cannot affect, and ends cancelled. */
    readonly superseded?: AbortSignal | undefined;
    phase(kind: RunPhase['kind']): void;
    finishPhase(): void;
}
export interface BuildPlan {
    readonly anticipated: Selection;
    readonly closure: readonly Project[];
    readonly builds: readonly Project[];
    readonly testBuilds: readonly Project[];
    readonly sharedOutputs: ReadonlySet<string>;
    /** Resolves build output paths without synchronous file system calls; prepared once per plan. */
    readonly normalize?: (file: string) => string;
    /** Only the test targets of the anticipated selection build (see engine/plan); the run checks that the selection agrees. */
    readonly narrowed?: boolean;
}
export interface BuildResult {
    readonly revision: number;
    readonly obsoleteBuild: boolean;
    /** Source versions the build and its tests are attributed to. */
    readonly before: ReadonlyMap<string, string>;
    readonly snapshots: ReadonlyMap<string, string>;
    readonly sdkByFile: ReadonlyMap<string, string>;
}
/** What a run's stages hand back for its cleanup: the runner session, and whether it may be kept for the next run (see
 * TestEngine.takeSession) under its key. */
export interface RunState {
    sessions?: RunnerSession;
    retentionKey?: string;
    retain?: boolean;
    analyzing?: Promise<ReadonlyMap<string, string | null>>;
}
export interface PreparedTests {
    readonly coverageTool?: string | undefined;
    sessions: RunnerSession;
    runtimeTreeChanged: boolean;
    liveIds: Set<string>;
    currentShapes: ReadonlyMap<string, string | null>;
}
export interface SelectedRun {
    readonly selection: Selection;
    /** What the order of `selection.groups` favours; a throughput run also keeps a fast lane (see executeSelection). */
    readonly priority?: SchedulingPriority;
    readonly currentShapes: ReadonlyMap<string, string | null>;
    /** Baseline files to learn again, and the versions the remaining checkpoints now describe. */
    readonly checkpoint?: { readonly invalidated: readonly string[]; readonly shapes: ReadonlyMap<string, string | null>; readonly inputs: ReadonlyMap<string, string> } | undefined;
    /** Selected files narrowed to the tests their own coverage links to the changes (see core/testCoverage narrowTests): the tests
     * that run, by group ID. The others are moved to the built versions when the run commits. */
    readonly narrowed?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    /** Unselected files whose traces provably did not execute the edits of these changed files, by group ID (see engine/rebase). */
    readonly unaffected?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}
export interface TestedRun { readonly results: readonly TestResult[]; readonly executedFiles: ReadonlySet<string>; readonly available: boolean; readonly failedBatches: number; }

/** Retained source analyses, reused while bytes, aliases and the analyzer context match. */
export interface AnalysisState {
    readonly analyses: ReadonlyMap<string, SourceShape | null>;
    readonly analyzedHashes: ReadonlyMap<string, string>;
    readonly analysisContext: string | undefined;
    readonly aliasStamp: string | undefined;
    readonly excludedAliases: readonly string[];
}
/** The evaluated workspace a structural refresh produced. */
export interface StructureState {
    readonly projectSnapshots: ReadonlyMap<string, readonly Project[]>;
    readonly buildGraph: readonly Project[];
    readonly projects: readonly Project[];
    readonly index: ProjectIndex;
    readonly structureDirty: boolean;
    /** Sources and inputs whose versions are tracked, and the additional files only analysis reads. */
    readonly sourceFiles: readonly string[];
    readonly analysisFiles: readonly string[];
    /** Watched files outside every project, and the restored package assets by content (see engine/untracked). */
    readonly unowned: readonly string[];
    readonly assets: ReadonlyMap<string, string>;
    /** The SDK versions and evaluation tools found, which coverage learned with other ones cannot be trusted under. */
    readonly toolchain: string;
}
