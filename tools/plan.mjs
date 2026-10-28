// A keyboard bot over the real rules (rules.js, content.js): for each shot it
// tries every keyboard aim the arrows reach (vx 1 … 17.5, vy −4 … 17.5 in
// 0.5 steps, as main.ts aimStep moves them, within the sling's 19.5 m/s) and
// takes the one that brings down the most Bumbles (then the most block
// score, then the fewest key presses from the current aim), until the stage
// is cleared or out of shots. Returns each shot's presses and how many rules
// ticks it took to settle, so play scripts can wait exactly.
//   import { planLevel } from './plan.mjs'; planLevel(level, { vx: 9, vy: 7 })
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../rules.js');

const STEP = 0.5;
const clone = (s) => JSON.parse(JSON.stringify(s));

function simulate(state, vx, vy) {
  const s = clone(state);
  const r = R.applyCommand(s, { id: 'plan', type: 'launch', vx, vy });
  if (!r.ok) return null;
  let ticks = 0;
  while (s.phase === 'flight' && !s.over && ticks < 60 * 30) { R.tick(s); ticks++; }
  return { s, ticks };
}

/** The presses from aim a to b: [key, count] pairs (vx with ←/→ first, then vy with ↑/↓). */
function presses(a, b) {
  const out = [];
  const dx = Math.round((b.vx - a.vx) / STEP), dy = Math.round((b.vy - a.vy) / STEP);
  if (dx) out.push([dx > 0 ? 'ArrowRight' : 'ArrowLeft', Math.abs(dx)]);
  if (dy) out.push([dy > 0 ? 'ArrowUp' : 'ArrowDown', Math.abs(dy)]);
  // a launch needs at least one aim press since the last one (main.ts kbAim.active)
  if (!out.length) out.push(b.vx > 1 ? ['ArrowLeft', 1] : ['ArrowRight', 1], b.vx > 1 ? ['ArrowRight', 1] : ['ArrowLeft', 1]);
  return out;
}

export function planLevel(level, aim = { vx: 9, vy: 7 }) {
  let state = R.createState(level);
  const shots = [];
  let cur = { ...aim };
  while (!state.over && state.shotsUsed < state.shots) {
    let best = null;
    for (let vx = 1; vx <= 17.5 + 1e-9; vx += STEP) {
      for (let vy = -4; vy <= 17.5 + 1e-9; vy += STEP) {
        if (Math.hypot(vx, vy) > R.MAX_SPEED) continue;
        const res = simulate(state, vx, vy);
        if (!res) continue;
        const keys = presses(cur, { vx, vy }).reduce((n, p) => n + p[1], 0);
        const score = [res.s.destroyedTargets, R.computeScore(res.s).blocks, -keys];
        if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) {
          best = { vx, vy, score, res };
        }
      }
    }
    shots.push({ from: cur, vx: best.vx, vy: best.vy, keys: presses(cur, best), ticks: best.res.ticks });
    cur = { vx: best.vx, vy: best.vy };
    state = best.res.s;
  }
  return { shots, won: state.won, total: R.computeScore(state).total, aim: cur, state };
}
