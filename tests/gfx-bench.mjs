// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics from the
// title, presses Play and keeps slinging the bird with real drags on the canvas — blocks topple, impact sparks,
// debris and dust puffs fly — moving on to the next stage (or retrying) from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#ov-title:not(.hidden)', { state: 'visible', timeout: 20000 });
  await page.click('#ov-title [data-action="settings"]');
  await page.waitForSelector('#ov-settings:not(.hidden)', { state: 'visible' });
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.getAttribute('data-gfx-preset') === p, preset);
  await page.locator('[data-action="close-settings"]').scrollIntoViewIfNeeded();
  await page.click('[data-action="close-settings"]');
  await page.waitForSelector('#ov-title:not(.hidden)', { state: 'visible' });
}

// Read-only observer of the live round state (the same object the session drives), as in tests/e2e.mjs.
async function installProbe(page) {
  await page.evaluate(() => {
    window.__ssBench = { state: null };
    const S = window.SkySling.session.Session;
    const orig = S.prototype.startRound;
    S.prototype.startRound = function (mode, ref) {
      const r = orig.call(this, mode, ref);
      if (r && r.ok) window.__ssBench.state = this.state;
      return r;
    };
  });
}

let pull = 0;
async function step(page) {
  const s = await page.evaluate(() => {
    const st = window.__ssBench.state;
    const results = document.querySelector('#ov-results:not(.hidden)');
    if (results) return { results: true, next: !!document.querySelector('#btn-next:not([hidden]):not([disabled])') };
    return { aim: !!st && st.phase === 'aim' && !st.over };
  });
  if (s.results) {
    await page.click(s.next ? '#btn-next' : '#ov-results [data-action="retry"]', { timeout: 3000 });
    return;
  }
  if (!s.aim) return;
  const bb = await page.locator('#gl-canvas').boundingBox();
  const sx = bb.x + bb.width / 2, sy = bb.y + bb.height / 2;
  // Vary the pull so shots land on different parts of the structure.
  const k = [1, 1.4, 0.8, 1.2][pull++ % 4];
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx - 70 * k, sy + 45 * k, { steps: 6 });
  await page.mouse.up();
}

export async function start(page) {
  await installProbe(page);
  await page.click('[data-action="play"]');
  await page.waitForFunction(() => window.__ssBench.state && window.__ssBench.state.phase === 'aim', null, { timeout: 20000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(300).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
