import { randomUUID } from 'node:crypto';
import { EngineConfiguration } from '../../core/model';
import { environmentIdentity } from '../../core/environment';
import { contentHash } from '../../core/paths';
import { extensionVersion, helperPath } from '../assets';
import { coverageToolVersion } from '../coverageTool';
import { fileIdentity } from '../preparationTools';

/** Bump when what a trace records, or how selection reads it, changes in a way the other inputs below do not show. */
const traceSemantics = 1;

/** The settings coverage is learned under: the workspace folders, build configuration, run mode, collection, .NET host, test
 * arguments, exclusions, coverage tool and entry-point filters. Changing any of them makes the engine start a new baseline. */
export function settingsIdentity(config: EngineConfiguration, roots: readonly string[]): string {
    return contentHash(JSON.stringify([roots, config.configuration, config.mode, config.coverage, config.dotnet, config.testArguments, config.excludes,
        config.coverageTool ?? null, config.solution ?? null, config.solutions ?? null, config.projects ?? null]));
}

/** What a saved trace must have been learned under to narrow selections after a restart: the settings, Testy's version, the
 * environment (MSBuild reads its variables as properties; launch-specific ones are left out, see environmentIdentity), and the
 * bytes of the tools that produced its coverage and dependencies (the collector and the runtime observer). A tool that cannot be
 * read yields an identity nothing else matches, so nothing learned with it is trusted later. The SDK and evaluation tools are
 * known only after evaluation; the checkpoint compares them instead (see TestEngine.restore). */
export async function coverageIdentity(config: EngineConfiguration, roots: readonly string[], tools: Map<string, Promise<string>>, signal?: AbortSignal): Promise<string> {
    const identity = (file: string): Promise<string> => fileIdentity(file, signal, tools).catch(() => {signal?.throwIfAborted(); return `unavailable:${randomUUID()}`;});
    const collector = !config.coverage ? 'none' : config.coverageTool ? await identity(config.coverageTool) : `dotnet-coverage@${coverageToolVersion}`;
    return contentHash(JSON.stringify([traceSemantics, settingsIdentity(config, roots), extensionVersion(), collector,
        await identity(helperPath('observer', 'Testy.RuntimeObserver.dll')), environmentIdentity(process.env)]));
}
