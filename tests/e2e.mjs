/**
 * Sky Sling — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play (Journey stage 1) → aim with the documented arrow keys to the
 *   exact winning velocity → Space to launch (a real shot through the game's
 *   doLaunch path) → fast-forward with the visible Skip button → "Stage Clear!"
 *   results with score breakdown + stars + persisted progress. Also exercises
 *   pause/resume and the settings overlay through the visible controls.
 * A second pass runs the same load → Play → drag-launch on a mobile touch
 * viewport and verifies a real move registers (shots decrement).
 *
 * The game exposes its rules engine on `window.SkySling.rules`. The test wraps
 * only `rules.applyCommand` as a READ-ONLY observer of the live round state
 * (the same object the session drives) to synchronize on turn/phase and to
 * assert the win — it never calls the move API itself and never performs a
 * move. Every action is a real key press / click / mouse drag on visible
 * controls, identical to a human player's interaction. No game source is
 * modified.
 *
 * Serving: the game ships `server.js` (the StarHermit script declared by
 * starhermit.txt) but is fully playable offline — Play/Journey/Practice/Challenge
 * need no backend, and even the Daily path degrades to the local clock when
 * `/api/v1/time` is unavailable. So, per the sibling convention (picture-logic,
 * blockstead, balance-spire), this test embeds a self-contained node:http static
 * server on an ephemeral port and answers /api/* probes with 200 `{}` so the
 * platform adapter takes its documented offline path with zero console noise.
 * If the UI ever requires the real backend it can be swapped for spawning
 * server.js; today it is not needed.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/sky-sling-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON (200) so the
    // platform adapter degrades to its documented offline path without noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the rules state ----------

// window.SkySling.session is the game's session controller. We capture the
// live rule state the moment a round starts (Session.prototype.startRound)
// and keep observing it as shots mutate the same object in place. Read only:
// shots/shotsUsed/targets/won/phase. We never synthesize a move — every move
// is a real key press / drag / click on the visible UI.
async function installProbe(page) {
  await page.evaluate(() => {
    window.__ssProbe = { state: null, seq: 0 };
    const S = window.SkySling && window.SkySling.session;
    if (!S || !S.Session) throw new Error('SkySling.session.Session missing');
    const orig = S.Session.prototype.startRound;
    S.Session.prototype.startRound = function (mode, ref) {
      const r = orig.call(this, mode, ref);
      if (r && r.ok) { window.__ssProbe.state = this.state; window.__ssProbe.seq++; }
      return r;
    };
  });
}

const readState = (page) => page.evaluate(() => {
  const s = window.__ssProbe?.state;
  if (!s) return null;
  return {
    seq: window.__ssProbe.seq,
    phase: s.phase, over: s.over, won: s.won, reason: s.reason,
    shotsUsed: s.shotsUsed, shots: s.shots,
    targets: s.targets.length, destroyedTargets: s.destroyedTargets,
    destroyedBlocks: s.destroyedBlocks,
  };
});

// Wait until a launch registers (shotsUsed increments) and the screen leaves aim.
const waitShot = (page, before, timeout = 4000) =>
  page.waitForFunction((n) => {
    const s = window.__ssProbe?.state;
    return s && s.shotsUsed > n && s.phase === 'flight';
  }, before, { timeout });

// Wait until the round settles (back to aim or into results).
const waitSettled = (page, timeout = 6000) =>
  page.waitForFunction(() => {
    const s = window.__ssProbe?.state;
    if (!s) return false;
    return s.over || s.phase === 'aim';
  }, null, { timeout });

// -------- one full pass --------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#ov-title:not(.hidden)', { state: 'visible', timeout: 20000 });
    await installProbe(page);
    await page.waitForFunction(() => !!window.__ssProbe?.state || window.SkySling?.rules);
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible`);

    // How to Play from the title must close back onto the title, not onto an
    // empty screen with no round behind it.
    await page.click('#ov-title [data-action="help"]');
    await page.waitForSelector('#ov-help:not(.hidden)', { state: 'visible' });
    await page.click('[data-action="close-help"]');
    await page.waitForSelector('#ov-title:not(.hidden)', { state: 'visible', timeout: 3000 });
    ok(`${name}: help opens from the title and closes back to it`);

    // Play → Journey stage 1
    await page.click('[data-action="play"]');
    if (full) {
      await page.waitForFunction(() => {
        const s = window.__ssProbe?.state;
        return s && s.phase === 'aim' && !s.over;
      }, null, { timeout: 10000 });
    }
    await page.waitForSelector('#hud-title');
    const live = (await page.textContent('#hud-objective')) || '';
    const st0 = await readState(page);
    ok(`${name}: journey started (1 target, ${st0.shots} shots, objective "${live.trim()}")`);
    await page.screenshot({ path: SHOT('play', name) });

    if (full) {
      // pause / resume via the visible buttons
      await page.click('#btn-pause');
      await page.waitForSelector('#ov-pause:not(.hidden)', { state: 'visible' });
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('[data-action="resume"]');
      await page.waitForSelector('#ov-pause.hidden', { state: 'attached' });
      const resumeSt = await readState(page);
      if (resumeSt.phase !== 'aim') throw new Error('resume did not return to aim phase');
      ok(`${name}: pause (❚❚ Pause) and resume work`);

      // settings overlay open/close
      await page.click('#btn-menu');
      await page.waitForSelector('#ov-pause:not(.hidden)', { state: 'visible' });
      await page.click('#ov-pause [data-action="settings"]');
      await page.waitForSelector('#ov-settings:not(.hidden)', { state: 'visible' });
      const qsel = await page.$eval('#ov-settings [data-setting-select="quality"]', (el) => el.value);
      if (!['0', '1', '2'].includes(qsel)) throw new Error('settings quality select not bound: ' + qsel);
      await page.click('[data-action="close-settings"]');
      await page.waitForSelector('#ov-settings.hidden', { state: 'attached' });
      await page.click('[data-action="resume"]');
      await page.waitForSelector('#ov-pause.hidden', { state: 'attached' });
      ok(`${name}: settings overlay opens, bound and closes cleanly`);

      // Real keyboard play: aim to the exact winning velocity and launch.
      // Journey stage 1 (50% of the game's own content) is clearable with one
      // shot at vx 5, vy 7 (verified with the shipped rules engine via the
      // golden per-shot search in test.js). Drive the documented arrow + Space.
      const W = { vx: 5, vy: 7 };
      // step kbAim to the target using the actual arrow keys (0.5/step).
      const hintOf = () => page.textContent('#hint-text').then((t) => (t || '').trim().match(/vx (-?[\d.]+), vy (-?[\d.]+)/));
      let cur = await hintOf(); // may be empty until first arrow
      let cvx = cur ? parseFloat(cur[1]) : 9, cvy = cur ? parseFloat(cur[2]) : 7;
      while (Math.abs(cvx - W.vx) > 1e-9) {
        await page.keyboard.press(cvx > W.vx ? 'ArrowLeft' : 'ArrowRight');
        cvx += cvx > W.vx ? -0.5 : 0.5;
      }
      while (Math.abs(cvy - W.vy) > 1e-9) {
        await page.keyboard.press(cvy > W.vy ? 'ArrowDown' : 'ArrowUp');
        cvy += cvy > W.vy ? -0.5 : 0.5;
      }
      const aimTxt = ((await page.textContent('#hint-text')) || '').trim();
      if (!/vx 5\.0, vy 7\.0/.test(aimTxt)) {
        throw new Error(`did not reach aim vx 5.0 vy 7.0, HUD says "${aimTxt}"`);
      }
      ok(`${name}: keyboard aim set to the winning velocity ("${aimTxt}")`);

      const beforeShot = st0.shotsUsed;
      await page.keyboard.press('Space');
      await waitShot(page, beforeShot);
      ok(`${name}: shot launched (shots used ${beforeShot}→${beforeShot + 1})`);

      // fast-forward the physics with the visible Skip button
      await page.click('#btn-skip');
      await waitSettled(page);
      const final = await readState(page);
      if (!final.won) throw new Error(`round not won: ${JSON.stringify(final)}`);
      if (final.destroyedTargets < final.targets) throw new Error(`not all targets cleared: ${JSON.stringify(final)}`);
      ok(`${name}: level cleared on the visible board (targets ${final.destroyedTargets}/${final.targets}, blocks ${final.destroyedBlocks})`);

      // results screen
      await page.waitForSelector('#ov-results:not(.hidden)', { state: 'visible', timeout: 8000 });
      const resTitle = ((await page.textContent('#res-title')) || '').trim();
      if (!/Stage Clear/.test(resTitle)) throw new Error(`unexpected results title "${resTitle}"`);
      const score = ((await page.textContent('#res-score')) || '').trim();
      const rows = await page.locator('#res-breakdown tbody tr').count();
      if (rows < 3) throw new Error(`score breakdown incomplete: ${rows} rows`);
      const stars = ((await page.textContent('#res-stars')) || '').trim();
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: results shown ("${resTitle}", ${score}, ${rows} breakdown rows, stars "${stars}")`);

      // progress persisted (journey star + best score for stage 1)
      const progress = await page.evaluate(() => {
        const raw = localStorage.getItem('skysling.progress.v1');
        return raw ? JSON.parse(raw) : null;
      });
      if (!progress || !progress.stars || !(progress.stars[0] > 0)) {
        throw new Error('journey stage 1 star not persisted: ' + JSON.stringify(progress));
      }
      if (!progress.bestScores || !(progress.bestScores[0] > 0)) {
        throw new Error('stage 1 best score not persisted');
      }
      ok(`${name}: progress persisted (stage 1 stars: ${progress.stars[0]}, best: ${progress.bestScores[0]})`);
    } else {
      // Mobile: a real drag-launch on the canvas is the slingshot move (tap is a
      // no-op here by design). Do a genuine mouse/pointer drag over the canvas
      // and confirm a shot registers — a real move is made.
      const canvas = await page.$('#gl-canvas');
      const bb = await canvas.boundingBox();
      if (!bb || bb.width < 10 || bb.height < 10) throw new Error('canvas too small to drag: ' + JSON.stringify(bb));
      const sx = bb.x + bb.width / 2, sy = bb.y + bb.height / 2;
      const before = (await readState(page)).shotsUsed;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      // drag back (left + down) so the slingshot launches rightward/up
      await page.mouse.move(sx - 60, sy + 50, { steps: 8 });
      await page.mouse.up();
      try {
        await waitShot(page, before);
      } catch {
        const st = await readState(page);
        throw new Error(`drag did not launch a shot (shotsUsed ${before}→${st.shotsUsed}): ${JSON.stringify(st)}`);
      }
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: drag-launch on the canvas registered a real move (shots used ${before}→${before + 1})`);

      // documented S = fast-forward: it has to work while the shot is resolving,
      // which is exactly when the screen is not 'active'
      await page.keyboard.press('s');
      await waitSettled(page, 1500);
      ok(`${name}: S key fast-forwarded the resolving shot`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — sky-sling, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
