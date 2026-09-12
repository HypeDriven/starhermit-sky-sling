'use strict';

/*
 * Sky Sling - platform adapter: launch-token auth, account profile, cloud-save
 * mirror, read-only platform leaderboard. Hosted mode activates iff a launch
 * token was read from the URL; its own server.js daily/scores routes are used
 * only as a local-dev its-backend. localStorage stays the offline cache.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.platform = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  // ---- minimal stored-zip helper (single entry, no compression) ----------------
  var CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    const enc = new TextEncoder();
    const nameB = enc.encode(name);
    const crc = crc32(dataBytes);
    const out = [];
    const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
    const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    const head = new Uint8Array(out);
    const cd = [];
    const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
    const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
    const cdHead = new Uint8Array(cd);
    const cdOff = head.length + nameB.length + dataBytes.length;
    const parts = [head, nameB, dataBytes, cdHead, nameB];
    const eocd = [];
    const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    // Stored single-entry reader: scan local headers for compression 0.
    const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    let off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      const method = dv.getUint16(off + 8, true);
      const size = dv.getUint32(off + 18, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    const s = atob(b64);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }

  // ---- launch token ---------------------------------------------------------------
  // Read once from the #game_token fragment (then strip it); query params are a
  // local-dev fallback only. Never persisted.
  function readToken() {
    var token = null;
    try {
      var frag = (location.hash || '').replace(/^#/, '');
      var idx = frag.indexOf('game_token=');
      if (idx >= 0) {
        var end = frag.indexOf('&', idx);
        token = frag.slice(idx + 'game_token='.length, end < 0 ? undefined : end);
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        var q = new URLSearchParams(location.search);
        token = q.get('game_token') || q.get('token') || q.get('launch');
      }
    } catch (_) {}
    return token || null;
  }

  function decodeJwtPayload(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length < 2) return null;
      var p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var bin = atob(p);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var d = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      return (d && typeof d === 'object') ? d : null;
    } catch (_) { return null; }
  }

  var REFRESH_MS = 45 * 60 * 1000;
  var REFRESH_RETRY_MS = 60 * 1000;
  var SAVE_DEBOUNCE_MS = 2000;

  var platform = {
    hosted: false,
    token: null,
    userId: null,
    slug: null,
    nickname: null,
    serverOffset: 0,
    syncStatus: 'offline',
    onSyncStatus: null,          // fn(status), set by boot
    _nickCache: {},
    _saveTimer: null,
    _pendingDoc: null,
    _refreshTimer: null,
    _tokenRejected: false
  };

  function authHeaders(json) {
    var h = {};
    if (platform.token) h['Authorization'] = 'Bearer ' + platform.token;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function setSyncStatus(s) {
    platform.syncStatus = s;
    if (platform.onSyncStatus) { try { platform.onSyncStatus(s); } catch (_) {} }
  }

  // ---- profile --------------------------------------------------------------------
  // GET /api/v1/users/{id}/profile — NEVER /api/v1/me, never usernames.
  function nicknameFor(userId) {
    if (userId == null) return Promise.resolve(null);
    var key = String(userId);
    if (platform._nickCache[key] != null) return Promise.resolve(platform._nickCache[key]);
    return fetch('/api/v1/users/' + encodeURIComponent(key) + '/profile', {
      headers: authHeaders(false)
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    }).then(function (d) {
      var nick = (d && typeof d.nickname === 'string' && d.nickname.trim())
        ? d.nickname.trim() : null;
      nick = nick || ('Player ' + key.slice(0, 8));
      platform._nickCache[key] = nick;
      return nick;
    }).catch(function () {
      return 'Player ' + key.slice(0, 8);
    });
  }

  function loadProfile() {
    if (!platform.hosted || !platform.userId) return Promise.resolve(null);
    return nicknameFor(platform.userId).then(function (nick) {
      platform.nickname = nick;
      return nick;
    });
  }

  // ---- token refresh ----------------------------------------------------------------
  function scheduleRefresh() {
    if (!platform.hosted || !platform.slug || platform._tokenRejected) return;
    if (platform._refreshTimer) clearTimeout(platform._refreshTimer);
    platform._refreshTimer = setTimeout(refreshToken, REFRESH_MS);
  }

  function refreshToken() {
    if (!platform.hosted || !platform.token || !platform.slug || platform._tokenRejected) return;
    fetch('/api/v1/games/' + encodeURIComponent(platform.slug) + '/launch-token', {
      method: 'POST',
      headers: authHeaders(false)
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) { platform._tokenRejected = true; throw new Error('rejected'); }
      if (!r.ok) throw new Error('http-' + r.status);
      return r.json();
    }).then(function (d) {
      if (d && typeof d.token === 'string' && d.token) {
        platform.token = d.token; // swap in {token}; never persisted
        var p = decodeJwtPayload(d.token);
        if (p && p.sub) platform.userId = p.sub;
      }
      scheduleRefresh();
    }).catch(function () {
      if (platform.hosted && !platform._tokenRejected) {
        platform._refreshTimer = setTimeout(refreshToken, REFRESH_RETRY_MS);
      }
    });
  }

  // ---- cloud saves ---------------------------------------------------------------------
  // ONE slot per game (slug from game_scope), zip+base64. Remote wins conflicts;
  // localStorage remains the offline cache.
  function cloudSavePath() {
    return '/api/v1/me/cloud-saves/' + encodeURIComponent(platform.slug);
  }

  function cloudSave(progressDoc) {
    if (!platform.hosted || !platform.slug || !platform.token) return Promise.resolve(false);
    var bytes = new TextEncoder().encode(JSON.stringify(progressDoc));
    var body = JSON.stringify({ dataBase64: bytesToBase64(zipStore('skysling-progress.json', bytes)) });
    setSyncStatus('saving');
    return fetch(cloudSavePath(), {
      method: 'PUT',
      headers: authHeaders(true),
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error('http-' + r.status);
      setSyncStatus('synced');
      return true;
    }).catch(function () {
      setSyncStatus('offline'); // local cache intact; retried on next save
      return false;
    });
  }

  function scheduleCloudSave(progressDoc) {
    platform._pendingDoc = progressDoc;
    if (!platform.hosted) return;
    if (platform._saveTimer) clearTimeout(platform._saveTimer);
    platform._saveTimer = setTimeout(function () {
      platform._saveTimer = null;
      cloudSave(platform._pendingDoc);
    }, SAVE_DEBOUNCE_MS);
  }

  function flushCloudSave() {
    if (platform._saveTimer) { clearTimeout(platform._saveTimer); platform._saveTimer = null; }
    if (platform.hosted && platform._pendingDoc) return cloudSave(platform._pendingDoc);
    return Promise.resolve(false);
  }

  function loadCloud() {
    if (!platform.hosted || !platform.slug || !platform.token) return Promise.resolve(null);
    setSyncStatus('saving');
    return fetch(cloudSavePath(), { headers: authHeaders(false) })
      .then(function (r) {
        if (r.status === 404) { setSyncStatus('synced'); return null; } // no remote save yet
        if (!r.ok) throw new Error('http-' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        if (!buf) return null;
        var entry = unzipFirstEntry(new Uint8Array(buf));
        var d = JSON.parse(new TextDecoder('utf-8').decode(entry));
        setSyncStatus('synced');
        return d;
      })
      .catch(function () {
        setSyncStatus('offline'); // fall back to the local cache
        return null;
      });
  }

  // ---- leaderboards (read-only; clients never submit scores) ---------------------------
  function leaderboardInfo() {
    if (!platform.hosted || !platform.slug || !platform.token) return Promise.resolve(null);
    return fetch('/api/v1/games/' + encodeURIComponent(platform.slug), {
      headers: authHeaders(false)
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    }).catch(function () { return null; });
  }

  function leaderboardEntries(leaderboardId, opts) {
    if (!platform.hosted || !platform.token || !leaderboardId) return Promise.resolve(null);
    var q = new URLSearchParams();
    if (opts && opts.friendsOnly) q.set('friendsOnly', '1');
    q.set('page', String((opts && opts.page) || 0));
    q.set('pageSize', String((opts && opts.pageSize) || 50));
    return fetch('/api/v1/leaderboards/' + encodeURIComponent(leaderboardId) + '/entries?' + q.toString(), {
      headers: authHeaders(false)
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    }).catch(function () { return null; });
  }

  // ---- its-backend (the game's own server.js) — local dev only --------------------------
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
      // Platform leaderboards are script/elo-owned: clients can never submit.
      return Promise.resolve({ ok: false, error: 'client-submit-disabled' });
    }
    return fetch('/api/v1/scores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'offline' }; });
  };

  // ---- lifecycle -------------------------------------------------------------------------
  platform.init = function () {
    var token = readToken();
    if (!token) return false; // local play: offline cache only
    var claims = decodeJwtPayload(token);
    platform.token = token;
    platform.hosted = true;
    if (claims) {
      if (claims.sub) platform.userId = String(claims.sub);
      if (claims.game_scope) platform.slug = String(claims.game_scope);
    }
    scheduleRefresh();
    window.addEventListener('pagehide', flushCloudSave);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushCloudSave();
    });
    return true;
  };

  platform.loadProfile = loadProfile;
  platform.nicknameFor = nicknameFor;
  platform.cloudSave = cloudSave;
  platform.scheduleCloudSave = scheduleCloudSave;
  platform.flushCloudSave = flushCloudSave;
  platform.loadCloud = loadCloud;
  platform.leaderboardInfo = leaderboardInfo;
  platform.leaderboardEntries = leaderboardEntries;

  // exposed for the offline test suite (zip writer/reader round-trip)
  platform._zip = {
    zipStore: zipStore,
    unzipFirstEntry: unzipFirstEntry,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes
  };

  return platform;
});
