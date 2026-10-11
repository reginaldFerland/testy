import { StackFrame } from './stackTrace';

/** One workspace line on the stack of a failing test: where it threw (`depth` 0, the innermost workspace frame) or a caller. */
export interface ExceptionSite {
    /** The test's Test Explorer item ID. */
    readonly test: string;
    readonly label: string;
    readonly message: string;
    readonly file: string;
    /** One-based. */
    readonly line: number;
    readonly depth: number;
    /** The file's content version when the test failed; a site of another version may point at the wrong line. */
    readonly version?: string | undefined;
}

/** Most frames shown per failure; deep framework recursion would otherwise mark long call chains. */
const maxDepth = 16;

/** The sites of a failure from its parsed stack frames: frames in workspace files only, innermost first, one per line. `resolve`
 * maps a reported path to the workspace file it names, or undefined outside the workspace. */
export function exceptionSites(test: string, label: string, message: string | undefined, frames: readonly StackFrame[],
    resolve: (file: string) => string | undefined, version: (file: string) => string | undefined): ExceptionSite[] {
    const sites: ExceptionSite[] = [], seen = new Set<string>();
    const text = (message ?? '').split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
    for (const frame of frames) {
        if (sites.length === maxDepth) {break;}
        const file = frame.file && frame.line ? resolve(frame.file) : undefined;
        if (!file || !frame.line || seen.has(`${file}\0${frame.line}`)) {continue;}
        seen.add(`${file}\0${frame.line}`);
        sites.push({ test, label, message: text, file, line: frame.line, depth: sites.length, version: version(file) });
    }
    return sites;
}

/** The exception sites of every currently failing test, by test and by file. A test's sites are replaced whenever it reports again. */
export class ExceptionSites {
    private readonly tests = new Map<string, readonly ExceptionSite[]>();
    private readonly files = new Map<string, Set<string>>();
    /** Changes with every change of the sites. */
    revision = 0;

    get size(): number { return this.tests.size; }

    /** The test reported: its failure's sites, or none once it passed or was skipped. */
    set(test: string, sites: readonly ExceptionSite[]): void {
        const previous = this.tests.get(test);
        if (!previous && !sites.length) {return;}
        this.unlink(test, previous);
        if (sites.length) {
            this.tests.set(test, sites);
            for (const site of sites) {let tests = this.files.get(site.file); if (!tests) {tests = new Set(); this.files.set(site.file, tests);} tests.add(test);}
        } else {this.tests.delete(test);}
        this.revision++;
    }

    /** Forget tests that no longer exist. */
    retain(tests: (test: string) => boolean): void {
        for (const [test, sites] of [...this.tests]) {if (!tests(test)) {this.unlink(test, sites); this.tests.delete(test); this.revision++;}}
    }

    clear(): void { if (this.tests.size) {this.tests.clear(); this.files.clear(); this.revision++;} }

    /** The sites in a file by one-based line, innermost failures first on each line. */
    forFile(file: string): Map<number, ExceptionSite[]> {
        const lines = new Map<number, ExceptionSite[]>();
        for (const test of this.files.get(file) ?? []) {
            for (const site of this.tests.get(test) ?? []) {
                if (site.file !== file) {continue;}
                const list = lines.get(site.line) ?? []; list.push(site); lines.set(site.line, list);
            }
        }
        for (const list of lines.values()) {list.sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));}
        return lines;
    }

    /** Files with at least one site. */
    get filesWithSites(): ReadonlySet<string> { return new Set(this.files.keys()); }

    private unlink(test: string, sites: readonly ExceptionSite[] | undefined): void {
        for (const site of sites ?? []) {
            const tests = this.files.get(site.file);
            if (tests?.delete(test) && !tests.size) {this.files.delete(site.file);}
        }
    }
}
