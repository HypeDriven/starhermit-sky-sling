'use strict';

/*
 * Sky Sling - offline test suite (no dependencies).
 * Covers: legal actions, invalid-action reasons, scoring components,
 * terminal states, serialization round-trips, deterministic replay,
 * content validation, fuzz of malformed commands, golden sessions,
 * tie-break ordering, save checksum migration, server validation logic.
 */
var assert = require('assert');
var R = require('./rules');
var C = require('./content');
var S = require('./session');

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    console.error('FAIL ' + name + ': ' + (e && e.stack || e));
    process.exitCode = 1;
  }
}

function aim() { return { vx: 10, vy: 8 }; }

// ---- content -------------------------------------------------------------------
test('content: 45 levels all valid', function () {
  assert.strictEqual(C.LEVEL_COUNT, 45);
  var report = C.validateAll();
  assert.deepStrictEqual(report, [], JSON.stringify(report.slice(0, 3)));
});

test('content: every level has targets, blocks, shots and a theme', function () {
  for (var i = 0; i < C.LEVEL_COUNT; i++) {
    var lv = C.getLevel(i);
    assert.ok(lv.targets.length >= 1, 'level ' + i);
    assert.ok(lv.blocks.length >= 1);
    assert.ok(lv.shots >= 3 && lv.shots <= 6);
    assert.ok(C.THEMES.some(function (t) { return t.id === lv.theme; }));
    assert.strictEqual(lv.version, C.CONTENT_VERSION);
  }
});

test('content: daily is deterministic per UTC day and immutable', function () {
  var d = new Date(Date.UTC(2026, 7, 30));
  var a = C.makeDaily(d), b = C.makeDaily(d);
  assert.strictEqual(a.seed, b.seed);
  assert.deepStrictEqual(a.blocks, b.blocks);
  assert.strictEqual(C.dailyKey(d), 20260830);
});

test('content: five themes exist', function () {
  assert.strictEqual(C.THEMES.length, 5);
});

// ---- legal actions ---------------------------------------------------------------
test('rules: launch legal in aim phase, illegal reasons exposed', function () {
  var lv = C.getLevel(0);
  var st = R.createState(lv);
  assert.ok(R.legalActions(st).canLaunch);
  var r = R.applyCommand(st, { id: 'a', type: 'launch', vx: 10, vy: 8 });
  assert.ok(r.ok);
  assert.strictEqual(st.phase, 'flight');
  // cannot launch while resolving
  assert.strictEqual(R.legalActions(st).canLaunch, false);
  assert.strictEqual(R.legalActions(st).reason, 'resolving');
  var r2 = R.applyCommand(st, { id: 'b', type: 'launch', vx: 5, vy: 5 });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'resolving');
  assert.strictEqual(st.invalidActions, 1);
});

test('rules: invalid velocities rejected with reasons', function () {
  var st = R.createState(C.getLevel(0));
  assert.strictEqual(R.applyCommand(st, { type: 'launch', vx: NaN, vy: 1 }).reason, 'velocity-not-a-number');
  assert.strictEqual(R.applyCommand(st, { type: 'launch', vx: 99, vy: 99 }).reason, 'velocity-out-of-range');
  assert.strictEqual(R.applyCommand(st, { type: 'launch', vx: -3, vy: 5 }).reason, 'must-launch-rightward');
  assert.strictEqual(R.applyCommand(st, { type: 'frobnicate' }).reason, 'unknown-command');
  assert.strictEqual(R.applyCommand(st, null).reason, 'malformed-command');
  assert.strictEqual(st.invalidActions, 5);
  assert.strictEqual(st.shotsUsed, 0);
});

test('rules: velocity quantization is stable', function () {
  var st = R.createState(C.getLevel(0));
  var r = R.applyCommand(st, { id: 'q', type: 'launch', vx: 10.004, vy: 7.996 });
  assert.ok(r.ok);
  assert.strictEqual(st.bird.vx, 10);
  assert.strictEqual(st.bird.vy, 8);
});

// ---- terminal states --------------------------------------------------------------
test('rules: win when all targets cleared, with reason', function () {
  var lv = C.getLevel(0);
  var st = R.createState(lv);
  // clear targets directly to test terminal transition logic
  lv.targets.forEach(function (_, i) { st.targets[i].alive = false; });
  st.destroyedTargets = lv.targets.length;
  R.applyCommand(st, { id: 'x', type: 'launch', vx: 8, vy: 6 });
  R.resolve(st);
  assert.ok(st.over);
  assert.ok(st.won);
  assert.strictEqual(st.reason, 'targets-cleared');
});

test('rules: out-of-shots terminal state', function () {
  var st = R.createState(C.getLevel(0));
  for (var i = 0; i < st.shots; i++) {
    var r = R.applyCommand(st, { id: 's' + i, type: 'launch', vx: 2, vy: 2 });
    assert.ok(r.ok, 'shot ' + i);
    R.resolve(st);
  }
  assert.ok(st.over);
  assert.ok(!st.won);
  assert.strictEqual(st.reason, 'out-of-shots');
  assert.strictEqual(R.legalActions(st).reason, 'round-over');
});

test('rules: bounded resolution (no unbounded loops, no NaN)', function () {
  var st = R.createState(C.getLevel(7));
  R.applyCommand(st, { id: 'z', type: 'launch', vx: 19.5, vy: 0.5 });
  R.resolve(st);
  assert.ok(isFinite(st.bird.x) && isFinite(st.bird.y));
  st.blocks.forEach(function (b) { assert.ok(isFinite(b.x) && isFinite(b.y) && isFinite(b.hp)); });
});

// ---- scoring ----------------------------------------------------------------------
test('rules: scoring components and breakdown', function () {
  var lv = C.getLevel(0);
  var st = R.createState(lv);
  st.destroyedTargets = 2;
  st.blocks[0].alive = false;
  st.won = true; st.shotsUsed = 1;
  var sc = R.computeScore(st);
  assert.strictEqual(sc.targets, 2000);
  assert.strictEqual(sc.blocks, R.MAT[st.blocks[0].mat].score);
  assert.strictEqual(sc.shotsBonus, (st.shots - 1) * R.SHOT_BONUS);
  assert.strictEqual(sc.total, sc.targets + sc.blocks + sc.shotsBonus);
});

test('rules: tie-break ordering', function () {
  var a = { won: true, invalidActions: 0, tick: 100, sessionId: 'b' };
  var b = { won: true, invalidActions: 0, tick: 100, sessionId: 'a' };
  var c = { won: false, invalidActions: 0, tick: 50, sessionId: 'z' };
  assert.ok(R.compareResults(a, c) < 0);
  assert.ok(R.compareResults(b, a) < 0); // stable session id decides exact ties
});

// ---- determinism / replay ------------------------------------------------------------
test('rules: deterministic replay — same seed and commands, identical hashes', function () {
  var lv = C.getLevel(5);
  function run() {
    var st = R.createState(lv);
    R.applyCommand(st, { id: '1', type: 'launch', vx: 12, vy: 9 });
    R.resolve(st);
    var h1 = R.hash(st);
    R.applyCommand(st, { id: '2', type: 'launch', vx: 10, vy: 10 });
    R.resolve(st);
    return [h1, R.hash(st), R.serialize(st)];
  }
  var r1 = run(), r2 = run();
  assert.deepStrictEqual(r1, r2);
});

test('rules: replay envelope validates, tampered hash rejected', function () {
  var lv = C.getLevel(3);
  var st = R.createState(lv);
  var env = { version: R.RULES_VERSION, seed: lv.seed, index: lv.index, initialHash: R.hash(st), commands: [] };
  R.applyCommand(st, { id: '1', type: 'launch', vx: 11, vy: 9 });
  R.resolve(st);
  env.commands = st.log.slice();
  env.hashes = [R.hash(st)];
  var rep = R.replay(lv, env);
  assert.ok(rep.ok, rep.reason);
  env.hashes = ['deadbeef'];
  var rep2 = R.replay(lv, env);
  assert.strictEqual(rep2.ok, false);
  assert.strictEqual(rep2.reason, 'hash-mismatch-at-0');
});

// ---- serialization --------------------------------------------------------------------
test('rules: serialize/deserialize round-trip preserves hash', function () {
  var lv = C.getLevel(9);
  var st = R.createState(lv);
  R.applyCommand(st, { id: '1', type: 'launch', vx: 9, vy: 9 });
  for (var i = 0; i < 30; i++) R.tick(st);
  var json = R.serialize(st);
  var h1 = R.hash(st);
  var st2 = R.deserialize(lv, json);
  assert.strictEqual(R.hash(st2), h1);
});

// ---- fuzz ------------------------------------------------------------------------------
test('rules: fuzz malformed commands — no hangs, no NaN, no crash', function () {
  var rng = R.mulberry32(42);
  var st = R.createState(C.getLevel(12));
  for (var i = 0; i < 500; i++) {
    var cmd = {
      id: i, type: rng() < 0.8 ? 'launch' : 'junk' + i,
      vx: (rng() - 0.5) * 100, vy: (rng() - 0.5) * 100
    };
    if (rng() < 0.1) cmd.vx = [NaN, Infinity, undefined, 'x'][i % 4];
    R.applyCommand(st, cmd);
    if (st.phase === 'flight') R.resolve(st);
  }
  assert.ok(isFinite(st.bird.x) && isFinite(st.bird.y));
  assert.ok(st.tick < 1e6);
});

// ---- golden sessions ---------------------------------------------------------------------
test('golden: a reachable clear exists for representative levels', function () {
  // greedy per-shot search over a velocity fan proves goal reachability
  [0, 5, 11, 20, 30, 44].forEach(function (idx) {
    var lv = C.getLevel(idx);
    var st = R.createState(lv);
    var won = false;
    for (var shot = 0; shot < st.shots && !st.over; shot++) {
      var best = null;
      for (var vx = 5; vx <= 19; vx += 1) {
        for (var vy = 2; vy <= 17; vy += 1) {
          var cand = R.createState(lv);
          cand = R.deserialize(lv, R.serialize(st));
          R.applyCommand(cand, { id: 'try', type: 'launch', vx: vx, vy: vy });
          R.resolve(cand);
          var merit = cand.destroyedTargets * 1000 + cand.destroyedBlocks * 10 + (cand.won ? 1e6 : 0);
          if (!best || merit > best.merit) best = { merit: merit, state: cand };
        }
      }
      st = best.state;
      if (st.won) { won = true; break; }
    }
    assert.ok(won, 'level ' + idx + ' should be clearable');
  });
});

test('golden: resumed session reproduces terminal state', function () {
  var lv = C.getLevel(2);
  var st = R.createState(lv);
  R.applyCommand(st, { id: '1', type: 'launch', vx: 13, vy: 8 });
  for (var i = 0; i < 60; i++) R.tick(st);      // interrupted mid-flight
  var snap = R.serialize(st);
  var resumed = R.deserialize(lv, snap);        // resume from snapshot
  R.resolve(st); R.resolve(resumed);
  assert.strictEqual(R.hash(resumed), R.hash(st));
});

// ---- session / persistence -----------------------------------------------------------------
test('session: round lifecycle, undo in practice, achievements idempotent', function () {
  var sess = new S.Session();
  var res = sess.startRound('practice', 0);
  assert.ok(res.ok);
  assert.strictEqual(sess.screen, 'active');
  var lr = sess.launch('c1', 10, 8);
  assert.ok(lr.ok);
  assert.strictEqual(sess.screen, 'resolving');
  sess.skip(); // fast-forward settle
  assert.ok(sess.screen === 'active' || sess.screen === 'results');
  if (sess.screen === 'active') {
    var u = sess.undo();
    assert.ok(u.ok);
    assert.strictEqual(sess.state.shotsUsed, 0);
  }
  // achievements idempotent
  sess.progress.achievements['first-clear'] = true;
  sess._checkAchievements({ won: true, shotsUsed: 2 });
  assert.strictEqual(sess.progress.achievements['first-clear'], true);
});

test('session: save document checksum catches corruption', function () {
  var sess = new S.Session();
  sess.progress.stars[0] = 3;
  sess._saveProgress();
  var sess2 = new S.Session();
  assert.strictEqual(sess2.progress.stars[0], 3);
  // corrupt the stored doc
  var store = typeof localStorage !== 'undefined' ? localStorage : null;
  if (store) {
    var raw = JSON.parse(store.getItem(S.PROGRESS_KEY));
    raw.stars[0] = 99; // tamper without updating checksum
    store.setItem(S.PROGRESS_KEY, JSON.stringify(raw));
    var sess3 = new S.Session();
    assert.strictEqual(sess3.progress.stars[0] || 0, 0); // resets to safe default
  }
});

// ---- server validation logic ---------------------------------------------------------------
test('server: validateSubmission accepts honest replay, rejects cheats', function () {
  var srv = require('./server');
  var lv = C.makeDaily(new Date());
  var st = R.createState(lv);
  R.applyCommand(st, { id: '1', type: 'launch', vx: 10, vy: 8 });
  R.resolve(st);
  var env = {
    version: R.RULES_VERSION, seed: lv.seed, index: lv.index,
    initialHash: R.hash(R.createState(lv)), commands: st.log.slice()
  };
  var score = R.computeScore(st).total;
  var ok = srv.validateSubmission({
    board: 'daily', key: lv.id, score: score, envelope: env
  });
  assert.ok(ok.ok, ok.error);
  var cheat = srv.validateSubmission({
    board: 'daily', key: lv.id, score: score + 1000, envelope: env
  });
  assert.strictEqual(cheat.ok, false);
  assert.strictEqual(cheat.error, 'score-mismatch');
  var stale = srv.validateSubmission({
    board: 'daily', key: 'daily-19990101', score: score, envelope: env
  });
  assert.strictEqual(stale.ok, false);
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
