import { TargetReports } from '../../core/runPolicy';

/** The learning checkpoint of one baseline generation. Stages read it; changes go through these methods,
 * so cancellation resumes from exactly the files that completed. */
export class Baseline {
    private readonly completedFiles = new Set<string>();
    private readonly runtimeReports = new Map<string, ReadonlySet<string>>();
    private sourceShapes: ReadonlyMap<string, string | null>;
    private sourceInputs: ReadonlyMap<string, string> = new Map();

    constructor(readonly generation: string | number, shapes: ReadonlyMap<string, string | null>) { this.sourceShapes = shapes; }

    get completed(): ReadonlySet<string> { return this.completedFiles; }
    /** Runtime rows each completed file reported. */
    get runtimeResults(): ReadonlyMap<string, ReadonlySet<string>> { return this.runtimeReports; }
    /** Declaration shapes and input versions the checkpoints were learned against. */
    get shapes(): ReadonlyMap<string, string | null> { return this.sourceShapes; }
    get inputs(): ReadonlyMap<string, string> { return this.sourceInputs; }

    complete(ids: Iterable<string>): void { for (const id of ids) {this.completedFiles.add(id);} }

    /** Files that must be learned again, because they changed, were affected, or no longer exist. */
    invalidate(ids: Iterable<string>): void { for (const id of ids) {this.completedFiles.delete(id); this.runtimeReports.delete(id);} }

    /** Adopt the versions a selection was made against. */
    rebase(shapes: ReadonlyMap<string, string | null>, inputs: ReadonlyMap<string, string>): void { this.sourceShapes = shapes; this.sourceInputs = inputs; }

    /** Reported rows by target, updated as files commit. */
    reports(files: (target: string) => readonly string[]): TargetReports { return new TargetReports(this.runtimeReports, files); }
}
