# Testy - C# Test Helper

A Visual Studio Code extension that enhances the test experience for C# projects, by automatically triggering test runs when files change and providing integration with VS Code's built-in Test Explorer.

## Features

- **Auto Test Execution**: Automatically runs tests when C# files are changed
- **Test Explorer Integration**: Leverages VS Code's built-in Test Explorer
- **Coverage Support**: Option to run tests with code coverage
- **File Watching**: Monitors file changes to keep test results up-to-date
- **Manual Refresh**: Refresh tests anytime with a single click

## Requirements

- Visual Studio Code 1.99.0+
- C# Dev Kit extension (automatically prompted for installation)
- .NET SDK installed on your system

## Usage

1. Open a C# project containing tests
2. The extension will automatically watch for file changes and trigger test runs
3. Click the test icon in the Activity Bar to open the Test Explorer view
4. Use the refresh button in the Test Explorer header to manually trigger a test run

### Running Tests

- Tests run automatically when C# files change
- Click the refresh button in Test Explorer for manual test execution
- Use standard Test Explorer features to run individual tests or groups of tests

### Test Coverage

- Coverage is enabled by default and can be configured in settings

## Extension Settings

This extension contributes the following settings:

* `testy.fileWatcherPattern`: Glob pattern for files to watch for changes (default: `**/*.cs`)
* `testy.debounceTime`: Delay in milliseconds before triggering tests after file changes (default: `1000`)
* `testy.runWithCoverage`: Whether to run tests with coverage (default: `true`)
* `testy.startupDelay`: Delay in milliseconds before initializing the extension (default: `10000`)

## Known Issues

None at this time.

## Release Notes

### 0.0.1

- Initial release
- Automatic test execution on file changes
- Test Explorer integration
- Coverage support
