/** What the engine did and when, for **Testy: Export Timeline**: run phases on one lane, and each test batch on the lane of the
 * worker that ran it, like NCrunch's timeline report. Spans are kept for the last `retainMs` and at most `maxSpans`. */
export interface TimelineSpan {
    readonly name: string;
    /** `run` (a whole run), `phase` (a run stage), `batch` (a test batch on a worker, including preparation), `process` (its test
     * process), `analysis` (source analysis, which overlaps preparation), `build` (one MSBuild invocation), `discovery` (one test
     * target's discovery), `instrumentation` (one assembly's coverage instrumentation), `wait` (a worker idle while work remains,
     * waiting for a shared resource or a busy target). */
    readonly category: 'run' | 'phase' | 'batch' | 'process' | 'analysis' | 'build' | 'discovery' | 'instrumentation' | 'wait';
    /** Lane 0 holds runs, phases and analysis; worker `n` uses lane `n + 1`; preparation lanes start at `preparationLanes`. */
    readonly lane: number;
    /** Epoch milliseconds. */
    readonly start: number;
    readonly end: number;
    readonly details?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** The first lane of the preparation work (builds, discovery, instrumentation), which has no worker of its own. */
export const preparationLanes = 1000;

/** A sampled value over time, such as the extension host's event-loop delay. */
export interface TimelineCounter { readonly name: string; readonly time: number; readonly value: number }

export class Timeline {
    private spans: TimelineSpan[] = [];
    private counters: TimelineCounter[] = [];
    /** Preparation lanes in use, so overlapping preparation work is drawn on separate lanes. */
    private readonly busy = new Set<number>();

    constructor(private readonly retainMs = 10 * 60 * 1000, private readonly maxSpans = 20_000, private readonly now = Date.now) {}

    get size(): number { return this.spans.length; }

    /** Start preparation work on the lowest free preparation lane; the returned function records it when it ends. */
    begin(name: string, category: TimelineSpan['category'], details?: TimelineSpan['details']): (more?: TimelineSpan['details']) => void {
        let lane = preparationLanes; while (this.busy.has(lane)) {lane++;}
        this.busy.add(lane);
        const start = this.now();
        let ended = false;
        return more => {
            if (ended) {return;}
            ended = true; this.busy.delete(lane);
            this.record({ name, category, lane, start, end: this.now(), ...details || more ? { details: { ...details, ...more } } : {} });
        };
    }

    /** A sample of a counter, kept like spans. */
    count(name: string, value: number, time = this.now()): void {
        if (!Number.isFinite(value)) {return;}
        this.counters.push({ name, time, value });
        if (this.counters.length > this.maxSpans * 1.25) {this.counters = this.counters.slice(-this.maxSpans);}
    }

    /** The retained counter samples, oldest first. */
    samples(): TimelineCounter[] {
        const since = this.now() - this.retainMs;
        this.counters = this.counters.filter(sample => sample.time >= since).slice(-this.maxSpans);
        return [...this.counters];
    }

    record(span: TimelineSpan): void {
        if (!(span.end >= span.start)) {return;}
        this.spans.push(span);
        if (this.spans.length > this.maxSpans * 1.25) {this.spans = this.spans.slice(-this.maxSpans);}
    }

    /** The retained spans, oldest first: those that ended in the retention window. */
    recent(): TimelineSpan[] {
        const since = this.now() - this.retainMs;
        this.spans = this.spans.filter(span => span.end >= since).slice(-this.maxSpans);
        return [...this.spans].sort((a, b) => a.start - b.start || b.end - a.end);
    }

    clear(): void { this.spans = []; this.counters = []; }
}

/** Colours chrome://tracing reserves, by what a span is: passing batches green, failing ones red, waits grey. */
function colour(span: TimelineSpan): string | undefined {
    if (span.category === 'batch') {return span.details?.completed === false ? 'bad' : Number(span.details?.failed ?? 0) > 0 ? 'terrible' : 'good';}
    return ({ build: 'rail_load', discovery: 'rail_animation', instrumentation: 'rail_idle', wait: 'grey', process: 'thread_state_running' } as Partial<Record<TimelineSpan['category'], string>>)[span.category];
}

function laneName(lane: number): string {
    return lane >= preparationLanes ? `Preparation ${lane - preparationLanes + 1}` : lane ? `Worker ${lane}` : 'Engine';
}

/** The Trace Event Format (complete events in microseconds) that Perfetto (ui.perfetto.dev) and chrome://tracing open. */
export function traceEvents(spans: readonly TimelineSpan[], counters: readonly TimelineCounter[] = []): { readonly traceEvents: readonly Record<string, unknown>[]; readonly displayTimeUnit: 'ms' } {
    const origin = Math.min(spans.reduce((first, span) => Math.min(first, span.start), Number.POSITIVE_INFINITY),
        counters.reduce((first, sample) => Math.min(first, sample.time), Number.POSITIVE_INFINITY));
    const lanes = [...new Set(spans.map(span => span.lane))].sort((a, b) => a - b);
    const events: Record<string, unknown>[] = [{ name: 'process_name', ph: 'M', pid: 1, args: { name: 'Testy' } },
        ...lanes.map(lane => ({ name: 'thread_name', ph: 'M', pid: 1, tid: lane, args: { name: laneName(lane) } })),
        ...lanes.map(lane => ({ name: 'thread_sort_index', ph: 'M', pid: 1, tid: lane, args: { sort_index: lane } }))];
    for (const span of spans) {
        const cname = colour(span);
        events.push({ name: span.name, cat: span.category, ph: 'X', pid: 1, tid: span.lane, ts: Math.round((span.start - origin) * 1000),
            dur: Math.max(1, Math.round((span.end - span.start) * 1000)), ...cname ? { cname } : {}, args: { ...span.details, startedAt: new Date(span.start).toISOString() } });
    }
    // Counter tracks, such as the extension host's event-loop delay (in milliseconds).
    for (const sample of counters) {events.push({ name: sample.name, ph: 'C', pid: 1, ts: Math.round((sample.time - origin) * 1000), args: { ms: sample.value } });}
    return { traceEvents: events, displayTimeUnit: 'ms' };
}

/** The slowest test files by learned run time, longest first. */
export function slowest<T extends { readonly id: string }>(groups: readonly T[], elapsed: (id: string) => number | undefined, limit = 50): { readonly group: T; readonly elapsed: number }[] {
    return groups.flatMap(group => {const time = elapsed(group.id); return time === undefined ? [] : [{ group, elapsed: time }];})
        .sort((a, b) => b.elapsed - a.elapsed).slice(0, limit);
}
