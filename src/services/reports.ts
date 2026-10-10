import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { CoveredLine } from '../core/model';
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

export function parseCobertura(xml: string, cwd: string, allowedFiles: ReadonlySet<string>): ReadonlyMap<string, readonly CoveredLine[]> {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {throw new Error('The coverage report is not valid, safe XML.');}
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false,
        // Class-level lines are authoritative. The collector repeats their geometry
        // under methods; validate that XML above, then skip its unused object tree.
        stopNodes: ['coverage.packages.package.classes.class.methods'], updateTag: tag => tag !== 'methods' });
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
        }
    }
    return new Map([...files].map(([file, lines]) => [file, [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits }))]));
}
