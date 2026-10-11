/** One text change, as an editor reports it: the 0-based lines of the replaced range, and the text that replaced it. */
export interface LineChange { readonly range: { readonly start: { readonly line: number }; readonly end: { readonly line: number } }; readonly text: string }

/** Lines of a document's saved version mapped to the lines of its unsaved text, through the changes made since the save. A line a
 * change touched has no mapping (its content may differ); lines below a change move by the lines it added or removed. */
export class LineMap {
    /** Changes in the order they applied: the 0-based lines they replaced, of the text before them, and the lines they inserted. */
    private readonly edits: { readonly start: number; readonly end: number; readonly inserted: number }[] = [];
    /** Counts applied changes, so a renderer can tell whether its last drawing is still placed right. */
    version = 0;

    /** The changes of one editor event. Their ranges all refer to the text before the event, so they apply bottom up. */
    apply(changes: readonly LineChange[]): void {
        const ordered = [...changes].sort((a, b) => b.range.start.line - a.range.start.line);
        for (const change of ordered) {
            this.edits.push({ start: change.range.start.line, end: change.range.end.line, inserted: change.text.split(/\r\n|\r|\n/).length - 1 });
        }
        this.version++;
    }

    /** Where a saved 0-based line is in the unsaved text, or undefined when a change touched it. */
    map(line: number): number | undefined {
        let current = line;
        for (const edit of this.edits) {
            if (current < edit.start) {continue;}
            if (current > edit.end) {current += edit.inserted - (edit.end - edit.start); continue;}
            return undefined;
        }
        return current;
    }

    /** Which saved 0-based line an unsaved line shows, or undefined for a line a change wrote. */
    inverse(line: number): number | undefined {
        let current = line;
        for (let index = this.edits.length - 1; index >= 0; index--) {
            const edit = this.edits[index]!, after = edit.start + edit.inserted;
            if (current < edit.start) {continue;}
            if (current > after) {current -= edit.inserted - (edit.end - edit.start); continue;}
            return undefined;
        }
        return current;
    }
}
