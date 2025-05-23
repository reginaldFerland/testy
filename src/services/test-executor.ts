import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { TestRunResult, CSharpTestProject } from '../models/test-interfaces';

/**
 * Service responsible for executing C# tests
 */
export class TestExecutor {
    /**
     * Runs a C# test using dotnet test
     * @param projectInfo Project information
     * @param testMethod Name of the test method to run
     * @param testRun The VS Code test run to report progress to
     * @param testItem The test item being run
     * @returns Result of the test execution
     */
    public async runTest(
        projectInfo: CSharpTestProject,
        testMethod: string,
        testRun: vscode.TestRun,
        testItem: vscode.TestItem
    ): Promise<TestRunResult> {
        return this.executeDotnetTest(
            projectInfo.projectDir,
            testMethod,
            testRun,
            ['--no-build']
        );
    }

    /**
     * Debugs a C# test
     * @param projectInfo Project information
     * @param testMethod Name of the test method to debug
     * @returns Whether debugging was started successfully
     */
    public async debugTest(
        projectInfo: CSharpTestProject,
        testMethod: string
    ): Promise<boolean> {
        try {
            // Launch debug configuration
            await vscode.debug.startDebugging(undefined, {
                type: 'coreclr',
                name: `Debug Test: ${testMethod}`,
                request: 'launch',
                program: 'dotnet',
                args: [
                    'test',
                    projectInfo.projectPath,
                    '--filter',
                    `FullyQualifiedName~${testMethod}`,
                    '--no-build',
                ],
                cwd: projectInfo.projectDir,
                console: 'internalConsole',
                internalConsoleOptions: 'openOnSessionStart',
                justMyCode: true
            });

            return true;
        } catch (error) {
            console.error('Failed to start debugging:', error);
            return false;
        }
    }

    /**
     * Executes a dotnet test command
     * @param projectDir Directory containing the project
     * @param testMethod Name of the test method to run
     * @param testRun The VS Code test run to report progress to
     * @param additionalArgs Additional arguments to pass to dotnet test
     * @returns Result of the test execution
     */
    private executeDotnetTest(
        projectDir: string,
        testMethod: string,
        testRun: vscode.TestRun,
        additionalArgs: string[] = []
    ): Promise<TestRunResult> {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const args = [
                'test',
                '--filter',
                `FullyQualifiedName~${testMethod}`,
                '-v',
                'minimal',
                ...additionalArgs
            ];

            const dotnetProcess = spawn('dotnet', args, { cwd: projectDir });

            let stdout = '';
            let stderr = '';

            dotnetProcess.stdout.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                testRun.appendOutput(output);
            });

            dotnetProcess.stderr.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                testRun.appendOutput(output);
            });

            dotnetProcess.on('close', (code) => {
                const duration = Date.now() - startTime;

                if (code === 0) {
                    resolve({
                        success: true,
                        message: 'Test passed',
                        duration
                    });
                } else {
                    // Try to extract the error message from the output
                    let errorMessage = 'Test failed';

                    // Look for error details in the output
                    const errorRegex = /Failed\s+(.*?)\s+\[(.*?)\]/;
                    const match = stdout.match(errorRegex);
                    if (match) {
                        errorMessage = `Test failed: ${match[1]}`;
                    }

                    resolve({
                        success: false,
                        message: errorMessage,
                        duration
                    });
                }
            });
        });
    }
}