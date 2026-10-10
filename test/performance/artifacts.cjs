// Require first in a benchmark: mirrors every JSON line the script prints into
// .benchmarks/<script>-<timestamp>.jsonl (git-ignored; `npm run clean` removes it).
// Scratch workspaces stay in the OS temp directory; set TESTY_BENCH_DIR to relocate the results.
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.TESTY_BENCH_DIR || path.resolve(__dirname, '../../.benchmarks');
const script = path.basename(process.argv[1] || 'benchmark', '.cjs');
const file = path.join(dir, `${script}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const log = console.log.bind(console);
console.log = (...args) => {
  log(...args);
  if (typeof args[0] === 'string' && args[0].startsWith('{')) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, args[0] + '\n'); } catch { /* results are best effort */ }
  }
};
