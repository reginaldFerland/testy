import * as path from 'node:path';
import { sourceDirectories } from './paths';

/** The engine's evaluated inputs; `inputVersion` changes whenever they do. */
export interface InputSource {
    readonly inputVersion?: number;
    readonly knownFiles: readonly string[];
    readonly directories: readonly string[];
}

/**
 * Constant-time membership checks over the engine's inputs, so a burst of file
 * events (a branch switch) costs O(events) rather than O(events × files). It is
 * rebuilt only when the engine reports different inputs.
 */
export class InputIndex {
    private version: number | undefined;
    private list: readonly string[] | undefined;
    private directories: readonly string[] | undefined;
    private known = new Set<string>();
    private sources: readonly string[] = [];
    private sourceSet = new Set<string>();
    private sorted: string[] | undefined;

    constructor(private readonly engine: InputSource) {}

    /** Reads the engine once and rebuilds when its inputs changed. Call once per operation. */
    refresh(): this {
        const version = this.engine.inputVersion, files = this.engine.knownFiles, directories = this.engine.directories;
        if (this.list === files && this.directories === directories && this.version === version) {return this;}
        this.version = version; this.list = files; this.directories = directories;
        this.known = new Set(files);
        this.sources = sourceDirectories(files, directories ?? []);
        this.sourceSet = new Set(this.sources);
        this.sorted = undefined;
        return this;
    }

    get files(): readonly string[] { return this.list ?? []; }

    get sourceDirectories(): readonly string[] { return this.sources; }

    has(file: string): boolean { return this.known.has(file); }

    /** Whether the path is, or lies inside, a directory that holds source inputs. */
    inSourceDirectory(file: string): boolean {
        for (let current = file; ; ) {
            if (this.sourceSet.has(current)) {return true;}
            const parent = path.dirname(current);
            if (parent === current) {return false;}
            current = parent;
        }
    }

    /** Known inputs strictly inside a directory. */
    descendants(folder: string): string[] {
        const sorted = this.sorted ??= [...this.known].sort();
        const prefix = folder.endsWith('/') || folder.endsWith(path.sep) ? folder : `${folder}/`;
        let low = 0, high = sorted.length;
        while (low < high) {const middle = (low + high) >>> 1; if (sorted[middle] < prefix) {low = middle + 1;} else {high = middle;}}
        const result: string[] = [];
        for (; low < sorted.length && sorted[low].startsWith(prefix); low++) {result.push(sorted[low]);}
        return result;
    }
}
