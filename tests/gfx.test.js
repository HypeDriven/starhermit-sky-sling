'use strict';
// Unit tests for the pure graphics quality model (node --test).
const test = require('node:test');
const assert = require('node:assert');
const G = require('../gfx.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.strictEqual(G.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.strictEqual(G.detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.strictEqual(G.detectPreset('Microsoft Basic Render Driver', DESK), 'low');
  assert.strictEqual(G.detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.strictEqual(G.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.strictEqual(G.detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.strictEqual(G.detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.strictEqual(G.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(G.LEVELS)) assert.strictEqual(G.presetForLevel(lv), p);
  assert.strictEqual(G.presetForLevel(3), 'low');
  assert.strictEqual(G.presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.strictEqual(G.detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(G.detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.strictEqual(G.detectPreset('NVIDIA GeForce RTX 5090', PHONE), 'balanced');
  assert.strictEqual(G.detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'segments', 'texture', 'clouds', 'sparks', 'bloomRes', 'aoRes'];
  for (const p of G.PRESETS) for (const k of keys) assert.ok(G.BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < G.PRESETS.length; i++) {
    for (const k of keys) {
      if (typeof G.BUDGETS.low[k] === 'number') assert.ok(G.BUDGETS[G.PRESETS[i]][k] >= G.BUDGETS[G.PRESETS[i - 1]][k], `${G.PRESETS[i]}.${k}`);
    }
  }
  assert.deepStrictEqual(G.PRESETS.map((p) => G.BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepStrictEqual(G.resolve({ preset: 'high' }, 'low', 10).budget, { ...G.BUDGETS.high }, 'floor level = the tuned budget');
  assert.deepStrictEqual(G.resolve({ preset: 'ultra' }, 'low', 0).budget, G.resolve({ preset: 'ultra' }, 'ultra', 17).budget,
    'manual Ultra on a weak GPU keeps the Ultra floor budget');
  assert.ok(G.budgetFor('high', 14).sparks > G.budgetFor('high', 10).sparks, 'counts scale up within the preset');
  assert.ok(G.budgetFor('ultra', 20).sparks <= G.SPARK_MAX);
  assert.strictEqual(G.resolve({}, 'low', 0).level, 0);
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
  assert.strictEqual(G.resolve({ preset: 'high', render_scale: 5 }).scale, 2);
  assert.strictEqual(G.resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.strictEqual(G.resolve({ preset: 'balanced', render_scale: 5 }).userScale, 2);
  assert.strictEqual(G.resolve({ preset: 'balanced', render_scale: 1 }).scale, 0.85, 'Balanced renders at 85%');
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
