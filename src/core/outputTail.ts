/** A bounded character tail without copying the retained text on every chunk. */
export class OutputTail {
    private chunks: string[] = [];
    private first = 0;
    private length = 0;
    constructor(private readonly limit: number) {}

    append(text: string): void {
        if (!text || this.limit <= 0) {return;}
        this.chunks.push(text); this.length += text.length;
        while (this.length > this.limit) {
            const chunk = this.chunks[this.first], excess = this.length - this.limit;
            if (chunk.length <= excess) {this.length -= chunk.length; this.chunks[this.first++] = '';}
            else {this.chunks[this.first] = chunk.slice(excess); this.length -= excess;}
        }
        if (this.first > 1024 && this.first * 2 >= this.chunks.length) {this.chunks = this.chunks.slice(this.first); this.first = 0;}
    }

    text(): string { return this.chunks.slice(this.first).join(''); }
}
