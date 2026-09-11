const test = require('node:test'), assert = require('node:assert/strict');
const { setImmediate: turn } = require('node:timers/promises');
const { CoverageStore } = require('../../out/core/coverage');
const { contentHash } = require('../../out/core/paths');

const emptyDelta = () => ({ sources: [], traces: [], removedSources: [], removedTraces: [] });
const source = (file, hash = 'v1', lines = [1, 2]) => ({ id: contentHash(`${file}\0${hash}`), file, hash, lines });
const contribution = (source, hits = 1) => ({ file: source.file, hash: source.hash, lines: [{ line: 1, hits }] });
const trace = (groupId, sources, coverage = [], extra = {}) => ({ groupId, sourceIds: sources.map(source => source.id), coverage,
    dependencies: sources.map(source => source.file), moduleProjects: ['/Project.csproj'], inputs: {}, reliable: true, stale: false, timestamp: 1, ...extra });
const hashes = sources => new Map(sources.map(source => [source.file, source.hash]));

function facts(store, versions, dependencyFiles = [], projects = ['/Project.csproj']) {
    return { traces: [...store.traces], summaries: store.summarize(versions),
        dependencies: dependencyFiles.map(file => [file, [...store.dependentGroups([file])]]),
        projects: projects.map(project => [project, [...store.dependentProjects([project])]]) };
}
async function restored(sources, traces) {
    const actual = new CoverageStore(), expected = new CoverageStore();
    // The synchronous API retains the unchanged general installation path.
    expected.restorePacked(sources, traces, true);
    await actual.restorePackedAsync(sources, traces);
    assert.deepEqual(actual.takeDelta(), emptyDelta());
    assert.deepEqual(expected.takeDelta(), emptyDelta());
    return { actual, expected };
}

test('staged restore matches generic installation for zero owners, max hits and historical versions', async () => {
    const old = source('/Code.cs', 'old'), current = source('/Code.cs', 'current', [1, 3]);
    const zero = source('/Zero.cs'), unused = source('/Unused.cs');
    const sources = [old, current, zero, unused];
    const traces = [trace('old', [old, zero], [contribution(old, 8)], { historical: true }),
        trace('fresh', [current, zero], [contribution(current, 2)]),
        trace('other', [current], [contribution(current, 5)])];
    const { actual, expected } = await restored(sources, traces), versions = hashes(sources);
    assert.deepEqual(facts(actual, versions, sources.map(value => value.file)), facts(expected, versions, sources.map(value => value.file)));
    assert.deepEqual(actual.summary('/Code.cs', versions).lines, [{ line: 1, hits: 5 }, { line: 3, hits: 0 }]);
    assert.deepEqual(actual.summary('/Zero.cs', versions).groupIds, ['fresh', 'old']);
    assert.equal(actual.summary('/Zero.cs', versions).stale, true);
    assert.equal(actual.summary('/Unused.cs', versions), undefined);
    assert.ok([...actual.traces.values()].every(value => !value.reliable && value.stale));
    assert.equal(actual.traces.get('old').historical, true);
});

test('duplicate source IDs count one stale owner and later freshness/removal stays exact', async () => {
    const code = source('/Code.cs'), traces = [trace('one', [code, code, code]), trace('two', [code, code])];
    const { actual, expected } = await restored([code], traces), versions = hashes([code]);
    for (const store of [actual, expected]) { store.markStale(new Set(['one', 'two']), false); }
    assert.deepEqual(facts(actual, versions), facts(expected, versions));
    assert.equal(actual.summary(code.file, versions).stale, false, 'duplicate IDs cannot leave excess stale counts');
    assert.deepEqual(actual.summary(code.file, versions).groupIds, ['one', 'two']);
    for (const store of [actual, expected]) {
        store.markStale(new Set(['one'])); store.summarize(versions);
        store.replace([], new Set(['two']));
    }
    assert.deepEqual(facts(actual, versions), facts(expected, versions));
    assert.equal(actual.summary(code.file, versions).stale, false);
    assert.deepEqual(actual.summary(code.file, versions).groupIds, ['two']);
    assert.deepEqual(actual.takeDelta(), expected.takeDelta());
});

test('last valid duplicate group replaces indexes while an invalid later duplicate is skipped', async () => {
    const a = source('/A.cs'), b = source('/B.cs'), missing = source('/Missing.cs');
    const traces = [trace('same', [a], [contribution(a, 9)], { dependencies: ['/old'], moduleProjects: ['/Old.csproj'] }),
        trace('middle', [a]), trace('same', [b], [contribution(b, 3)], { dependencies: ['/new'], moduleProjects: ['/New.csproj'], timestamp: 2 }),
        trace('same', [b, missing], [contribution(b, 99)], { timestamp: 3 })];
    const { actual, expected } = await restored([a, b], traces), versions = hashes([a, b]);
    assert.deepEqual(facts(actual, versions, ['/old', '/new'], ['/Old.csproj', '/New.csproj']),
        facts(expected, versions, ['/old', '/new'], ['/Old.csproj', '/New.csproj']));
    assert.deepEqual([...actual.traces.keys()], ['same', 'middle']);
    assert.equal(actual.traces.get('same').timestamp, 2);
    assert.deepEqual(actual.summary(a.file, versions).lines, [{ line: 1, hits: 0 }, { line: 2, hits: 0 }]);
    assert.deepEqual([...actual.dependentGroups(['/old'])], []);
    assert.deepEqual([...actual.dependentProjects(['/New.csproj'])], ['same']);
});

test('duplicate geometry unions and duplicate contributions retain last-entry semantics', async () => {
    const a = source('/A.cs', 'v1', [1]), expanded = source('/A.cs', 'v1', [1, 3]), b = source('/B.cs');
    const traces = [trace('first', [a], [contribution(a, 9), contribution(a, 2), contribution(b, 4)]), trace('owner', [b])];
    const { actual, expected } = await restored([a, expanded, b], traces), versions = hashes([a, b]);
    assert.deepEqual(facts(actual, versions), facts(expected, versions));
    assert.deepEqual(actual.summary(a.file, versions).lines, [{ line: 1, hits: 2 }, { line: 3, hits: 0 }]);
    // The direct store API historically accepts this shape; disk validation is stricter.
    assert.deepEqual(actual.summary(b.file, versions).lines, [{ line: 1, hits: 4 }, { line: 2, hits: 0 }]);
    assert.deepEqual(actual.summary(b.file, versions).groupIds, ['owner']);
    for (const store of [actual, expected]) { store.retryDelta({ ...emptyDelta(), sources: [a, b] }); }
    assert.deepEqual(actual.takeDelta(), expected.takeDelta(), 'restored shared geometry is the same durable union');
});

test('fresh replacement and historical transitions preserve held restored snapshots', async () => {
    const a = source('/A.cs'), b = source('/B.cs'), versions = hashes([a, b]);
    const { actual, expected } = await restored([a, b], [trace('one', [a, b], [contribution(a, 4)]), trace('two', [a, b])]);
    const held = actual.summarize(versions), heldBytes = JSON.stringify(held);
    for (const store of [actual, expected]) {
        await store.replaceAsync([{ groupId: 'one', dependencies: ['/new'], moduleProjects: ['/New.csproj'], inputs: {}, reliable: true, timestamp: 9,
            coverage: [{ file: a.file, hash: a.hash, lines: [{ line: 1, hits: 0 }, { line: 2, hits: 0 }] }] }], new Set(['one', 'two']));
        store.markStale(new Set(['two']), false); store.markHistorical(new Set(['one']));
    }
    assert.deepEqual(facts(actual, versions, ['/new', b.file], ['/Project.csproj', '/New.csproj']),
        facts(expected, versions, ['/new', b.file], ['/Project.csproj', '/New.csproj']));
    assert.deepEqual(actual.takeDelta(), expected.takeDelta());
    assert.equal(JSON.stringify(held), heldBytes);
});

function wideFixture() {
    const sources = Array.from({ length: 700 }, (_, index) => source(`/Source${index}.cs`));
    return { sources, traces: Array.from({ length: 50 }, (_, index) => trace(`group${index}`, sources, [contribution(sources[index])])) };
}
test('cancelled staged membership work publishes neither partial indexes nor deltas', { timeout: 10000 }, async () => {
    const old = source('/Old.cs'), store = new CoverageStore();
    store.restorePacked([old], [trace('old', [old])], true);
    const versions = hashes([old]), held = store.summarize(versions), revision = store.revision;
    const fixture = wideFixture(), abort = new AbortController();
    const pending = store.restorePackedAsync(fixture.sources, fixture.traces, abort.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await turn(); await turn(); await turn(); await turn();
    assert.deepEqual([...store.traces.keys()], ['old']);
    abort.abort(); await rejected;
    assert.equal(store.revision, revision);
    assert.strictEqual(store.summarize(versions), held);
    assert.deepEqual(store.takeDelta(), emptyDelta());
    assert.deepEqual([...store.dependentGroups(['/Source0.cs'])], []);
    await store.restorePackedAsync(fixture.sources, fixture.traces);
    assert.equal(store.traces.size, fixture.traces.length, 'a cancelled attempt does not poison the next restore');
});

test('a live replacement supersedes a pending restore without changing its completed state', { timeout: 10000 }, async () => {
    const fixture = wideFixture(), store = new CoverageStore();
    const pending = store.restorePackedAsync(fixture.sources, fixture.traces);
    await turn(); await turn();
    store.replace([{ groupId: 'live', dependencies: ['/Live.cs'], reliable: true, timestamp: 1,
        coverage: [{ file: '/Live.cs', hash: 'live', lines: [{ line: 1, hits: 3 }] }] }], new Set(['live']));
    const versions = new Map([['/Live.cs', 'live']]), held = store.summarize(versions), delta = store.takeDelta(), revision = store.revision;
    await pending;
    assert.equal(store.revision, revision);
    assert.strictEqual(store.summarize(versions), held);
    assert.deepEqual([...store.traces.keys()], ['live']);
    assert.deepEqual([...store.dependentGroups(['/Live.cs'])], ['live']);
    assert.deepEqual(store.takeDelta(), emptyDelta());
    assert.equal(delta.traces[0].groupId, 'live');
});
