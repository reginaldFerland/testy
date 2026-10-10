import * as vscode from 'vscode';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

/** Files learned so far, out of all test files. */
export interface BaselineCounts { readonly completed: number; readonly total: number; }

interface Session {
    percent: number;
    message: string;
    ended: boolean;
    progress?: vscode.Progress<{ message?: string; increment?: number }>;
    finish?: () => void;
}

/**
 * Window progress (status bar, no popup) while a baseline learns coverage. It ends with the run.
 * VS Code only draws a cancel button for notification progress, so the token is honoured where
 * offered; the status bar menu and Test Explorer's stop button always cancel the run.
 */
export class BaselineProgress {
    private session: Session | undefined;

    constructor(private readonly cancel: () => void) {}

    get active(): boolean { return !!this.session; }

    /** Report the baseline's progress; nothing happens without one (small incremental runs). */
    update(counts: BaselineCounts | undefined): void {
        if (!counts) {return;}
        const session = this.session ?? this.begin();
        const percent = counts.total ? Math.min(100, Math.floor(counts.completed * 100 / counts.total)) : 0;
        const message = `${percent}% · ${l10n.t('{0}/{1} files learned', counts.completed, counts.total)}`;
        if (percent === session.percent && message === session.message) {return;}
        const increment = Math.max(0, percent - session.percent);
        session.percent = Math.max(session.percent, percent); session.message = message;
        session.progress?.report({ message, ...increment ? { increment } : {} });
    }

    /** The baseline completed or the run ended. */
    end(): void {
        const session = this.session;
        this.session = undefined;
        if (!session) {return;}
        session.ended = true; session.finish?.();
    }

    private begin(): Session {
        const session: Session = { percent: 0, message: '', ended: false };
        this.session = session;
        void Promise.resolve(vscode.window.withProgress({
            location: vscode.ProgressLocation.Window, title: l10n.t('Testy: establishing baseline'), cancellable: true
        }, (progress, token) => new Promise<void>(resolve => {
            session.progress = progress; session.finish = resolve;
            if (session.ended) {resolve(); return;}
            token.onCancellationRequested(() => { if (!session.ended) {this.cancel();} });
            if (session.message) {progress.report({ message: session.message, increment: session.percent || undefined });}
        }))).catch(() => undefined);
        return session;
    }

    dispose(): void { this.end(); }
}
