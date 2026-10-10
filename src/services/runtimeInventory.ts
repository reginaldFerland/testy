import { DiscoveredTest, TestFile, TestResult } from '../core/model';
import { testTargetKey } from '../core/paths';
import { discoveredTest } from './mtp';

/** Test rows a provider reported while running that discovery did not list (theory cases,
 * dynamic data), and the synthetic containers holding rows whose source file is unknown. */
export class RuntimeInventory {
    /** Runtime rows by owning group: a discovered file or a synthetic container. */
    readonly rows = new Map<string, Map<string, DiscoveredTest>>();
    /** Synthetic containers for rows without a known source file. */
    readonly containers = new Map<string, TestFile>();
    /** Merged discovered and runtime tests, reused while a group's discovery is unchanged. */
    readonly known = new Map<string, { readonly discovered: TestFile['tests']; readonly tests: TestFile['tests'] }>();
    private discovered = new Map<string, ReadonlySet<string>>();

    /** Discovered tests followed by runtime rows, without duplicate IDs. */
    tests(group: TestFile): readonly DiscoveredTest[] {
        const rows = this.rows.get(group.id);
        if (!rows?.size) {return group.tests;}
        const cached = this.known.get(group.id);
        if (cached?.discovered === group.tests) {return cached.tests;}
        const tests = [...new Map([...group.tests, ...rows.values()].map(test => [test.id, test])).values()];
        this.known.set(group.id, { discovered: group.tests, tests }); return tests;
    }

    /** Record a result. A discovered file's result retires the same row from its target's
     * containers. Returns whether the displayed tree changed. */
    observe(group: TestFile, result: TestResult, test?: DiscoveredTest): boolean {
        let changed = false;
        if (group.runtimeOnly) {
            changed = !this.containers.has(group.id);
            this.containers.set(group.id, group);
        } else {
            const key = testTargetKey(group.project, group.framework);
            for (const [id, container] of this.containers) {
                if (testTargetKey(container.project, container.framework) !== key) {continue;}
                const rows = this.rows.get(id);
                if (rows?.delete(result.id)) {
                    this.known.delete(id); changed = true;
                    if (!rows.size) {this.containers.delete(id); this.rows.delete(id);}
                }
            }
        }
        if (result.node && !this.discovered.get(group.id)?.has(result.id)) {
            const rows = this.rows.get(group.id) ?? new Map<string, DiscoveredTest>();
            rows.set(result.id, test ?? discoveredTest(result.node as { uid: string })); this.rows.set(group.id, rows);
            this.known.delete(group.id);
        }
        return changed;
    }

    /** After complete runs: drop the groups' rows that were not reported again and, once every
     * file of the target has completed (`targetReported`), its containers' unreported rows.
     * Returns whether any row was removed. */
    retireUnreported(groups: readonly TestFile[], reported: ReadonlySet<string>, targetReported?: ReadonlySet<string>): boolean {
        let removed = false;
        for (const group of groups) {
            const rows = this.rows.get(group.id);
            for (const id of rows?.keys() ?? []) {if (!reported.has(id)) {rows!.delete(id); this.known.delete(group.id); removed = true;}}
        }
        const [first] = groups;
        if (!targetReported || !first) {return removed;}
        const key = testTargetKey(first.project, first.framework);
        for (const [id, container] of this.containers) {
            if (testTargetKey(container.project, container.framework) !== key) {continue;}
            const rows = this.rows.get(id);
            for (const uid of rows?.keys() ?? []) {if (!targetReported.has(uid)) {rows!.delete(uid); this.known.delete(id); removed = true;}}
            if (!rows?.size) {this.containers.delete(id); this.rows.delete(id); this.known.delete(id);}
        }
        return removed;
    }

    /** Adopt a new discovered inventory. Groups whose identities changed lose their rows, and
     * containers of retired or changed targets are dropped with their rows. */
    reconcile(next: readonly TestFile[], identitiesChanged: ReadonlySet<string>): void {
        for (const id of identitiesChanged) {this.rows.delete(id); this.known.delete(id);}
        this.discovered = new Map(next.map(group => [group.id, new Set(group.tests.map(test => test.id))]));
        const groupIds = new Set(next.map(group => group.id));
        const targets = new Set(next.map(group => testTargetKey(group.project, group.framework)));
        const changedTargets = new Set(next.filter(group => identitiesChanged.has(group.id)).map(group => testTargetKey(group.project, group.framework)));
        for (const [id, container] of this.containers) {
            const key = testTargetKey(container.project, container.framework);
            if (!targets.has(key) || changedTargets.has(key)) {this.containers.delete(id);}
        }
        for (const id of this.rows.keys()) {if (!groupIds.has(id) && !this.containers.has(id)) {this.rows.delete(id); this.known.delete(id);}}
    }
}
