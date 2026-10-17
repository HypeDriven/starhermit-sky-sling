'use strict';

/*
 * Sky Sling - platform adapter tests: platform.js over the shipped StarHermit
 * SDK with a stubbed fetch and launch fragment. Covers token read/strip,
 * profile nickname, cloud-save round-trip on game:<slug>, settings KV
 * load + patch, key bindings, read-only leaderboard, sign-out, and zero
 * network traffic standalone.
 */
var assert = require('assert');
var SDK = require('../starhermit-sdk.js');

var USER = 'abcdef12-3456-7890-abcd-ef1234567890';
var SLUG = 'sky-sling-test';
function b64u(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
var TOKEN = b64u({ alg: 'none' }) + '.' + b64u({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';

function res(status, body) {
  var bytes = body instanceof Uint8Array ? body : null;
  var text = bytes || body == null ? '' : JSON.stringify(body);
  return {
    status: status, ok: status >= 200 && status < 300, statusText: String(status),
    text: async function () { return text; }, json: async function () { return JSON.parse(text); },
    arrayBuffer: async function () { return (bytes || Buffer.from(text)).slice().buffer; }
  };
}
function win(hash, hostname) {
  return {
    location: { hash: hash, search: '', pathname: '/index.html', hostname: hostname || 'localhost', href: 'http://localhost/index.html' + hash },
    history: { state: null, replaceState: function (_s, _t, url) { this.last = url; } }
  };
}
function freshPlatform(sh) {
  globalThis.StarHermit = sh;
  delete require.cache[require.resolve('../platform.js')];
  return require('../platform.js');
}

(async function () {
  // ---- hosted ----
  var calls = [], save = null, ver = 0, kv = { music: 0.2, graphics: { preset: 'low' }, junk: 1, 'ui.language': { choice: 'it-IT' } };
  var fetch = async function (url, init) {
    init = init || {};
    var method = init.method || 'GET', path = url.split('?')[0];
    calls.push({ url: url, method: method, auth: init.headers.Authorization, body: init.body, keepalive: init.keepalive });
    if (path === '/api/v1/users/' + USER + '/profile') return res(200, { username: 'sky_u', nickname: 'Aviator' });
    var slot = '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG);
    if (path === slot + '/info') return res(200, save ? { exists: true, etag: 'v' + ver } : { exists: false });
    if (path === slot) {
      if (method === 'PUT') {
        var h = init.headers || {}, cur = save ? 'v' + ver : null;
        if ((h['If-Match'] && h['If-Match'] !== cur) || (h['If-None-Match'] === '*' && cur)) return res(412, { etag: cur });
        save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        ver++;
        return res(200, { etag: 'v' + ver });
      }
      return save ? res(200, new Uint8Array(save)) : res(404);
    }
    if (path === '/api/v1/games/' + SLUG + '/settings') {
      if (method === 'PATCH') Object.assign(kv, JSON.parse(init.body).settings);
      return res(200, { settings: kv });
    }
    if (path === '/api/v1/games/' + SLUG + '/controls') return res(200, { actions: [{ action: 'launch', codes: ['KeyL'] }] });
    if (path === '/api/v1/games/' + SLUG + '/leaderboards') return res(200, [{ id: 'lb1', key: 'daily' }]);
    if (path === '/api/v1/leaderboards/lb1/entries') return res(200, { items: [{ userId: USER, score: 900, rank: 1 }], total: 1 });
    return res(404);
  };
  var w = win('#game_token=' + TOKEN + '&session_id=s1');
  var sh = SDK.create({ window: w, fetch: fetch, setTimeout: function () { return 0; }, clearTimeout: function () {} });
  sh.init();
  var P = freshPlatform(sh);
  assert.strictEqual(P.init(), true, 'hosted with fragment token');
  assert.strictEqual(w.history.last, '/index.html', 'token stripped');
  assert.strictEqual(P.slug, SLUG, 'slug from game_scope');
  assert.strictEqual(await P.loadProfile(), 'Aviator', 'profile nickname');
  assert.strictEqual(await P.loadCloud(), null, 'empty slot');

  P.scheduleCloudSave({ v: 1, stars: { 0: 3 } });
  await P.flushCloudSave();
  var put = calls.filter(function (c) { return c.method === 'PUT'; })[0];
  assert.ok(put.url.endsWith('/cloud-saves/game%3A' + SLUG), 'PUT to game:<slug>');
  assert.strictEqual(put.keepalive, true, 'flush uses keepalive');
  assert.deepStrictEqual(await P.loadCloud(), { v: 1, stars: { 0: 3 } }, 'cloud round-trip');
  assert.strictEqual(P.syncStatus, 'synced');

  // another device saves first: this write is refused (412) and reported
  // through onSaveConflict; reload + save then goes through
  var other = SDK.create({ window: win('#game_token=' + TOKEN), fetch: fetch, setTimeout: function () { return 0; }, clearTimeout: function () {} });
  other.init();
  await other.loadSave();
  assert.strictEqual(await other.writeSave(JSON.stringify({ v: 1, stars: { 1: 2 } })), true, 'other device saved');
  var conflicts = 0;
  P.onSaveConflict = function () { conflicts++; };
  P.scheduleCloudSave({ v: 1, stars: { 0: 3, 2: 1 } });
  await P.flushCloudSave();
  assert.strictEqual(conflicts, 1, 'saveconflict reaches the game');
  assert.strictEqual(P.syncStatus, 'saving', 'a conflict is not shown as offline');
  assert.deepStrictEqual(await P.loadCloud(), { v: 1, stars: { 1: 2 } }, 'reload sees the other device');
  P.scheduleCloudSave({ v: 1, stars: { 0: 3, 1: 2, 2: 1 } });
  await P.flushCloudSave();
  assert.strictEqual(P.syncStatus, 'synced', 'merged save goes through');
  assert.deepStrictEqual(JSON.parse(await other.loadSave()).stars, { 0: 3, 1: 2, 2: 1 }, 'merged save landed');

  var remote = await P.loadSettings();
  assert.deepStrictEqual(remote, { music: 0.2, graphics: { preset: 'low' } }, 'only preference keys applied (never the shared ui.* keys)');
  P.pushSettings({ music: 0.8, replayTutorial: true, largeText: true });
  await new Promise(function (r) { setTimeout(r, 0); });
  var patch = calls.filter(function (c) { return c.method === 'PATCH'; })[0];
  assert.deepStrictEqual(JSON.parse(patch.body).settings, { music: 0.8, largeText: true }, 'settings PATCH');

  await P.loadControls();
  assert.strictEqual(P.actionFor('KeyL'), 'launch', 'binding override');
  assert.strictEqual(P.actionFor('Space'), null);
  assert.strictEqual(P.actionFor('KeyP'), 'pause', 'default kept');
  assert.strictEqual(P.keyLabel('pause'), 'Esc/P');

  var info = await P.leaderboardInfo();
  var list = await P.leaderboardEntries(info.leaderboardId, { page: 0, pageSize: 10 });
  assert.strictEqual(list.entries[0].score, 900, 'read-only board entries');
  assert.ok(calls.every(function (c) { return c.auth === 'Bearer ' + TOKEN; }), 'Bearer on every call');
  assert.ok(!calls.some(function (c) { return c.url === '/api/v1/me'; }), 'never /api/v1/me');

  assert.ok(P.inviteLink().indexOf('/game-invite/' + USER + '/' + SLUG) > 0, 'invite link');
  assert.strictEqual(P.canSignIn(), false);
  var out = 0;
  P.onSignedOut = function () { out++; };
  sh.signOut('expired');
  assert.strictEqual(out, 1, 'sign-out notified');
  assert.strictEqual(P.hosted, false);
  assert.strictEqual(P.inviteLink(), null);

  // ---- standalone ----
  var quiet = [];
  var sh2 = SDK.create({ window: win(''), fetch: async function (u) { quiet.push(u); return res(500); } });
  sh2.init();
  var P2 = freshPlatform(sh2);
  assert.strictEqual(P2.init(), false);
  assert.strictEqual(await P2.loadProfile(), null);
  assert.strictEqual(await P2.loadCloud(), null);
  P2.scheduleCloudSave({ v: 1 });
  await P2.flushCloudSave();
  assert.deepStrictEqual(await P2.loadSettings(), {});
  P2.pushSettings({ music: 1 });
  await P2.loadControls();
  assert.strictEqual(await P2.leaderboardInfo(), null);
  assert.strictEqual(P2.actionFor('Space'), 'launch');
  assert.strictEqual(P2.canSignIn(), false, 'no sign-in when running locally');
  assert.strictEqual(quiet.length, 0, 'no fetch standalone');

  // ---- on-platform without a token: sign-in offered ----
  var sh3 = SDK.create({ window: win('', '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com'), fetch: async function () { return res(500); } });
  sh3.init();
  var P3 = freshPlatform(sh3);
  P3.init();
  assert.strictEqual(P3.canSignIn(), true, 'sign-in button on <uuid>.starhermit.com');

  console.log('platform: all assertions passed');
})().catch(function (e) { console.error('FAIL', e); process.exit(1); });
