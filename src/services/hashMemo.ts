import type { BigIntStats, Stats } from 'node:fs';

/** A write in the same timestamp tick as a read can leave a file's metadata unchanged
 * (FAT keeps two-second resolution), so only files whose modification and change
 * times were both this much older than the read are trusted. Tests may adjust it. */
export const hashMemoTiming = { racyMs: 2_000 };

/** Content hashes reused while a file's identity, size and timestamps are unchanged;
 * anything uncertain is hashed again. Least recently used entries are evicted. */
export class HashMemo {
    private readonly known = new Map<string, { readonly stamp: string; readonly digest: string }>();
    constructor(private readonly capacity: number) {}

    private static stamp(stat: Stats | BigIntStats): string {
        return 'mtimeNs' in stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    }

    get size(): number { return this.known.size; }

    get(file: string, stat: Stats | BigIntStats): string | undefined {
        const entry = this.known.get(file);
        if (!entry || entry.stamp !== HashMemo.stamp(stat)) {return undefined;}
        this.known.delete(file); this.known.set(file, entry); return entry.digest;
    }

    /** `stat` is read before the content and `readAt` taken before reading it, so a later
     * edit always postdates the recorded metadata and the entry cannot vouch for newer bytes. */
    set(file: string, stat: Stats | BigIntStats, digest: string, readAt: number): void {
        const changed = Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs));
        this.known.delete(file);
        if (!(readAt - changed > hashMemoTiming.racyMs)) {return;}
        this.known.set(file, { stamp: HashMemo.stamp(stat), digest });
        if (this.known.size > this.capacity) {this.known.delete(this.known.keys().next().value!);}
    }

    clear(): void { this.known.clear(); }
}
