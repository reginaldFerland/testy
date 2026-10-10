import * as vscode from 'vscode';
import * as path from 'node:path';
import { BuildDiagnostic, diagnosticKey, LineSplitter, parseBuildDiagnostic } from './core/diagnostics';

/** Routes engine output to the log, collecting build diagnostics for the Problems panel. */
export class DiagnosticsPublisher implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('testy');
    private readonly lines = new LineSplitter();
    private diagnostics = new Map<string, BuildDiagnostic>();

    constructor(private readonly output: vscode.LogOutputChannel, private readonly roots: () => readonly string[]) {}

    get values(): IterableIterator<BuildDiagnostic> { return this.diagnostics.values(); }

    /** Log complete output lines of streamed text. */
    push(text: string): void { this.log(this.lines.push(text)); }

    /** Log the trailing partial line. */
    flush(): void { this.log(this.lines.flush()); }

    /** Forget the previous run's diagnostics without touching what the Problems panel shows. */
    begin(): void { this.diagnostics = new Map(); }

    clear(): void { this.collection.clear(); this.diagnostics.clear(); }

    /** Log complete output lines at the level their content implies, collecting build diagnostics. */
    private log(lines: readonly string[]): void {
        for (const line of lines) {
            const diagnostic = parseBuildDiagnostic(line);
            if (diagnostic) {this.diagnostics.set(diagnosticKey(diagnostic), diagnostic);}
            if (diagnostic?.severity === 'error') {this.output.error(line);}
            else if (diagnostic?.severity === 'warning') {this.output.warn(line);}
            else if (line.trim()) {this.output.info(line);}
        }
    }

    publish(): void {
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const item of this.diagnostics.values()) {
            const start = new vscode.Position(Math.max(0, item.line - 1), Math.max(0, item.column - 1));
            const end = item.endLine ? new vscode.Position(Math.max(0, item.endLine - 1), Math.max(0, item.endColumn! - 1)) : start;
            const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), item.message,
                item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
            diagnostic.code = item.code; diagnostic.source = 'Testy build';
            const file = path.isAbsolute(item.file) ? item.file : path.resolve(item.project ? path.dirname(item.project) : this.roots()[0] ?? '', item.file);
            const list = byFile.get(file) ?? []; list.push(diagnostic); byFile.set(file, list);
        }
        this.collection.clear();
        for (const [file, list] of byFile) {this.collection.set(vscode.Uri.file(file), list);}
    }

    dispose(): void { this.collection.dispose(); }
}
