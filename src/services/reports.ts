import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { mergeDeclarations } from '../core/coverage';
import { CoveredLine, Declaration } from '../core/model';
import { pathNormalizer } from '../core/paths';

type XmlNode = Record<string, unknown>;
const record = (value: unknown): XmlNode => value && typeof value === 'object' ? value as XmlNode : {};
const list = (value: unknown): XmlNode[] => (Array.isArray(value) ? value : value ? [value] : []).map(record);

/** Cobertura `<sources>` entries, which relative class filenames are resolved against. */
function sourceRoots(coverage: XmlNode, cwd: string): string[] {
    const sources = record(coverage.sources).source;
    return (Array.isArray(sources) ? sources : [sources]).map(source => typeof source === 'string' ? source : record(source)['#text'])
        .filter((source): source is string => typeof source === 'string' && source.trim() !== '').map(source => path.resolve(cwd, source.trim()));
}

const entities: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (value: string): string => value.replace(/&(lt|gt|amp|quot|apos);/g, (entity: string, name: string) => entities[name] ?? entity);
const attributes = { name: /\sname\s*=\s*(?:"([^"]*)"|'([^']*)')/, signature: /\ssignature\s*=\s*(?:"([^"]*)"|'([^']*)')/ };
const attribute = (tag: string, name: keyof typeof attributes): string | undefined => {
    const match = attributes[name].exec(tag);
    return match ? decode(match[1] ?? match[2] ?? '') : undefined;
};

/** Method spans from a class's raw `<methods>` XML, which was validated with the whole report.
 * Lambdas and local functions lie inside their member's span and are skipped; async and
 * iterator state machines (`<Name>d__N.MoveNext`) are reported as the member that declared them. */
export function methodDeclarations(className: string, methods: string): Declaration[] {
    const declarations: Declaration[] = [];
    const machine = /(?:^|[./+])<([^<>]+)>d__\d+$/.exec(className), generated = /(?:^|[./+])</.test(className);
    const body = methods.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    for (const match of body.matchAll(/<method\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/method>)/g)) {
        const [, tag = '', content = ''] = match;
        const method = attribute(tag, 'name');
        if (!method || method.startsWith('<')) {continue;}
        const name = machine ? method === 'MoveNext' ? machine[1] : undefined : generated ? undefined : `${method}${attribute(tag, 'signature') ?? ''}`;
        if (!name) {continue;}
        let start = Infinity, end = 0;
        for (const line of content.matchAll(/<line\b[^>]*?\snumber\s*=\s*["'](\d+)["']/g)) {
            const number = Number(line[1]);
            if (Number.isSafeInteger(number) && number > 0) {start = Math.min(start, number); end = Math.max(end, number);}
        }
        if (end) {declarations.push({ name, start, end });}
    }
    return declarations;
}

/** `declarations`, when given, receives each allowed file's method spans. */
export function parseCobertura(xml: string, cwd: string, allowedFiles: ReadonlySet<string>,
    declarations?: Map<string, readonly Declaration[]>): ReadonlyMap<string, readonly CoveredLine[]> {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {throw new Error('The coverage report is not valid, safe XML.');}
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false,
        // Class-level lines are authoritative. The collector repeats their geometry under
        // methods; validate that XML above, then keep it only as raw text for method spans.
        stopNodes: ['coverage.packages.package.classes.class.methods'], updateTag: tag => !!declarations || tag !== 'methods' });
    const methods = new Map<string, Declaration[]>();
    const coverage = record(record(parser.parse(xml)).coverage);
    if (!coverage.packages) {throw new Error('The coverage report contains no packages.');}
    const files = new Map<string, Map<number, number>>(), normalize = pathNormalizer();
    const roots = sourceRoots(coverage, cwd), resolved = new Map<string, string>();
    // The first source root containing the file wins; otherwise keep resolving against cwd.
    const resolve = (filename: string): string => {
        let file = resolved.get(filename);
        if (file === undefined) {
            file = path.isAbsolute(filename) ? path.resolve(cwd, filename) : roots.map(root => path.resolve(root, filename)).find(candidate => existsSync(candidate)) ?? path.resolve(cwd, filename);
            resolved.set(filename, file);
        }
        return file;
    };
    for (const pkg of list(record(coverage.packages).package)) {
        for (const cls of list(record(pkg.classes).class)) {
            if (typeof cls.filename !== 'string') {continue;}
            const file = normalize(resolve(cls.filename));
            if (!allowedFiles.has(file)) {continue;}
            const lines = files.get(file) ?? new Map<number, number>();
            for (const item of list(record(cls.lines).line)) {
                const line = Number(item.number);
                const hits = Number(item.hits);
                if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits) || hits < 0) {throw new Error('The coverage report contains an invalid line.');}
                lines.set(line, Math.max(lines.get(line) ?? 0, hits));
            }
            files.set(file, lines);
            if (declarations && typeof cls.methods === 'string') {
                const found = methodDeclarations(typeof cls.name === 'string' ? cls.name : '', cls.methods);
                if (found.length) {methods.set(file, [...methods.get(file) ?? [], ...found]);}
            }
        }
    }
    for (const [file, found] of methods) {declarations!.set(file, mergeDeclarations(undefined, found)!);}
    return new Map([...files].map(([file, lines]) => [file, [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits }))]));
}
