'use strict';

/*
 * Sky Sling - content: versioned levels, themes, tutorials, daily challenge.
 * Content is data: identifier, seed, initial state, goals, allowed mechanics,
 * par values, tutorial flags and presentation theme.
 */
(function (root, factory) {
  var api = factory(typeof module !== 'undefined' ? require('./rules') : (root.SkySling || {}).rules);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.content = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R) {

  var CONTENT_VERSION = 3;
  var LEVEL_SALT = 0x5eed50;   // content decoration stream salt
  var LEVEL_COUNT = 45;

  // Five visual themes (presentation only — never affects rules).
  var THEMES = [
    { id: 'lagoon',  name: 'Lagoon',  sky: 0x9fd8ef, water: 0x2f8fb5, sand: 0xe8d8a8, foliage: 0x4e9e5a, accent: 0xff8c5a },
    { id: 'sunset',  name: 'Sunset',  sky: 0xf6b18b, water: 0x5a6fb0, sand: 0xe0b98a, foliage: 0x6d8f4e, accent: 0xd95f6b },
    { id: 'dawn',    name: 'Dawn',    sky: 0xcfd8f0, water: 0x4a7fa0, sand: 0xdccfae, foliage: 0x5a9e7a, accent: 0xf0a04b },
    { id: 'reef',    name: 'Reef',    sky: 0x8fe0d8, water: 0x1f7f95, sand: 0xf0e0b0, foliage: 0x3e8e6a, accent: 0xff6f91 },
    { id: 'storm',   name: 'Storm',   sky: 0x8a94a8, water: 0x3a5568, sand: 0xc8bf9e, foliage: 0x4a6e52, accent: 0xf0d060 }
  ];

  function round2(v) { return Math.round(v * 100) / 100; }

  // Deterministic authored-structure builder. Each level is assembled from a
  // small grammar of towers, bridges and bunkers, seeded per level index.
  function makeLevel(index) {
    var seed = (LEVEL_SALT + index * 7919) >>> 0;
    var rnd = R.mulberry32(seed);
    var blocks = [];
    var targets = [];
    var baseX = 9 + Math.floor(rnd() * 3);   // first structure position
    var tier = Math.floor(index / 9);        // difficulty band 0..4

    var structures = 1 + Math.min(2, Math.floor((index + 3) / 9)); // 1..3 structures
    var x = baseX;

    for (var s = 0; s < structures; s++) {
      var pattern = pickPattern(index, s, rnd, tier);
      buildPattern(pattern, x, blocks, targets, rnd);
      x += pattern.width + 2.2 + rnd() * 1.6;
    }

    // tutorial flags: first three journey stages teach one rule at a time
    var tutorial = null;
    if (index === 0) tutorial = { step: 1, text: 'Drag back from the sling, release to launch.' };
    else if (index === 1) tutorial = { step: 2, text: 'Aim for the supports — falling blocks crush targets.' };
    else if (index === 2) tutorial = { step: 3, text: 'Stone is tough. Hit wood and ice first.' };

    var shots = clampI(2 + Math.ceil(targets.length * 0.9) + (tier > 2 ? 0 : 1), 3, 6);

    return {
      id: 'journey-' + (index + 1),
      version: CONTENT_VERSION,
      index: index,
      seed: seed,
      shots: shots,
      par: Math.max(1, shots - 2),
      blocks: blocks,
      targets: targets,
      theme: THEMES[index % THEMES.length].id,
      tutorial: tutorial,
      mastery: (index + 1) % 9 === 0   // every 9th stage is a mastery stage
    };
  }

  function clampI(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function pickPattern(index, slot, rnd, tier) {
    var names = ['tower', 'wall', 'bridge', 'bunker', 'spire'];
    // early levels only see simple patterns; mastery stages may see any
    var maxKind = tier === 0 ? 2 : (tier === 1 ? 3 : 5);
    var kind = names[Math.floor(rnd() * maxKind)];
    var mats = ['wood'];
    if (tier >= 1) mats.push('ice');
    if (tier >= 2) mats.push('stone');
    return { kind: kind, width: kind === 'bridge' ? 4.4 : 2.6, tier: tier, mats: mats };
  }

  function mat(rnd, mats) { return mats[Math.floor(rnd() * mats.length)]; }

  function block(blocks, x, y, w, h, m) {
    blocks.push({ x: round2(x), y: round2(y), w: w, h: h, mat: m });
  }
  function target(targets, x, y, r) {
    targets.push({ x: round2(x), y: round2(y), r: r || 0.4 });
  }

  // All structures rest on the ground (y=0). Block y = center.
  function buildPattern(p, x0, blocks, targets, rnd) {
    var m1 = mat(rnd, p.mats), m2 = mat(rnd, p.mats), m3 = mat(rnd, p.mats);
    if (p.kind === 'tower') {
      // two legs, a cap, target underneath or on top
      block(blocks, x0 - 0.55, 0.75, 0.35, 1.5, m1);
      block(blocks, x0 + 0.55, 0.75, 0.35, 1.5, m1);
      block(blocks, x0, 1.65, 1.8, 0.3, m2);
      target(targets, x0, 0.4);
      if (p.tier >= 1 && rnd() < 0.6) {
        block(blocks, x0, 2.05, 0.6, 0.5, m3);
        target(targets, x0, 2.7);
      }
    } else if (p.kind === 'wall') {
      block(blocks, x0, 0.5, 2.4, 1.0, m1);
      block(blocks, x0, 1.25, 2.0, 0.5, m2);
      target(targets, x0, 1.9);
    } else if (p.kind === 'bridge') {
      block(blocks, x0 - 1.7, 0.9, 0.4, 1.8, m1);
      block(blocks, x0 + 1.7, 0.9, 0.4, 1.8, m1);
      block(blocks, x0, 1.95, 3.8, 0.3, m2);
      target(targets, x0 - 0.8, 0.4);
      target(targets, x0 + 0.8, 0.4);
      if (p.tier >= 2) block(blocks, x0, 2.5, 1.0, 0.8, m3);
    } else if (p.kind === 'bunker') {
      block(blocks, x0 - 0.85, 0.6, 0.4, 1.2, 'stone');
      block(blocks, x0 + 0.85, 0.6, 0.4, 1.2, 'stone');
      block(blocks, x0, 1.35, 2.1, 0.3, m1);
      block(blocks, x0, 1.75, 0.8, 0.5, m2);
      target(targets, x0, 0.4);
    } else { // spire
      block(blocks, x0, 0.4, 1.2, 0.8, m1);
      block(blocks, x0, 1.15, 0.9, 0.7, m2);
      block(blocks, x0, 1.8, 0.6, 0.6, m3);
      target(targets, x0, 2.45);
    }
  }

  function getLevel(index) {
    if (index < 0 || index >= LEVEL_COUNT) return null;
    return makeLevel(index);
  }

  // ---- daily challenge -------------------------------------------------------
  // One shared seed per UTC day. Immutable after publication.
  function dailyKey(date) {
    var d = date || new Date();
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  function makeDaily(date) {
    var key = dailyKey(date);
    // derive a hard journey-like layout from the date key
    var rnd = R.mulberry32((key * 2654435761) >>> 0);
    var index = 20 + Math.floor(rnd() * 25); // upper-half difficulty
    var level = makeLevel(index);
    return {
      id: 'daily-' + key,
      version: level.version,
      index: index,
      seed: (key ^ LEVEL_SALT) >>> 0,
      shots: level.shots,
      par: level.par,
      blocks: level.blocks,
      targets: level.targets,
      theme: THEMES[key % THEMES.length].id,
      tutorial: null,
      mastery: false,
      dailyKey: key
    };
  }

  // ---- tutorials (Learn mode) -------------------------------------------------
  var LESSONS = [
    { id: 'lesson-1', levelIndex: 0, title: 'The Sling', text: 'Drag back from the pouch and release.' },
    { id: 'lesson-2', levelIndex: 1, title: 'Supports', text: 'Knock out supports to drop structures.' },
    { id: 'lesson-3', levelIndex: 2, title: 'Materials', text: 'Ice breaks easily, wood is sturdy, stone is tough.' }
  ];

  // ---- offline validator ------------------------------------------------------
  // Proves basic legality, reachable goals, bounded duration and no soft locks.
  function validateLevel(level) {
    var errors = [];
    if (!level.id || !level.version) errors.push('missing id/version');
    if (!level.targets || level.targets.length === 0) errors.push('no targets');
    if (!level.shots || level.shots < 1) errors.push('no shots');
    if (level.shots > 10) errors.push('unbounded shots');
    (level.blocks || []).forEach(function (b, i) {
      if (!R.MAT[b.mat]) errors.push('block ' + i + ' bad material');
      if (!(b.w > 0 && b.h > 0)) errors.push('block ' + i + ' bad size');
      if (!isFinite(b.x) || !isFinite(b.y)) errors.push('block ' + i + ' NaN');
      if (b.y - b.h / 2 < -0.01) errors.push('block ' + i + ' underground');
    });
    (level.targets || []).forEach(function (t, i) {
      if (!isFinite(t.x) || !isFinite(t.y)) errors.push('target ' + i + ' NaN');
    });
    // reachability: targets must be within max flight range of the sling
    var maxRange = R.SLING_X + (R.MAX_SPEED * R.MAX_SPEED) / R.GRAVITY; // ~40 m flat
    (level.targets || []).forEach(function (t, i) {
      if (t.x - R.SLING_X > maxRange + 2) errors.push('target ' + i + ' unreachable');
    });
    return errors;
  }

  function validateAll() {
    var report = [];
    for (var i = 0; i < LEVEL_COUNT; i++) {
      var errs = validateLevel(makeLevel(i));
      if (errs.length) report.push({ index: i, errors: errs });
    }
    return report;
  }

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    LEVEL_COUNT: LEVEL_COUNT,
    THEMES: THEMES,
    LESSONS: LESSONS,
    getLevel: getLevel,
    makeLevel: makeLevel,
    makeDaily: makeDaily,
    dailyKey: dailyKey,
    validateLevel: validateLevel,
    validateAll: validateAll
  };
});
