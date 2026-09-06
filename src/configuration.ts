import * as vscode from 'vscode';
import { EngineConfiguration } from './services/engine';
import { defaultExcludes } from './core/paths';

export interface Configuration extends EngineConfiguration {
    readonly enabled: boolean;
    readonly trigger: 'save' | 'fileSystem';
    readonly debounce: number;
    readonly pattern: string;
    readonly showCoverage: boolean;
}

export function configuration(): Configuration {
    const settings = vscode.workspace.getConfiguration('testy');
    const args = settings.get<string[]>('testArguments', []);
    return {
        enabled: settings.get('autoRun', true), trigger: settings.get('trigger', 'save'),
        debounce: Math.max(0, settings.get('debounceTime', 500)),
        pattern: settings.get('fileWatcherPattern', '**/*.{cs,csproj,sln,slnx,props,targets,runsettings,json,config,resx,editorconfig,globalconfig,ruleset}'),
        showCoverage: settings.get('showCoverage', true),
        dotnet: settings.get('dotnetPath', 'dotnet'), configuration: settings.get('buildConfiguration', 'Debug'),
        mode: settings.get('runMode', 'affected'), coverage: settings.get('runWithCoverage', true),
        excludes: [...defaultExcludes, ...settings.get<string[]>('exclude', [])],
        testArguments: args, timeout: Math.max(10, settings.get('timeoutSeconds', 600)) * 1000,
        coverageTool: settings.get<string>('coverageToolPath') || undefined
    };
}
