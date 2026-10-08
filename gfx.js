'use strict';

/*
 * Sky Sling - graphics quality model: presets, per-category overrides, GPU
 * detection and a cost summary. Pure (no three.js) so the settings panel, the
 * renderer and the unit tests agree on what each setting means.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.gfx = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

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
    balanced: { scale: 1,    cap: 1.5, shadows: 'low',    ao: 'off',  bloom: 'on',  grade: 'on',  antialias: 'fxaa', reflections: 'on',  particles: 'high', background: 'animated', detail: 'detailed' },
    high:     { scale: 1,    cap: 2,   shadows: 'medium', ao: 'on',   bloom: 'on',  grade: 'on',  antialias: 'smaa', reflections: 'on',  particles: 'high', background: 'animated', detail: 'detailed' },
    ultra:    { scale: 1.25, cap: 2,   shadows: 'high',   ao: 'high', bloom: 'on',  grade: 'on',  antialias: 'msaa', reflections: 'on',  particles: 'high', background: 'animated', detail: 'detailed' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  /* Best preset for this GPU from the unmasked renderer string. Touch/mobile
     devices are capped at Balanced. */
  function detectPreset(gpu, opts) {
    var g = String(gpu || '').toLowerCase();
    var tier = 'balanced';
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) tier = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) tier = 'high';
    if (opts && opts.touch && (tier === 'high' || tier === 'ultra')) tier = 'balanced';
    return tier;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* Resolve saved settings into concrete tiers.
     saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier } */
  function resolve(saved, detected) {
    var s = saved || {};
    var auto = PRESETS.indexOf(s.preset) < 0;
    var preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    var row = TABLE[preset];
    var userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
    var out = { preset: preset, auto: auto, userScale: userScale, scale: row.scale * userScale, cap: row.cap };
    Object.keys(CATEGORIES).forEach(function (cat) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    });
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
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe
  };
});
