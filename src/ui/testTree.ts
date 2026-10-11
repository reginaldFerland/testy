import * as vscode from 'vscode';
import * as path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { BuildDiagnostic } from '../core/diagnostics';
import { TestFile, TestResult } from '../core/model';
import { displayPath, isInside, lowercaseKeys, normalizePath, resolveDisplayPaths } from '../core/paths';
import { testType, typeLabel } from '../core/testUpdates';
import { traitsSignature, traitTagIds } from '../core/traits';
import { failingFrame, mapDeterministicPath, parseStackTrace } from '../core/stackTrace';
import { Selection } from '../core/selection';
import { RunScope, TestEngine } from '../services/engine';
import { projectCoverageId } from '../core/coverage';
import { explainSelection } from './selectionCause';
import { countOutcome, FileOutcome } from './inlineStatus';

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
    const add = (identity: { group: string; test: string }): void => {
        const ids = tests.get(identity.group) ?? new Set<string>(); ids.add(identity.test); tests.set(identity.group, ids); groups.add(identity.group);
    };
    for (const item of items ?? []) {
        const identity = testIds.get(item.id);
        if (identity) {add(identity);}
        else if (item.id.startsWith('class:')) {item.children.forEach(child => {const test = testIds.get(child.id); if (test) {add(test);}});}
        else if (item.id.startsWith('project:')) {projects.add(item.id.slice('project:'.length));}
        else if (item.id.startsWith('file:')) {groups.add(item.id.slice('file:'.length));}
    }
    // Container selection wins when VS Code also includes a child.
    for (const item of items ?? []) {if (item.id.startsWith('file:')) {tests.delete(item.id.slice('file:'.length));}}
    return { all, projects, groups, tests };
}

export function requestScope(testIds: TestIds, request: vscode.TestRunRequest): RunScope {
    return { ...scopeOf(testIds, request.include, !request.include), exclude: request.exclude?.length ? scopeOf(testIds, request.exclude) : undefined };
}

/** Sorts after every file name in Test Explorer. */
const lastSortText = (label: string): string => `\uffff${label}`;

/** A failure with an assertion diff, clickable stack frames, and the failing workspace line as its location.
 * `named` lists known files by lowercase file name, so deterministic `/_/` paths link to the workspace file they stand for. */
export function failureMessage(result: TestResult, item: vscode.TestItem, roots: readonly string[], named?: (name: string) => readonly string[]): vscode.TestMessage {
    const frames = parseStackTrace(result.stack).map(frame => {
        const file = frame.file && named ? mapDeterministicPath(frame.file, named) : undefined;
        return file ? { ...frame, file: displayPath(file) } : frame;
    });
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
    // Frames are checked as reported first; normalizing (which reads the file system) is only the fallback for aliased spellings.
    const inside = (file: string): boolean => roots.some(root => isInside(file, root));
    const failing = failingFrame(frames, inside) ?? failingFrame(frames, file => inside(normalizePath(file)));
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
    /** Outcome counts per test file, kept current with `outcomes`; `outcomeRevision` changes with them. */
    readonly fileOutcomes = new Map<string, FileOutcome>();
    outcomeRevision = 0;
    passed = 0;
    failed = 0;
    /** Outcomes adopted from a previous session that this one has not reported again. */
    private restored: Set<string> | undefined;
    private readonly treeFiles = new Map<string, { tests: TestFile['tests']; ids: Set<string>; classes: Set<string>; dirty?: boolean }>();
    private readonly treeProjects = new Map<string, readonly string[]>();
    private treeRoots: readonly string[] = [];
    /** Project items currently showing a build failure. */
    private readonly buildFailures = new Set<string>();
    /** File items showing a selection cause, with the description to restore. */
    private readonly described = new Map<vscode.TestItem, string | undefined>();
    /** Known source files by lowercase file name, for deterministic stack-frame paths; rebuilt when the sources change. */
    private sourceNames: { hashes: ReadonlyMap<string, string>; size: number; names: Map<string, string[]> } | undefined;

    constructor(private readonly controller: vscode.TestController, private readonly engine: TestEngine, private readonly host: TreeHost) {}

    /** Marks the project items busy while tests are rediscovered. */
    setBusy(busy: boolean): void {
        for (const id of this.treeRoots) {const item = this.items.get(id); if (item && item.busy !== busy) {item.busy = busy;}}
    }

    /** Known source files by lowercase file name, for deterministic stack-frame paths. */
    namedSources(name: string): readonly string[] {
        const hashes = this.engine.hashes;
        if (this.sourceNames?.hashes !== hashes || this.sourceNames.size !== hashes.size) {
            const names = new Map<string, string[]>();
            for (const file of hashes.keys()) {const key = path.basename(file).toLowerCase(), list = names.get(key); if (list) {list.push(file);} else {names.set(key, [file]);}}
            this.sourceNames = { hashes, size: hashes.size, names };
        }
        return this.sourceNames.names.get(name) ?? [];
    }

    setOutcome(id: string, outcome?: string): void {
        const previous = this.outcomes.get(id);
        if (previous === 'passed') {this.passed--;}
        if (previous === 'failed' || previous === 'errored') {this.failed--;}
        if (outcome) {this.outcomes.set(id, outcome);} else {this.outcomes.delete(id);}
        if (outcome === 'passed') {this.passed++;}
        if (outcome === 'failed' || outcome === 'errored') {this.failed++;}
        if (countOutcome(this.fileOutcomes, id, previous, outcome)) {this.outcomeRevision++;}
    }

    /** The failing tests of a test file, by tree item. */
    failingTests(groupId: string): vscode.TestItem[] {
        return [...this.treeFiles.get(groupId)?.ids ?? []].filter(id => {const outcome = this.outcomes.get(id); return outcome === 'failed' || outcome === 'errored';})
            .flatMap(id => this.items.get(id) ?? []);
    }

    /** Count the outcomes the engine restored, so the status matches the previous session before anything runs. */
    restore(outcomes: ReadonlyMap<string, string>): void {
        for (const [id, outcome] of outcomes) {if (!this.outcomes.has(id)) {this.setOutcome(id, outcome); (this.restored ??= new Set()).add(id);}}
    }

    /** `file` is a canonical path; the item shows its on-disk spelling. */
    item(id: string, label: string, file?: string): vscode.TestItem {
        const existing = this.items.get(id), shown = file === undefined ? undefined : displayPath(file);
        if (existing && (existing.uri ? shown !== undefined && path.normalize(existing.uri.fsPath) === path.normalize(shown) : shown === undefined)) {
            if (existing.label !== label) {existing.label = label;} return existing;
        }
        const item = this.controller.createTestItem(id, label, shown ? vscode.Uri.file(shown) : undefined);
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
            if (lowercaseKeys()) {await resolveDisplayPaths([group.project, ...group.file ? [group.file] : [], ...new Set(tests.map(test => test.file).filter(file => file && file !== group.file) as string[])]); if (this.host.disposed) {return;}}
            const projectId = `project:${group.project}`, projectName = path.basename(displayPath(group.project), '.csproj');
            const projectTag = `project:${projectName}`, tags = [projectTag, `framework:${group.framework}`];
            setTags(this.item(projectId, projectName, group.project), [projectTag]);
            live.add(group.id);
            owners.set(group.id, `file:${group.id}`); owners.set(projectCoverageId(group), projectId);
            const files = projects.get(projectId) ?? [];
            const file = this.item(`file:${group.id}`, `${path.basename(group.file ? displayPath(group.file) : group.runtimeOnly ? l10n.t('Unmapped runtime tests') : l10n.t('Other tests'))} · ${group.framework}`, group.file);
            setTags(file, tags);
            const sortText = group.file ? undefined : lastSortText(file.label);
            if (file.sortText !== sortText) {Object.assign(file, { sortText });}
            files.push(file); projects.set(projectId, files);
            let same = !previous?.dirty && previous?.tests.length === tests.length;
            // same implies both lists have tests.length entries.
            if (same && previous!.tests !== tests) {for (let index = 0; index < tests.length; index++) {
                const a = previous!.tests[index]!, b = tests[index]!;
                if (a.id !== b.id || a.name !== b.name || a.file !== b.file || a.line !== b.line || testType(a.node) !== testType(b.node) || a.endLine !== b.endLine || (a.traits !== b.traits && traitsSignature(a.traits) !== traitsSignature(b.traits))) {same = false; break;}
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }}
            if (same) {this.treeFiles.set(group.id, { tests, ids: previous!.ids, classes: previous!.classes }); continue;}
            const children: vscode.TestItem[] = [], ids = new Set<string>(), classes = new Map<string, { item: vscode.TestItem; members: vscode.TestItem[]; file: string | undefined; span?: { first: number; last: number } }>();
            for (const test of tests) {
                const id = `${group.id}:${test.id}`, type = testType(test.node);
                let owner = file;
                if (type !== undefined) {
                    let entry = classes.get(type);
                    if (!entry) {
                        const item = this.item(`class:${group.id}:${type}`, typeLabel(type), test.file);
                        setTags(item, tags); entry = { item, members: [], file: test.file }; classes.set(type, entry); children.push(item);
                    }
                    owner = entry.item;
                    if (test.file && test.file === entry.file) {
                        const first = Math.max(0, test.line - 1), last = Math.max(first + 1, test.endLine ?? 0);
                        entry.span = entry.span ? { first: Math.min(entry.span.first, first), last: Math.max(entry.span.last, last) } : { first, last };
                    }
                }
                let item = this.item(id, test.name, test.file);
                // A test moving between the file and a class gets a fresh item; the old one leaves with its parent's replacement.
                if (item.parent && item.parent !== owner) {this.items.delete(id); item = this.item(id, test.name, test.file);}
                // Span the declaration when the provider reports its end; otherwise the whole first line.
                const start = Math.max(0, test.line - 1);
                item.range = test.file ? new vscode.Range(start, 0, Math.max(start + 1, test.endLine ?? 0), 0) : undefined;
                setTags(item, test.traits ? [...tags, ...traitTagIds(test.traits)] : tags);
                ids.add(id); this.testIds.set(id, { group: group.id, test: test.id }); if (owner === file) {children.push(item);} else {classes.get(type!)!.members.push(item);}
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }
            const classIds = new Set<string>();
            for (const [type, { item, members, span }] of classes) {
                item.children.replace(members); classIds.add(`class:${group.id}:${type}`);
                // MTP reports method locations only: a class spans its tests in the class item's file, for its gutter glyph and Go to Test.
                item.range = span ? new vscode.Range(span.first, 0, span.last, 0) : undefined;
            }
            file.children.replace(children);
            for (const id of previous?.classes ?? []) {if (!classIds.has(id)) {this.items.delete(id);}}
            for (const id of previous?.ids ?? []) {if (!ids.has(id)) {
                this.testIds.delete(id); this.items.delete(id); this.setOutcome(id);
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }}
            this.treeFiles.set(group.id, { tests, ids, classes: classIds });
        }
        for (const [group, previous] of this.treeFiles) {if (!live.has(group)) {
            for (const id of previous.ids) {
                this.testIds.delete(id); this.items.delete(id); this.setOutcome(id);
                if (++work % 512 === 0) {await yieldTurn(); if (this.host.disposed) {return;}}
            }
            for (const id of previous.classes) {this.items.delete(id);}
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
        // A restored outcome may have no item yet; once the engine forgets it, its test no longer exists.
        for (const id of this.restored ?? []) {if (!this.engine.outcomes.has(id)) {this.restored!.delete(id); if (this.outcomes.has(id)) {this.setOutcome(id);}}}
        const roots = [...projects.keys()];
        if (!sameIds(this.treeRoots, roots)) {this.controller.items.replace(roots.map(id => this.items.get(id)!)); this.treeRoots = roots;}
        return owners;
    }

    publishResult(group: TestFile, result: TestResult): void {
        if (this.host.disposed) {return;}
        if (group.runtimeOnly && !this.treeFiles.has(group.id)) {
            const file = this.item(`file:${group.id}`, `${l10n.t('Unmapped runtime tests')} · ${group.framework}`);
            file.sortText = lastSortText(file.label);
            this.items.get(`project:${group.project}`)?.children.add(file);
            this.treeFiles.set(group.id, { tests: [], ids: new Set(), classes: new Set(), dirty: true });
        }
        const id = `${group.id}:${result.id}`;
        this.testIds.set(id, { group: group.id, test: result.id });
        const file = this.treeFiles.get(group.id);
        if (file && !file.ids.has(id)) {file.ids.add(id); file.dirty = true;}
        let item = this.items.get(id);
        if (!item) {
            item = this.item(id, result.name, group.file);
            let parent = this.items.get(`file:${group.id}`);
            const type = testType(result.node);
            if (parent && type !== undefined) {
                const classId = `class:${group.id}:${type}`;
                let owner = this.items.get(classId);
                if (!owner) {
                    owner = this.item(classId, typeLabel(type), group.file); setTags(owner, parent.tags.map(tag => tag.id));
                    parent.children.add(owner); file?.classes.add(classId); if (file) {file.dirty = true;}
                }
                parent = owner;
            }
            parent?.children.add(item);
        }
        this.setOutcome(id, result.outcome); this.restored?.delete(id);
        const run = this.host.activeRun;
        if (result.outcome === 'passed') {run?.passed(item, result.duration);}
        else if (result.outcome === 'skipped') {run?.skipped(item);}
        else {
            const message = failureMessage(result, item, this.host.roots, name => this.namedSources(name));
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
