import tseslint from 'typescript-eslint';
import js from '@eslint/js';

const nodeGlobals = {
    require: 'readonly',
    module: 'writable',
    exports: 'writable',
    __dirname: 'readonly',
    __filename: 'readonly',
    process: 'readonly',
    Buffer: 'readonly',
    console: 'readonly',
    global: 'readonly',
    globalThis: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly',
    queueMicrotask: 'readonly',
    structuredClone: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    fetch: 'readonly',
    performance: 'readonly'
};

export default tseslint.config(
    {
        files: ['src/**/*.ts'],
        extends: [...tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
        },
        rules: {
            '@typescript-eslint/naming-convention': ['error', { selector: 'import', format: ['camelCase', 'PascalCase'] }],
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            // Cancellation and cleanup paths deliberately propagate the caught
            // value (often an AbortSignal reason) unchanged.
            '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true, allowThrowingAny: true }],
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            '@typescript-eslint/return-await': ['error', 'in-try-catch'],
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
            '@typescript-eslint/no-unnecessary-type-conversion': 'error',
            curly: 'error',
            eqeqeq: 'error',
            'no-throw-literal': 'error',
            semi: 'error'
        }
    },
    {
        // Layering: core is pure; services do not reach into the UI.
        files: ['src/core/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
                paths: [{ name: 'vscode', message: 'src/core must not depend on the VS Code API.' }],
                patterns: [{ group: ['**/services/*', '**/ui/*', '../controller', '../configuration', '../extension'], message: 'src/core must not import services, ui or the extension host.' }]
            }]
        }
    },
    {
        files: ['src/services/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
                patterns: [{ group: ['**/ui/*', '../controller', '../configuration', '../extension'], message: 'src/services must not import ui or the extension host.' }]
            }]
        }
    },
    {
        // CommonJS test files: syntax and scope rules (type-aware promise rules follow).
        files: ['test/**/*.cjs'],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: nodeGlobals
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-undef': 'error',
            eqeqeq: 'error',
            // Off for tests: the suites use dense one-line statements without braces.
            curly: 'off',
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        // Type-aware promise rules for every test file, using tsconfig.tests.json.
        files: ['test/**/*.cjs'],
        extends: [tseslint.configs.base],
        languageOptions: {
            parserOptions: { project: './tsconfig.tests.json', tsconfigRootDir: import.meta.dirname }
        },
        rules: {
            // node:test registration calls return promises that the runner tracks itself.
            '@typescript-eslint/no-floating-promises': ['error', {
                allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }]
            }],
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error'
        }
    },
    {
        // Root ES module config, build scripts and the extension-test runner.
        files: ['*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
        extends: [js.configs.recommended, tseslint.configs.base],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: nodeGlobals,
            parserOptions: { project: './tsconfig.scripts.json', tsconfigRootDir: import.meta.dirname }
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error'
        }
    },
    {
        // Dynamic code evaluation has no place in the extension, its tests or its scripts.
        files: ['src/**/*.ts', 'test/**/*.cjs', '*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
        rules: {
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error'
        }
    }
);
