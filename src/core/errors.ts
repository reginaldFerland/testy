/** Caught values are unknown: anything can be thrown, including an abort reason. */
export function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
    return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
}
