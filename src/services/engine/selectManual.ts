import { TestFile } from '../../core/model';
import { testTargetKey } from '../../core/paths';
import { discoveredTest } from '../mtp';
import type { ManualSelection } from './types';

export function selectManual(groups: readonly TestFile[], manual: ManualSelection, known: (group: TestFile) => readonly ReturnType<typeof discoveredTest>[] = group => group.tests): readonly TestFile[] {
    const matches = (scope: ManualSelection, group: TestFile): boolean => !!scope.all || !!scope.projects?.has(group.project) || scope.groups.has(group.id);
    const projectExclusions = new Map<string, Set<string>>();
    const unmappedExclusions = new Map<string, Set<string>>();
    if (manual.exclude) {for (const group of groups) {
        const excluded = manual.exclude;
        if (!matches(excluded, group)) {continue;}
        const key = testTargetKey(group.project, group.framework), ids = projectExclusions.get(key) ?? new Set<string>();
        const tests = excluded.all || excluded.projects?.has(group.project) || !excluded.tests?.has(group.id)
            ? known(group).map(test => test.id) : excluded.tests.get(group.id)!;
        for (const id of tests) {ids.add(id);} projectExclusions.set(key, ids);
        if (group.runtimeOnly) {unmappedExclusions.set(key, new Set(tests));}
    }}
    // Project/container runs already select the discovered parents. Repeating a
    // synthetic runtime container would execute that project a second time.
    return groups.filter(group => matches(manual, group) && (!group.runtimeOnly || (!manual.all && !manual.projects?.has(group.project)))).map(group => {
        const entire = manual.all || manual.projects?.has(group.project) || !manual.tests?.has(group.id);
        const requested = manual.tests?.get(group.id), excluded = manual.exclude;
        const excludesGroup = excluded && matches(excluded, group);
        const excludedTests = excluded?.tests?.get(group.id);
        const excludesEntire = excludesGroup && (excluded.all || excluded.projects?.has(group.project) || !excludedTests);
        const available = known(group);
        const key = testTargetKey(group.project, group.framework);
        return { ...group, excludedTestIds: group.runtimeOnly ? [...projectExclusions.get(key) ?? []]
            : [...(excludesGroup ? excludedTests ?? [] : []), ...unmappedExclusions.get(key) ?? []],
            tests: available.filter(test => !excludesEntire && (entire || requested?.has(test.id)) && (!excludesGroup || !excludedTests?.has(test.id))) };
    }).filter(group => group.tests.length);
}
