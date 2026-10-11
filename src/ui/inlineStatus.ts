// Inline results without the VS Code API: which outcome a covered source line shows, from the test files whose
// retained coverage hits it and their latest results. Kept pure so it is unit tested directly.

/** `testy.inlineResults`: no inline results, gutter markers, or gutter markers plus a hover on covered lines. */
export type InlineResultsMode = 'off' | 'gutter' | 'gutterAndHover';

/** Whether inline results draw covered lines' gutter markers; `testy.showCoverage` then marks only the other lines. */
export function inlineGutter(mode: InlineResultsMode | undefined): boolean { return mode === 'gutter' || mode === 'gutterAndHover'; }

/** A covered line's marker: every covering test file passed, one failed, or one has not run (again) since a change. */
export type LineStatus = 'passed' | 'failed' | 'pending';

/** How many tests of one test file last passed, failed or errored, and ran at all. */
export interface FileOutcome { passed: number; failed: number; total: number }

/** Precedence when a line's test files disagree: a known failure stays visible until it is rerun, and any file
 * awaiting a rerun keeps the line from looking verified. */
const precedence: readonly LineStatus[] = ['failed', 'pending', 'passed'];

/** The test file of a tree test id (`group:test`); runtime containers have `runtime:<hash>` ids, other files a plain hash. */
export function groupOfTestId(id: string): string | undefined {
    const end = id.indexOf(':', id.startsWith('runtime:') ? 'runtime:'.length : 0);
    return end < 0 ? undefined : id.slice(0, end);
}

/** Count a test's outcome change into its file's totals; a file without counted tests is dropped. */
export function countOutcome(files: Map<string, FileOutcome>, id: string, previous: string | undefined, next: string | undefined): boolean {
    const group = groupOfTestId(id);
    if (!group || previous === next) {return false;}
    const counts = files.get(group) ?? { passed: 0, failed: 0, total: 0 };
    const add = (outcome: string | undefined, delta: number): void => {
        if (!outcome) {return;}
        counts.total += delta;
        if (outcome === 'passed') {counts.passed += delta;} else if (outcome === 'failed' || outcome === 'errored') {counts.failed += delta;}
    };
    add(previous, -1); add(next, 1);
    if (counts.total > 0) {files.set(group, counts);} else {files.delete(group);}
    return true;
}

/** A test file's status: failed when any of its tests failed; pending while its coverage is stale or none of its tests passed yet. */
export function fileStatus(outcome: FileOutcome | undefined, stale: boolean): LineStatus {
    if (outcome?.failed) {return 'failed';}
    return stale || !outcome?.passed ? 'pending' : 'passed';
}

/** The status of a line covered by `groups`; nothing for a line no test file covers. */
export function lineStatus(groups: readonly string[], statusOf: (group: string) => LineStatus): LineStatus | undefined {
    let best: number | undefined;
    for (const group of groups) {
        const rank = precedence.indexOf(statusOf(group));
        if (best === undefined || rank < best) {best = rank;}
        if (best === 0) {break;}
    }
    return best === undefined ? undefined : precedence[best];
}

/** 0-based lines per status for a file's covered lines (1-based keys of `covering`). An unsaved document, or coverage of
 * another version of the file, only marks the lines pending: their positions may no longer match. `map` moves the saved lines of
 * an unsaved document to where its edits put them (see core/lineMap), dropping lines an edit touched. Lines past the end are dropped. */
export function lineStatuses(covering: ReadonlyMap<number, readonly string[]>, statusOf: (group: string) => LineStatus,
    options: { readonly pending: boolean; readonly lineCount: number; readonly map?: ((line: number) => number | undefined) | undefined }): Record<LineStatus, number[]> {
    const result: Record<LineStatus, number[]> = { passed: [], failed: [], pending: [] };
    const memo = new Map<string, LineStatus>();
    const cached = (group: string): LineStatus => {let status = memo.get(group); if (!status) {status = statusOf(group); memo.set(group, status);} return status;};
    for (const [line, groups] of covering) {
        const target = options.map ? options.map(line - 1) : line - 1;
        if (target === undefined || target >= options.lineCount || !groups.length) {continue;}
        const status = options.pending ? 'pending' : lineStatus(groups, cached);
        if (status) {result[status].push(target);}
    }
    for (const lines of Object.values(result)) {lines.sort((a, b) => a - b);}
    return result;
}

/** Hover summary counts for a line: covering files, failing files and files awaiting a rerun. */
export function summarizeLine(groups: readonly string[], statusOf: (group: string) => LineStatus): { files: number; failing: number; pending: number } {
    let failing = 0, pending = 0;
    for (const group of groups) {const status = statusOf(group); if (status === 'failed') {failing++;} else if (status === 'pending') {pending++;}}
    return { files: groups.length, failing, pending };
}

/** Failing files first, then pending, then passed; the order within each status is kept. */
export function orderByStatus(groups: readonly string[], statusOf: (group: string) => LineStatus): string[] {
    return [...groups].sort((a, b) => precedence.indexOf(statusOf(a)) - precedence.indexOf(statusOf(b)));
}

/** What the tests through a covered line cost: their total and the slowest, from the tests' own durations when each test's coverage
 * says which tests ran the line, or else from the covering files' learned times. Undefined when no time is known. */
export function lineCost(entries: readonly { readonly name: string; readonly milliseconds: number | undefined }[]): { readonly total: number; readonly slowest: { readonly name: string; readonly milliseconds: number }; readonly count: number } | undefined {
    const known = entries.flatMap(entry => entry.milliseconds === undefined ? [] : [{ name: entry.name, milliseconds: entry.milliseconds }]);
    if (!known.length) {return undefined;}
    const slowest = known.reduce((most, entry) => entry.milliseconds > most.milliseconds ? entry : most);
    return { total: known.reduce((sum, entry) => sum + entry.milliseconds, 0), slowest, count: known.length };
}
