/** Variables that change on every editor or terminal launch without affecting
 * builds or collectors. Including them in a cache identity defeats reuse after
 * a restart. Variables that MSBuild or the runtime can read are kept. */
const volatile = /^(?:VSCODE_.*|ELECTRON_.*|SHLVL|_|OLDPWD|TERM_SESSION_ID|ITERM_SESSION_ID|SECURITYSESSIONID|WINDOWID|SSH_AUTH_SOCK|XPC_SERVICE_NAME|CHROME_CRASHPAD_PIPE_NAME|APPLICATION_INSIGHTS_NO_DIAGNOSTIC_CHANNEL)$/i;

export function isVolatileVariable(name: string): boolean { return volatile.test(name); }

/** A copy whose volatile variables are unset, suitable for launching and hashing. */
export function stableEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = { ...env };
    for (const name of Object.keys(result)) {if (isVolatileVariable(name)) {result[name] = undefined;}}
    return result;
}

/** Sorted defined entries for a cache identity. */
export function environmentIdentity(env: NodeJS.ProcessEnv): readonly (readonly [string, string])[] {
    return Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !isVolatileVariable(entry[0]))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
