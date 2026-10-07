'use strict';

/*
 * Sky Sling - platform adapter over window.StarHermit (starhermit-sdk.js,
 * loaded first): launch token + renewal, account nickname, sign-in / invite
 * link, cloud-save mirror (slot game:<slug>), settings KV, keyboard bindings
 * and the read-only platform leaderboard. Hosted iff the SDK holds a token;
 * without one every platform call is a no-op with no network traffic. The
 * game's own server.js daily/scores routes are used only as a local-dev
 * backend. localStorage stays the offline cache.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.platform = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {

  // Keyboard actions; mirrors the control.* lines in starhermit.txt.
  var DEFAULT_CONTROLS = {
    aimLeft: ['ArrowLeft'], aimRight: ['ArrowRight'], aimUp: ['ArrowUp'], aimDown: ['ArrowDown'],
    launch: ['Space', 'Enter'], pause: ['Escape', 'KeyP'], skip: ['KeyS'],
    restart: ['KeyR'], undo: ['KeyU']
  };
  // Player preferences mirrored to the platform settings KV.
  var SYNCED_SETTINGS = ['music', 'sfx', 'ambience', 'voice', 'camera', 'reducedMotion',
    'highContrast', 'largeText', 'leftHanded', 'haptics', 'timingAssist', 'graphics'];

  function SH() { return root.StarHermit || null; }
  function cloneControls(c) {
    var out = {};
    Object.keys(c).forEach(function (k) { out[k] = c[k].slice(); });
    return out;
  }

  var platform = {
    hosted: false,
    token: null,
    userId: null,
    slug: null,
    nickname: null,
    serverOffset: 0,
    syncStatus: 'offline',
    onSyncStatus: null,          // fn(status), set by boot
    onSignedOut: null,           // fn(), set by boot
    controls: cloneControls(DEFAULT_CONTROLS),
    DEFAULT_CONTROLS: DEFAULT_CONTROLS,
    SYNCED_SETTINGS: SYNCED_SETTINGS
  };

  function setSyncStatus(s) {
    platform.syncStatus = s;
    if (platform.onSyncStatus) { try { platform.onSyncStatus(s); } catch (_) {} }
  }
  function syncFromSdk() {
    var sh = SH();
    platform.hosted = !!(sh && sh.signedIn);
    platform.token = sh ? sh.token : null;
    platform.userId = sh ? sh.userId : null;
    platform.slug = sh ? sh.slug : null;
  }

  // ---- profile (nickname, "Player "+id prefix fallback; never /api/v1/me) ----
  function nicknameFor(userId) {
    if (userId == null || !platform.hosted) return Promise.resolve(null);
    return SH().profile(String(userId)).then(function (p) { return p ? p.displayName : null; }, function () { return null; });
  }
  function loadProfile() {
    if (!platform.hosted) return Promise.resolve(null);
    return nicknameFor(platform.userId).then(function (nick) { platform.nickname = nick; return nick; });
  }

  // ---- cloud save: one slot, remote wins conflicts ----
  function scheduleCloudSave(progressDoc) {
    if (!platform.hosted) return;
    setSyncStatus('saving');
    SH().saveJSON(progressDoc);
  }
  function flushCloudSave() {
    return platform.hosted ? SH().flushSave(true) : Promise.resolve(false);
  }
  function cloudSave(progressDoc) {
    if (!platform.hosted) return Promise.resolve(false);
    setSyncStatus('saving');
    return SH().writeSave(JSON.stringify(progressDoc));
  }
  function loadCloud() {
    if (!platform.hosted) return Promise.resolve(null);
    setSyncStatus('saving');
    return SH().loadSave().then(function (text) {
      setSyncStatus('synced');
      try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
    });
  }

  // ---- settings KV: platform wins on start, changes mirrored ----
  function pick(settings) {
    var out = {};
    SYNCED_SETTINGS.forEach(function (k) { if (settings[k] !== undefined) out[k] = settings[k]; });
    return out;
  }
  function loadSettings() {
    if (!platform.hosted) return Promise.resolve({});
    return SH().getSettings().then(function (remote) { return pick(remote || {}); }, function () { return {}; });
  }
  function pushSettings(settings) {
    if (platform.hosted) SH().patchSettings(pick(settings));
  }

  // ---- keyboard bindings ----
  function loadControls() {
    if (!platform.hosted) return Promise.resolve(platform.controls);
    return SH().loadBindings(DEFAULT_CONTROLS).then(function (b) { platform.controls = b; return b; },
      function () { return platform.controls; });
  }
  function actionFor(code) {
    var c = platform.controls;
    for (var a in c) if (c[a].indexOf(code) !== -1) return a;
    return null;
  }
  function keyLabel(action) {
    var NAMES = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
    return (platform.controls[action] || []).map(function (c) {
      return NAMES[c] || c.replace(/^Key|^Digit/, '');
    }).join('/');
  }

  // ---- leaderboard reads ----
  function leaderboardInfo() {
    if (!platform.hosted) return Promise.resolve(null);
    return SH().leaderboards().then(function (boards) {
      var b = (boards || [])[0];
      return b ? { leaderboardId: b.id, board: b } : null;
    }, function () { return null; });
  }
  function leaderboardEntries(leaderboardId, opts) {
    if (!platform.hosted || !leaderboardId) return Promise.resolve(null);
    return SH().leaderboardEntries(leaderboardId, {
      page: ((opts && opts.page) || 0) + 1, pageSize: (opts && opts.pageSize) || 50
    }).then(function (r) { return { entries: (r && r.items) || [] }; }, function () { return null; });
  }

  // ---- platform leaderboard post (hosted only) ----
  // Posts a finished run's total through the game's score script
  // (score-script.js) to the high-score board; resolves { posted, rank }.
  platform.submitPlatformScore = function (total) {
    if (!platform.hosted) return Promise.resolve({ posted: false, rank: null });
    var sh = SH();
    return sh.submitScores({ 'high-score': total }).then(function (keys) {
      if (keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      return sh.leaderboard('high-score', { pageSize: 100 }).then(function (r) {
        var me = ((r && r.items) || []).filter(function (i) { return i.userId === sh.userId; })[0];
        return { posted: true, rank: me ? me.rank : null };
      }, function () { return { posted: true, rank: null }; });
    });
  };

  // ---- its-backend (the game's own server.js) — local dev only ----
  // On the platform host these routes do not exist; hosted mode never calls them.
  platform.time = function () {
    if (platform.hosted) return Promise.resolve(null);
    return fetch('/api/v1/time').then(function (r) { return r.json(); }).then(function (d) {
      var after = Date.now();
      platform.serverOffset = d.now - after; // round-trip-adjusted offset (approx)
      return d;
    }).catch(function () { return null; }); // offline: keep local clock
  };
  platform.daily = function () {
    if (platform.hosted) return Promise.resolve(null);
    return fetch('/api/v1/daily').then(function (r) { return r.json(); })
      .catch(function () { return null; });
  };
  platform.submitScore = function (payload) {
    if (platform.hosted) {
      // Hosted runs post through submitPlatformScore (score-script.js) instead.
      return Promise.resolve({ ok: false, error: 'client-submit-disabled' });
    }
    return fetch('/api/v1/scores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'offline' }; });
  };

  // ---- lifecycle ----
  var wired = false;
  platform.init = function () {
    var sh = SH();
    if (!sh) return false;
    if (!sh.token) sh.init();
    if (!wired) {
      wired = true;
      sh.on('saved', function (ok) { setSyncStatus(ok ? 'synced' : 'offline'); });
      sh.on('auth', function (a) {
        var was = platform.hosted;
        syncFromSdk();
        if (was && !a.signedIn) {
          platform.nickname = null;
          setSyncStatus('offline');
          if (platform.onSignedOut) { try { platform.onSignedOut(); } catch (_) {} }
        }
      });
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pagehide', flushCloudSave);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') flushCloudSave();
        });
      }
    }
    syncFromSdk();
    return platform.hosted;
  };

  platform.canSignIn = function () { var sh = SH(); return !!(sh && sh.canSignIn()); };
  platform.signIn = function () { var sh = SH(); return !!(sh && sh.signIn()); };
  platform.inviteLink = function () { return platform.hosted ? SH().inviteLink() : null; };
  platform.loadProfile = loadProfile;
  platform.nicknameFor = nicknameFor;
  platform.cloudSave = cloudSave;
  platform.scheduleCloudSave = scheduleCloudSave;
  platform.flushCloudSave = flushCloudSave;
  platform.loadCloud = loadCloud;
  platform.loadSettings = loadSettings;
  platform.pushSettings = pushSettings;
  platform.loadControls = loadControls;
  platform.actionFor = actionFor;
  platform.keyLabel = keyLabel;
  platform.leaderboardInfo = leaderboardInfo;
  platform.leaderboardEntries = leaderboardEntries;

  return platform;
});
