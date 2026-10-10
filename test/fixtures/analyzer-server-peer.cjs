// A stand-in for Testy.Analysis.dll, launched through Node as the "dotnet" host.
// `--server` speaks the line protocol; two files (request, response) mimic the
// one-shot mode. The request's `mode` selects the behavior under test.
const fs = require('node:fs');
const readline = require('node:readline');

if (!process.argv.includes('--server')) {
    const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    if ((request.mode ?? request.aliasSources?.[0]) === 'fallback-fail') {process.stderr.write('one-shot failed'); process.exit(1);}
    fs.writeFileSync(process.argv[3], JSON.stringify(['one-shot', process.env.DOTNET_TieredPGO ?? null]));
    return;
}
if (process.env.PEER_START === 'exit') {process.stderr.write('refusing to start'); process.exit(7);}
if (process.env.PEER_START === 'noise') {process.stdout.write('not the protocol\n'); return setTimeout(() => undefined, 60_000);}
if (process.env.PEER_START === 'silent') {return setTimeout(() => undefined, 60_000);}
const out = line => process.stdout.write(line + '\n');
const waiting = new Map();
out('{"ready":1}');
// Exit when the input closes, like the real server.
readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.cancel !== undefined) {
        const cancel = waiting.get(message.cancel);
        if (cancel) {cancel();}
        return;
    }
    const { id, cwd, request } = message;
    switch (request.mode ?? request.aliasSources?.[0]) {
        case 'echo': return out(`{"id":${id},"result":${JSON.stringify({ pid: process.pid, cwd, env: process.env.PEER_MARK ?? null, request })}}`);
        case 'fail': return out(`{"id":${id},"error":${JSON.stringify('boom\nwith lines')}}`);
        case 'crash': return process.exit(3);
        case 'garbage': return out('nonsense');
        case 'hang': return undefined;
        case 'slow': {
            // Finishes on its own, or earlier when cancelled; `stubborn` ignores the cancel.
            const timer = setTimeout(() => {waiting.delete(id); out(`{"id":${id},"result":"done"}`);}, request.ms ?? 300);
            if (!request.stubborn) {waiting.set(id, () => {clearTimeout(timer); waiting.delete(id); out(`{"id":${id},"error":"cancelled"}`);});}
            return undefined;
        }
        default: return out(`{"id":${id},"result":${JSON.stringify(request.aliasSources ? ['server'] : null)}}`);
    }
}).on('close', () => process.exit(0));
