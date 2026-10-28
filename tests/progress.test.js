'use strict';
// The progress document and the game's options (progress.js): normalizing stored
// values, the two-device merge (the same result as the browser build's
// session.adoptProgress), the browser build's cloud slot read as a foreign save
// (checksum checked), the options' values, and the Daily's date handed to the session.
var test = require('node:test');
var assert = require('node:assert');
var P = require('../progress.js');
var S = require('../session.js');
var C = require('../content.js');

function doc(stars, best, ach, counters, excluded) {
  var d = { v: 1, stars: stars, bestScores: best, achievements: ach, counters: counters, dailyExcluded: excluded || [] };
  d.sum = P.checksum(d);
  return d;
}

test('empty and normalized documents are checksummed', function () {
  var e = P.emptyProgress();
  assert.strictEqual(e.sum, P.checksum(e));
  assert.deepStrictEqual(P.normalizeProgress(null), e);
  assert.deepStrictEqual(P.normalizeProgress({ v: 2, stars: { 0: 3 } }), e, 'another version is not adopted');
  var n = P.normalizeProgress({ v: 1, stars: { 0: 3, 1: 'x', 2: -1 }, bestScores: { 0: 2700.5 }, achievements: { 'first-clear': true, x: false }, counters: { launches: 7 } });
  assert.deepStrictEqual(n.stars, { 0: 3 });
  assert.deepStrictEqual(n.bestScores, { 0: 2700 });
  assert.deepStrictEqual(n.achievements, { 'first-clear': true });
  assert.deepStrictEqual(n.counters, { launches: 7, clears: 0, streak: 0 });
  assert.strictEqual(n.sum, P.checksum(n));
});

test('merge matches session.adoptProgress (two devices)', function () {
  var local = doc({ 0: 3, 1: 1 }, { 0: 2700, 1: 900 }, { 'first-clear': true }, { launches: 12, clears: 2, streak: 2 }, [20261001]);
  var remote = doc({ 1: 2, 2: 1 }, { 1: 1500, 2: 800 }, { 'streak-3': true }, { launches: 30, clears: 1, streak: 0 }, [20261002]);
  var merged = P.mergeProgress(remote, local);
  var s = new S.Session();
  s.progress = JSON.parse(JSON.stringify(local));
  assert.ok(s.adoptProgress(JSON.parse(JSON.stringify(remote))));
  assert.ok(P.same(merged, s.progress), JSON.stringify([merged, s.progress]));
  assert.deepStrictEqual(merged.stars, { 0: 3, 1: 2, 2: 1 });
  assert.deepStrictEqual(merged.counters, { launches: 30, clears: 2, streak: 2 });
  assert.ok(P.same(P.mergeProgress(merged, merged), merged), 'merging the same twice changes nothing');
});

test('the browser build\'s cloud slot is read when its checksum holds', function () {
  var old = doc({ 4: 3 }, { 4: 3100 }, { 'century-club': true }, { launches: 100, clears: 5, streak: 1 });
  var got = P.readForeign(JSON.stringify(old));
  assert.deepStrictEqual(got.stars, { 4: 3 });
  assert.strictEqual(got.counters.launches, 100);
  var bad = JSON.parse(JSON.stringify(old)); bad.stars[5] = 3;
  assert.strictEqual(P.readForeign(JSON.stringify(bad)), null, 'tampered');
  assert.strictEqual(P.readForeign('not json'), null);
  assert.strictEqual(P.readForeign(null), null);
});

test('options: booleans only, browser keys listed', function () {
  assert.deepStrictEqual(P.DEFAULT_OPTIONS, { leftHanded: false, timingAssist: false });
  assert.strictEqual(P.pickOption('leftHanded', true), true);
  assert.strictEqual(P.pickOption('leftHanded', 'yes'), undefined);
  assert.strictEqual(P.pickOption('music', 1), undefined);
  P.OPTION_KEYS.forEach(function (k) { assert.ok(P.BROWSER_KEYS.indexOf(k) >= 0, k); });
});

test('the Daily takes the platform clock\'s date', function () {
  var s = new S.Session();
  var day = new Date(Date.UTC(2027, 2, 14, 12));
  assert.ok(s.startRound('daily', day).ok);
  assert.strictEqual(s.level.id, 'daily-20270314');
  assert.deepStrictEqual(s.level.blocks, C.makeDaily(day).blocks);
});
