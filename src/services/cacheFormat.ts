import { CoverageSource, StoredTrace } from '../core/coverage';
import { contentHash } from '../core/paths';

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function validSource(value: unknown): value is CoverageSource {
    const source = record(value);
    return !!source && typeof source.id === 'string' && typeof source.file === 'string' && typeof source.hash === 'string'
        && source.id === contentHash(`${source.file}\0${source.hash}`) && Array.isArray(source.lines) && source.lines.every(positive);
}

export function validTrace(value: unknown): value is StoredTrace {
    const trace = record(value);
    const sourceIds = new Set(strings(trace?.sourceIds) ? trace.sourceIds : []);
    return !!trace && typeof trace.groupId === 'string' && strings(trace.sourceIds) && strings(trace.dependencies)
        && (trace.moduleProjects === undefined || strings(trace.moduleProjects))
        && typeof trace.reliable === 'boolean' && (trace.stale === undefined || typeof trace.stale === 'boolean')
        && (trace.historical === undefined || typeof trace.historical === 'boolean')
        && typeof trace.timestamp === 'number' && Number.isFinite(trace.timestamp) && !!record(trace.inputs)
        && Object.values(trace.inputs as object).every(hash => typeof hash === 'string')
        && Array.isArray(trace.coverage) && trace.coverage.every(value => {
            const file = record(value);
            return !!file && typeof file.file === 'string' && typeof file.hash === 'string'
                && sourceIds.has(contentHash(`${file.file}\0${file.hash}`))
                && Array.isArray(file.lines) && file.lines.every(value => {
                    const line = record(value); return !!line && positive(line.line) && typeof line.hits === 'number' && Number.isFinite(line.hits) && line.hits > 0;
                });
        });
}
