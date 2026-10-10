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
        // CommonJS test files. Syntax and scope rules only; no type-aware rules.
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
        // Root ES module config and build scripts.
        files: ['*.mjs'],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: nodeGlobals
        }
    }
);
