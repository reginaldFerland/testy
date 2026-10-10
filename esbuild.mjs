import * as esbuild from 'esbuild';

// Bundles the extension host entry point and the Node scripts it starts
// (worker threads and the POSIX process owner) into dist/. tsc still emits
// out/ for the Node test suites.
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
    entryPoints: {
        extension: 'src/extension.ts',
        cacheWorker: 'src/services/cacheWorker.ts',
        coverageWorker: 'src/services/coverageWorker.ts',
        posixOwner: 'src/services/posixOwner.ts'
    },
    outdir: 'dist',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'info'
};

// Marks build boundaries for the VS Code background problem matcher.
const watchMarkers = {
    name: 'watch-markers',
    setup(build) {
        build.onStart(() => console.log('[watch] build started'));
        build.onEnd(result => {
            for (const { text, location } of result.errors) {console.error(`✘ [ERROR] ${location ? `${location.file}:${location.line}:${location.column}: ` : ''}${text}`);}
            console.log('[watch] build finished');
        });
    }
};

if (watch) {
    const context = await esbuild.context({ ...options, logLevel: 'silent', plugins: [watchMarkers] });
    await context.watch();
} else {
    await esbuild.build(options);
}
