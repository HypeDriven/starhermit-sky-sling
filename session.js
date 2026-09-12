'use strict';

/*
 * Sky Sling - session: mode orchestration, snapshots, undo, replay envelope,
 * persistence (settings/progress/achievements), tie-break scoring.
 * UI state and simulation state stay separate: this module owns the sim.
 */
(function (root, factory) {
  var deps = (typeof module !== 'undefined')
    ? { R: require('./rules'), C: require('./content') }
    : { R: (root.SkySling || {}).rules, C: (root.SkySling || {}).content };
  var api = factory(deps.R, deps.C);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.session = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R, C) {

  var SETTINGS_KEY = 'skysling.settings.v1';
  var PROGRESS_KEY = 'skysling.progress.v1';
  var SAVE_VERSION = 1;

  var DEFAULT_SETTINGS = {
    music: 0.6, sfx: 0.9, ambience: 0.5, voice: 0.0,
    reducedMotion: false, highContrast: false, largeText: false,
    leftHanded: false, timingAssist: false, haptics: true,
    quality: 2,           // 0 low, 1 medium, 2 high
    camera: 'default',
    replayTutorial: false
  };

  var ACHIEVEMENTS = [
    { key: 'first-clear',   name: 'First Collapse',  desc: 'Clear your first stage.' },
    { key: 'support-mastery', name: 'Demolition Eye', desc: 'Clear a stage using a single shot.' },
    { key: 'streak-3',      name: 'On a Roll',       desc: 'Clear three stages in a row.' },
    { key: 'milestone-30',  name: 'Island Surveyor', desc: 'Clear 30 journey stages.' },
    { key: 'century-club',  name: 'Century Club',    desc: 'Fire 100 launches in total.' }
  ];

  function storage() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (_) {}
    // in-memory fallback (Node tests / private browsing)
    if (!storage._mem) {
      var m = {};
      storage._mem = {
        getItem: function (k) { return k in m ? m[k] : null; },
        setItem: function (k, v) { m[k] = String(v); },
        removeItem: function (k) { delete m[k]; }
      };
    }
    return storage._mem;
  }

  function loadJSON(key, fallback) {
    try {
      var raw = storage().getItem(key);
      if (!raw) return fallback;
      var d = JSON.parse(raw);
      return (d && typeof d === 'object') ? d : fallback;
    } catch (_) { return fallback; }
  }
  function saveJSON(key, val) {
    try { storage().setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  // checksum for the versioned save document
  function checksum(doc) {
    var body = JSON.stringify({ v: doc.v, stars: doc.stars, achievements: doc.achievements, counters: doc.counters });
    return R.fnv1a(body);
  }

  function Session() {
    this.screen = 'boot';           // boot→title→mode-select→preparing→active↔paused→resolving→results
    this.mode = null;               // learn | journey | daily | practice | challenge
    this.level = null;
    this.state = null;              // rules state (owned exclusively here)
    this.snapshots = [];            // undo stack (practice)
    this.envelope = null;           // replay envelope for the round
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadJSON(SETTINGS_KEY, {}));
    this.progress = this._loadProgress();
    this.listeners = [];
    this.ranked = false;
  }

  Session.prototype._loadProgress = function () {
    var d = loadJSON(PROGRESS_KEY, null);
    if (!d || d.v !== SAVE_VERSION || checksum(d) !== d.sum) {
      return { v: SAVE_VERSION, stars: {}, bestScores: {}, achievements: {},
               counters: { launches: 0, clears: 0, streak: 0 }, dailyExcluded: [] };
    }
    return d;
  };
  Session.prototype._saveProgress = function () {
    this.progress.sum = checksum(this.progress);
    saveJSON(PROGRESS_KEY, this.progress);
    this._emit({ type: 'progress', progress: this.progress });
  };

  // Cloud (remote-preferred) merge: adopt a remote save doc, never losing local
  // clears/bests. Progression is monotonic, so per-field max wins; corrupt or
  // foreign docs are ignored. The merged doc is re-persisted locally.
  Session.prototype.adoptProgress = function (remote) {
    if (!remote || remote.v !== SAVE_VERSION || checksum(remote) !== remote.sum) return false;
    var local = this.progress;
    var k;
    var merged = {
      v: SAVE_VERSION, sum: 0,
      stars: {}, bestScores: {}, achievements: {},
      counters: { launches: 0, clears: 0, streak: 0 },
      dailyExcluded: []
    };
    function maxInto(dst, src) {
      for (var key in src) {
        var v = Math.max(dst[key] || 0, src[key] || 0);
        if (v) dst[key] = v;
      }
    }
    maxInto(merged.stars, remote.stars);
    maxInto(merged.stars, local.stars);
    maxInto(merged.bestScores, remote.bestScores);
    maxInto(merged.bestScores, local.bestScores);
    var ach = [remote.achievements, local.achievements];
    for (var i = 0; i < ach.length; i++) for (k in ach[i]) merged.achievements[k] = true;
    var cnt = ['launches', 'clears', 'streak'];
    for (i = 0; i < cnt.length; i++) {
      merged.counters[cnt[i]] = Math.max(
        (remote.counters && remote.counters[cnt[i]]) || 0,
        (local.counters && local.counters[cnt[i]]) || 0);
    }
    var ex = [(remote.dailyExcluded || []), (local.dailyExcluded || [])];
    for (i = 0; i < ex.length; i++) {
      for (k = 0; k < ex[i].length; k++) {
        if (merged.dailyExcluded.indexOf(ex[i][k]) < 0) merged.dailyExcluded.push(ex[i][k]);
      }
    }
    this.progress = merged;
    this._saveProgress(); // persists + emits 'progress' (mirrors to cloud)
    return true;
  };

  Session.prototype.on = function (fn) { this.listeners.push(fn); };
  Session.prototype._emit = function (evt) {
    for (var i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](evt); } catch (_) {}
    }
  };

  Session.prototype.setScreen = function (screen, reason) {
    var prev = this.screen;
    this.screen = screen;
    this._emit({ type: 'screen', from: prev, to: screen, reason: reason || '' });
  };

  Session.prototype.saveSettings = function (patch) {
    Object.assign(this.settings, patch);
    saveJSON(SETTINGS_KEY, this.settings);
    this._emit({ type: 'settings', settings: this.settings });
  };

  // ---- round lifecycle --------------------------------------------------------
  // mode: learn|journey|daily|practice|challenge ; ref: level index or lesson
  Session.prototype.startRound = function (mode, ref) {
    this.mode = mode;
    if (mode === 'daily') this.level = C.makeDaily();
    else if (mode === 'learn') {
      var lesson = C.LESSONS[ref || 0];
      this.level = C.getLevel(lesson.levelIndex);
      this.level = Object.assign({}, this.level, { id: lesson.id, tutorial: { step: 1, text: lesson.text } });
    } else if (mode === 'challenge') {
      var base = C.getLevel(typeof ref === 'number' ? ref : 10);
      this.level = Object.assign({}, base, {
        id: 'challenge-' + base.index, shots: Math.max(1, base.shots - 1) // move limit constraint
      });
    } else {
      this.level = C.getLevel(typeof ref === 'number' ? ref : 0);
    }
    if (!this.level) return { ok: false, reason: 'no-such-level' };

    this.state = R.createState(this.level);
    this.snapshots = [];
    this.ranked = (mode === 'daily');
    this.envelope = {
      version: R.RULES_VERSION, contentVersion: C.CONTENT_VERSION,
      seed: this.level.seed, index: this.level.index,
      initialHash: R.hash(this.state),
      commands: [], hashes: []
    };
    this.setScreen('active', 'round-start');
    this._emit({ type: 'round-start', mode: mode, level: this.level });
    return { ok: true };
  };

  Session.prototype.legal = function () {
    return this.state ? R.legalActions(this.state) : { canLaunch: false, reason: 'no-round' };
  };

  // Launch with action identifier (double-commit protection).
  Session.prototype.launch = function (cmdId, vx, vy) {
    if (!this.state) return { ok: false, reason: 'no-round' };
    if (this.screen !== 'active') return { ok: false, reason: 'not-active' };
    if (this.mode === 'practice') {
      this.snapshots.push(R.serialize(this.state));
      if (this.snapshots.length > 32) this.snapshots.shift();
    }
    var res = R.applyCommand(this.state, { id: cmdId, type: 'launch', vx: vx, vy: vy });
    if (!res.ok) {
      this._emit({ type: 'invalid', reason: res.reason });
      return res;
    }
    this.progress.counters.launches++;
    this.setScreen('resolving', 'launch');
    this._emit({ type: 'launch', vx: vx, vy: vy });
    return res;
  };

  // Advance one tick; emits sim events; settles resolution.
  Session.prototype.tick = function () {
    if (!this.state || this.screen !== 'resolving') return [];
    var ev = R.tick(this.state);
    for (var i = 0; i < ev.length; i++) this._emit({ type: 'sim', sim: ev[i] });
    if (this.state.phase !== 'flight') {
      this.envelope.hashes.push(R.hash(this.state));
      if (this.state.over) this._finish();
      else this.setScreen('active', 'settled');
    }
    return ev;
  };

  // Fast-forward: settle every object into the exact deterministic end state.
  Session.prototype.skip = function () {
    if (!this.state || this.screen !== 'resolving') return;
    var ev = R.resolve(this.state);
    this.envelope.hashes.push(R.hash(this.state));
    for (var i = 0; i < ev.length; i++) this._emit({ type: 'sim', sim: ev[i] });
    if (this.state.over) this._finish();
    else this.setScreen('active', 'skipped');
  };

  Session.prototype.undo = function () {
    if (this.mode !== 'practice' || this.snapshots.length === 0) {
      return { ok: false, reason: 'undo-not-available' };
    }
    this.state = R.deserialize(this.level, this.snapshots.pop());
    this.envelope.commands.pop();
    this.envelope.hashes.pop();
    this.setScreen('active', 'undo');
    this._emit({ type: 'undo' });
    return { ok: true };
  };

  Session.prototype.pause = function () {
    if (this.screen === 'active' || this.screen === 'resolving') {
      this._resumeTo = this.screen;
      this.setScreen('paused', 'user');
    }
  };
  Session.prototype.resume = function () {
    if (this.screen === 'paused') this.setScreen(this._resumeTo || 'active', 'resume');
  };

  Session.prototype._finish = function () {
    var score = R.computeScore(this.state);
    var result = {
      won: this.state.won,
      reason: this.state.reason,
      score: score,
      invalidActions: this.state.invalidActions,
      ticks: this.state.tick,
      shotsUsed: this.state.shotsUsed,
      shots: this.state.shots,
      ranked: this.ranked
    };
    // progression
    if (this.state.won && this.mode === 'journey') {
      var idx = this.level.index;
      var stars = score.total >= this._starTarget(3) ? 3 :
                  score.total >= this._starTarget(2) ? 2 : 1;
      this.progress.stars[idx] = Math.max(this.progress.stars[idx] || 0, stars);
      this.progress.bestScores[idx] = Math.max(this.progress.bestScores[idx] || 0, score.total);
      this.progress.counters.clears++;
      this.progress.counters.streak++;
    } else if (!this.state.won) {
      this.progress.counters.streak = 0;
    }
    this._checkAchievements(result);
    this._saveProgress();
    this.setScreen('results', this.state.reason);
    this._emit({ type: 'results', result: result });
  };

  Session.prototype._starTarget = function (n) {
    var full = R.computeScore({ destroyedTargets: this.level.targets.length,
      blocks: this.level.blocks.map(function (b) { return { alive: false, mat: b.mat }; }),
      won: true, shots: this.level.shots, shotsUsed: this.level.par }).total;
    return Math.round(full * (n === 3 ? 0.85 : 0.6));
  };

  Session.prototype._checkAchievements = function (result) {
    var a = this.progress.achievements;
    var unlock = function (key, self) {
      if (!a[key]) { a[key] = true; self._emit({ type: 'achievement', key: key }); }
    };
    if (result.won) {
      unlock('first-clear', this);
      if (result.shotsUsed === 1) unlock('support-mastery', this);
      if (this.progress.counters.streak >= 3) unlock('streak-3', this);
      var cleared = Object.keys(this.progress.stars).length;
      if (cleared >= 30) unlock('milestone-30', this);
    }
    if (this.progress.counters.launches >= 100) unlock('century-club', this);
  };

  // Replay envelope with terminal result, for leaderboard validation.
  Session.prototype.finishEnvelope = function () {
    if (!this.envelope || !this.state) return null;
    this.envelope.commands = this.state.log.slice();
    this.envelope.result = {
      won: this.state.won,
      score: R.computeScore(this.state),
      reason: this.state.reason,
      invalidActions: this.state.invalidActions,
      ticks: this.state.tick
    };
    return this.envelope;
  };

  return {
    Session: Session,
    SETTINGS_KEY: SETTINGS_KEY,
    PROGRESS_KEY: PROGRESS_KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ACHIEVEMENTS: ACHIEVEMENTS,
    SAVE_VERSION: SAVE_VERSION
  };
});
