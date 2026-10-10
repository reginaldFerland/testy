import { CoverageStore } from '../../core/coverage';
import { Project, TestFile, TestResult } from '../../core/model';
import { ProjectIndex, Selection } from '../../core/selection';
import { SourceShape } from '../analysis';
import { discoveredTest } from '../mtp';
import { PreparedOutputCache } from '../preparedOutputCache';
import { ProjectEvaluationCache } from '../projectEvaluationCache';
import { RuntimeInventory } from '../runtimeInventory';
import { SourceTracker } from '../sources';
import { SdkChecks } from './sdk';
import type { Baseline, EngineOptions } from './types';

/** The engine state and operations the run stages share; implemented by `TestEngine`. */
export interface EngineHost {
    readonly options: EngineOptions;
    readonly coverage: CoverageStore;
    readonly sources: SourceTracker;
    readonly runtime: RuntimeInventory;
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
    projects: readonly Project[];
    groups: readonly TestFile[];
    buildGraph: readonly Project[];
    index: ProjectIndex;
    topology: number;
    structureDirty: boolean;
    shapes: ReadonlyMap<string, string | null>;
    analyses: ReadonlyMap<string, SourceShape | null>;
    analyzedHashes: ReadonlyMap<string, string>;
    analysisContext: string | undefined;
    aliasStamp: string | undefined;
    excludedAliases: readonly string[];
    projectSnapshots: ReadonlyMap<string, readonly Project[]>;
    unsupportedReport: string;
    select(files: readonly string[], conservative?: boolean): Selection;
    knownTests(group: TestFile): readonly ReturnType<typeof discoveredTest>[];
    setInputs(files: Iterable<string>): void;
    reconcileGroups(next: readonly TestFile[], baseline?: Baseline): Promise<Set<string>>;
    publishCoverage(signal?: AbortSignal): Promise<void>;
    save(signal?: AbortSignal): Promise<void>;
}
