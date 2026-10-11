import { CoveredLine, Declaration, FileCoverage, Trace } from './model';

/** An executable body that source analysis fingerprinted: its 1-based inclusive lines and a hash of its position and tokens. */
export interface MemberBody {
    readonly start: number;
    readonly end: number;
    readonly hash: string;
}

/** One analyzed version of a source file: its declaration signature, its bodies in document order and the fingerprints of the
 * text around them (one more than the bodies), when the analysis reported them. */
export interface MemberLayout {
    readonly signature: string;
    readonly members: readonly MemberBody[];
    readonly gaps?: readonly string[];
}

/** What a trace recorded in one version of a file: its positive hits and that version's instrumentable lines, both sorted. */
export interface FileHits {
    readonly hash: string;
    readonly hits: readonly CoveredLine[];
    readonly lines: readonly number[];
}

/** Whether a test file whose coverage of one version of a source file is `recorded` can be affected by the `after` version.
 * A test that executed no changed body did not execute the edit: equal signatures mean that everything outside the bodies,
 * which other code can depend on without running it, is unchanged, and the bodies pair by position. A changed body without
 * any instrumentable line cannot prove that the test missed it, and counts as reached. */
export function reachesChangedMember(before: MemberLayout, after: MemberLayout, recorded: Pick<FileHits, 'hits' | 'lines'>): boolean {
    if (before.signature !== after.signature || before.members.length !== after.members.length) {return true;}
    for (const [index, member] of before.members.entries()) {
        if (after.members[index]!.hash === member.hash) {continue;}
        if (anyWithin(recorded.hits, line => line.line, member) || !anyWithin(recorded.lines, line => line, member)) {return true;}
    }
    return false;
}

/** Where each line of the `before` version is in the `after` version, or undefined for a line whose position the layouts cannot
 * vouch for: one in a changed body or a changed gap. Member and gap fingerprints include line breaks, so an unchanged one moves
 * as a whole. Undefined when the versions do not pair up (see reachesChangedMember). */
export function lineMapping(before: MemberLayout, after: MemberLayout): ((line: number) => number | undefined) | undefined {
    const count = before.members.length, gaps = before.gaps, movedGaps = after.gaps;
    if (before.signature !== after.signature || after.members.length !== count || gaps?.length !== count + 1 || movedGaps?.length !== count + 1) {return undefined;}
    return line => {
        // The first body that ends on or after the line; bodies are disjoint and in order, but may share a line.
        let low = 0, high = count;
        while (low < high) {const middle = (low + high) >>> 1; if (before.members[middle]!.end < line) {low = middle + 1;} else {high = middle;}}
        let mapped: number | undefined;
        for (let index = low; index < count && before.members[index]!.start <= line; index++) {
            const member = before.members[index]!, moved = after.members[index]!;
            if (moved.hash !== member.hash) {return undefined;}
            const target = line + moved.start - member.start;
            if (mapped !== undefined && mapped !== target) {return undefined;}
            mapped = target;
        }
        if (mapped !== undefined) {return mapped;}
        // Between body low - 1 and body low: that gap's text starts where the earlier body ends.
        if (gaps[low] !== movedGaps[low]) {return undefined;}
        return low === 0 ? line : line + after.members[low - 1]!.end - before.members[low - 1]!.end;
    };
}

/** A version's instrumentable lines and method spans, as the coverage store shares them. */
export interface VersionGeometry { readonly lines: readonly number[]; readonly declarations?: readonly Declaration[] | undefined }

/** The trace moved to the built versions of files whose edits it provably did not execute (see reachesChangedMember), so that it
 * stays current: its coverage of each file moves line by line to the new version. Undefined when a covered line cannot move, for
 * example because it is in a gap that gained a comment, or a layout is unknown; the trace then stays as it is, and stale. */
export function rebasedTrace(trace: Trace, files: Iterable<string>, versions: ReadonlyMap<string, string>,
    geometry: (file: string, hash: string) => VersionGeometry | undefined, layouts: (file: string, hash: string) => MemberLayout | undefined): Trace | undefined {
    const coverage = [...trace.coverage], inputs: Record<string, string> = { ...trace.inputs };
    for (const file of files) {
        const version = versions.get(file), index = coverage.findIndex(entry => entry.file === file);
        if (version === undefined || index < 0) {return undefined;}
        const entry = coverage[index]!;
        inputs[file] = version;
        if (entry.hash === version) {continue;}
        const before = layouts(file, entry.hash), after = layouts(file, version), source = geometry(file, entry.hash);
        const map = before && after && source && lineMapping(before, after);
        if (!map) {return undefined;}
        const hits = new Map<number, number>();
        for (const line of entry.lines) {
            if (line.hits <= 0) {continue;}
            const moved = map(line.line);
            if (moved === undefined) {return undefined;}
            hits.set(moved, line.hits);
        }
        // Lines in changed bodies have no position yet; the files that ran the new version report them.
        const lines = new Map<number, number>();
        for (const line of source.lines) {const moved = map(line); if (moved !== undefined) {lines.set(moved, hits.get(moved) ?? 0);}}
        for (const [line, count] of hits) {lines.set(line, count);}
        const declarations = source.declarations?.flatMap(declaration => {
            const start = map(declaration.start), end = map(declaration.end);
            return start !== undefined && end !== undefined && end - start === declaration.end - declaration.start ? [{ ...declaration, start, end }] : [];
        });
        const moved: FileCoverage = { file, hash: version, lines: [...lines].sort(([a], [b]) => a - b).map(([line, count]) => ({ line, hits: count })),
            ...declarations?.length ? { declarations } : {} };
        coverage[index] = moved;
    }
    return { ...trace, coverage, inputs };
}

/** Whether a sorted list has an entry within the member's lines. */
function anyWithin<T>(sorted: readonly T[], line: (entry: T) => number, member: MemberBody): boolean {
    let low = 0, high = sorted.length;
    while (low < high) {const middle = (low + high) >>> 1; if (line(sorted[middle]!) < member.start) {low = middle + 1;} else {high = middle;}}
    return low < sorted.length && line(sorted[low]!) <= member.end;
}

/** Analyzed layouts by file and source version. A version stays known while a trace's coverage still refers to it, so that
 * a test file that skipped several edits is compared with the version it last ran against. */
export class MemberLayouts {
    private readonly layouts = new Map<string, Map<string, MemberLayout>>();

    get(file: string, hash: string): MemberLayout | undefined { return this.layouts.get(file)?.get(hash); }

    set(file: string, hash: string, layout: MemberLayout): void {
        let versions = this.layouts.get(file);
        if (!versions) {versions = new Map(); this.layouts.set(file, versions);}
        versions.set(hash, layout);
    }

    /** Forget versions that are neither current nor referred to by a trace. */
    retain(current: ReadonlyMap<string, string>, referenced: (file: string, hash: string) => boolean): void {
        for (const [file, versions] of this.layouts) {
            for (const hash of versions.keys()) {if (current.get(file) !== hash && !referenced(file, hash)) {versions.delete(hash);}}
            if (!versions.size) {this.layouts.delete(file);}
        }
    }

    clear(): void { this.layouts.clear(); }
}
