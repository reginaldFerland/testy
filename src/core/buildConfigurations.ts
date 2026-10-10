/** Distinct, non-empty configuration names, without the one automatic runs already use (compared case-insensitively). */
export function additionalConfigurations(values: readonly unknown[], primary: string): string[] {
    const seen = new Set([primary.trim().toLowerCase()]);
    return values.flatMap(value => typeof value === 'string' ? [value.trim()] : [])
        .filter(value => value && !seen.has(value.toLowerCase()) && !!seen.add(value.toLowerCase()));
}
