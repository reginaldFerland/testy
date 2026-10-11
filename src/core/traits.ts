import type { ItemResources } from './concurrency';
import { DiscoveredTest, TestFile } from './model';

export type Trait = NonNullable<DiscoveredTest['traits']>[number];

/** Upper bounds keep a pathological provider from flooding Test Explorer with tags. */
const maxTraits = 32, maxLength = 128;

const scalar = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : undefined;

/**
 * Trait/category metadata of an MTP node. Frameworks report it in these shapes, so all are read:
 *  - `traits`: an array of `{ key, value }` (the MTP `TestMetadataProperty` shape; `name` is accepted for `key`),
 *    `{ name: value }` objects (MSTest 4, which reports a `TestCategory` as `{ category: "" }`, read as a `Category` trait),
 *    `"key=value"` strings, or a `{ key: value | value[] }` map. MSTest `TestCategory` and xUnit/NUnit traits
 *    arrive this way.
 *  - `trait.<key>`: one flat property per trait, whose value is a string or an array of strings.
 * Duplicates are dropped; the order of first appearance is kept.
 */
export function nodeTraits(node: Readonly<Record<string, unknown>>): readonly Trait[] | undefined {
    const found = new Map<string, Trait>();
    const add = (key: unknown, value: unknown): void => {
        const k = scalar(key), v = scalar(value);
        if (!k || v === undefined || found.size >= maxTraits) {return;}
        const trait = { key: k.slice(0, maxLength), value: v.slice(0, maxLength) };
        found.set(`${trait.key}\0${trait.value}`, trait);
    };
    const addAll = (key: unknown, value: unknown): void => {
        if (Array.isArray(value)) {for (const item of value) {add(key, item);}} else {add(key, value);}
    };
    const traits = node.traits;
    if (Array.isArray(traits)) {
        for (const item of traits) {
            if (typeof item === 'string') {
                const split = item.indexOf('=');
                if (split > 0) {add(item.slice(0, split), item.slice(split + 1));}
            } else if (item && typeof item === 'object') {
                const entry = item as Record<string, unknown>;
                if (entry.key !== undefined || entry.name !== undefined) {addAll(entry.key ?? entry.name, entry.value);}
                // MSTest 4 reports `{ "<name>": "<value>" }`, and a `TestCategory` as its name with an empty value.
                else {for (const [key, value] of Object.entries(entry)) {if (value === '') {add('Category', key);} else {addAll(key, value);}}}
            }
        }
    } else if (traits && typeof traits === 'object') {
        for (const [key, value] of Object.entries(traits)) {addAll(key, value);}
    }
    for (const [name, value] of Object.entries(node)) {
        if (name.startsWith('trait.') && name.length > 'trait.'.length) {addAll(name.slice('trait.'.length), value);}
    }
    return found.size ? [...found.values()] : undefined;
}

/** Test Explorer tag IDs for traits, for filtering with `@testy:trait:Category=Integration`. */
export function traitTagIds(traits: readonly Trait[] | undefined): string[] {
    const ids: string[] = [];
    // Whitespace would end the tag in Test Explorer's filter text.
    const tag = (text: string): string => text.replace(/\s+/g, '_');
    for (const { key, value } of traits ?? []) {
        ids.push(`trait:${tag(key)}=${tag(value)}`);
        if (/^(test)?category$/i.test(key)) {ids.push(`category:${tag(value)}`);}
    }
    return [...new Set(ids)];
}

/** A comparable signature, so a tree rebuild notices changed traits. */
export function traitsSignature(traits: readonly Trait[] | undefined): string {
    return traits?.map(trait => `${trait.key}=${trait.value}`).join('\0') ?? '';
}

/** Whether a test has the trait a setting such as `testy.excludeTraits` names. `Key=Value` matches that trait; a bare value
 * matches a category (a `Category` or `TestCategory` trait) of that value. Both compare without regard to case. */
export function matchesTrait(traits: readonly Trait[] | undefined, pattern: string): boolean {
    const split = pattern.indexOf('='), wanted = (split > 0 ? pattern.slice(split + 1) : pattern).trim().toLowerCase();
    const key = split > 0 ? pattern.slice(0, split).trim().toLowerCase() : undefined;
    return !!wanted && !!traits?.some(trait => trait.value.toLowerCase() === wanted && (key === undefined ? /^(test)?category$/i.test(trait.key) : trait.key.toLowerCase() === key));
}

/** Whether a test has a trait that `testy.excludeTraits` names (see matchesTrait). */
export function hasExcludedTrait(traits: readonly Trait[] | undefined, patterns: readonly string[]): boolean {
    if (!traits?.length || !patterns.length) {return false;}
    return patterns.some(pattern => matchesTrait(traits, pattern));
}

/** The shared resources a batch of test files needs (see ItemResources): every `testy.exclusiveTraits` pattern a test of the files
 * matches is a resource named by that pattern, every `testy.inclusiveTraits` pattern one it shares with other inclusive holders (an
 * exclusive holder of the same name still waits for them), a test matching a `testy.serialTraits` pattern makes the batch serial,
 * and a `testy.workerTraits` pattern takes that many test-file workers (the largest that matches). A file's tests share one test
 * process, so a trait on one test applies to its whole file. Undefined when the batch needs none. */
export function batchResources(groups: readonly TestFile[], exclusive: readonly string[], serial: readonly string[],
    more: { readonly inclusive?: readonly string[] | undefined; readonly workers?: Readonly<Record<string, number>> | undefined } = {}): ItemResources | undefined {
    const inclusive = more.inclusive ?? [], workers = Object.entries(more.workers ?? {}).filter(([pattern, count]) => pattern.trim() && Number.isFinite(count) && count > 1);
    if (!exclusive.length && !serial.length && !inclusive.length && !workers.length) {return undefined;}
    const tests = groups.flatMap(group => group.tests);
    const matches = (pattern: string): boolean => tests.some(test => matchesTrait(test.traits, pattern));
    const resources = [...new Set(exclusive.filter(matches).map(resourceName))], isSerial = serial.some(matches);
    const sharedResources = [...new Set(inclusive.filter(matches).map(resourceName))].filter(name => !resources.includes(name));
    const slots = Math.max(1, ...workers.filter(([pattern]) => matches(pattern)).map(([, count]) => Math.floor(count)));
    return resources.length || isSerial || sharedResources.length || slots > 1
        ? { exclusive: resources, serial: isSerial, ...sharedResources.length ? { inclusive: sharedResources } : {}, ...slots > 1 ? { workers: slots } : {} } : undefined;
}

/** Patterns that differ only in case or spacing around `=` name the same resource. */
function resourceName(pattern: string): string {
    const split = pattern.indexOf('=');
    return (split > 0 ? `${pattern.slice(0, split).trim()}=${pattern.slice(split + 1).trim()}` : pattern.trim()).toLowerCase();
}

/** The test files automatic runs work with: tests with an excluded trait left out (and named in `excludedTestIds`, so that no
 * fallback to the containing file runs them), and files left with no test dropped. Unchanged files are the same objects. */
export function eligibleGroups(groups: readonly TestFile[], patterns: readonly string[] | undefined): readonly TestFile[] {
    if (!patterns?.length) {return groups;}
    const eligible: TestFile[] = [];
    for (const group of groups) {
        const excluded = group.tests.filter(test => hasExcludedTrait(test.traits, patterns));
        if (!excluded.length) {eligible.push(group); continue;}
        if (excluded.length === group.tests.length) {continue;}
        const ids = new Set(excluded.map(test => test.id));
        eligible.push({ ...group, tests: group.tests.filter(test => !ids.has(test.id)), excludedTestIds: [...new Set([...group.excludedTestIds ?? [], ...ids])] });
    }
    return eligible;
}
