// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext): void {
	// Log activation
	console.log('Activating the testy extension');

	// Check if the required extension is installed first
	checkRequiredExtension(context).then(hasExtension => {
		// Only proceed with normal initialization if the dependency check passes
		if (hasExtension) {
			// Get configuration settings
			const config = vscode.workspace.getConfiguration('testy');
			const startupDelay = config.get<number>('startupDelay', 10000);

			console.log(`Delaying extension initialization for ${startupDelay}ms to allow other extensions to initialize`);

			// Delay the initialization to give other extensions time to get ready
			setTimeout(() => {
				initializeExtension(context);
			}, startupDelay);
		} else {
			console.log('Required extension not installed. Some functionality may not work.');
		}
	});
}

/**
 * Creates a debounced function that delays invoking the provided function
 * until after the specified wait time has elapsed since the last time it was invoked.
 * @param func The function to debounce
 * @param wait The number of milliseconds to delay
 * @returns A debounced function that can be called repeatedly, but will only execute once per wait period
 */
function debounce<T extends (...args: any[]) => Promise<void> | void>(
	func: T,
	wait: number
): (...args: Parameters<T>) => void {
	let timeout: NodeJS.Timeout | undefined;
	let pendingPromise: Promise<void> | undefined;

	return function (this: any, ...args: Parameters<T>): void {
		// Clear the timeout on each call
		if (timeout) {
			clearTimeout(timeout);
		}

		// Set a new timeout
		timeout = setTimeout(async () => {
			timeout = undefined;

			try {
				// Execute the function and store any returned promise
				const result = func.apply(this, args);
				if (result instanceof Promise) {
					pendingPromise = result;
					await result;
					pendingPromise = undefined;
				}
			} catch (error) {
				console.error('Error in debounced function:', error);
				pendingPromise = undefined;
			}
		}, wait);
	};
}

/**
 * Initialize the extension after the startup delay
 * @param context The extension context
 */
function initializeExtension(context: vscode.ExtensionContext): void {
	console.log('Initializing extension functionality after startup delay');

	// Get configuration settings
	const config = vscode.workspace.getConfiguration('testy');
	const fileWatcherPattern = config.get<string>('fileWatcherPattern', '**/*.cs');
	let debounceDelay = config.get<number>('debounceTime', 1000);
	let runWithCoverage = config.get<boolean>('runWithCoverage', false);

	// Create a file system watcher using the configured pattern
	const fileWatcher = vscode.workspace.createFileSystemWatcher(fileWatcherPattern);
	context.subscriptions.push(fileWatcher);

	// Flag to track if tests are currently running
	let testsRunning = false;

	// Create an efficient debounced test runner with the configurable delay
	let debouncedTestRun = debounce(async () => {
		console.log(`File change detected, triggering test run${runWithCoverage ? ' with coverage' : ''}`);

		// Set the flag to indicate tests are running
		testsRunning = true;

		try {
			// Execute the appropriate VS Code testing command based on coverage setting
			if (runWithCoverage) {
				await vscode.commands.executeCommand('testing.coverageAll');
			} else {
				await vscode.commands.executeCommand('testing.runAll');
			}
		} finally {
			// Reset the flag when tests are done
			testsRunning = false;
		}
	}, debounceDelay);

	// Function to cancel running tests
	const cancelRunningTests = async (): Promise<void> => {
		if (testsRunning) {
			console.log('Cancelling running tests due to new file changes');
			testsRunning = false;
			await vscode.commands.executeCommand('testing.cancelRun');
			// Small delay to ensure cancellation is processed
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	};

	// Watch for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('testy.debounceTime')) {
				// Update debounce time if changed
				debounceDelay = vscode.workspace.getConfiguration('testy').get<number>('debounceTime', 1000);
				console.log(`Debounce delay updated to ${debounceDelay}ms`);
				// Recreate the debounced function with the new delay
				debouncedTestRun = debounce(async () => {
					console.log(`File change detected, triggering test run${runWithCoverage ? ' with coverage' : ''}`);

					// Set the flag to indicate tests are running
					testsRunning = true;

					try {
						if (runWithCoverage) {
							await vscode.commands.executeCommand('testing.coverageAll');
						} else {
							await vscode.commands.executeCommand('testing.runAll');
						}
					} finally {
						// Reset the flag when tests are done
						testsRunning = false;
					}
				}, debounceDelay);
			}
			if (event.affectsConfiguration('testy.runWithCoverage')) {
				// Update coverage setting if changed
				runWithCoverage = vscode.workspace.getConfiguration('testy').get<boolean>('runWithCoverage', true);
				console.log(`Run with coverage set to: ${runWithCoverage}`);
			}
		})
	);

	// Set up a single handler for all file system events
	fileWatcher.onDidChange(async uri => {
		console.log(`File changed: ${uri.fsPath}`);
		// Cancel any running tests before starting a new test run
		await cancelRunningTests();
		debouncedTestRun();
	});

	fileWatcher.onDidCreate(async uri => {
		console.log(`File created: ${uri.fsPath}`);
		// Cancel any running tests before starting a new test run
		await cancelRunningTests();
		debouncedTestRun();
	});

	fileWatcher.onDidDelete(async uri => {
		console.log(`File deleted: ${uri.fsPath}`);
		// Cancel any running tests before starting a new test run
		await cancelRunningTests();
		debouncedTestRun();
	});

	// Register a command to manually trigger a test run
	const refreshCommand = vscode.commands.registerCommand('testy.refreshTests', async () => {
		// Cancel any running tests before starting a new test run
		await cancelRunningTests();
		debouncedTestRun();
	});
	context.subscriptions.push(refreshCommand);
}

/**
 * Check if the required C# Dev Kit extension is installed
 * @param context The extension context
 * @returns Promise<boolean> True if the extension is installed or user dismisses the prompt
 */
async function checkRequiredExtension(context: vscode.ExtensionContext): Promise<boolean> {
	const csDevKitExtId = 'ms-dotnettools.csdevkit';

	// Check if the extension is already installed
	const extension = vscode.extensions.getExtension(csDevKitExtId);

	// If already installed, return true
	if (extension) {
		return true;
	}

	// If not installed, prompt the user to install it
	const installButton = 'Install';
	const dismissButton = 'Not Now';
	const message = 'The C# Dev Kit extension is required for full functionality of this extension.';

	const selection = await vscode.window.showInformationMessage(
		message,
		{ modal: false },
		installButton,
		dismissButton
	);

	if (selection === installButton) {
		// Open the extension in the marketplace
		await vscode.commands.executeCommand('extension.open', csDevKitExtId);
		// Return false since the extension is still not installed
		return false;
	}

	// User dismissed the prompt, return true to continue initialization
	return true;
}

// This method is called when your extension is deactivated
export function deactivate(): void {
	// Clean up resources when the extension is deactivated
	console.log('testy deactivated');
}
