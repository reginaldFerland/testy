import * as vscode from 'vscode';
import * as path from 'path';
import { CSharpUtils } from '../utils/csharp-utils';
import { TestConfig } from '../models/test-interfaces';

/**
 * Service responsible for discovering C# tests in the workspace
 */
export class TestDiscoveryService {
    private readonly defaultTestPatterns = ['**/*{Test,Tests,TestCase,Spec}.cs'];
    private readonly testConfig: TestConfig;

    /**
     * Creates a new TestDiscoveryService
     * @param testConfig Optional test configuration
     */
    constructor(testConfig?: Partial<TestConfig>) {
        this.testConfig = {
            testFilePatterns: testConfig?.testFilePatterns || this.defaultTestPatterns,
            autoRunTests: testConfig?.autoRunTests || false,
            additionalTestArgs: testConfig?.additionalTestArgs || []
        };
    }

    /**
     * Find all test files in the workspace
     * @returns Array of URIs pointing to test files
     */
    public async findTestFiles(): Promise<vscode.Uri[]> {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return [];
        }

        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const testFiles: vscode.Uri[] = [];

        for (const pattern of this.testConfig.testFilePatterns) {
            const relativePattern = new vscode.RelativePattern(workspaceFolder, pattern);
            const files = await vscode.workspace.findFiles(relativePattern);
            testFiles.push(...files);
        }

        return testFiles;
    }

    /**
     * Parses a test file and creates a test item for it
     * @param uri URI of the test file
     * @param testController Test controller to add items to
     */
    public async parseTestFile(uri: vscode.Uri, testController: vscode.TestController): Promise<vscode.TestItem> {
        const filePath = uri.fsPath;
        const fileName = path.basename(filePath);

        // Create a test item for the file
        const fileTestItem = testController.createTestItem(
            filePath,
            fileName,
            uri
        );
        fileTestItem.canResolveChildren = true;

        return fileTestItem;
    }

    /**
     * Resolves test methods in a test file and adds them as children to the test item
     * @param fileTestItem Test item representing a file
     * @param testController Test controller
     */
    public async resolveTestMethods(fileTestItem: vscode.TestItem, testController: vscode.TestController): Promise<void> {
        try {
            // Clear existing children first
            fileTestItem.children.replace([]);

            if (!fileTestItem.uri) {
                return;
            }

            const document = await vscode.workspace.openTextDocument(fileTestItem.uri);
            const testMethods = CSharpUtils.extractTestMethods(document);

            for (const method of testMethods) {
                // Create a test item for the method
                const testMethodItem = testController.createTestItem(
                    `${fileTestItem.id}::${method.name}`,
                    method.name,
                    fileTestItem.uri
                );

                // Add a description based on the test attribute
                testMethodItem.description = method.attribute;

                // Set the test location for navigation
                testMethodItem.range = new vscode.Range(
                    new vscode.Position(method.position.line, method.position.character),
                    new vscode.Position(method.position.line, method.position.lineLength)
                );

                fileTestItem.children.add(testMethodItem);
            }
        } catch (error) {
            console.error(`Error resolving test methods: ${error}`);
        }
    }

    /**
     * Checks if a file is likely to be a test file and should be monitored
     * @param uri URI of the file to check
     */
    public isTestFile(uri: vscode.Uri): boolean {
        const fileName = path.basename(uri.fsPath);
        return CSharpUtils.isLikelyTestFile(fileName);
    }
}