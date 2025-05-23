import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Controller for discovering and managing C# tests in the workspace
 */
export class CSharpTestController {
    private readonly testController: vscode.TestController;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly testItems = new Map<string, vscode.TestItem>();

    constructor() {
        // Create the test controller
        this.testController = vscode.tests.createTestController('csharpTestController', 'C# Test Explorer');

        // Add a resolver for handling dynamic test discovery
        this.testController.resolveHandler = this.resolveHandler.bind(this);

        // Add a run handler for running tests
        this.testController.createRunProfile(
            'Run Tests',
            vscode.TestRunProfileKind.Run,
            this.runHandler.bind(this),
            true
        );

        // Register refresh handler
        this.testController.refreshHandler = this.refreshHandler.bind(this);

        // Trigger initial test discovery when workspace folders are available
        if (vscode.workspace.workspaceFolders) {
            this.refreshHandler();
        }

        // Watch for file changes in the workspace to update tests
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
        this.disposables.push(
            watcher.onDidCreate(() => this.refreshHandler()),
            watcher.onDidChange(() => this.refreshHandler()),
            watcher.onDidDelete(() => this.refreshHandler()),
            watcher
        );
    }

    /**
     * Handler for refreshing all tests in the workspace
     */
    private async refreshHandler(): Promise<void> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return;
        }

        // Clear existing test items
        this.testController.items.replace([]);
        this.testItems.clear();

        // Scan all workspace folders for tests
        for (const workspaceFolder of vscode.workspace.workspaceFolders) {
            await this.discoverTestsInFolder(workspaceFolder.uri);
        }
    }

    /**
     * Handler for resolving test items in a specific folder or file
     */
    private async resolveHandler(item: vscode.TestItem | undefined): Promise<void> {
        if (!item) {
            // If no item is provided, discover all tests in the workspace
            await this.refreshHandler();
        } else {
            // If an item is provided, discover tests in the specific folder or file
            const uri = item.uri;
            if (uri) {
                if (this.isDirectory(uri)) {
                    await this.discoverTestsInFolder(uri, item);
                } else if (uri.fsPath.endsWith('.cs')) {
                    await this.discoverTestsInFile(uri, this.getParentItem(uri));
                }
            }
        }
    }

    /**
     * Handler for running tests
     */
    private async runHandler(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken
    ): Promise<void> {
        const run = this.testController.createTestRun(request);
        const queue: vscode.TestItem[] = [];

        // Create a queue of test items to run based on the request
        if (request.include) {
            request.include.forEach(item => queue.push(item));
        } else {
            // If no specific tests are requested, run all tests
            this.testController.items.forEach(item => queue.push(item));
        }

        // Process all tests in the queue
        while (queue.length > 0 && !token.isCancellationRequested) {
            const item = queue.shift()!;

            // Skip items that are excluded from this test run
            if (request.exclude?.includes(item)) {
                continue;
            }

            // If the item has children, add them to the queue
            if (item.children.size > 0) {
                item.children.forEach(child => queue.push(child));
                continue;
            }

            // Mark the test as running
            run.started(item);

            try {
                // TODO: Implement actual test execution logic here
                // For now, we'll just simulate successful test execution after a short delay
                await new Promise(resolve => setTimeout(resolve, 500));

                // Randomly pass or fail tests for demonstration purposes
                if (Math.random() > 0.3) {
                    run.passed(item, 500);
                } else {
                    run.failed(item,
                        new vscode.TestMessage('Test failed with an error'),
                        500
                    );
                }
            } catch (e) {
                run.errored(item, new vscode.TestMessage(`Error during test execution: ${e}`));
            }
        }

        // Complete the test run
        run.end();
    }

    /**
     * Discovers all C# tests in a workspace folder
     */
    private async discoverTestsInFolder(
        folderUri: vscode.Uri,
        parent?: vscode.TestItem
    ): Promise<void> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(folderUri);

            // Process all entries in the folder
            for (const [name, type] of entries) {
                // Skip hidden folders and files
                if (name.startsWith('.')) {
                    continue;
                }

                const uri = vscode.Uri.joinPath(folderUri, name);

                if (type === vscode.FileType.Directory) {
                    // Create a test item for the folder
                    const folderItem = this.getOrCreateFolderItem(uri, parent);

                    // Recursively discover tests in subfolders
                    await this.discoverTestsInFolder(uri, folderItem);

                    // Only keep folder items if they have children
                    if (folderItem.children.size === 0) {
                        const parentCollection = parent ? parent.children : this.testController.items;
                        parentCollection.delete(folderItem.id);
                        this.testItems.delete(folderItem.id);
                    }
                } else if (type === vscode.FileType.File && name.endsWith('.cs')) {
                    // Discover tests in C# files
                    await this.discoverTestsInFile(uri, parent);
                }
            }
        } catch (error) {
            console.error(`Error scanning folder ${folderUri.fsPath}:`, error);
        }
    }

    /**
     * Discovers tests in a single C# file
     */
    private async discoverTestsInFile(
        fileUri: vscode.Uri,
        parent?: vscode.TestItem
    ): Promise<void> {
        try {
            // Create a test item for the file
            const fileItem = this.getOrCreateFileItem(fileUri, parent);

            // Read the file content
            const content = await vscode.workspace.fs.readFile(fileUri);
            const fileContent = Buffer.from(content).toString('utf8');

            // Check if this is a test file (has test attributes or using test libraries)
            if (this.isCSharpTestFile(fileContent)) {
                // Parse the file to find test methods
                const testMethods = this.findTestMethods(fileContent, fileUri.fsPath);

                // Create test items for each test method
                for (const testMethod of testMethods) {
                    const testId = `${fileItem.id}/${testMethod.name}`;

                    // Create the test item or update existing one
                    let testItem = this.testItems.get(testId);
                    if (!testItem) {
                        testItem = this.testController.createTestItem(
                            testId,
                            testMethod.name,
                            fileUri
                        );
                        testItem.range = testMethod.range;
                        fileItem.children.add(testItem);
                        this.testItems.set(testId, testItem);
                    }
                }
            }

            // Remove the file item if it doesn't contain any tests
            if (fileItem.children.size === 0) {
                const parentCollection = parent ? parent.children : this.testController.items;
                parentCollection.delete(fileItem.id);
                this.testItems.delete(fileItem.id);
            }
        } catch (error) {
            console.error(`Error discovering tests in file ${fileUri.fsPath}:`, error);
        }
    }

    /**
     * Creates or gets an existing test item for a folder
     */
    private getOrCreateFolderItem(
        folderUri: vscode.Uri,
        parent?: vscode.TestItem
    ): vscode.TestItem {
        const folderName = path.basename(folderUri.fsPath);
        const folderId = folderUri.toString();

        // Try to get an existing folder item
        let folderItem = this.testItems.get(folderId);

        if (!folderItem) {
            // Create a new folder item
            folderItem = this.testController.createTestItem(
                folderId,
                folderName,
                folderUri
            );

            // Add to the parent collection
            const parentCollection = parent ? parent.children : this.testController.items;
            parentCollection.add(folderItem);
            this.testItems.set(folderId, folderItem);
        }

        return folderItem;
    }

    /**
     * Creates or gets an existing test item for a file
     */
    private getOrCreateFileItem(
        fileUri: vscode.Uri,
        parent?: vscode.TestItem
    ): vscode.TestItem {
        const fileName = path.basename(fileUri.fsPath);
        const fileId = fileUri.toString();

        // Try to get an existing file item
        let fileItem = this.testItems.get(fileId);

        if (!fileItem) {
            // Create a new file item
            fileItem = this.testController.createTestItem(
                fileId,
                fileName,
                fileUri
            );

            // Add to the parent collection
            const parentCollection = parent ? parent.children : this.testController.items;
            parentCollection.add(fileItem);
            this.testItems.set(fileId, fileItem);
        }

        return fileItem;
    }

    /**
     * Gets the parent test item for a given URI
     */
    private getParentItem(uri: vscode.Uri): vscode.TestItem | undefined {
        const parentUri = vscode.Uri.file(path.dirname(uri.fsPath));
        return this.testItems.get(parentUri.toString());
    }

    /**
     * Checks if a URI points to a directory
     */
    private isDirectory(uri: vscode.Uri): boolean {
        try {
            return fs.statSync(uri.fsPath).isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Checks if a file is a C# test file
     */
    private isCSharpTestFile(content: string): boolean {
        // Check for common test attributes and namespaces
        const testPatterns = [
            /\[Test(Case|Fixture|Class)?\]/i,
            /\[Fact\]/i,
            /\[Theory\]/i,
            /using\s+NUnit\.Framework/i,
            /using\s+Xunit/i,
            /using\s+Microsoft\.VisualStudio\.TestTools/i
        ];

        return testPatterns.some(pattern => pattern.test(content));
    }

    /**
     * Finds test methods in a C# file
     */
    private findTestMethods(content: string, filePath: string): Array<{ name: string; range: vscode.Range }> {
        const testMethods: Array<{ name: string; range: vscode.Range }> = [];

        // Regular expressions to match different test method patterns
        const testMethodPatterns = [
            // NUnit test
            /\s*\[Test(Case)?.*?\]\s*\n\s*public\s+void\s+(\w+)/g,
            // xUnit test
            /\s*\[(Fact|Theory).*?\]\s*\n\s*public\s+void\s+(\w+)/g,
            // MSTest test
            /\s*\[TestMethod.*?\]\s*\n\s*public\s+void\s+(\w+)/g
        ];

        const lines = content.split('\n');

        for (const pattern of testMethodPatterns) {
            let match;
            // Clone the pattern for each iteration, as RegExp objects maintain state
            const regExp = new RegExp(pattern.source, pattern.flags);

            while ((match = regExp.exec(content)) !== null) {
                const methodName = match[2] || match[1]; // Capture group for the method name
                const matchedText = match[0];

                // Calculate line number by finding the position of the match
                const matchStart = match.index;
                let lineNumber = 0;
                let currentPos = 0;

                for (let i = 0; i < lines.length; i++) {
                    currentPos += lines[i].length + 1; // +1 for the newline character
                    if (currentPos > matchStart) {
                        lineNumber = i;
                        break;
                    }
                }

                // Create a range for the test method
                const range = new vscode.Range(
                    new vscode.Position(lineNumber, 0),
                    new vscode.Position(lineNumber + 1, 0)
                );

                testMethods.push({ name: methodName, range });
            }
        }

        return testMethods;
    }

    /**
     * Disposes resources used by the test controller
     */
    public dispose(): void {
        this.testController.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}