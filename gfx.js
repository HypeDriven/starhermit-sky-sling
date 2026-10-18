'use strict';

/*
 * Sky Sling - graphics quality model: presets, per-category overrides,
 * StarHermit hardware-level detection, per-preset asset/effect budgets and a
 * cost summary. Pure (no three.js) so the settings panel, the renderer and the
 * unit tests agree on what each setting means.
 */
(function (root, factory) {
  // gpu-level.js (shared StarHermit copy) is a classic script loaded before this one
  // (window.StarHermitGpu); under node it is required directly.
  var gpu = (typeof module !== 'undefined' && module.exports) ? require('./gpu-level.js') : root.StarHermitGpu;
  var api = factory(gpu);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.gfx = api;
})(typeof self !== 'undefined' ? self : globalThis, function (GPU) {

  var PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  var CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    ao: ['off', 'on', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],
    particles: ['low', 'high'],
    background: ['static', 'animated'],
    detail: ['plain', 'detailed']
  };

  // Each preset: a tier per category, a render scale (multiplies the device
  // pixel ratio) and a device-pixel-ratio cap.
  var TABLE = {
    low:      { scale: 1,    cap: 1,   shadows: 'off',    ao: 'off',  bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', particles: 'low',  background: 'static',   detail: 'plain' },
    balanced: { scale: 0.85, cap: 1.5, shadows: 'low',    ao: 'off',  bloom: 'on',  grade: 'on',  antialias: 'fxaa', reflections: 'on',  particles: 'high', background: 'animated', detail: 'detailed' },
    high:     { scale: 1,    cap: 2,   shadows: 'medium', ao: 'on',   bloom: 'on',  grade: 'on',  antialias: 'smaa', reflections: 'on',  particles: 'high', background: 'animated', detail: 'detailed' },
    ultra:    { scale: 1.25, cap: 2,   shadows: 'high',   ao: 'high', bloom: 'on',  grade: 'on',  antialias: 'msaa', reflections: 'on',  particles: 'high', background: 'animated', detail: 'detailed' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  // Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 /
  // Intel UHD or weaker, 20 = RTX 5090, each level ~1.23x the one below):
  // Low from 0, Balanced from 4, High from 10, Ultra from 17. Phones, tablets
  // and <= 4 GB machines are capped at level 9 by gpu-level.js.
  var LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

  /* Hardware level 0-20 for an unmasked renderer string plus
     StarHermitGpu.detectSystem() facts (mobile, cores, memoryGb, screen...). */
  function detectLevel(gpu, system) {
    if (!GPU) return LEVELS.balanced;
    var sys = Object.assign({ webgl: true, webgl2: true }, system || {});
    sys.gpu = String(gpu || '');
    return GPU.detectLevel(sys);
  }

  /* The preset Auto starts from for a hardware level. */
  function presetForLevel(level) {
    if (GPU) return GPU.presetForLevel(level, LEVELS);
    return PRESETS.filter(function (p) { return LEVELS[p] <= level; }).pop() || 'low';
  }

  /* Best preset for this GPU (the level already caps phones/tablets at Balanced). */
  function detectPreset(gpu, system) {
    return presetForLevel(detectLevel(gpu, system));
  }

  /*
   * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on
   * the weakest GPU Auto gives it (Low -> level 0, Balanced -> 4, High -> 10,
   * Ultra -> 17; measured with tests/gfx-bench.mjs). Gameplay, physics and hit
   * areas are identical on every preset - only visuals change.
   *   material  shading model for the scene: 'lambert' (per-vertex diffuse),
   *             'standard' (PBR, clearcoat dropped) or 'physical' (clearcoat
   *             on the bird, critters and ice)
   *   segments  sphere/cylinder/torus tessellation as a share of the authored
   *             counts (bird, critters, island, palms, foam, debris)
   *   texture   procedural wood/stone/ice/sand/grass texture size in px
   *   clouds    drifting cloud clusters in the sky (each merged to one draw)
   *   sparks    impact sparks per big hit at Particles "high", scaled with the
   *             level (StarHermitGpu.scaleBudget, <= 2x)
   *   bloomRes / aoRes  bloom and GTAO resolution as a share of the frame
   */
  var BUDGETS = {
    low:      { material: 'lambert',  segments: 0.5,  texture: 128, clouds: 3, sparks: 10, bloomRes: 0.5, aoRes: 0.5 },
    balanced: { material: 'standard', segments: 0.75, texture: 256, clouds: 6, sparks: 16, bloomRes: 0.5, aoRes: 0.5 },
    high:     { material: 'physical', segments: 1,    texture: 256, clouds: 8, sparks: 20, bloomRes: 0.5, aoRes: 0.5 },
    ultra:    { material: 'physical', segments: 1.5,  texture: 512, clouds: 10, sparks: 28, bloomRes: 1, aoRes: 1 }
  };
  var SPARK_MAX = 56;

  /* A preset's concrete budget for a hardware level (counts scale <= 2x within the preset). */
  function budgetFor(preset, level) {
    var b = Object.assign({}, BUDGETS[preset] || BUDGETS.balanced);
    var floor = LEVELS[preset] || 0;
    var lv = Math.max(isFinite(level) && level != null ? level : floor, floor);
    var k = GPU ? Math.min(2, GPU.scaleBudget(1, lv, floor)) : 1;
    b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
    return b;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* Resolve saved settings into concrete tiers.
     saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier } */
  function resolve(saved, detected, level) {
    var s = saved || {};
    var auto = PRESETS.indexOf(s.preset) < 0;
    var preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    var row = TABLE[preset];
    var userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
    var out = { preset: preset, auto: auto, userScale: userScale, scale: row.scale * userScale, cap: row.cap };
    Object.keys(CATEGORIES).forEach(function (cat) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    });
    out.level = isFinite(level) && level != null ? level : LEVELS[preset];
    out.budget = budgetFor(preset, out.level);
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    // The composer runs only when an effect needs it; plain MSAA uses the canvas.
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /* Choosing a preset clears every per-category override (keeps scale/toggles). */
  function choosePreset(saved, preset) {
    var s = saved || {};
    var out = { preset: PRESETS.indexOf(preset) >= 0 ? preset : 'auto' };
    if (s.render_scale != null) out.render_scale = s.render_scale;
    if (s.adaptive != null) out.adaptive = s.adaptive;
    if (s.show_fps != null) out.show_fps = s.show_fps;
    return out;
  }

  /* The preset's own tier for a category (for "From preset (...)" labels). */
  function presetTier(preset, cat) {
    return TABLE[preset] ? TABLE[preset][cat] : undefined;
  }

  var WORDS_EN = {
    noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
    bloom: 'bloom', reflections: 'sky reflections', noAA: 'no anti-aliasing'
  };

  /* Cost summary. `words` optionally localizes the fragments. */
  function describe(r, pixels, words) {
    var w = words || WORDS_EN;
    var parts = [
      r.shadows === 'off' ? w.noShadows : SHADOW_MAP[r.shadows] + '² ' + w.shadows,
      r.ao === 'off' ? null : (r.ao === 'high' ? w.aoHigh : w.ao),
      r.bloom === 'on' ? w.bloom : null,
      r.reflections === 'on' ? w.reflections : null,
      r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS, CATEGORIES: CATEGORIES, SHADOW_MAP: SHADOW_MAP,
    LEVELS: LEVELS, BUDGETS: BUDGETS, SPARK_MAX: SPARK_MAX, budgetFor: budgetFor,
    detectLevel: detectLevel, presetForLevel: presetForLevel,
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe
  };
});
