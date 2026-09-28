'use strict';
// Unit tests for the pure graphics quality model (node --test).
const test = require('node:test');
const assert = require('node:assert');
const G = require('../gfx.js');

test('detectPreset: software renderers get low', () => {
  assert.strictEqual(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.strictEqual(G.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.strictEqual(G.detectPreset('Microsoft Basic Render Driver'), 'low');
});

test('detectPreset: discrete GPUs and Apple M get high, others balanced', () => {
  assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.strictEqual(G.detectPreset('ANGLE (AMD, AMD Radeon RX 6800 XT)'), 'high');
  assert.strictEqual(G.detectPreset('Apple M2 Pro'), 'high');
  assert.strictEqual(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)'), 'balanced');
  assert.strictEqual(G.detectPreset('Adreno (TM) 650'), 'balanced');
  assert.strictEqual(G.detectPreset(''), 'balanced');
});

test('detectPreset: touch devices are capped at balanced', () => {
  assert.strictEqual(G.detectPreset('Apple M1', { touch: true }), 'balanced');
  assert.strictEqual(G.detectPreset('SwiftShader', { touch: true }), 'low');
});

test('resolve: auto follows detection, explicit preset wins', () => {
  const a = G.resolve({}, 'low');
  assert.strictEqual(a.preset, 'low');
  assert.strictEqual(a.auto, true);
  assert.strictEqual(a.shadows, 'off');
  assert.strictEqual(a.post, false);
  const h = G.resolve({ preset: 'high' }, 'low');
  assert.strictEqual(h.preset, 'high');
  assert.strictEqual(h.auto, false);
  assert.strictEqual(h.shadows, G.presetTier('high', 'shadows'));
  assert.strictEqual(h.post, true);
  assert.strictEqual(h.adaptive, true);
  assert.strictEqual(h.showFps, false);
});

test('resolve: overrides apply and invalid tiers fall back to the preset', () => {
  const r = G.resolve({ preset: 'low', bloom: 'on', shadows: 'bogus', particles: 'high' }, 'low');
  assert.strictEqual(r.bloom, 'on');
  assert.strictEqual(r.shadows, 'off');
  assert.strictEqual(r.particles, 'high');
  assert.strictEqual(r.post, true);
});

test('resolve: render scale is clamped to 50-200%', () => {
  assert.strictEqual(G.resolve({ preset: 'balanced', render_scale: 5 }).scale, 2);
  assert.strictEqual(G.resolve({ preset: 'balanced', render_scale: 0.1 }).scale, 0.5);
  assert.strictEqual(G.resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
});

test('choosePreset clears category overrides but keeps scale and toggles', () => {
  const s = G.choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, show_fps: true, adaptive: false }, 'high');
  assert.deepStrictEqual(s, { preset: 'high', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.strictEqual(G.resolve(s, 'low').bloom, G.presetTier('high', 'bloom'));
});

test('describe summarises cost and pixels', () => {
  const d = G.describe(G.resolve({ preset: 'high' }), [1920, 1080]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1920×1080 px/);
  assert.match(G.describe(G.resolve({ preset: 'low' })), /no shadows/);
});
