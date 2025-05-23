# GitHub Copilot Instructions

## Project Overview
This project "testy" is a VS Code extension that integrates C# tests with VS Code's Test Explorer. When making suggestions, please adhere to the following guidelines.

## Functional Programming Practices

### 1. Immutability
- Prefer `const` over `let` for variable declarations
- Use immutable data structures and avoid direct mutation of objects and arrays
- Create new copies of data structures instead of modifying existing ones
- Use the spread operator (`...`) for creating new objects/arrays with modifications

### 2. Pure Functions
- Functions should not have side effects when possible
- Functions should return a value and not modify external state
- The same input should always produce the same output
- Avoid functions that rely on or modify global state

### 3. Function Composition
- Break complex operations into smaller, reusable functions
- Use function composition to build more complex operations
- Consider utility libraries that support functional programming patterns

### 4. Higher-Order Functions
- Use functions like map, filter, reduce instead of imperative loops
- Create functions that accept other functions as parameters
- Return functions from functions when appropriate

### 5. Optional and Error Handling
- Use Option/Maybe patterns instead of null/undefined checks
- Prefer explicit error handling with Either/Result patterns
- Avoid throwing exceptions in favor of returning error objects

### 6. Recursion
- Consider recursive solutions when appropriate
- Be mindful of stack limitations and use tail recursion when possible

### 7. TypeScript Best Practices
- Use strong typing and avoid `any`
- Leverage union types, intersection types, and generics
- Define interfaces for all data structures
- Use readonly modifiers for immutable properties

### 8. VSCode Extension Context
- When working with the VSCode API, wrap side-effectful operations in pure functions where possible
- Isolate side effects required by the VSCode extension API
- Maintain a clear separation between pure business logic and VSCode integration code

### 9. Testing
- Write tests that validate function outputs for given inputs
- Mock external dependencies in tests
- Test functions in isolation

## Project-Specific Guidelines

### File Structure
- Place functional utilities in the `utils` directory
- Maintain separation between services, models, and UI components
- Keep test discovery and execution logic separate from UI rendering

Remember that full functional programming purity may not always be achievable in a VS Code extension context due to the nature of the API, but we should strive for functional principles wherever possible.