/** A compiler or MSBuild message with a source location, as printed by `dotnet build`. */
export interface BuildDiagnostic {
    readonly file: string;
    /** One-based, as printed. */
    readonly line: number;
    readonly column: number;
    readonly endLine?: number;
    readonly endColumn?: number;
    readonly severity: 'error' | 'warning';
    readonly code: string;
    readonly message: string;
    readonly project?: string;
}

// path(line[,col[,endLine,endCol]]): error|warning CODE: message [project]
// Parallel builds may prefix a node number ("12>"). Lines without a file
// location (for example "MSBUILD : error MSB1009") are not attributable.
const pattern = /^\s*(?:\d+>)?(.+?)\((\d+)(?:,(\d+))?(?:,(\d+),(\d+))?\)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?\s*$/;

export function parseBuildDiagnostic(line: string): BuildDiagnostic | undefined {
    const match = pattern.exec(line);
    if (!match) {return undefined;}
    const [, file, start, column, endLine, endColumn, severity, code, message, project] = match;
    return {
        file: file.trim(), line: Number(start), column: Number(column ?? 1),
        ...(endLine ? { endLine: Number(endLine), endColumn: Number(endColumn) } : {}),
        severity: severity as 'error' | 'warning', code, message, ...(project ? { project } : {})
    };
}

/** MSBuild repeats each message in its summary; keep one per location and code. */
export function diagnosticKey(diagnostic: BuildDiagnostic): string {
    return [diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.severity, diagnostic.code, diagnostic.message].join('\0');
}

/** Splits streamed output into complete lines, retaining a trailing partial line. */
export class LineSplitter {
    private partial = '';
    push(text: string): string[] {
        const lines = (this.partial + text).split(/\r?\n/);
        this.partial = lines.pop() ?? '';
        return lines;
    }
    flush(): string[] {
        const rest = this.partial; this.partial = '';
        return rest ? [rest] : [];
    }
}
