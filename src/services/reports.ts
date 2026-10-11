import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { mergeDeclarations } from '../core/coverage';
import { CoveredLine, Declaration } from '../core/model';
import { pathNormalizer } from '../core/paths';
import { invalidXmlMessage, readXml, XmlHandler } from './xml';

/** Collects member spans from a class's `<method>` elements.
 * Lambdas and local functions lie inside their member's span and are skipped; async and
 * iterator state machines (`<Name>d__N.MoveNext`) are reported as the member that declared them. */
class MethodSpans {
    readonly declarations: Declaration[] = [];
    private readonly machine: RegExpExecArray | null;
    private readonly generated: boolean;
    private name: string | undefined;
    private start = Infinity;
    private end = 0;
    constructor(className: string) {
        this.machine = /(?:^|[./+])<([^<>]+)>d__\d+$/.exec(className);
        this.generated = /(?:^|[./+])</.test(className);
    }
    begin(attributes: ReadonlyMap<string, string>): void {
        const method = attributes.get('name');
        this.name = undefined; this.start = Infinity; this.end = 0;
        if (!method || method.startsWith('<')) {return;}
        this.name = this.machine ? method === 'MoveNext' ? this.machine[1] : undefined : this.generated ? undefined : `${method}${attributes.get('signature') ?? ''}`;
    }
    line(attributes: ReadonlyMap<string, string>): void {
        const text = attributes.get('number');
        if (this.name === undefined || text === undefined || !/^\d+$/.test(text)) {return;}
        const number = Number(text);
        if (Number.isSafeInteger(number) && number > 0) {this.start = Math.min(this.start, number); this.end = Math.max(this.end, number);}
    }
    finish(): void {
        if (this.name && this.end) {this.declarations.push({ name: this.name, start: this.start, end: this.end });}
        this.name = undefined;
    }
}

/** Method spans from the inner XML of a class's `<methods>` element. */
export function methodDeclarations(className: string, methods: string): Declaration[] {
    const spans = new MethodSpans(className);
    let depth = 0;
    readXml(`<methods>${methods}</methods>`, {
        open: (name, attributes) => {
            depth++;
            if (depth === 2 && name === 'method') {spans.begin(attributes);}
            else if (depth > 2 && name === 'line') {spans.line(attributes);}
        },
        close: () => {if (--depth === 1) {spans.finish();}},
        text: () => undefined
    });
    return spans.declarations;
}

interface ClassEntry {
    readonly filename: string;
    /** Flat `[number, hits, ...]` pairs from the class's own `<lines>`, converted with `Number`. */
    readonly lines: number[];
    readonly spans?: MethodSpans | undefined;
}

/** What a complete parse learned about the reports of one instrumented output (see readWithLayout). Its collector reports the
 * same classes, files and executable lines every time; only the hit counts differ. */
export interface ReportLayout {
    /** The report's `<sources>` element exactly as written, or '' without one: it decides how filenames resolve. */
    readonly sources: string;
    readonly classes: readonly LayoutClass[];
}

interface LayoutClass {
    /** The `filename` attribute exactly as written. */
    readonly filename: string;
    /** The workspace file it resolved to. */
    readonly file: string;
    /** The line numbers of the class's own `<lines>`, in document order. */
    readonly lines: Int32Array;
    readonly declarations: readonly Declaration[];
}

/** The `<sources>` element as written: the first one, through its end tag. */
function sourcesText(xml: string): string | undefined {
    const start = xml.indexOf('<sources');
    if (start < 0) {return '';}
    const end = xml.indexOf('</sources>', start);
    return end < 0 ? undefined : xml.slice(start, end + '</sources>'.length);
}

/** The value of `name="..."` in the text of one start tag; undefined if it is missing, or written in a way the fast read does not handle. */
function attributeText(tag: string, name: string): string | undefined {
    const key = ` ${name}="`, start = tag.indexOf(key);
    if (start < 0) {return undefined;}
    const end = tag.indexOf('"', start + key.length);
    if (end < 0) {return undefined;}
    const value = tag.slice(start + key.length, end);
    return value.includes('&') ? undefined : value;
}

/** The value of `key` (` name="`) in the start tag `xml[start, end)` when it is a plain decimal integer, read without slicing:
 * a report has an attribute pair like this for every line. */
function integerAttribute(xml: string, start: number, end: number, key: string): number | undefined {
    let index = xml.indexOf(key, start);
    if (index < 0 || index >= end) {return undefined;}
    index += key.length;
    const first = index;
    let value = 0;
    for (let code = xml.charCodeAt(index); code >= 0x30 && code <= 0x39; code = xml.charCodeAt(++index)) {value = value * 10 + code - 0x30;}
    return index === first || index - first > 15 || xml.charCodeAt(index) !== 0x22 ? undefined : value;
}

/** Read a report of an instrumented output whose layout a complete parse learned (see parseCobertura `learn`), without parsing it
 * whole: each class must have the learned filename and exactly the learned lines in the same order, the sources must be the same,
 * and the document must be complete. Only the hit counts are read; method spans come from the layout. Returns undefined, so the
 * caller parses the report completely, whenever anything differs or is written in a way it does not check. */
export function readWithLayout(xml: string, layout: ReportLayout, allowedFiles: ReadonlySet<string>,
    declarations?: Map<string, readonly Declaration[]>): ReadonlyMap<string, readonly CoveredLine[]> | undefined {
    if (/<!DOCTYPE|<!ENTITY|<!--|<!\[CDATA\[/i.test(xml) || !/<\/coverage>\s*$/.test(xml)) {return undefined;}
    const sources = sourcesText(xml);
    if (sources !== layout.sources) {return undefined;}
    const files = new Map<string, Map<number, number>>(), methods = new Map<string, Declaration[]>();
    // Each class's start is found once: as the next class after the previous one, which also proves the previous one held no other.
    let start = xml.indexOf('<class ', sources ? xml.indexOf(sources) + sources.length : 0);
    for (const cls of layout.classes) {
        if (start < 0) {return undefined;}
        const tagEnd = xml.indexOf('>', start);
        if (tagEnd < 0 || xml.charCodeAt(tagEnd - 1) === 0x2F) {return undefined;}
        if (attributeText(xml.slice(start, tagEnd), 'filename') !== cls.filename) {return undefined;}
        const end = xml.indexOf('</class>', tagEnd), next = xml.indexOf('<class ', tagEnd);
        if (end < 0 || (next >= 0 && next < end)) {return undefined;}
        // The class's own lines follow its methods, whose lines repeat them.
        const open = xml.lastIndexOf('<lines>', end), close = xml.indexOf('</lines>', open);
        if (open < tagEnd || xml.lastIndexOf('</methods>', end) > open || close < 0 || close > end) {return undefined;}
        const allowed = allowedFiles.has(cls.file), lines = allowed ? files.get(cls.file) ?? new Map<number, number>() : undefined;
        let cursor = open;
        for (const number of cls.lines) {
            const line = xml.indexOf('<line ', cursor);
            if (line < 0 || line > close) {return undefined;}
            const lineEnd = xml.indexOf('>', line);
            if (lineEnd < 0 || lineEnd > close || integerAttribute(xml, line, lineEnd, ' number="') !== number) {return undefined;}
            const hits = integerAttribute(xml, line, lineEnd, ' hits="');
            if (hits === undefined) {return undefined;}
            if (lines) {lines.set(number, Math.max(lines.get(number) ?? 0, hits));}
            cursor = lineEnd;
        }
        const extra = xml.indexOf('<line ', cursor);
        if (extra >= 0 && extra < close) {return undefined;}
        if (lines) {
            files.set(cls.file, lines);
            if (cls.declarations.length) {methods.set(cls.file, [...methods.get(cls.file) ?? [], ...cls.declarations]);}
        }
        start = next;
    }
    if (start >= 0) {return undefined;}
    if (declarations) {for (const [file, found] of methods) {declarations.set(file, mergeDeclarations(undefined, found)!);}}
    return new Map([...files].map(([file, lines]) => [file, [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits }))]));
}

/** `declarations`, when given, receives each allowed file's method spans. `learn`, when given with `declarations`, receives the
 * report's layout, for reading later reports of the same instrumented output with readWithLayout. It is offered only when
 * readWithLayout reproduces this parse exactly. */
export function parseCobertura(xml: string, cwd: string, allowedFiles: ReadonlySet<string>,
    declarations?: Map<string, readonly Declaration[]>, learn?: (layout: ReportLayout) => void): ReadonlyMap<string, readonly CoveredLine[]> {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {throw new Error(invalidXmlMessage);}
    // Class-level lines are authoritative. The collector repeats their geometry under
    // methods; it is read only for method spans, and only when they were requested.
    const classes: ClassEntry[] = [], sources: string[] = [], names: string[] = [];
    let current: ClassEntry | undefined, source = '';
    const state = { packages: false };
    const handler: XmlHandler = {
        open: (name, attributes) => {
            const depth = names.push(name);
            if (names[0] !== 'coverage') {return;}
            if (depth === 2 && name === 'packages') {state.packages ||= attributes.size > 0;}
            else if (depth === 3 && names[1] === 'packages') {state.packages = true;}
            else if (depth === 5 && name === 'class' && names[1] === 'packages' && names[2] === 'package' && names[3] === 'classes') {
                const filename = attributes.get('filename');
                if (filename !== undefined) {
                    current = { filename, lines: [], spans: declarations ? new MethodSpans(attributes.get('name') ?? '') : undefined };
                    classes.push(current);
                }
            } else if (current && depth === 7 && name === 'line' && names[5] === 'lines') {
                current.lines.push(Number(attributes.get('number')), Number(attributes.get('hits')));
            } else if (current?.spans) {
                if (depth === 7 && name === 'method' && names[5] === 'methods') {current.spans.begin(attributes);}
                else if (depth > 7 && name === 'line' && names[5] === 'methods') {current.spans.line(attributes);}
            }
        },
        close: name => {
            const depth = names.length;
            if (depth === 5 && current) {current = undefined;}
            else if (depth === 7 && current && name === 'method' && names[5] === 'methods') {current.spans?.finish();}
            else if (depth === 3 && name === 'source' && names[1] === 'sources' && names[0] === 'coverage') {
                if (source.trim() !== '') {sources.push(source.trim());}
                source = '';
            }
            names.pop();
        },
        text: value => {
            if (names[0] !== 'coverage') {return;}
            if (names.length === 3 && names[2] === 'source' && names[1] === 'sources') {source += value;}
            else if (names.length === 2 && names[1] === 'packages' && value.trim() !== '') {state.packages = true;}
        }
    };
    readXml(xml, handler);
    if (!state.packages) {throw new Error('The coverage report contains no packages.');}
    const methods = new Map<string, Declaration[]>();
    const files = new Map<string, Map<number, number>>(), normalize = pathNormalizer();
    const roots = sources.map(item => path.resolve(cwd, item)), resolved = new Map<string, string>();
    // The first source root containing the file wins; otherwise keep resolving against cwd.
    const resolve = (filename: string): string => {
        let file = resolved.get(filename);
        if (file === undefined) {
            file = path.isAbsolute(filename) ? path.resolve(cwd, filename) : roots.map(root => path.resolve(root, filename)).find(candidate => existsSync(candidate)) ?? path.resolve(cwd, filename);
            resolved.set(filename, file);
        }
        return file;
    };
    const layout: LayoutClass[] = [];
    for (const cls of classes) {
        const file = normalize(resolve(cls.filename));
        if (learn && declarations) {
            layout.push({ filename: cls.filename, file, lines: Int32Array.from({ length: cls.lines.length / 2 }, (_, index) => cls.lines[index * 2]!),
                declarations: cls.spans?.declarations ?? [] });
        }
        if (!allowedFiles.has(file)) {continue;}
        const lines = files.get(file) ?? new Map<number, number>();
        for (let i = 0; i < cls.lines.length; i += 2) {
            const line = cls.lines[i]!, hits = cls.lines[i + 1]!;
            if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits) || hits < 0) {throw new Error('The coverage report contains an invalid line.');}
            lines.set(line, Math.max(lines.get(line) ?? 0, hits));
        }
        files.set(file, lines);
        if (cls.spans?.declarations.length) {methods.set(file, [...methods.get(file) ?? [], ...cls.spans.declarations]);}
    }
    for (const [file, found] of methods) {declarations!.set(file, mergeDeclarations(undefined, found)!);}
    const result = new Map([...files].map(([file, lines]) => [file, [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits }))]));
    const written = learn && declarations ? sourcesText(xml) : undefined;
    if (written !== undefined && layout.length === classes.length) {
        // Offer the layout only if the fast read reproduces this parse: anything it would read differently stays a complete parse.
        const candidate: ReportLayout = { sources: written, classes: layout }, check = new Map<string, readonly Declaration[]>();
        const fast = readWithLayout(xml, candidate, allowedFiles, check);
        if (fast && sameCoverage(fast, result) && sameDeclarations(check, declarations!)) {learn!(candidate);}
    }
    return result;
}

function sameCoverage(left: ReadonlyMap<string, readonly CoveredLine[]>, right: ReadonlyMap<string, readonly CoveredLine[]>): boolean {
    if (left.size !== right.size) {return false;}
    for (const [file, lines] of left) {
        const other = right.get(file);
        if (!other || other.length !== lines.length || lines.some((line, index) => line.line !== other[index]!.line || line.hits !== other[index]!.hits)) {return false;}
    }
    return true;
}

function sameDeclarations(left: ReadonlyMap<string, readonly Declaration[]>, right: ReadonlyMap<string, readonly Declaration[]>): boolean {
    if (left.size !== right.size) {return false;}
    for (const [file, list] of left) {
        const other = right.get(file);
        if (!other || other.length !== list.length || list.some((item, index) => item.name !== other[index]!.name || item.start !== other[index]!.start || item.end !== other[index]!.end)) {return false;}
    }
    return true;
}
