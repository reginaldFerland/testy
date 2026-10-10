import { DiscoveredTest, TestFile, TestResult, Trace } from '../core/model';
import { PreparedOutputCache } from './preparedOutputCache';
import type { AnalysisOptions } from './analysis';
import { RuntimeModule } from './runtimeObservation';

/** `analyzerServers` serves the source-location reads of discovery. */
export interface RunnerOptions extends AnalysisOptions {
    readonly dotnet: string;
    readonly storage: string;
    readonly testArguments: readonly string[];
    readonly coverageTool?: string | undefined;
    /** The pinned collector receives a stable instrumentation environment across editor launches. */
    readonly managedCoverageTool?: boolean;
    /** Borrow an idle primary-preparation permit without waiting; the caller already owns one. */
    readonly tryInstrumentation?: (<T>(signal: AbortSignal | undefined, work: () => Promise<T>) => Promise<T> | undefined) | undefined;
    readonly assemblies?: readonly string[];
    readonly modules?: readonly RuntimeModule[];
    readonly buildInputs?: ReadonlyMap<string, readonly string[]>;
    readonly analyzer?: string;
    /** Stable within an engine, isolated from every other extension instance. */
    readonly identity?: string;
    readonly outputRoot?: string;
    readonly snapshots?: ReadonlyMap<string, string>;
    readonly preparedOutputCache?: PreparedOutputCache;
    /** A mark of preparedOutputCache taken after this run's build and snapshots completed (see PreparedOutputCache.mark). */
    readonly preparedAfter?: number;
    /** Evaluated target, reference, SDK and build configuration identity. */
    readonly preparationContexts?: ReadonlyMap<string, string>;
    /** Internal per-target private output slot; zero retains canonical native IDs. */
    readonly preparationLane?: number;
    /** Shared only by the private lanes of one run. */
    readonly preparationTools?: Map<string, Promise<string>>;
    /** Resolve commands per project, then share hashes of the same executable within one run. */
    readonly preparationToolIdentities?: Map<string, Promise<string>>;
    /** Defer coverage for targets awaiting affected-file selection; discovery remains fresh. */
    readonly deferCoverage?: ((target: Pick<TestFile, 'project' | 'framework'>) => boolean) | undefined;
    readonly onResult?: (group: TestFile, result: TestResult, test?: DiscoveredTest) => void;
    readonly onStarted?: (group: TestFile, id: string) => void;
    readonly onPrepared?: ((project: string) => void) | undefined;
    readonly onExpanded?: (groups: readonly TestFile[]) => void;
    /** Attach a debugger to each test host before it runs. */
    readonly debug?: ((processId: number) => Promise<void>) | undefined;
}
export interface FileRun {
    readonly results: readonly TestResult[];
    readonly trace: Trace;
    readonly coverageAvailable: boolean;
    readonly executedGroups: readonly TestFile[];
}
