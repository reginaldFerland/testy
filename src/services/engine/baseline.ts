import { TargetReports } from '../../core/runPolicy';

/** The learning checkpoint of one baseline generation. Stages read it; changes go through these methods,
 * so cancellation resumes from exactly the files that completed. */
export class Baseline {
    private readonly completedFiles = new Set<string>();
    private readonly runtimeReports = new Map<string, ReadonlySet<string>>();
    private sourceShapes: ReadonlyMap<string, string | null>;
    private sourceInputs: ReadonlyMap<string, string> = new Map();
    private untrackedInputs: ReadonlyMap<string, string> = new Map();
    private changes = 0;

    /** `resumed`: restored from a saved checkpoint rather than started in this session; see TestEngine.restore. */
    constructor(readonly generation: string | number, shapes: ReadonlyMap<string, string | null>, readonly resumed = false) { this.sourceShapes = shapes; }

    /** Changes with every update, so the saved checkpoint is rewritten only when it would differ. */
    get revision(): number { return this.changes; }

    get completed(): ReadonlySet<string> { return this.completedFiles; }
    /** Runtime rows each completed file reported. */
    get runtimeResults(): ReadonlyMap<string, ReadonlySet<string>> { return this.runtimeReports; }
    /** Declaration shapes and input versions the checkpoints were learned against. */
    get shapes(): ReadonlyMap<string, string | null> { return this.sourceShapes; }
    get inputs(): ReadonlyMap<string, string> { return this.sourceInputs; }
    /** Versions of the untracked files a restart compares (see engine/untracked). */
    get untracked(): ReadonlyMap<string, string> { return this.untrackedInputs; }

    complete(ids: Iterable<string>): void { for (const id of ids) {this.completedFiles.add(id);} this.changes++; }

    /** Files that must be learned again, because they changed, were affected, or no longer exist. */
    invalidate(ids: Iterable<string>): void { for (const id of ids) {this.completedFiles.delete(id); this.runtimeReports.delete(id);} this.changes++; }

    /** Adopt the versions a selection was made against; `untracked` is kept when not given. */
    rebase(shapes: ReadonlyMap<string, string | null>, inputs: ReadonlyMap<string, string>, untracked = this.untrackedInputs): void {
        this.sourceShapes = shapes; this.sourceInputs = inputs; this.untrackedInputs = untracked; this.changes++;
    }

    /** Reported rows by target, updated as files commit. */
    reports(files: (target: string) => readonly string[]): TargetReports { return new TargetReports(this.runtimeReports, files); }
}
