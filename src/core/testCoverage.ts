import { FileCoverage, TestFile, Trace } from './model';
import { MemberLayout, reachesChangedMember, rebasedTrace, VersionGeometry } from './memberImpact';

/** Each test's own coverage of a test file, by test ID (see RunnerOptions.perTestCoverage). */
export type TestRecords = ReadonlyMap<string, readonly FileCoverage[]>;

/**
 * The coverage of every test of a test file, learned by running its tests one request at a time (`testy.selectionGranularity:
 * test`). Records describe the same source versions as the file's trace: they are replaced whenever the trace is, and a record
 * whose version of a file differs from the trace's cannot narrow (see narrowTests). Kept for the session only: after a restart a
 * file narrows by test again once it has run completely.
 */
export class TestCoverageStore {
    private readonly files = new Map<string, TestRecords>();

    get size(): number { return this.files.size; }

    get(groupId: string): TestRecords | undefined { return this.files.get(groupId); }

    set(groupId: string, records: TestRecords): void { this.files.set(groupId, records); }

    delete(groupId: string): void { this.files.delete(groupId); }

    /** Forget files that no longer exist. */
    retain(groupIds: ReadonlySet<string>): void { for (const id of [...this.files.keys()]) {if (!groupIds.has(id)) {this.files.delete(id);}} }

    clear(): void { this.files.clear(); }
}

/** What narrowing a selected test file to its affected tests reads. */
export interface NarrowingContext {
    /** The file's trace, which must be reliable. */
    readonly trace: Trace;
    /** The built version of each changed file. */
    readonly versions: ReadonlyMap<string, string>;
    /** Changes that can only be analyzed conservatively (declaration changes, unknown shapes, non-C# files). */
    readonly conservative: ReadonlySet<string>;
    readonly geometry: (file: string, hash: string) => VersionGeometry | undefined;
    readonly layouts: (file: string, hash: string) => MemberLayout | undefined;
}

/** The tests of a selected test file that can be affected by `changes`, or undefined when the file must run whole. A test whose own
 * coverage executed no changed body of an edited C# file did not execute the edit (see reachesChangedMember); any doubt, such as a
 * change the trace depends on without line coverage, a conservative change, or a record of another version, counts as reached. */
export function narrowTests(group: TestFile, records: TestRecords | undefined, changes: readonly string[], context: NarrowingContext): Set<string> | undefined {
    if (!records || !context.trace.reliable || context.trace.historical || group.tests.some(test => !records.has(test.id))) {return undefined;}
    const relevant = changes.filter(file => context.trace.dependencies.includes(file));
    if (!relevant.length || relevant.some(file => context.conservative.has(file) || !/\.cs$/i.test(file))) {return undefined;}
    const traced = new Map(context.trace.coverage.map(entry => [entry.file, entry]));
    const reached = new Set<string>();
    for (const test of group.tests) {
        const record = new Map(records.get(test.id)!.map(entry => [entry.file, entry]));
        if (relevant.some(file => testReaches(record.get(file), traced.get(file), file, context))) {reached.add(test.id);}
    }
    return reached.size && reached.size < group.tests.length ? reached : undefined;
}

function testReaches(entry: FileCoverage | undefined, traced: FileCoverage | undefined, file: string, context: NarrowingContext): boolean {
    const version = context.versions.get(file);
    if (!entry || !traced || entry.hash !== traced.hash || version === undefined) {return true;}
    if (entry.hash === version) {return false;}
    const before = context.layouts(file, entry.hash), after = context.layouts(file, version), geometry = context.geometry(file, entry.hash);
    if (!before || !after || !geometry) {return true;}
    return reachesChangedMember(before, after, { hits: entry.lines.filter(line => line.hits > 0), lines: geometry.lines });
}

/** Records moved to the built versions of `files`, which their tests provably did not execute (see rebasedTrace); undefined when a
 * record cannot move, so the file's coverage cannot be completed without running that test. */
export function rebaseRecords(records: TestRecords, tests: Iterable<string>, files: readonly string[], versions: ReadonlyMap<string, string>,
    geometry: (file: string, hash: string) => VersionGeometry | undefined, layouts: (file: string, hash: string) => MemberLayout | undefined): Map<string, readonly FileCoverage[]> | undefined {
    const moved = new Map<string, readonly FileCoverage[]>();
    for (const test of tests) {
        const record = records.get(test);
        if (!record) {return undefined;}
        const covered = files.filter(file => record.some(entry => entry.file === file));
        const next = covered.length ? rebasedTrace({ groupId: test, dependencies: [], coverage: record, reliable: true, timestamp: 0 }, covered, versions, geometry, layouts) : { coverage: record };
        if (!next) {return undefined;}
        moved.set(test, next.coverage);
    }
    return moved;
}
