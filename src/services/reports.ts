import * as path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { CoveredLine } from '../core/model';
import { normalizePath } from '../core/paths';

type XmlNode = Record<string, unknown>;
const record = (value: unknown): XmlNode => value && typeof value === 'object' ? value as XmlNode : {};
const list = (value: unknown): XmlNode[] => (Array.isArray(value) ? value : value ? [value] : []).map(record);

export function parseCobertura(xml: string, cwd: string, allowedFiles: ReadonlySet<string>): ReadonlyMap<string, readonly CoveredLine[]> {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {throw new Error('The coverage report is not valid, safe XML.');}
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false });
    const coverage = record(record(parser.parse(xml)).coverage);
    if (!coverage.packages) {throw new Error('The coverage report contains no packages.');}
    const files = new Map<string, Map<number, number>>();
    for (const pkg of list(record(coverage.packages).package)) {
        for (const cls of list(record(pkg.classes).class)) {
            if (typeof cls.filename !== 'string') {continue;}
            const file = normalizePath(path.resolve(cwd, cls.filename));
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
