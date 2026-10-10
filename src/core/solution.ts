import * as path from 'node:path';

/** Projects listed by a solution, solution filter or XML solution, as absolute paths. */
export interface SolutionProjects {
    readonly projects: readonly string[];
    /** A filter's underlying solution, which must also be watched. */
    readonly solution?: string;
}

const resolve = (directory: string, file: string): string => path.resolve(directory, file.replace(/[\\/]/g, path.sep));
const isProject = (file: string): boolean => /\.(cs|fs|vb)proj$/i.test(file) || /\.proj$/i.test(file);
const decodeXml = (value: string): string => value.replace(/&(lt|gt|quot|apos|amp);/g, (_match, name: string) =>
    ({ lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' })[name]!);

/** Classic `.sln`: `Project("{type}") = "Name", "relative\path.csproj", "{guid}"`. Solution folders are skipped. */
export function parseSln(content: string, directory: string): SolutionProjects {
    const projects: string[] = [];
    for (const match of content.matchAll(/^\s*Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"/gm)) {
        const [, file] = match;
        if (file && isProject(file)) {projects.push(resolve(directory, file));}
    }
    return { projects };
}

/** XML `.slnx`: `<Project Path="relative/path.csproj" />`, possibly nested in folders. */
export function parseSlnx(content: string, directory: string): SolutionProjects {
    const projects: string[] = [];
    for (const match of content.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<Project\b[^>]*?\bPath\s*=\s*(["'])(.*?)\1/g)) {
        const file = decodeXml(match[2] ?? '');
        if (isProject(file)) {projects.push(resolve(directory, file));}
    }
    return { projects };
}

/** `.slnf` JSON: projects are relative to the referenced solution's directory. */
export function parseSlnf(content: string, directory: string): SolutionProjects {
    const parsed = JSON.parse(content.replace(/^﻿/, '')) as { solution?: { path?: unknown; projects?: unknown } };
    const solutionPath = parsed.solution?.path, projects = parsed.solution?.projects;
    if (typeof solutionPath !== 'string' || !Array.isArray(projects) || !projects.every(project => typeof project === 'string')) {
        throw new Error('The solution filter must contain solution.path and a solution.projects array.');
    }
    const solution = resolve(directory, solutionPath), base = path.dirname(solution);
    return { solution, projects: (projects).filter(isProject).map(project => resolve(base, project)) };
}

export function parseSolution(file: string, content: string): SolutionProjects {
    const directory = path.dirname(file);
    if (/\.slnf$/i.test(file)) {return parseSlnf(content, directory);}
    if (/\.slnx$/i.test(file)) {return parseSlnx(content, directory);}
    if (/\.sln$/i.test(file)) {return parseSln(content, directory);}
    throw new Error(`${path.basename(file)} is not a .sln, .slnx or .slnf file.`);
}
