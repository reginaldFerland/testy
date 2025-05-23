# C# Test Helper

A Visual Studio Code extension that integrates C# tests into the VS Code Test Explorer interface. This extension helps you discover, view, run, and debug your C# tests directly from the VS Code Test Explorer.

## Features

- **Automatic Test Discovery**: Finds C# test files in your workspace based on naming patterns
- **Real-time Updates**: Monitors file changes to keep the test explorer up-to-date
- **Run Tests**: Run individual tests or test files directly from the test explorer
- **Debug Tests**: Debug tests with full VS Code debugger integration
- **Test Framework Support**: Compatible with popular .NET test frameworks:
  - xUnit ([Fact], [Theory])
  - MSTest ([TestMethod])
  - NUnit ([Test])

## Requirements

- Visual Studio Code 1.99.0+
- .NET SDK 6.0 or higher installed on your system
- C# extension for debugging support

## Usage

1. Open a C# project containing tests
2. The extension automatically discovers test files and populates the Test Explorer
3. Click the test icon in the Activity Bar to open the Test Explorer view
4. Run or debug tests using the buttons in the Test Explorer

### Running Tests

- Click the play button next to a test to run it
- Click the play button at the Test Explorer header to run all tests
- Use the "Run Tests" option in the context menu of a test or test file

### Debugging Tests

- Click the debug icon next to a test to start debugging
- Set breakpoints in your test code before debugging
- Use the "Debug Tests" option in the context menu

## Extension Settings

This extension does not currently add any VS Code settings.

## Known Issues

- Test discovery is based on file naming patterns and may not find all tests if non-standard naming is used

## Release Notes

### 0.0.1

- Initial release
- Basic test discovery and execution
- Support for running and debugging tests
