import { DiscoveredTest } from './model';

export type Trait = NonNullable<DiscoveredTest['traits']>[number];

/** Upper bounds keep a pathological provider from flooding Test Explorer with tags. */
const maxTraits = 32, maxLength = 128;

const scalar = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : undefined;

/**
 * Trait/category metadata of an MTP node. Frameworks report it in these shapes, so all are read:
 *  - `traits`: an array of `{ key, value }` (the MTP `TestMetadataProperty` shape; `name` is accepted for `key`),
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
                addAll(entry.key ?? entry.name, entry.value);
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
