// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext): void {
	// Log activation
	console.log('Activating the testy extension');

	// Check if the required extension is installed
	checkRequiredExtension(context);

	// Create a file system watcher for .cs files
	const csFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
	context.subscriptions.push(csFileWatcher);

	// Set up a debounce mechanism to prevent triggering tests too frequently
	let debounceTimer: NodeJS.Timeout | undefined;
	const debounceDelay = 1000; // 1 second delay

	// Function to trigger the VS Code test runner
	const triggerTestRun = () => {
		// Clear any pending debounce timer
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		// Set a new debounce timer
		debounceTimer = setTimeout(async () => {
			console.log('File change detected, triggering test run');

			// Execute the VS Code testing: Run All Tests command
			await vscode.commands.executeCommand('testing.runAll');
		}, debounceDelay);
	};

	// Watch for file changes and trigger test runs
	csFileWatcher.onDidChange(uri => {
		console.log(`C# file changed: ${uri.fsPath}`);
		triggerTestRun();
	});

	// Also watch for new files
	csFileWatcher.onDidCreate(uri => {
		console.log(`C# file created: ${uri.fsPath}`);
		triggerTestRun();
	});

	// Also watch for deleted files
	csFileWatcher.onDidDelete(uri => {
		console.log(`C# file deleted: ${uri.fsPath}`);
		triggerTestRun();
	});

	// Register a command to manually trigger a test run
	const refreshCommand = vscode.commands.registerCommand('testy.triggerTestRun', () => {
		triggerTestRun();
	});
	context.subscriptions.push(refreshCommand);
}

/**
 * Check if the required C# Dev Kit extension is installed
 * @param context The extension context
 */
async function checkRequiredExtension(context: vscode.ExtensionContext): Promise<void> {
	const csDevKitExtId = 'ms-dotnettools.csdevkit';

	// Check if the extension is already installed
	const extension = vscode.extensions.getExtension(csDevKitExtId);

	// If not installed, prompt the user to install it
	if (!extension) {
		const installButton = 'Install';
		const message = 'The C# Dev Kit extension is required for full functionality of this extension.';

		const selection = await vscode.window.showInformationMessage(message, installButton);

		if (selection === installButton) {
			// Open the extension in the marketplace
			await vscode.commands.executeCommand('extension.open', csDevKitExtId);
		}
	}
}

// This method is called when your extension is deactivated
export function deactivate(): void {
	// Clean up resources when the extension is deactivated
	console.log('testy deactivated');
}
