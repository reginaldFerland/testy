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
        const wsFolders = vscode.workspace.workspaceFolders ?? [];

        const nodes = await Promise.all(
            wsFolders.map(async (folder) => this.scanFolder(folder.uri))
        ).then((results) => results.flat());

        const rootNode: FolderNode = {
            name: 'Workspace',
            children: nodes,
            hasTests: nodes.some(child => child.hasTests)
        };

        return rootNode;

    }

    async scanFolder(folder: vscode.Uri): Promise<(FolderNode | FileNode)[]> {
        // Assume this is returning children for the folder
        const files = await vscode.workspace.fs.readDirectory(folder);

        return Promise.all(
            files.map(async ([name, fileType]) => {
                switch (fileType) {
                    case vscode.FileType.Directory:
                        const children = await this.scanFolder(vscode.Uri.joinPath(folder, name));
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
            })
        ).then((results) => results.flat());
    }

    extractTestItems = (text: string): TestItem[] => {
        const testItems: TestItem[] = [];
        const testMethodRegex = /\[\s*(Test|TestMethod|Fact|Theory)\s*\][^\{]*?public\s+(?:async\s+)?(?:void|Task)\s+(\w+)/g;

        let match;
        while ((match = testMethodRegex.exec(text)) !== null) {
            testItems.push({ name: match[2] });
        }

        return testItems;
    };

    // Then in your class
    async getTestItems(filePath: string): Promise<TestItem[]> {
        if (!filePath.endsWith('.cs')) {
            return [];
        }

        try {
            const fileUri = vscode.Uri.file(filePath);
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(fileContent).toString('utf8');

            const hasTestClass = /\[\s*Test(Class|Fixture)\s*\]|\[\s*Fact\s*\]|Microsoft\.VisualStudio\.TestTools|NUnit\.Framework|Xunit/i.test(text);

            return hasTestClass ? this.extractTestItems(text) : [];
        } catch (error) {
            console.error(`Error parsing file ${filePath}:`, error);
            return [];
        }
    }
}