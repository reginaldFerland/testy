/**
 * Data interfaces for C# test discovery and execution
 */

/**
 * Represents a C# test project
 */
export interface CSharpTestProject {
    /** Project file path */
    projectPath: string;
    /** Directory containing the project file */
    projectDir: string;
}

/**
 * Represents a test method found in a C# file
 */
export interface TestMethod {
    /** Name of the test method */
    name: string;
    /** Type of test attribute (Fact, Theory, Test, TestMethod) */
    attribute: string;
    /** Position in document */
    position: {
        /** Line where the test method is defined */
        line: number;
        /** Character position in the line */
        character: number;
        /** Length of the test method declaration line */
        lineLength: number;
    };
}

/**
 * Represents the result of a test run
 */
export interface TestRunResult {
    /** Whether the test passed */
    success: boolean;
    /** Error message or success message */
    message: string;
    /** Duration of the test run in milliseconds */
    duration?: number;
}

/**
 * Represents test configuration options
 */
export interface TestConfig {
    /** Test file discovery patterns */
    testFilePatterns: string[];
    /** Whether to auto-run tests on file change */
    autoRunTests: boolean;
    /** Additional arguments to pass to dotnet test */
    additionalTestArgs: string[];
}