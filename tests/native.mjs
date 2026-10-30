// Native client checks on the StarHermit engine: the TypeScript type check,
// `starhermit check .` (manifest, package, browser module linking, 120
// headless frames; any warning fails), then every tests/native/*.play script
// as a signed-out offscreen run (--render-check) that drives the real UI.
// Also checks that the committed web index (starhermit-files.json) matches
// the files, i.e. that `npm run package` ran after the last change. STARHERMIT
// names the runtime (default: the published 1.29.0 Linux runtime under
// ~/sh/runtime); TSC the TypeScript compiler (default ~/sh/runtime/ts).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = join(homedir(), 'sh/runtime/1.29.0/starhermit-1.29.0-linux-x86_64/starhermit');
const exe = process.env.STARHERMIT || (existsSync(fallback) ? fallback : null);
const tsc = process.env.TSC || join(homedir(), 'sh/runtime/ts/node_modules/.bin/tsc');
let failed = 0;
const fail = (name, e) => { failed++; console.log(`not ok - ${name}\n${String(e.stderr || e.stdout || e.message || e).trim()}`); };

const { files: index, excluded = [] } = JSON.parse(readFileSync(join(root, 'starhermit-files.json'), 'utf8'));
const left = (f) => excluded.some((e) => (e.endsWith('/') ? f.startsWith(e) : f === e));
const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--deduplicate'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && f !== 'starhermit-files.json' && !left(f) && !f.split('/').some((p) => p.startsWith('.')));
const stale = tracked.filter((f) => {
  let data; try { data = readFileSync(join(root, f)); } catch { return false; }
  return !index[f] || index[f].sha256 !== createHash('sha256').update(data).digest('hex');
}).concat(Object.keys(index).filter((f) => !tracked.includes(f)));
if (stale.length) fail('web index is up to date', `stale (run npm run package): ${stale.join(', ')}`);
else console.log('ok - web index matches the files');

if (existsSync(tsc)) {
  try { execFileSync(tsc, ['-p', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); console.log('ok - tsc'); }
  catch (e) { fail('tsc', e); }
} else console.log('SKIP tsc: set TSC to a TypeScript 5 compiler');

if (!exe) {
  console.log('SKIP engine checks: set STARHERMIT to the engine runtime');
  process.exit(failed ? 1 : 0);
}
try {
  const out = execFileSync(exe, ['check', '.', '--quiet'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const warnings = out.split('\n').filter((l) => /^warning/i.test(l));
  if (warnings.length) fail('starhermit check', warnings.join('\n'));
  else console.log('ok - starhermit check');
} catch (e) { fail('starhermit check', e); }
// The Daily depends on the date: today's script is generated (tools/gen-plays.mjs dailyPlay) into a temporary folder.
const { dailyPlay } = await import('../tools/gen-plays.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'sky-sling-daily-'));
const now = new Date();
const today = now.toISOString().slice(0, 10);
writeFileSync(join(tmp, 'daily.play'), dailyPlay(now));
const scripts = readdirSync(join(root, 'tests', 'native')).filter((n) => n.endsWith('.play')).sort().map((f) => [f, `tests/native/${f}`]);
scripts.push([`daily ${today}`, join(tmp, 'daily.play')]);
const shots = process.env.SKYSLING_SHOTS; // optional: where the scripts' `save` frames go
for (const [name, path] of scripts) {
  try {
    execFileSync(exe, ['.', '--render-check', '--guest', '--script', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: shots ? { ...process.env, STARHERMIT_RENDER_CHECK_PNG: shots } : process.env });
    console.log(`ok - ${name}`);
  } catch (e) { fail(name, e); }
}
console.log(failed ? `NATIVE FAIL — ${failed} failed` : 'NATIVE PASS');
process.exit(failed ? 1 : 0);
