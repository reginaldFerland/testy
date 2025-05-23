import * as vscode from 'vscode';
import { TestExecutor } from '../services/test-executor';
import { TestDiscoveryService } from '../services/test-discovery';
import { CSharpUtils } from '../utils/csharp-utils';

/**
 * Controls the C# test integration with VS Code's test explorer
 */
export class CSharpTestController {
    private readonly testController: vscode.TestController;
    private readonly testDiscovery: TestDiscoveryService;
    private readonly testExecutor: TestExecutor;
    private readonly fileWatcher: vscode.FileSystemWatcher;

    /**
     * Creates a new CSharpTestController
     * @param context The extension context
     */
    constructor(context: vscode.ExtensionContext) {
        // Create the main components
        this.testController = vscode.tests.createTestController('csharpTestController', 'C# Tests');
        this.testDiscovery = new TestDiscoveryService();
        this.testExecutor = new TestExecutor();

        // Initialize the test controller
        this.initializeTestController();

        // Register file system watcher for .cs files
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
        this.registerFileWatchers();

        // Register commands
        this.registerCommands(context);

        // Add the controller to disposables
        context.subscriptions.push(
            this.testController,
            this.fileWatcher
        );

        // Initial scan for test files
        this.refreshAllTests();
    }

    /**
     * Initialize the test controller with profiles and handlers
     */
    private initializeTestController(): void {
        // Set up the resolver for test items
        this.testController.resolveHandler = async (item) => {
            if (!item) {
                // Root level - scan for test files
                await this.refreshAllTests();
            } else {
                // File level - parse test methods
                await this.testDiscovery.resolveTestMethods(item, this.testController);
            }
        };

        // Create a test run profile for running tests
        this.testController.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => this.runHandler(request, token),
            true
        );

        // Create a test run profile for debugging tests
        this.testController.createRunProfile(
            'Debug',
            vscode.TestRunProfileKind.Debug,
            (request, token) => this.debugHandler(request, token),
            true
        );
    }

    /**
     * Register file system watchers
     */
    private registerFileWatchers(): void {
        // Watch for file created events
        this.fileWatcher.onDidCreate(uri => {
            console.log(`CS file created: ${uri.fsPath}`);
            this.handleFileCreated(uri);
        });

        // Watch for file changed events
        this.fileWatcher.onDidChange(uri => {
            console.log(`CS file changed: ${uri.fsPath}`);
            this.handleFileChanged(uri);
        });

        // Watch for file deleted events
        this.fileWatcher.onDidDelete(uri => {
            console.log(`CS file deleted: ${uri.fsPath}`);
            this.handleFileDeleted(uri);
        });
    }

    /**
     * Register commands
     */
    private registerCommands(context: vscode.ExtensionContext): void {
        const refreshCommand = vscode.commands.registerCommand('testy.refreshTests', () => {
            vscode.window.showInformationMessage('Refreshing C# tests...');
            this.refreshAllTests();
        });

        context.subscriptions.push(refreshCommand);
    }

    /**
     * Handles the running of tests
     */
    private async runHandler(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken
    ): Promise<void> {
        const run = this.testController.createTestRun(request);
        const queue: vscode.TestItem[] = [];
        const testLeafNodes: vscode.TestItem[] = [];

        // Build a queue of test items to run
        if (request.include) {
            request.include.forEach(test => queue.push(test));
        } else {
            // If no specific tests are included, run all tests
            this.testController.items.forEach(test => queue.push(test));
        }

        // First identify all leaf nodes to run in parallel
        while (queue.length > 0) {
            const test = queue.shift()!;

            // Skip tests that should be excluded
            if (request.exclude?.some(excluded => this.isAncestorOf(excluded, test))) {
                continue;
            }

            // If it's a test file (parent), queue its children
            if (test.children.size > 0) {
                test.children.forEach(child => queue.push(child));
                continue;
            }

            // It's a leaf node (test method), so add it to our leaf nodes array
            testLeafNodes.push(test);
        }

        // Start each test and collect promises
        const runPromises = testLeafNodes.map(async (test) => {
            // Mark the test as started
            run.started(test);

            try {
                if (!test.uri) {
                    run.skipped(test);
                    return;
                }

                // Find the project file (csproj)
                const projectInfo = await CSharpUtils.findProjectFile(test.uri.fsPath);
                if (!projectInfo) {
                    run.skipped(test);
                    run.appendOutput(`Could not find project for test: ${test.id}\n`);
                    return;
                }

                // Extract test method name from the test id
                const testParts = test.id.split('::');
                const testMethodName = testParts[testParts.length - 1];

                run.appendOutput(`Running test: ${test.label} from ${projectInfo.projectPath}\n`);

                // Run the test using dotnet test with filters
                const result = await this.testExecutor.runTest(
                    projectInfo,
                    testMethodName,
                    run,
                    test
                );

                if (result.success) {
                    run.passed(test, result.duration);
                } else {
                    run.failed(test, new vscode.TestMessage(result.message), result.duration);
                }
            } catch (e) {
                const error = e as Error;
                run.failed(test, new vscode.TestMessage(error.message));
                run.appendOutput(`Error running test ${test.id}: ${error.message}\n`);
            }
        });

        // Wait for all tests to complete
        if (token.isCancellationRequested) {
            // Early termination if cancellation is requested
            run.appendOutput(`Test run was cancelled\n`);
        } else {
            await Promise.all(runPromises);
        }

        run.end();
    }

    /**
     * Handles the debugging of tests
     */
    private async debugHandler(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken
    ): Promise<void> {
        const run = this.testController.createTestRun(request);

        // Get a single test to debug
        let testToDebug: vscode.TestItem | undefined;

        if (request.include && request.include.length > 0) {
            // Take the first included test
            testToDebug = request.include[0];

            // If it's a container, get the first leaf test
            if (testToDebug.children.size > 0) {
                const queue = [testToDebug];
                while (queue.length > 0) {
                    const item = queue.shift()!;
                    if (item.children.size === 0) {
                        testToDebug = item;
                        break;
                    } else {
                        item.children.forEach(child => queue.push(child));
                    }
                }
            }
        }

        if (!testToDebug || !testToDebug.uri) {
            run.appendOutput('No valid test specified for debugging.\n');
            run.end();
            return;
        }

        try {
            run.started(testToDebug);

            // Find the project file
            const projectInfo = await CSharpUtils.findProjectFile(testToDebug.uri.fsPath);
            if (!projectInfo) {
                run.skipped(testToDebug);
                run.appendOutput(`Could not find project for test: ${testToDebug.id}\n`);
                run.end();
                return;
            }

            // Extract test method name
            const testParts = testToDebug.id.split('::');
            const testMethodName = testParts[testParts.length - 1];

            // Start debugging
            const success = await this.testExecutor.debugTest(projectInfo, testMethodName);
            if (!success) {
                run.failed(testToDebug, new vscode.TestMessage('Failed to start debugging'));
            }
        } catch (e) {
            const error = e as Error;
            run.failed(testToDebug, new vscode.TestMessage(error.message));
            run.appendOutput(`Error debugging test ${testToDebug.id}: ${error.message}\n`);
        }

        run.end();
    }

    /**
     * Refreshes all tests in the workspace
     */
    private async refreshAllTests(): Promise<void> {
        // Clear existing test items
        this.testController.items.replace([]);

        try {
            // Find all test files
            const testFiles = await this.testDiscovery.findTestFiles();

            // Process each test file
            for (const uri of testFiles) {
                const fileItem = await this.testDiscovery.parseTestFile(uri, this.testController);
                this.testController.items.add(fileItem);
                await this.testDiscovery.resolveTestMethods(fileItem, this.testController);
            }
        } catch (error) {
            console.error('Error refreshing tests:', error);
        }
    }

    /**
     * Handles file creation events
     */
    private async handleFileCreated(uri: vscode.Uri): Promise<void> {
        try {
            if (this.testDiscovery.isTestFile(uri)) {
                const fileItem = await this.testDiscovery.parseTestFile(uri, this.testController);
                this.testController.items.add(fileItem);
                await this.testDiscovery.resolveTestMethods(fileItem, this.testController);
            }
        } catch (error) {
            console.error('Error handling file creation:', error);
        }
    }

    /**
     * Handles file change events
     */
    private async handleFileChanged(uri: vscode.Uri): Promise<void> {
        try {
            const fileId = uri.fsPath;
            const existingItem = this.testController.items.get(fileId);

            if (existingItem) {
                await this.testDiscovery.resolveTestMethods(existingItem, this.testController);
            } else if (this.testDiscovery.isTestFile(uri)) {
                // New test file that wasn't previously recognized
                await this.handleFileCreated(uri);
            }
        } catch (error) {
            console.error('Error handling file change:', error);
        }
    }

    /**
     * Handles file deletion events
     */
    private handleFileDeleted(uri: vscode.Uri): void {
        try {
            const fileId = uri.fsPath;
            const existingItem = this.testController.items.get(fileId);

            if (existingItem) {
                this.testController.items.delete(fileId);
            }
        } catch (error) {
            console.error('Error handling file deletion:', error);
        }
    }

    /**
     * Determines if ancestor is an ancestor of the test item
     */
    private isAncestorOf(ancestor: vscode.TestItem, test: vscode.TestItem): boolean {
        let parent = test.parent;
        while (parent) {
            if (parent === ancestor) {
                return true;
            }
            parent = parent.parent;
        }
        return false;
    }
}