// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "testy" is now active!');

	// Create a test controller for C# tests
	const testController = vscode.tests.createTestController('csharpTestController', 'C# Tests');
	context.subscriptions.push(testController);

	// Set up the resolver for test items
	testController.resolveHandler = async (item) => {
		if (!item) {
			// This is the root of the test tree, so scan the workspace for test files
			await findCSharpTestFiles(testController);
		} else {
			// For individual test items, resolve their test methods
			await parseTestMethods(testController, item);
		}
	};

	// Create a test run profile for running tests
	testController.createRunProfile(
		'Run',
		vscode.TestRunProfileKind.Run,
		(request, token) => runHandler(testController, request, token),
		true
	);

	// Create a test run profile for debugging tests
	testController.createRunProfile(
		'Debug',
		vscode.TestRunProfileKind.Debug,
		(request, token) => debugHandler(testController, request, token),
		true
	);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('testy.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from testy!');
	});

	context.subscriptions.push(disposable);

	// Register a command to refresh tests
	const refreshTestsCommand = vscode.commands.registerCommand('testy.refreshTests', () => {
		vscode.window.showInformationMessage('Refreshing C# tests...');
		findCSharpTestFiles(testController);
	});

	context.subscriptions.push(refreshTestsCommand);

	// Set up file system watcher for .cs files
	const csWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');

	// Watch for file created events
	csWatcher.onDidCreate(uri => {
		console.log(`CS file created: ${uri.fsPath}`);
		checkAndAddTestFile(uri, testController);
	});

	// Watch for file changed events
	csWatcher.onDidChange(uri => {
		console.log(`CS file changed: ${uri.fsPath}`);
		// Update test items if the file is a test file
		checkAndUpdateTestFile(uri, testController);
	});

	// Watch for file deleted events
	csWatcher.onDidDelete(uri => {
		console.log(`CS file deleted: ${uri.fsPath}`);
		// Remove test items if the file was a test file
		removeTestFile(uri, testController);
	});

	// Make sure to dispose the watcher when the extension is deactivated
	context.subscriptions.push(csWatcher);

	// Initial scanning for test files
	findCSharpTestFiles(testController);
}

/**
 * Handler for running tests
 */
async function runHandler(
	testController: vscode.TestController,
	request: vscode.TestRunRequest,
	token: vscode.CancellationToken
): Promise<void> {
	const run = testController.createTestRun(request);
	const queue: vscode.TestItem[] = [];

	// Get the test items to run
	if (request.include) {
		request.include.forEach(test => queue.push(test));
	} else {
		// If no specific tests are included, run all tests
		testController.items.forEach(test => queue.push(test));
	}

	// Process queue
	while (queue.length > 0 && !token.isCancellationRequested) {
		const test = queue.shift()!;

		// Skip tests that should be excluded
		if (request.exclude?.some(excluded => excluded.id === test.id || isAncestorOf(excluded, test))) {
			continue;
		}

		// If it's a test file (parent), queue its children
		if (test.children.size > 0) {
			test.children.forEach(child => queue.push(child));
			continue;
		}

		// It's a leaf node (test method), so run it
		run.started(test);

		try {
			// Find the project file (csproj)
			const projectInfo = await findProjectForTest(test);
			if (!projectInfo) {
				run.skipped(test);
				run.appendOutput(`Could not find project for test: ${test.id}\n`);
				continue;
			}

			const { projectPath, projectDir } = projectInfo;
			run.appendOutput(`Running test: ${test.label} from ${projectPath}\n`);

			// Extract test method name and class from the test id
			const testParts = test.id.split('::');
			const testMethodName = testParts[testParts.length - 1];

			// Run the test using dotnet test with filters
			const result = await runDotnetTest(projectDir, testMethodName, run, test);

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
	}

	// End the test run
	run.end();
}

/**
 * Handler for debugging tests
 */
async function debugHandler(
	testController: vscode.TestController,
	request: vscode.TestRunRequest,
	token: vscode.CancellationToken
): Promise<void> {
	const run = testController.createTestRun(request);

	// Get a single test to debug
	let testToDebug: vscode.TestItem | undefined;

	if (request.include && request.include.length > 0) {
		// Take the first included test
		testToDebug = request.include[0];

		// If it's a container, get the first leaf test
		if (testToDebug.children.size > 0) {
			const queue = [testToDebug];
			while (queue.length > 0 && !testToDebug) {
				const item = queue.shift()!;
				if (item.children.size === 0) {
					testToDebug = item;
				} else {
					item.children.forEach(child => queue.push(child));
				}
			}
		}
	}

	if (!testToDebug) {
		run.appendOutput('No test specified for debugging.\n');
		run.end();
		return;
	}

	try {
		// Mark test as running
		run.started(testToDebug);

		// Find the project file
		const projectInfo = await findProjectForTest(testToDebug);
		if (!projectInfo) {
			run.skipped(testToDebug);
			run.appendOutput(`Could not find project for test: ${testToDebug.id}\n`);
			run.end();
			return;
		}

		const { projectPath, projectDir } = projectInfo;

		// Extract test method name
		const testParts = testToDebug.id.split('::');
		const testMethodName = testParts[testParts.length - 1];

		// Launch debug configuration
		await vscode.debug.startDebugging(undefined, {
			type: 'coreclr',
			name: `Debug Test: ${testMethodName}`,
			request: 'launch',
			program: 'dotnet',
			args: [
				'test',
				projectPath,
				'--filter',
				`FullyQualifiedName~${testMethodName}`,
				'--no-build',
			],
			cwd: projectDir,
			console: 'internalConsole',
			internalConsoleOptions: 'openOnSessionStart',
			justMyCode: true
		});

		// Since debug sessions are not awaitable, we don't actually mark the test as passed/failed
		// The debugger will show the results directly
	} catch (e) {
		const error = e as Error;
		run.failed(testToDebug, new vscode.TestMessage(error.message));
		run.appendOutput(`Error debugging test ${testToDebug.id}: ${error.message}\n`);
	}

	// End the test run
	run.end();
}

/**
 * Runs a C# test using dotnet test
 */
async function runDotnetTest(
	projectDir: string,
	testMethod: string,
	run: vscode.TestRun,
	testItem: vscode.TestItem
): Promise<{ success: boolean; message: string; duration?: number }> {
	return new Promise((resolve) => {
		const startTime = Date.now();

		const dotnetProcess = spawn(
			'dotnet',
			['test', '--filter', `FullyQualifiedName~${testMethod}`, '-v', 'minimal'],
			{ cwd: projectDir }
		);

		let stdout = '';
		let stderr = '';

		dotnetProcess.stdout.on('data', (data) => {
			const output = data.toString();
			stdout += output;
			run.appendOutput(output);
		});

		dotnetProcess.stderr.on('data', (data) => {
			const output = data.toString();
			stderr += output;
			run.appendOutput(output);
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

/**
 * Finds the project file (.csproj) for a test
 */
async function findProjectForTest(testItem: vscode.TestItem): Promise<{ projectPath: string; projectDir: string } | undefined> {
	if (!testItem.uri) {
		return undefined;
	}

	const testFilePath = testItem.uri.fsPath;
	const testFileDir = path.dirname(testFilePath);

	// Look for a .csproj file in the same directory or parent directories
	let currentDir = testFileDir;
	const maxDepth = 5; // Limit search depth

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
 * Determines if ancestor is an ancestor of the given test item
 */
function isAncestorOf(ancestor: vscode.TestItem, test: vscode.TestItem): boolean {
	let parent = test.parent;
	while (parent) {
		if (parent === ancestor) {
			return true;
		}
		parent = parent.parent;
	}
	return false;
}

/**
 * Scans the workspace for C# test files
 */
async function findCSharpTestFiles(testController: vscode.TestController): Promise<void> {
	// Clear existing test items first
	testController.items.replace([]);

	if (!vscode.workspace.workspaceFolders) {
		return;
	}

	const testFilePattern = new vscode.RelativePattern(
		vscode.workspace.workspaceFolders[0],
		'**/*{Test,Tests,TestCase,Spec}.cs'
	);

	const testFiles = await vscode.workspace.findFiles(testFilePattern);

	for (const file of testFiles) {
		await addTestFile(file, testController);
	}
}

/**
 * Adds a test file to the test explorer
 */
async function addTestFile(uri: vscode.Uri, testController: vscode.TestController): Promise<void> {
	const filePath = uri.fsPath;
	const fileName = path.basename(filePath);

	// Create a test item for the file
	const fileTestItem = testController.createTestItem(
		filePath,
		fileName,
		uri
	);
	fileTestItem.canResolveChildren = true;

	testController.items.add(fileTestItem);

	// Parse the file immediately to show tests
	await parseTestMethods(testController, fileTestItem);
}

/**
 * Checks if a file is a test file and adds it if it is
 */
async function checkAndAddTestFile(uri: vscode.Uri, testController: vscode.TestController): Promise<void> {
	const filePath = uri.fsPath;
	const fileName = path.basename(filePath);

	// Check if this looks like a test file based on naming convention
	if (fileName.includes('Test') || fileName.includes('Tests') || fileName.includes('Spec')) {
		await addTestFile(uri, testController);
	}
}

/**
 * Updates test items for a modified file
 */
async function checkAndUpdateTestFile(uri: vscode.Uri, testController: vscode.TestController): Promise<void> {
	const filePath = uri.fsPath;

	// Check if we already have this file in our test items
	const existingItem = testController.items.get(filePath);
	if (existingItem) {
		await parseTestMethods(testController, existingItem);
	}
}

/**
 * Removes test items for a deleted file
 */
function removeTestFile(uri: vscode.Uri, testController: vscode.TestController): void {
	const filePath = uri.fsPath;

	// Remove the file's test item if it exists
	const existingItem = testController.items.get(filePath);
	if (existingItem) {
		testController.items.delete(filePath);
	}
}

/**
 * Parses C# test methods from a file
 */
async function parseTestMethods(testController: vscode.TestController, fileItem: vscode.TestItem): Promise<void> {
	try {
		// Clear existing children first
		fileItem.children.replace([]);

		const document = await vscode.workspace.openTextDocument(fileItem.uri!);
		const content = document.getText();

		// Look for test methods using various test framework attributes
		const testMethodRegex = /\[\s*(Fact|Theory|Test|TestMethod)\s*\].*?public.*?(?:void|async Task)\s+(\w+)/gs;
		let match: RegExpExecArray | null;

		while ((match = testMethodRegex.exec(content)) !== null) {
			const testAttribute = match[1];
			const testMethodName = match[2];
			const startPosition = document.positionAt(match.index);

			// Create a range for the test method
			const line = document.lineAt(startPosition.line);
			const methodLineContent = line.text;

			// Create a test item for the method
			const testMethodItem = testController.createTestItem(
				`${fileItem.id}::${testMethodName}`,
				testMethodName,
				fileItem.uri
			);

			// Add a description based on the test attribute
			testMethodItem.description = testAttribute;

			// Set the test location for navigation
			testMethodItem.range = new vscode.Range(
				startPosition,
				new vscode.Position(startPosition.line, methodLineContent.length)
			);

			fileItem.children.add(testMethodItem);
		}

		// Also look for test classes (to handle nested structure)
		const testClassRegex = /\[\s*(TestClass|TestFixture)\s*\].*?class\s+(\w+)/gs;
		while ((match = testClassRegex.exec(content)) !== null) {
			const className = match[2];
			const startPosition = document.positionAt(match.index);

			// We could handle test classes here if needed
			// For now, just log them
			console.log(`Found test class: ${className} at line ${startPosition.line + 1}`);
		}
	} catch (error) {
		console.error(`Error parsing test methods: ${error}`);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }
