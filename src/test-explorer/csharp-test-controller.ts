import * as vscode from 'vscode';

/**
 * Controls the C# test integration with VS Code's test explorer
 */
export class CSharpTestController {
    private readonly controller: vscode.TestController;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        // Create the test controller
        this.controller = vscode.tests.createTestController('csharpTests', 'C# Tests');

        // Add to disposables for proper cleanup
        this.disposables.push(this.controller);

        const workspace = new Workspace();

        // Set up test item discovery
        this.controller.resolveHandler = async (test) => {
            if (!test) {
                // Root test item discovery
                console.log('Discovering tests...');
                var files = await workspace.scanWorkspace();
                console.log('Workspace scanned:', files);
            } else {
                // Specific test item resolution
                console.log(`Resolving test item: ${test.id}`);
            }
        };

        // Set up run profiles
        this.setupRunProfiles();

    }

    /**
     * Set up the run profiles for test execution
     */
    private setupRunProfiles(): void {
        // Create a run profile for running tests
        this.controller.createRunProfile(
            'Run Tests',
            vscode.TestRunProfileKind.Run,
            (request, token) => console.log('Running tests...'),
            true // Set as default for running tests
        );

        // Create a debug profile
        this.controller.createRunProfile(
            'Debug Tests',
            vscode.TestRunProfileKind.Debug,
            (request, token) => console.log('Debugging tests...'),
            true // Set as default for debugging tests
        );
    }
}


// Class to represent the project structure
interface TestItem {
    name: string;
}
interface FileNode {
    name: string;
    hasTests: boolean;
    children: TestItem[];
}
interface FolderNode {
    name: string;
    children: (FolderNode | FileNode)[];
    hasTests: boolean;
}

class Workspace {
    async scanWorkspace(): Promise<FolderNode> {
        const wsFolders = vscode.workspace.workspaceFolders;

        const nodePromises = wsFolders?.map(async (folder) => {
            return this.scanFolder(folder.uri);
        });

        const nodeResults = (await Promise.all(nodePromises || [])).flat();

        const rootNode: FolderNode = {
            name: 'Workspace',
            children: nodeResults,
            hasTests: nodeResults.some((child) => { return child.hasTests; }),
        };

        return rootNode;

    }

    async scanFolder(folder: vscode.Uri): Promise<(FolderNode | FileNode)[]> {
        // Assume this is returning children for the folder

        return vscode.workspace.fs.readDirectory(folder).then(async (files) => {
            const result = files.map(async ([name, fileType]) => {
                switch (fileType) {
                    case vscode.FileType.Directory:
                        var children = await this.scanFolder(vscode.Uri.joinPath(folder, name));
                        return {
                            name: name,
                            children: children,
                            hasTests: children.some((child) => { return child.hasTests; }),
                        } as FolderNode;
                    case vscode.FileType.File:
                        const tests = await this.getTestItems(vscode.Uri.joinPath(folder, name).fsPath);
                        return {
                            name: name,
                            hasTests: tests.length > 0,
                            children: tests
                        } as FileNode;
                    default:
                        console.log(`Found unknown type: ${name}`);
                        throw new Error(`Unknown file type: ${name}`);
                }
            });
            return await Promise.all(result);
        });
    }

    async fileHasTests(filePath: string, fileName: string): Promise<boolean> {
        // Check if file is .cs first
        if (!fileName.endsWith('.cs')) {
            return Promise.resolve(false);
        }
        return Promise.resolve(true); // Placeholder logic
    }

    async getTestItems(filePath: string): Promise<TestItem[]> {
        try {
            // Skip non-C# files
            if (!filePath.endsWith('.cs')) {
                return [];
            }

            // Read the file content
            const fileUri = vscode.Uri.file(filePath);
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(fileContent).toString('utf8');
            const testItems: TestItem[] = [];

            // Look for test class indicators
            const hasTestClass = /\[\s*Test(Class|Fixture)\s*\]|\[\s*Fact\s*\]|Microsoft\.VisualStudio\.TestTools|NUnit\.Framework|Xunit/i.test(text);

            if (!hasTestClass) {
                return [];
            }

            // Find test methods - supports NUnit, MSTest, and xUnit patterns
            const testMethodRegex = /\[\s*(Test|TestMethod|Fact|Theory)\s*\][^\{]*?public\s+(?:async\s+)?(?:void|Task)\s+(\w+)/g;

            let match;
            while ((match = testMethodRegex.exec(text)) !== null) {
                const methodName = match[2];
                testItems.push({
                    name: methodName
                });
            }

            return testItems;
        } catch (error) {
            console.error(`Error parsing file ${filePath}:`, error);
            return [];
        }
    }
}