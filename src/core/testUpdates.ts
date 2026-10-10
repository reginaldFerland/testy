export type TestNode = Readonly<Record<string, unknown>> & { readonly uid: string };

/** A scalar protocol property as text; objects and missing values become empty. */
export function nodeText(node: TestNode, key: string): string {
    const value = node[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

/** The display name, or the UID when the provider sent none. */
export const nodeName = (node: TestNode): string => nodeText(node, 'display-name') || node.uid;

/** The shown name: xUnit's default `Namespace.Class.Method(args)` is shortened to `Method(args)`; custom names are kept. */
export function testName(node: TestNode): string {
    const name = nodeName(node), type = nodeText(node, 'location.type'), method = nodeText(node, 'location.method');
    const base = method.split('(')[0]!, prefix = `${type}.${base}`;
    if (!type || !base || !name.startsWith(prefix)) {return name;}
    const rest = name.slice(prefix.length);
    return rest === '' || rest.startsWith('(') ? base + rest : name;
}

/** The declaring type (`location.type`) of a test row, when the provider reports one. */
export function testType(node: Readonly<Record<string, unknown>> | undefined): string | undefined {
    const type = node?.['location.type'];
    return typeof type === 'string' && type ? type : undefined;
}

/** Class label from a type name: no namespace, nested types as `Outer.Inner`. */
export function typeLabel(type: string): string {
    const head = type.search(/[+<[]/), cut = (head < 0 ? type : type.slice(0, head)).lastIndexOf('.');
    return type.slice(cut + 1).replace(/\+/g, '.') || type;
}

const isFailure = (node: TestNode): boolean => node['execution-state'] !== undefined
    && !['passed', 'skipped', 'in-progress', 'discovered'].includes(nodeText(node, 'execution-state'));

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
        return { ...identity, ...update };
    }
    const merged = { ...previous, ...update };
    if (!previous['retry.is-superseded'] && !update['retry.is-superseded'] && isFailure(previous) && !isFailure(update)) {
        return { ...merged, 'execution-state': previous['execution-state'], 'error.message': previous['error.message'], 'error.stacktrace': previous['error.stacktrace'] };
    }
    return merged;
}
