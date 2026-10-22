// Mutation check: applies each change in scripts/mutations.mjs to a scratch
// copy of the repo, runs the suite that should notice it, and records whether
// that suite fails. A mutation that survives marks a behaviour no test checks.
// Usage: npm run mutate -- [id-regex] [outDir]
// Env: WORKERS (parallel copies, 4). Browser suites run in Firefox only, and
// the full list takes well over ten minutes, so CI doesn't run it.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutations } from './mutations.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const [filter = '', outArg] = process.argv.slice(2);
const outDir = outArg ?? mkdtempSync(join(tmpdir(), 'playlist-sort-mutate-'));
const workers = Number(process.env.WORKERS ?? 4);
const selected = mutations.filter(mutation => new RegExp(filter).test(mutation.id));
if (!selected.length) { console.error(`no mutation id matches ${filter}`); process.exit(2); }
const suites = {
  sort: ['node', ['--test', 'tests/sort.test.ts']],
  settings: ['node', ['--test', 'tests/settings.test.ts']],
  stats: ['node', ['--test', 'tests/stats.test.ts']],
  youtube: ['node', ['tests/youtube.browser.mjs']],
  userscript: ['sh', ['-c', 'node scripts/build.mjs && node tests/browser.mjs']],
};
mkdirSync(outDir, { recursive: true });
const results = join(outDir, 'results.jsonl');
writeFileSync(results, '');

function tree(name) {
  const dir = join(outDir, `tree-${name}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(repo, dir, { recursive: true, filter: source => !/\/(node_modules|\.git)$/.test(source) });
  symlinkSync(realpathSync(join(repo, 'node_modules')), join(dir, 'node_modules'));
  // One browser is enough to see a failure, so the copies skip Chrome.
  for (const file of ['tests/browser.mjs', 'tests/youtube.browser.mjs']) {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    const line = "  ['chrome', process.env.CHROMIUM_BIN || '/usr/bin/chromium'],\n";
    if (!text.includes(line)) throw new Error(`no chrome line in ${file}`);
    writeFileSync(path, text.replace(line, ''));
  }
  return dir;
}

function runSuite(dir, suite) {
  const [command, args] = suites[suite];
  return new Promise(done => {
    const started = Date.now();
    const child = spawn('nice', ['-n', '19', command, ...args], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, 150000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      kill(); // Browsers the suite left behind.
      done({ code, signal, seconds: Math.round((Date.now() - started) / 1000), output });
    });
  });
}

function why(output) {
  const lines = output.split('\n');
  const failing = lines.filter(line => /^✖ /.test(line)).map(line => line.replace(/ \([\d.]+m?s\)$/, '')).slice(0, 2);
  const assertion = lines.find(line => /AssertionError|Error:|Expected|actual/.test(line)) ?? '';
  return [...failing, assertion.trim()].filter(Boolean).join(' | ').slice(0, 300);
}

const queue = [...selected];
const records = [];
async function worker(index) {
  const dir = tree(index);
  for (let mutation; (mutation = queue.shift());) {
    const path = join(dir, mutation.file);
    const original = readFileSync(path, 'utf8');
    let text = original;
    let error = '';
    for (const [find, replace] of mutation.edits) {
      const count = text.split(find).length - 1;
      if (count !== 1) { error = `find occurs ${count} times: ${find.slice(0, 60)}`; break; }
      text = text.replace(find, () => replace);
    }
    let record;
    if (error) record = { id: mutation.id, status: 'invalid', note: error };
    else {
      writeFileSync(path, text);
      const run = await runSuite(dir, mutation.suite);
      writeFileSync(path, original);
      const status = run.signal ? 'caught-timeout' : run.code !== 0 ? 'caught' : mutation.equivalent ? 'equivalent' : 'survived';
      record = { id: mutation.id, suite: mutation.suite, status, seconds: run.seconds, note: status === 'equivalent' ? mutation.equivalent : status === 'survived' ? '' : why(run.output), what: mutation.what };
      if (status.startsWith('caught')) writeFileSync(join(outDir, `${mutation.id}.log`), run.output);
    }
    records.push(record);
    appendFileSync(results, JSON.stringify(record) + '\n');
    console.log(`${record.status}\t${record.id}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// Each suite must pass unmutated first, or nothing below means anything.
const baseDir = tree('base');
for (const suite of new Set(selected.map(mutation => mutation.suite))) {
  const run = await runSuite(baseDir, suite);
  if (run.code !== 0) { console.error(`baseline ${suite} failed:\n${run.output.slice(-2000)}`); process.exit(1); }
  console.log(`baseline ${suite} passed in ${run.seconds}s`);
}
rmSync(baseDir, { recursive: true, force: true });
await Promise.all(Array.from({ length: workers }, (_, index) => worker(index)));
const left = records.filter(record => record.status === 'survived' || record.status === 'invalid');
const same = records.filter(record => record.status === 'equivalent').length;
console.log(`${records.length - left.length - same} of ${records.length} caught, ${same} equivalent; results in ${results}`);
for (const record of left) console.log(`${record.status}: ${record.id} (${record.what ?? record.note})`);
process.exitCode = left.length ? 1 : 0;
