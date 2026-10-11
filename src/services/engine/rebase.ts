import { rebasedTrace } from '../../core/memberImpact';
import { rebaseRecords } from '../../core/testCoverage';
import { traceIsCurrent } from '../../core/runPolicy';
import type { EngineHost } from './host';
import type { BuildResult, RunContext, SelectedRun } from './types';

/** After a completed impact run, move the traces of unselected files to the built versions of the edits they provably did not
 * execute (see core/memberImpact). Their coverage stays current and keeps narrowing after a restart, instead of turning stale
 * until each file happens to run again. A trace whose lines cannot all move stays as it is. */
export async function rebaseUnaffected(host: EngineHost, run: RunContext, built: BuildResult, selected: SelectedRun, liveIds: ReadonlySet<string>): Promise<number> {
    if (!selected.unaffected?.size || host.topology !== run.topology || built.obsoleteBuild) {return 0;}
    let rebased = 0;
    for (const [id, files] of selected.unaffected) {
        run.signal.throwIfAborted();
        const trace = host.coverage.traces.get(id);
        if (!trace?.reliable || trace.historical) {continue;}
        const next = rebasedTrace(trace, files, built.before, (file, hash) => host.coverage.versionGeometry(file, hash), (file, hash) => host.members.get(file, hash));
        if (!next) {continue;}
        // A file edited again since the build is still a change this trace has not accounted for.
        await host.commitCoverage({ ...next, stale: built.revision !== host.sources.revision || !traceIsCurrent(next, host.hashes) }, liveIds, run.signal);
        // Each test's own coverage moves with the file's, or is dropped (see core/testCoverage).
        const records = host.testCoverage.get(id);
        if (records) {
            const moved = rebaseRecords(records, records.keys(), [...files], built.before, (file, hash) => host.coverage.versionGeometry(file, hash), (file, hash) => host.members.get(file, hash));
            if (moved) {host.testCoverage.set(id, moved);} else {host.testCoverage.delete(id);}
        }
        rebased++;
    }
    return rebased;
}
