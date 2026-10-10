import * as path from 'node:path';
import { CoverageSummary } from './coverage';
import { isInside } from './paths';

export type CoverageFormat = 'lcov' | 'cobertura';

/** Default file name for a format. */
export const coverageExportFile: Readonly<Record<CoverageFormat, string>> = { lcov: 'testy.lcov', cobertura: 'testy.cobertura.xml' };

/** A file's path relative to the first root containing it, with forward slashes; absolute when no root does. */
export function exportPath(file: string, roots: readonly string[]): string {
    const root = roots.find(candidate => isInside(file, candidate));
    return (root ? path.relative(root, file) : file).replace(/\\/g, '/');
}

/** Current merged coverage only: stale lines are being re-learned and would misreport. */
function exportable(summaries: readonly CoverageSummary[], roots: readonly string[]): { name: string; lines: CoverageSummary['lines'] }[] {
    return summaries.filter(summary => !summary.stale && summary.lines.length)
        .map(summary => ({ name: exportPath(summary.file, roots), lines: [...summary.lines].sort((a, b) => a.line - b.line) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** LCOV tracefile: one SF record per source file with DA, LF and LH lines. */
export function toLcov(summaries: readonly CoverageSummary[], roots: readonly string[]): string {
    const records = exportable(summaries, roots).map(({ name, lines }) => [
        'TN:', `SF:${name}`, ...lines.map(line => `DA:${line.line},${line.hits}`),
        `LF:${lines.length}`, `LH:${lines.filter(line => line.hits > 0).length}`, 'end_of_record'
    ].join('\n'));
    return records.length ? `${records.join('\n')}\n` : '';
}

const escapeXml = (value: string): string => value.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const rate = (covered: number, total: number): string => (total ? covered / total : 0).toFixed(4);

/** Cobertura XML with one class per source file. Line coverage only: branch data is not retained. */
export function toCobertura(summaries: readonly CoverageSummary[], roots: readonly string[], now = Date.now()): string {
    const files = exportable(summaries, roots);
    const covered = files.reduce((sum, file) => sum + file.lines.filter(line => line.hits > 0).length, 0);
    const total = files.reduce((sum, file) => sum + file.lines.length, 0);
    const classes = files.map(({ name, lines }) => {
        const hit = lines.filter(line => line.hits > 0).length;
        return `      <class name="${escapeXml(name)}" filename="${escapeXml(name)}" line-rate="${rate(hit, lines.length)}" branch-rate="0" complexity="0">\n`
            + '        <methods/>\n        <lines>\n'
            + lines.map(line => `          <line number="${line.line}" hits="${line.hits}" branch="false"/>`).join('\n')
            + '\n        </lines>\n      </class>';
    });
    return ['<?xml version="1.0" encoding="utf-8"?>',
        `<coverage line-rate="${rate(covered, total)}" branch-rate="0" lines-covered="${covered}" lines-valid="${total}" branches-covered="0" branches-valid="0" complexity="0" version="1" timestamp="${Math.floor(now / 1000)}">`,
        `  <sources>${roots.map(root => `<source>${escapeXml(root.replace(/\\/g, '/'))}</source>`).join('')}</sources>`,
        '  <packages>',
        `    <package name="Testy" line-rate="${rate(covered, total)}" branch-rate="0" complexity="0">`,
        classes.length ? `    <classes>\n${classes.join('\n')}\n    </classes>` : '    <classes/>',
        '    </package>', '  </packages>', '</coverage>', ''].join('\n');
}

export function exportCoverage(format: CoverageFormat, summaries: readonly CoverageSummary[], roots: readonly string[]): string {
    return format === 'lcov' ? toLcov(summaries, roots) : toCobertura(summaries, roots);
}
