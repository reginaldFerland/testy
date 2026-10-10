/** One frame of a .NET stack trace. */
export interface StackFrame {
    readonly label: string;
    readonly file?: string;
    /** One-based. */
    readonly line?: number;
}

// "   at Namespace.Type.Method(Args) in /path/File.cs:line 42". The "at", "in"
// and "line" words are localized by the runtime; accept any single word for each.
const frame = /^\s*\S+\s+([^\s(][^(]*\(.*?\))(?:\s+\S+\s+(.+):\S+\s+(\d+))?\s*$/;

export function parseStackTrace(stack: string | undefined): readonly StackFrame[] {
    if (!stack) {return [];}
    const frames: StackFrame[] = [];
    for (const text of stack.split(/\r?\n/)) {
        if (/^\s*---/.test(text)) {continue;} // "--- End of stack trace from previous location ---"
        const match = frame.exec(text);
        if (!match) {continue;}
        const [, label, file, line] = match;
        if (!label) {continue;}
        frames.push(file && line ? { label, file, line: Number(line) } : { label });
    }
    return frames;
}

/** The innermost frame in a workspace file: usually the failing assertion in the test. */
export function failingFrame(frames: readonly StackFrame[], isWorkspaceFile: (file: string) => boolean): StackFrame | undefined {
    return frames.find(item => item.file && item.line && isWorkspaceFile(item.file));
}
