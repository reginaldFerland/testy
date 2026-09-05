import { setImmediate as yieldTurn } from 'node:timers/promises';

export function finish<T>(work: Generator<void, T>): T {
    for (;;) {const step = work.next(); if (step.done) {return step.value;}}
}

export async function finishAsync<T>(work: Generator<void, T>, signal?: AbortSignal): Promise<T> {
    for (;;) {
        signal?.throwIfAborted();
        const step = work.next(); if (step.done) {return step.value;}
        await yieldTurn();
    }
}

/** Bounded sorting/merging also handles a single unusually large source file. */
export function* sortedUnion(a: readonly number[], b: readonly number[]): Generator<void, readonly number[]> {
    if (a === b) {return a;}
    let ordered = true, count = 0;
    for (const input of [a, b]) {for (let index = 1; index < input.length; index++) {
        if (input[index - 1] > input[index]) {ordered = false; break;}
        if (++count % 4096 === 0) {yield;}
    }}
    if (ordered) {
        let identical = a.length === b.length;
        if (identical) {for (let index = 0; index < a.length; index++) {
            if (a[index] !== b[index]) {identical = false; break;}
            if (++count % 4096 === 0) {yield;}
        }}
        if (identical) {return a;}
        const merged: number[] = [];
        let i = 0, j = 0;
        while (i < a.length || j < b.length) {
            const value = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
            if (value !== merged[merged.length - 1]) {merged.push(value);}
            if (++count % 4096 === 0) {yield;}
        }
        return merged;
    }
    let runs: number[][] = [], chunk: number[] = [];
    for (const input of [a, b]) {for (const value of input) {
        chunk.push(value);
        if (chunk.length === 4096) {runs.push(chunk.sort((x, y) => x - y)); chunk = []; yield;}
    }}
    if (chunk.length) {runs.push(chunk.sort((x, y) => x - y));}
    while (runs.length > 1) {
        const next: number[][] = [];
        for (let index = 0; index < runs.length; index += 2) {
            if (!runs[index + 1]) {next.push(runs[index]); continue;}
            const left = runs[index], right = runs[index + 1], merged: number[] = [];
            let i = 0, j = 0, count = 0;
            while (i < left.length || j < right.length) {
                const value = j >= right.length || (i < left.length && left[i] <= right[j]) ? left[i++] : right[j++];
                if (value !== merged[merged.length - 1]) {merged.push(value);}
                if (++count % 4096 === 0) {yield;}
            }
            next.push(merged);
        }
        runs = next;
    }
    const result: number[] = [];
    let index = 0;
    for (const value of runs[0] ?? []) {
        if (value !== result[result.length - 1]) {result.push(value);}
        if (++index % 4096 === 0) {yield;}
    }
    return result;
}
