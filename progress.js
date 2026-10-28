'use strict';

/*
 * Sky Sling - the progress document and the game's own options, pure (a
 * classic script in the engine, CommonJS in the Node tests).
 *
 * Progress is the browser build's versioned, checksummed document (session.js:
 * { v, sum, stars, bestScores, achievements, counters: { launches, clears,
 * streak }, dailyExcluded }), the same document its cloud slot game:<slug>
 * held. Two copies merge as session.adoptProgress did: the highest stars, best
 * scores and counters, the union of achievements and excluded dailies.
 *
 * Options: the game's settings the runtime's Options do not cover — the
 * left-handed rails and the timing assist (finer keyboard aim steps). The
 * browser build mirrored them with the volumes, graphics, motion, contrast,
 * text size, haptics and camera to the account's settings KV; those others are
 * the runtime's now.
 */
(function (root, factory) {
  var R = typeof module === 'object' && module.exports ? require('./rules') : (root.SkySling || {}).rules;
  var api = factory(R);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.progress = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R) {

  var SAVE_VERSION = 1;
  var COUNTERS = ['launches', 'clears', 'streak'];
  var DEFAULT_OPTIONS = { leftHanded: false, timingAssist: false };
  var OPTION_KEYS = ['leftHanded', 'timingAssist'];
  /** The browser build's settings-KV keys (platform.js SYNCED_SETTINGS), removed once the options are adopted. */
  var BROWSER_KEYS = ['music', 'sfx', 'ambience', 'voice', 'camera', 'reducedMotion', 'highContrast', 'largeText',
    'leftHanded', 'haptics', 'timingAssist', 'graphics'];

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function nat(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0; }

  /** session.js checksum(). */
  function checksum(doc) {
    return R.fnv1a(JSON.stringify({ v: doc.v, stars: doc.stars, achievements: doc.achievements, counters: doc.counters }));
  }

  function emptyProgress() {
    var p = { v: SAVE_VERSION, stars: {}, bestScores: {}, achievements: {}, counters: { launches: 0, clears: 0, streak: 0 }, dailyExcluded: [] };
    p.sum = checksum(p);
    return p;
  }

  /** Any stored value → a well-formed, checksummed progress document (fields in session.js's order). */
  function normalizeProgress(raw) {
    var p = emptyProgress();
    if (!isObj(raw) || raw.v !== SAVE_VERSION) return p;
    var numMap = function (m) {
      var out = {};
      if (isObj(m)) Object.keys(m).forEach(function (k) { var v = nat(m[k]); if (v) out[k] = v; });
      return out;
    };
    p.stars = numMap(raw.stars);
    p.bestScores = numMap(raw.bestScores);
    if (isObj(raw.achievements)) Object.keys(raw.achievements).forEach(function (k) { if (raw.achievements[k]) p.achievements[k] = true; });
    var c = isObj(raw.counters) ? raw.counters : {};
    COUNTERS.forEach(function (k) { p.counters[k] = nat(c[k]); });
    p.dailyExcluded = Array.isArray(raw.dailyExcluded) ? raw.dailyExcluded.filter(function (x) { return typeof x === 'string' || typeof x === 'number'; }) : [];
    p.sum = checksum(p);
    return p;
  }

  /** session.adoptProgress's merge, without its checksum gate (both sides are normalized first). */
  function mergeProgress(remote, local) {
    var a = normalizeProgress(remote), b = normalizeProgress(local);
    var out = emptyProgress();
    var maxInto = function (dst, src) {
      for (var key in src) { var v = Math.max(dst[key] || 0, src[key] || 0); if (v) dst[key] = v; }
    };
    maxInto(out.stars, a.stars); maxInto(out.stars, b.stars);
    maxInto(out.bestScores, a.bestScores); maxInto(out.bestScores, b.bestScores);
    [a.achievements, b.achievements].forEach(function (m) { for (var k in m) out.achievements[k] = true; });
    COUNTERS.forEach(function (k) { out.counters[k] = Math.max(a.counters[k], b.counters[k]); });
    [a.dailyExcluded, b.dailyExcluded].forEach(function (list) {
      list.forEach(function (x) { if (out.dailyExcluded.indexOf(x) < 0) out.dailyExcluded.push(x); });
    });
    out.sum = checksum(out);
    return out;
  }

  /** Same content, key order aside. */
  function same(x, y) {
    var canon = function (v) {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
      return JSON.stringify(v);
    };
    return canon(x) === canon(y);
  }

  /** The browser build's cloud slot (the progress document as JSON text) → progress, or null when it is
   *  not one or its checksum fails (session.adoptProgress ignored corrupt or foreign docs). */
  function readForeign(text) {
    var doc;
    try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!isObj(doc) || doc.v !== SAVE_VERSION || checksum(doc) !== doc.sum) return null;
    return normalizeProgress(doc);
  }

  /** One option value checked; undefined when it is not one. */
  function pickOption(key, v) {
    if (OPTION_KEYS.indexOf(key) < 0) return undefined;
    return typeof v === 'boolean' ? v : undefined;
  }

  return {
    SAVE_VERSION: SAVE_VERSION, DEFAULT_OPTIONS: DEFAULT_OPTIONS, OPTION_KEYS: OPTION_KEYS, BROWSER_KEYS: BROWSER_KEYS,
    checksum: checksum, emptyProgress: emptyProgress, normalizeProgress: normalizeProgress, mergeProgress: mergeProgress,
    same: same, readForeign: readForeign, pickOption: pickOption
  };
});
