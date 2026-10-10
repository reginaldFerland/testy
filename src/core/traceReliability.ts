import { FileCoverage, TestFile, TestResult } from './model';

export interface TraceEvidence {
    /** The single source file the batch ran; batches without one never learn a file trace. */
    readonly file: Pick<TestFile, 'file' | 'tests'> | undefined;
    /** The collector produced a readable report for this batch. */
    readonly coverageAvailable: boolean;
    /** Runtime module loads were observed, so indirect dependencies are known. */
    readonly observed: boolean;
    readonly coverage: readonly Pick<FileCoverage, 'lines'>[];
    readonly results: readonly Pick<TestResult, 'id' | 'outcome'>[];
}

/** Outcomes that complete normally. A skipped test runs none of its body, so it
 * cannot reach code the trace would miss; failures and errors (including
 * timeouts) can stop before reaching their dependencies. */
const completed = new Set<TestResult['outcome']>(['passed', 'skipped']);

/** Whether a test-file run may serve as that file's dependency trace for affected
 * selection: complete coverage and observation, executed code, every expected test
 * reported, and no result that ended early. */
export function isReliableTrace(evidence: TraceEvidence): boolean {
    const { file, results } = evidence;
    if (!file?.file || !evidence.coverageAvailable || !evidence.observed) {return false;}
    if (!evidence.coverage.some(item => item.lines.some(line => line.hits > 0))) {return false;}
    if (!results.every(result => completed.has(result.outcome))) {return false;}
    const reported = new Set(results.map(result => result.id));
    return file.tests.every(test => reported.has(test.id));
}
