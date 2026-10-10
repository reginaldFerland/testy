import * as vscode from 'vscode';
import * as path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { BuildDiagnostic } from '../core/diagnostics';
import { TestFile, TestResult } from '../core/model';
import { isInside, normalizePath } from '../core/paths';
import { traitsSignature, traitTagIds } from '../core/traits';
import { failingFrame, parseStackTrace } from '../core/stackTrace';
import { Selection } from '../core/selection';
import { RunScope, TestEngine } from '../services/engine';
import { projectCoverageId } from '../services/runner';
import { explainSelection } from './selectionCause';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;
const testTags = new Map<string, vscode.TestTag>();

function setTags(item: vscode.TestItem, ids: readonly string[]): void {
    if (item.tags.length === ids.length && item.tags.every((tag, index) => tag.id === ids[index])) {return;}
    item.tags = ids.map(id => {
        let tag = testTags.get(id);
        if (!tag) {tag = new vscode.TestTag(id); testTags.set(id, tag);}
        return tag;
    });
}

type TestIds = ReadonlyMap<string, { group: string; test: string }>;

/** Translate Test Explorer items into an engine selection. */
function scopeOf(testIds: TestIds, items: readonly vscode.TestItem[] | undefined, all = false): RunScope {
    const groups = new Set<string>(), projects = new Set<string>(), tests = new Map<string, Set<string>>();
    for (const item of items ?? []) {
        const identity = testIds.get(item.id);
        if (identity) {
            const ids = tests.get(identity.group) ?? new Set<string>(); ids.add(identity.test); tests.set(identity.group, ids); groups.add(identity.group);
        } else if (item.id.startsWith('project:')) {projects.add(item.id.slice('project:'.length));}
        else if (item.id.startsWith('file:')) {groups.add(item.id.slice('file:'.length));}
    }
    // Container selection wins when VS Code also includes a child.
    for (const item of items ?? []) {if (item.id.startsWith('file:')) {tests.delete(item.id.slice('file:'.length));}}
    return { all, projects, groups, tests };
}

export function requestScope(testIds: TestIds, request: vscode.TestRunRequest): RunScope {
    return { ...scopeOf(testIds, request.include, !request.include), exclude: request.exclude?.length ? scopeOf(testIds, request.exclude) : undefined };
}

/** A failure with an assertion diff, clickable stack frames, and the failing workspace line as its location. */
export function failureMessage(result: TestResult, item: vscode.TestItem, roots: readonly string[]): vscode.TestMessage {
    const frames = parseStackTrace(result.stack);
    const text = result.message ?? l10n.t('The test did not complete successfully.');
    // Without parsed frames, the raw stack remains part of the message.
    const body = frames.length ? text : [text, result.stack].filter(Boolean).join('\n\n');
    const message = result.expected !== undefined && result.actual !== undefined
        ? vscode.TestMessage.diff(body, result.expected, result.actual) : new vscode.TestMessage(body);
    // The `testing/message/context` menu matches `testMessage == testy.failure`.
    message.contextValue = 'testy.failure';
    if (frames.length) {
        message.stackTrace = frames.map(frame => new vscode.TestMessageStackFrame(frame.label,
            frame.file ? vscode.Uri.file(frame.file) : undefined, frame.line ? new vscode.Position(frame.line - 1, 0) : undefined));
    }
    const failing = failingFrame(frames, file => roots.some(root => isInside(normalizePath(file), root)));
    if (failing?.file && failing.line) {message.location = new vscode.Location(vscode.Uri.file(failing.file), new vscode.Position(failing.line - 1, 0));}
    else if (item.uri && item.range) {message.location = new vscode.Location(item.uri, item.range);}
    return message;
}

/** What the tree needs from the extension that owns it. */
export interface TreeHost {
    readonly disposed: boolean;
    readonly activeRun: vscode.TestRun | undefined;
    readonly roots: readonly string[];
    updateStatus(): void;
}

/** Presents discovered tests and their results in Test Explorer. */
export class TestTree {
    readonly items = new Map<string, vscode.TestItem>();
    readonly testIds = new Map<string, { group: string; test: string }>();
    readonly outcomes = new Map<string, string>();
    passed = 0;
    failed = 0;
    private readonly treeFiles = new Map<string, { tests: TestFile['tests']; ids: Set<string>; dirty?: boolean }>();
    private readonly treeProjects = new Map<string, readonly string[]>();
    private treeRoots: readonly string[] = [];
    /** Project items currently showing a build failure. */
    private readonly buildFailures = new Set<string>();
    /** File items showing a selection cause, with the description to restore. */
    private readonly described = new Map<vscode.TestItem, string | undefined>();

    constructor(private readonly controller: vscode.TestController, private readonly engine: TestEngine, private readonly host: TreeHost) {}

    setOutcome(id: string, outcome?: string): void {
        const previous = this.outcomes.get(id);
        if (previous === 'passed') {this.passed--;}
        if (previous === 'failed' || previous === 'errored') {this.failed--;}
        if (outcome) {this.outcomes.set(id, outcome);} else {this.outcomes.delete(id);}
        if (outcome === 'passed') {this.passed++;}
        if (outcome === 'failed' || outcome === 'errored') {this.failed++;}
    }

    item(id: string, label: string, file?: string): vscode.TestItem {
        const existing = this.items.get(id);
        if (existing && (existing.uri ? file !== undefined && path.normalize(existing.uri.fsPath) === path.normalize(file) : file === undefined)) {
            if (existing.label !== label) {existing.label = label;} return existing;
        }
        const item = this.controller.createTestItem(id, label, file ? vscode.Uri.file(file) : undefined);
        this.items.set(id, item); return item;
    }

    /** Mark the selected tests as pending. The resolved selection is authoritative:
     * expanding it with remembered runtime rows would clear unselected failures. */
    select(groups: readonly TestFile[]): void {
        const invalidated: vscode.TestItem[] = [];
        for (const group of groups) {for (const test of group.tests) {
            const item = this.items.get(`${group.id}:${test.id}`);
            if (item) {invalidated.push(item); this.setOutcome(item.id); this.host.activeRun?.enqueued(item);}
        }}
        this.controller.invalidateTestResults(invalidated);
    }

    /** Announce why each selected file runs: in the run output, on the file item while the run is active, and in the returned log lines. */
    explain(selection: Selection): readonly string[] {
        const { explanations, lines } = explainSelection(selection);
        const run = this.host.activeRun;
        for (const { group, text } of explanations) {
            const item = this.items.get(`file:${group.id}`);
            if (!item) {continue;}
            if (!this.described.has(item)) {this.described.set(item, item.description);}
            if (item.description !== text) {item.description = text;}
        }
        // A line per file, attached to the file's item where one exists.
        for (const { text, group } of lines) {run?.appendOutput(`${text}\r\n`, undefined, group ? this.items.get(`file:${group.id}`) : undefined);}
        return lines.map(line => line.text);
    }

    /** Put back the descriptions that `explain` replaced for the run. */
    restoreDescriptions(): void {
        // Assigning undefined clears a description; the API typings omit undefined under exactOptionalPropertyTypes.
        for (const [item, description] of this.described) {if (item.description !== description) {Object.assign(item, { description });}}
        this.described.clear();
    }

    started(group: TestFile, id: string): void {
        const item = this.items.get(`${group.id}:${id}`);
        if (item) {this.host.activeRun?.started(item);}
    }

    /** Publishes the discovered groups; resolves to each coverage contribution's tree item, or nothing when disposed meanwhile. */
    async update(groups: readonly TestFile[]): Promise<ReadonlyMap<string, string> | undefined> {
        const projectCounts = new Map<string, number>(), live = new Set<string>();
        const projects = new Map<string, vscode.TestItem[]>();
        const owners = new Map<string, string>();
        let work = 0;
        const ordered = [...groups].sort((a, b) => a.project.localeCompare(b.project) || (a.file ?? '').localeCompare(b.file ?? '') || a.framework.localeCompare(b.framework));
        for (const group of ordered) {
            if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            const tests = this.engine.knownTests(group), previous = this.treeFiles.get(group.id);
            projectCounts.set(group.project, (projectCounts.get(group.project) ?? 0) + tests.length);
            const projectId = `project:${group.project}`, projectName = path.basename(group.project, '.csproj');
            const projectTag = `project:${projectName}`, tags = [projectTag, `framework:${group.framework}`];
            setTags(this.item(projectId, projectName, group.project), [projectTag]);
            live.add(group.id);
            owners.set(group.id, `file:${group.id}`); owners.set(projectCoverageId(group), projectId);
            const files = projects.get(projectId) ?? [];
            const file = this.item(`file:${group.id}`, `${path.basename(group.file ?? (group.runtimeOnly ? l10n.t('Unmapped runtime tests') : l10n.t('Other tests')))} · ${group.framework}`, group.file);
            setTags(file, tags);
            files.push(file); projects.set(projectId, files);
            let same = !previous?.dirty && previous?.tests.length === tests.length;
            // same implies both lists have tests.length entries.
            if (same && previous!.tests !== tests) {for (let index = 0; index < tests.length; index++) {
                const a = previous!.tests[index]!, b = tests[index]!;
                if (a.id !== b.id || a.name !== b.name || a.file !== b.file || a.line !== b.line || a.endLine !== b.endLine || (a.traits !== b.traits && traitsSignature(a.traits) !== traitsSignature(b.traits))) {same = false; break;}
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }}
            if (same) {this.treeFiles.set(group.id, { tests, ids: previous!.ids }); continue;}
            const children: vscode.TestItem[] = [], ids = new Set<string>();
            for (const test of tests) {
                const id = `${group.id}:${test.id}`, item = this.item(id, test.name, test.file);
                // Span the declaration when the provider reports its end; otherwise the whole first line.
                const start = Math.max(0, test.line - 1);
                item.range = test.file ? new vscode.Range(start, 0, Math.max(start + 1, test.endLine ?? 0), 0) : undefined;
                setTags(item, test.traits ? [...tags, ...traitTagIds(test.traits)] : tags);
                ids.add(id); this.testIds.set(id, { group: group.id, test: test.id }); children.push(item);
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }
            file.children.replace(children);
            for (const id of previous?.ids ?? []) {if (!ids.has(id)) {
                this.testIds.delete(id); this.items.delete(id); this.setOutcome(id);
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }}
            this.treeFiles.set(group.id, { tests, ids });
        }
        for (const [group, previous] of this.treeFiles) {if (!live.has(group)) {
            for (const id of previous.ids) {
                this.testIds.delete(id); this.items.delete(id); this.setOutcome(id);
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }
            this.items.delete(`file:${group}`); this.treeFiles.delete(group);
        }}
        const sameIds = (previous: readonly string[] | undefined, next: readonly string[]): boolean => !!previous && previous.length === next.length && previous.every((id, index) => id === next[index]);
        for (const [id, files] of projects) {
            const project = this.items.get(id)!, ids = files.map(file => file.id);
            const description = l10n.t('{0} tests', projectCounts.get(id.slice('project:'.length)) ?? 0);
            if (project.description !== description) {project.description = description;}
            if (!sameIds(this.treeProjects.get(id), ids)) {project.children.replace(files); this.treeProjects.set(id, ids);}
        }
        for (const id of this.treeProjects.keys()) {if (!projects.has(id)) {this.treeProjects.delete(id); this.items.delete(id);}}
        const roots = [...projects.keys()];
        if (!sameIds(this.treeRoots, roots)) {this.controller.items.replace(roots.map(id => this.items.get(id)!)); this.treeRoots = roots;}
        return owners;
    }

    publishResult(group: TestFile, result: TestResult): void {
        if (this.host.disposed) {return;}
        if (group.runtimeOnly && !this.treeFiles.has(group.id)) {
            const file = this.item(`file:${group.id}`, `${l10n.t('Unmapped runtime tests')} · ${group.framework}`);
            this.items.get(`project:${group.project}`)?.children.add(file);
            this.treeFiles.set(group.id, { tests: [], ids: new Set(), dirty: true });
        }
        const id = `${group.id}:${result.id}`;
        this.testIds.set(id, { group: group.id, test: result.id });
        const file = this.treeFiles.get(group.id);
        if (file && !file.ids.has(id)) {file.ids.add(id); file.dirty = true;}
        let item = this.items.get(id);
        if (!item) {
            item = this.item(id, result.name, group.file);
            this.items.get(`file:${group.id}`)?.children.add(item);
        }
        this.setOutcome(id, result.outcome);
        const run = this.host.activeRun;
        if (result.outcome === 'passed') {run?.passed(item, result.duration);}
        else if (result.outcome === 'skipped') {run?.skipped(item);}
        else {
            const message = failureMessage(result, item, this.host.roots);
            if (result.outcome === 'failed') {run?.failed(item, message, result.duration);}
            else {run?.errored(item, message, result.duration);}
        }
        if (result.output) {run?.appendOutput(result.output.replace(/\r?\n/g, '\r\n'), undefined, item);}
        this.host.updateStatus();
    }

    /** Mark the projects of a failed build in Test Explorer; errors without a known project mark every project. */
    showBuildFailures(diagnostics: Iterable<BuildDiagnostic>, fallback: string): void {
        const projects = new Map<string, vscode.TestItem>();
        for (const id of this.treeProjects.keys()) {
            const item = this.items.get(id);
            if (item) {projects.set(normalizePath(id.slice('project:'.length)), item);}
        }
        const owned = new Map<vscode.TestItem, BuildDiagnostic[]>(), unowned: BuildDiagnostic[] = [];
        for (const diagnostic of diagnostics) {
            if (diagnostic.severity !== 'error') {continue;}
            const item = diagnostic.project ? projects.get(normalizePath(diagnostic.project)) : undefined;
            if (!item) {unowned.push(diagnostic); continue;}
            const list = owned.get(item) ?? []; list.push(diagnostic); owned.set(item, list);
        }
        this.clearBuildFailures();
        for (const item of projects.values()) {
            const errors = [...owned.get(item) ?? [], ...unowned];
            if (!errors.length && owned.size) {continue;}
            const lines = errors.length ? errors.map(error => `${path.basename(error.file)}(${error.line},${error.column}): ${error.code}: ${error.message}`) : [fallback];
            const message = new vscode.MarkdownString(`**${l10n.t('Build failed')}**`);
            message.appendCodeblock(lines.slice(0, 10).join('\n'), 'text');
            if (lines.length > 10) {message.appendText(l10n.t('…and {0} more', lines.length - 10));}
            message.appendMarkdown(`\n\n[${l10n.t('Show Output')}](command:testy.showOutput)`);
            message.isTrusted = { enabledCommands: ['testy.showOutput'] };
            item.error = message; this.buildFailures.add(item.id);
        }
    }

    clearBuildFailures(): void {
        for (const id of this.buildFailures) {const item = this.items.get(id); if (item) {item.error = undefined;}}
        this.buildFailures.clear();
    }
}
