/** Stream JSON in bounded chunks so dense traces never need one host-blocking
 * JSON.stringify or a second full-size string allocation. Values are JSON data. */
export function* jsonChunks(value: unknown): Generator<string> {
    const flat = (value: unknown): boolean => value === null || typeof value !== 'object'
        || ('line' in value && 'hits' in value && typeof value.line === 'number' && typeof value.hits === 'number' && Object.keys(value).length === 2);
    function* pieces(value: unknown): Generator<string> {
        if (Array.isArray(value)) {
            yield '[';
            for (let index = 0; index < value.length;) {
                if (index) {yield ',';}
                if (flat(value[index])) {
                    const start = index;
                    while (index < value.length && index - start < 1024 && flat(value[index])) {index++;}
                    // Dense line/geometry arrays use native serialization, with
                    // a bounded batch instead of one giant synchronous string.
                    yield JSON.stringify(value.slice(start, index)).slice(1, -1);
                } else {yield* pieces(value[index++]);}
            }
            yield ']';
        } else if (value !== null && typeof value === 'object') {
            const fields = Object.entries(value);
            if (fields.every(([, field]) => field === null || typeof field !== 'object')) {yield JSON.stringify(value); return;}
            yield '{'; let first = true;
            for (const [key, field] of fields) {
                if (field === undefined) {continue;}
                if (!first) {yield ',';} first = false;
                yield JSON.stringify(key); yield ':'; yield* pieces(field);
            }
            yield '}';
        } else {yield JSON.stringify(value) ?? 'null';}
    }
    let chunk = '';
    for (const piece of pieces(value)) {
        chunk += piece;
        if (chunk.length >= 32 * 1024) {yield chunk; chunk = '';}
    }
    if (chunk) {yield chunk;}
}
