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

/** `declarations`, when given, receives each allowed file's method spans. */
export function parseCobertura(xml: string, cwd: string, allowedFiles: ReadonlySet<string>,
    declarations?: Map<string, readonly Declaration[]>): ReadonlyMap<string, readonly CoveredLine[]> {
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
    for (const cls of classes) {
        const file = normalize(resolve(cls.filename));
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
    return new Map([...files].map(([file, lines]) => [file, [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits }))]));
}
