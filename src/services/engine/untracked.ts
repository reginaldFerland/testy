import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Project } from '../../core/model';
import { contentHash } from '../../core/paths';
import { mapConcurrent } from '../../core/concurrency';
import { HashMemo } from '../hashMemo';

/** Versions of files the source tracker does not hash but a restart must compare (see TestEngine.restore): files outside every
 * project, such as shared test data, and the package assets Restore resolved. A missing file has no entry; a file that cannot be
 * read gets a version nothing matches, so it counts as changed. */

/** Size and modification time: every run stamps these files, and a change selects every test project anyway. */
export async function fileStamps(files: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const stamps = await mapConcurrent(files, 16, signal, async file => {
        try {const stat = await fs.stat(file); return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : undefined;}
        catch (error) {signal?.throwIfAborted(); return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : `unreadable:${randomUUID()}`;}
    });
    return new Map(files.flatMap((file, index) => stamps[index] === undefined ? [] : [[file, stamps[index]] as const]));
}

/** Each project's restored assets (project.assets.json in its evaluated intermediate directories) by content, so a floating or
 * re-pushed package that Restore resolves to other binaries is a change of that project. `memo` skips unchanged files. */
export async function assetVersions(projects: readonly Project[], memo: HashMemo, signal?: AbortSignal): Promise<Map<string, string>> {
    const files = [...new Set(projects.flatMap(project => [...project.outputDirectories ?? [], path.join(path.dirname(project.file), 'obj')]
        .map(directory => path.join(directory, 'project.assets.json'))))];
    const versions = await mapConcurrent(files, 16, signal, async (file, _index, workerSignal) => {
        try {
            const readAt = Date.now(), stat = await fs.stat(file, { bigint: true });
            if (!stat.isFile()) {return undefined;}
            const known = memo.get(file, stat);
            if (known) {return known;}
            const digest = contentHash(await fs.readFile(file, { signal: workerSignal }));
            memo.set(file, stat, digest, readAt); return digest;
        } catch (error) {signal?.throwIfAborted(); return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : `unreadable:${randomUUID()}`;}
    });
    return new Map(files.flatMap((file, index) => versions[index] === undefined ? [] : [[file, versions[index]] as const]));
}

/** Files whose version differs between two version maps, in either direction: added, removed or changed. */
export function changedVersions(saved: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[] {
    const changed = new Set<string>();
    for (const [file, version] of saved) {if (current.get(file) !== version) {changed.add(file);}}
    for (const [file, version] of current) {if (saved.get(file) !== version) {changed.add(file);}}
    return [...changed];
}
