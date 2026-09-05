export type TestNode = Readonly<Record<string, unknown>> & { readonly uid: string };

const isFailure = (node: TestNode): boolean => node['execution-state'] !== undefined
    && !['passed', 'skipped', 'in-progress', 'discovered'].includes(String(node['execution-state']));

/** Rows may share a UID. Only an explicitly newer retry may replace a failure. */
export function mergeTestUpdate(previous: TestNode | undefined, update: TestNode): TestNode {
    if (!previous) {return update;}
    const attempt = Number(update['retry.attempt'] ?? previous['retry.attempt'] ?? 1);
    const previousAttempt = Number(previous['retry.attempt'] ?? 1);
    if (attempt < previousAttempt) {return previous;}
    if (attempt > previousAttempt) {
        const identity = Object.fromEntries(Object.entries(previous).filter(([key]) =>
            !key.startsWith('error.') && !key.startsWith('retry.') && !key.startsWith('time.')
            && !['execution-state', 'standardOutput', 'standardError'].includes(key)));
        return { ...identity, ...update } as TestNode;
    }
    const merged = { ...previous, ...update };
    if (!previous['retry.is-superseded'] && !update['retry.is-superseded'] && isFailure(previous) && !isFailure(update)) {
        return { ...merged, 'execution-state': previous['execution-state'], 'error.message': previous['error.message'], 'error.stacktrace': previous['error.stacktrace'] };
    }
    return merged;
}
