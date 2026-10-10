import { CoverageStore } from '../../core/coverage';
import { Project, TestFile, TestResult } from '../../core/model';
import { FailingTests, TestOutcomes } from '../../core/runPolicy';
import { ProjectIndex, Selection } from '../../core/selection';
import { SourceShape } from '../analysis';
import { discoveredTest } from '../mtp';
import { PreparedOutputCache } from '../preparedOutputCache';
import { ProjectEvaluationCache } from '../projectEvaluationCache';
import { RuntimeInventory } from '../runtimeInventory';
import { SourceTracker } from '../sources';
import { SdkChecks } from './sdk';
import type { Baseline } from './baseline';
import type { AnalysisState, EngineOptions, StructureState } from './types';

/** The engine state the run stages read, and the operations they share; implemented by `TestEngine`.
 * Stages never assign engine state: they return results, or hand them to an explicit `apply` method. */
export interface EngineHost {
    readonly options: EngineOptions;
    readonly coverage: CoverageStore;
    readonly sources: SourceTracker;
    readonly runtime: RuntimeInventory;
    readonly lastOutcomes: TestOutcomes;
    readonly failing: FailingTests;
    readonly sdk: SdkChecks;
    readonly identity: string;
    readonly preparedOutputs: PreparedOutputCache;
    readonly projectEvaluations: ProjectEvaluationCache;
    readonly restored: Set<string>;
    readonly toolIdentities: Map<string, Promise<string>>;
    readonly resultObservers: Set<(group: TestFile, result: TestResult) => void>;
    readonly hashes: ReadonlyMap<string, string>;
    readonly inputs: readonly string[];
    readonly displayGroups: readonly TestFile[];
    readonly projects: readonly Project[];
    readonly groups: readonly TestFile[];
    readonly buildGraph: readonly Project[];
    readonly index: ProjectIndex;
    readonly topology: number;
    readonly shapes: ReadonlyMap<string, string | null>;
    readonly analyses: ReadonlyMap<string, SourceShape | null>;
    readonly analyzedHashes: ReadonlyMap<string, string>;
    readonly analysisContext: string | undefined;
    readonly aliasStamp: string | undefined;
    readonly excludedAliases: readonly string[];
    readonly projectSnapshots: ReadonlyMap<string, readonly Project[]>;
    readonly unsupportedReport: string;
    select(files: readonly string[], conservative?: boolean): Selection;
    knownTests(group: TestFile): readonly ReturnType<typeof discoveredTest>[];
    setInputs(files: Iterable<string>): void;
    /** Adopt a structural refresh and the unsupported-target report it produced. */
    applyStructure(next: StructureState, unsupportedReport: string): void;
    /** Adopt settled source analyses, even if the rest of preparation fails. */
    applyAnalysis(next: AnalysisState): void;
    reconcileGroups(next: readonly TestFile[], baseline?: Baseline): Promise<Set<string>>;
    publishCoverage(signal?: AbortSignal): Promise<void>;
    /** Persist pending coverage and outcomes now, after any save already in progress. */
    save(signal?: AbortSignal): Promise<void>;
    /** Persist pending coverage and outcomes soon; saves requested close together share one locked write. */
    scheduleSave(): void;
}
