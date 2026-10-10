import { TestFile } from '../core/model';
import { TestNode } from './mtp';
import { nodeKey } from './runnerDiscovery';
import type { Preparation } from './runnerPreparation';

export interface RunnerLane<T> { readonly session: Promise<T>; readonly slot: number; busy: boolean; }

/** Private runner lanes per test target. Each lane gets its own output directory
 * (`number`, never reused within a session) and a prepared-output slot: the lowest
 * one no live lane of the target holds, so slots stay distinct after a lane fails. */
export class RunnerLanes<T> {
    private readonly lanes = new Map<string, RunnerLane<T>[]>();
    private sequence = 0;
    constructor(private readonly create: (number: number, slot: number) => Promise<T>) {}

    /** Targets that currently have lanes. */
    get size(): number { return this.lanes.size; }

    sessions(): Promise<T>[] { return [...this.lanes.values()].flatMap(lanes => lanes.map(lane => lane.session)); }

    /** An idle lane of the target, or a new one, reserved before the caller yields:
     * changing pool worker IDs must not grow the lane count. The caller clears `busy`. */
    reserve(key: string): RunnerLane<T> {
        const lanes = this.lanes.get(key) ?? [];
        let lane = lanes.find(item => !item.busy);
        if (!lane) {
            const taken = new Set(lanes.map(item => item.slot));
            let slot = 1; while (taken.has(slot)) {slot++;}
            const created: RunnerLane<T> = lane = { busy: false, slot, session: this.create(++this.sequence, slot) };
            lanes.push(created); this.lanes.set(key, lanes);
            // A lane that never started holds nothing to clean up; a later batch creates a fresh one.
            void created.session.catch(() => {
                const index = lanes.indexOf(created);
                if (index >= 0) {lanes.splice(index, 1);}
                if (!lanes.length && this.lanes.get(key) === lanes) {this.lanes.delete(key);}
            });
        }
        lane.busy = true;
        return lane;
    }
}

/** Never guess between indistinguishable rows or run a different file shape. */
export function matchesFile(group: TestFile, primary: Preparation, lane: Preparation): boolean {
    const local = lane.groups?.find(item => item.id === group.id && item.file === group.file);
    if (!local || local.tests.length !== group.tests.length) {return false;}
    const localIds = new Set(local.tests.map(test => test.id)), matched = new Set<string>();
    for (const test of group.tests) {
        const key = nodeKey(test.node as TestNode);
        let native = lane.nativeById.get(test.id);
        if (native && nodeKey(native) !== key) {return false;}
        if (!native) {
            const candidates = lane.byKey.get(key);
            if (candidates?.length !== 1 || primary.byKey.get(key)?.length !== 1) {return false;}
            native = candidates[0];
            if (!native) {return false;}
        }
        if (!localIds.has(native.uid) || matched.has(native.uid)) {return false;}
        matched.add(native.uid);
    }
    return matched.size === localIds.size;
}
