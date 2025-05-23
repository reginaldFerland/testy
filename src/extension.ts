// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "testy" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('testy.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from testy!');
	});

	context.subscriptions.push(disposable);

	// Set up file system watcher for .cs files
	const csWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');

	// Watch for file created events
	csWatcher.onDidCreate(uri => {
		console.log(`CS file created: ${uri.fsPath}`);
		vscode.window.showInformationMessage(`CS file created: ${uri.fsPath}`);
	});

	// Watch for file changed events
	csWatcher.onDidChange(uri => {
		console.log(`CS file changed: ${uri.fsPath}`);
		vscode.window.showInformationMessage(`CS file changed: ${uri.fsPath}`);
	});

	// Watch for file deleted events
	csWatcher.onDidDelete(uri => {
		console.log(`CS file deleted: ${uri.fsPath}`);
		vscode.window.showInformationMessage(`CS file deleted: ${uri.fsPath}`);
	});

	// Make sure to dispose the watcher when the extension is deactivated
	context.subscriptions.push(csWatcher);
}

// This method is called when your extension is deactivated
export function deactivate() { }
