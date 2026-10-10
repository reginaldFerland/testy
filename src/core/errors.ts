/** Caught values are unknown: anything can be thrown, including an abort reason. */
export function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
    return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
}

export class Cancelled extends Error {
    constructor() { super('Run cancelled'); this.name = 'AbortError'; }
}

export type EnvironmentErrorCode = 'dotnet-missing' | 'dotnet-start' | 'sdk-unsupported' | 'analyzer' | 'configuration' | 'no-test-project' | 'not-mtp' | 'host-unresolved';

/** A startup or environment failure the user must fix (as opposed to a routine build or test failure). */
export class EnvironmentError extends Error {
    constructor(readonly code: EnvironmentErrorCode, message: string, options?: ErrorOptions) {super(message, options); this.name = 'EnvironmentError';}
}

export function isEnvironmentError(error: unknown): error is EnvironmentError {return error instanceof EnvironmentError;}
