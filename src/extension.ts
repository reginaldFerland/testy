// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CSharpTestController } from './test-explorer/csharp-test-controller';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext): void {
	// Log activation
	console.log('Activating the C# Test Explorer extension');

	// Create and register our test controller
	const csharpTestController = new CSharpTestController();
}

// This method is called when your extension is deactivated
export function deactivate(): void {
	// Clean up resources when the extension is deactivated
	console.log('C# Test Explorer extension deactivated');
}
