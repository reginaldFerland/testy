import * as vscode from 'vscode';
import * as path from 'path';
import { TestMethod } from '../models/test-interfaces';

/**
 * Utility functions for working with C# tests
 */
export class CSharpUtils {
    /**
     * Checks if a file appears to be a C# test file based on naming conventions
     */
    public static isLikelyTestFile(fileName: string): boolean {
        const testPattern = /(Test|Tests|TestCase|Spec)\.cs$/i;
        return testPattern.test(fileName);
    }

    /**
     * Finds the .csproj file associated with a test file
     * @param testFilePath Path to the test file
     * @param maxDepth Maximum directory depth to search (default: 5)
     * @returns Project path and directory if found, undefined otherwise
     */
    public static async findProjectFile(testFilePath: string, maxDepth = 5): Promise<{ projectPath: string; projectDir: string } | undefined> {
        const testFileDir = path.dirname(testFilePath);

        // Look for a .csproj file in the same directory or parent directories
        let currentDir = testFileDir;

        for (let i = 0; i < maxDepth; i++) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(currentDir, '*.csproj'),
                null,
                1
            );

            if (files.length > 0) {
                return {
                    projectPath: files[0].fsPath,
                    projectDir: path.dirname(files[0].fsPath)
                };
            }

            // Move up one directory
            const parentDir = path.dirname(currentDir);

            // Stop if we've reached the root
            if (parentDir === currentDir) {
                break;
            }

            currentDir = parentDir;
        }

        return undefined;
    }

    /**
     * Extract test methods from C# source code
     * @param document Text document containing C# source code
     * @returns Array of test methods found in the document
     */
    public static extractTestMethods(document: vscode.TextDocument): TestMethod[] {
        const content = document.getText();
        const testMethods: TestMethod[] = [];

        // Look for test methods with various test framework attributes
        const testMethodRegex = /\[\s*(Fact|Theory|Test|TestMethod)\s*\].*?public.*?(?:void|async Task)\s+(\w+)/gs;
        let match: RegExpExecArray | null;

        while ((match = testMethodRegex.exec(content)) !== null) {
            const testAttribute = match[1];
            const testMethodName = match[2];
            const startPosition = document.positionAt(match.index);
            const line = document.lineAt(startPosition.line);

            testMethods.push({
                name: testMethodName,
                attribute: testAttribute,
                position: {
                    line: startPosition.line,
                    character: startPosition.character,
                    lineLength: line.text.length
                }
            });
        }

        return testMethods;
    }
}