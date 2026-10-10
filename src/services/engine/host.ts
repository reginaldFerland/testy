import { CoverageStore } from '../../core/coverage';
import { DiscoveredTest, Project, TestFile, TestResult, Trace } from '../../core/model';
import { FailingTests } from '../../core/runPolicy';
import { ProjectIndex, Selection } from '../../core/selection';
import { SourceShape } from '../analysis';
import { AnalyzerServers } from '../analyzerServer';
import { HashMemo } from '../hashMemo';
import { discoveredTest } from '../mtp';
import { PreparedOutputCache } from '../preparedOutputCache';
import { ProjectEvaluationCache } from '../projectEvaluationCache';
import { RunnerSession } from '../runner';
import { RunnerOptions } from '../runnerTypes';
import { SourceTracker } from '../sources';
import { SdkChecks } from './sdk';
import type { Baseline } from './baseline';
import type { AnalysisState, EngineOptions, StructureState } from './types';

/** The coverage the stages read. Marking traces stale is the one write they make directly: it only widens later selections. */
export type CoverageView = Readonly<Pick<CoverageStore, 'traces' | 'dependentGroups' | 'dependentProjects' | 'markStale'>>;
/** Source versions. Refreshing rereads the disk and marking forces a reread; neither discards what the tracker knows. */
export type SourceView = Readonly<Pick<SourceTracker, 'hashes' | 'revision' | 'files' | 'analysisHashes' | 'aliasSources' | 'isGenerated' | 'refresh' | 'mark'>>;

/** The engine state the run stages read, and the operations they share; implemented by `TestEngine`.
 * Stages never change engine state directly: the views below are read-only (the type enforces it), and a stage
 * returns its results, hands them to an `apply` method, or calls one of the named methods below that own each write.
 * The services (caches, analyzer servers, SDK checks, tool identities) keep their own consistency. */
export interface EngineHost {
    readonly options: EngineOptions;
    readonly coverage: CoverageView;
    readonly sources: SourceView;
    readonly runtime: { readonly containers: ReadonlyMap<string, TestFile> };
    readonly failing: FailingTests;
    readonly sdk: Pick<SdkChecks, 'ensure' | 'resolved'>;
    readonly identity: string;
    readonly preparedOutputs: PreparedOutputCache;
    readonly projectEvaluations: ProjectEvaluationCache;
    readonly analyzerServers: AnalyzerServers;
    readonly createSession: (options: RunnerOptions) => RunnerSession;
    /** Restore keys completed since the last `forgetRestores`. */
    readonly restored: ReadonlySet<string>;
    /** Tool hashes keyed by path and metadata stamp; a shared memo that survives runs. */
    readonly toolIdentities: Map<string, Promise<string>>;
    /** Content hashes of restored package assets, reused while their metadata is unchanged. */
    readonly assetHashes: HashMemo;
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
    /** Adopt a structural refresh, its tracked sources and the unsupported-target report it produced. */
    applyStructure(next: StructureState, unsupportedReport: string): void;
    /** Adopt settled source analyses, even if the rest of preparation fails. */
    applyAnalysis(next: AnalysisState): void;
    /** Forget completed restores and established SDK contexts, so the next refresh restores again. */
    forgetRestores(): void;
    /** Remember completed restores by key. */
    recordRestored(keys: readonly string[]): void;
    reconcileGroups(next: readonly TestFile[], baseline?: Baseline): Promise<Set<string>>;
    /** Record a reported result: its outcome, its runtime row, observers and the event. Returns whether the displayed tree changed. */
    reportResult(group: TestFile, result: TestResult, test?: DiscoveredTest): boolean;
    /** Record a result for a test its failed batch never reported. */
    reportErrored(group: TestFile, result: TestResult): void;
    /** Observe every reported result until the returned function is called. */
    watchResults(observer: (group: TestFile, result: TestResult) => void): () => void;
    /** Settle the outcomes of files that ran completely, and retire runtime rows their target no longer reports
     * (`targetReported`). Returns whether the displayed tree changed. */
    settleCompleted(groups: readonly TestFile[], reported: ReadonlySet<string>, targetReported?: ReadonlySet<string>): boolean;
    /** Adopt a committed trace; coverage owned by groups outside `liveIds` is removed. */
    commitCoverage(trace: Trace, liveIds: ReadonlySet<string>, signal?: AbortSignal): Promise<void>;
    /** Keep traces as history: shown, but no longer used to narrow selections. */
    markHistorical(groupIds: ReadonlySet<string>): void;
    /** Remove coverage owned by groups outside `liveIds`. */
    pruneCoverage(liveIds: ReadonlySet<string>): void;
    /** Files that ran without collecting coverage keep their previous coverage, now stale; a new file gets a conservative trace. */
    retainCoverage(groups: readonly TestFile[], liveIds: ReadonlySet<string>): void;
    publishCoverage(signal?: AbortSignal): Promise<void>;
    /** Persist pending coverage and outcomes now, after any save already in progress. */
    save(signal?: AbortSignal): Promise<void>;
    /** Persist pending coverage and outcomes soon; saves requested close together share one locked write. */
    scheduleSave(): void;
}
