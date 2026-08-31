'use strict';

/*
 * Sky Sling - authoritative server (Node, no dependencies).
 * Serves the static distribution plus same-origin /api routes:
 *   GET  /api/v1/time    - platform time for countdown/daily sync
 *   GET  /api/v1/daily   - today's shared daily seed + ruleset version
 *   GET  /api/v1/scores  - leaderboard (board query param)
 *   POST /api/v1/scores  - score submission, validated by replaying the
 *                          ordered input log against deterministic rules
 */
var http = require('http');
var fs = require('fs');
var path = require('path');

var R = require('./rules');
var C = require('./content');

var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
var ROOT = __dirname;
var SCORES_FILE = path.join(ROOT, 'scores.json');
var MAX_BODY = 64 * 1024;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.opus': 'audio/ogg',
  '.woff2': 'font/woff2'
};

function send(res, code, type, body, headers) {
  var h = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (headers) Object.assign(h, headers);
  res.writeHead(code, h);
  res.end(body);
}
function sendJSON(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function sendErr(res, code, msg) { sendJSON(res, code, { error: msg }); }

// ---- score store ------------------------------------------------------------
function loadScores() {
  try { return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); }
  catch (_) { return { daily: {}, journey: {} }; }
}
function saveScores(db) {
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(db)); } catch (_) {}
}

// naive per-IP rate limit: 10 submissions / minute
var rate = {};
function rateOk(ip) {
  var now = Date.now();
  var rec = rate[ip] = (rate[ip] || []).filter(function (t) { return now - t < 60000; });
  if (rec.length >= 10) return false;
  rec.push(now);
  return true;
}

// Authoritative validation: replay the input log and compare score claims.
function validateSubmission(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'malformed' };
  var env = body.envelope;
  if (!env || env.version !== R.RULES_VERSION) return { ok: false, error: 'stale-version' };
  if (typeof body.score !== 'number' || body.score < 0 || body.score > 1000000) {
    return { ok: false, error: 'implausible-score' };
  }
  var level = null;
  if (body.board === 'daily') {
    var key = C.dailyKey(new Date());
    if (body.key !== 'daily-' + key) return { ok: false, error: 'stale-daily' };
    level = C.makeDaily(new Date());
  } else if (body.board === 'journey') {
    level = C.getLevel(env.index);
  } else {
    return { ok: false, error: 'unknown-board' };
  }
  if (!level) return { ok: false, error: 'unknown-level' };
  if (env.seed !== level.seed) return { ok: false, error: 'seed-mismatch' };
  var rep = R.replay(level, env);
  if (!rep.ok) return { ok: false, error: 'replay-failed: ' + rep.reason };
  if (rep.score.total !== body.score) return { ok: false, error: 'score-mismatch' };
  return { ok: true, ticks: rep.state.tick, invalidActions: rep.state.invalidActions, won: rep.state.won };
}

// ---- request handling ---------------------------------------------------------
var server = http.createServer(function (req, res) {
  var url = (req.url || '/').split('?')[0];
  var query = {};
  try {
    var qi = (req.url || '').indexOf('?');
    if (qi >= 0) new URLSearchParams(req.url.slice(qi + 1)).forEach(function (v, k) { query[k] = v; });
  } catch (_) {}

  if (url === '/api/v1/time') {
    return sendJSON(res, 200, { now: Date.now() });
  }
  if (url === '/api/v1/daily') {
    var key = C.dailyKey(new Date());
    var lv = C.makeDaily(new Date());
    return sendJSON(res, 200, { key: key, seed: lv.seed, version: lv.version, id: lv.id });
  }
  if (url === '/api/v1/scores' && req.method === 'GET') {
    var board = query.board === 'journey' ? 'journey' : 'daily';
    var db = loadScores();
    var list = db[board] && db[board][query.key || ''] ? db[board][query.key || ''] : [];
    return sendJSON(res, 200, { board: board, key: query.key || '', scores: list.slice(0, 50) });
  }
  if (url === '/api/v1/scores' && req.method === 'POST') {
    var ip = req.socket.remoteAddress || 'unknown';
    if (!rateOk(ip)) return sendErr(res, 429, 'rate-limited');
    var body = '';
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > MAX_BODY) { req.destroy(); }
    });
    req.on('end', function () {
      var parsed;
      try { parsed = JSON.parse(body); } catch (_) { return sendErr(res, 400, 'bad-json'); }
      var v = validateSubmission(parsed);
      if (!v.ok) return sendErr(res, 422, v.error);
      var db = loadScores();
      var board = parsed.board, key = String(parsed.key);
      db[board] = db[board] || {};
      db[board][key] = db[board][key] || [];
      var name = String(parsed.name || 'guest').slice(0, 24).replace(/[<>&"]/g, '');
      // idempotent: same envelope command count + score from same name updates in place
      var existing = db[board][key].filter(function (s) { return s.name === name; })[0];
      var entry = {
        name: name, score: parsed.score, won: !!v.won,
        ticks: v.ticks, invalidActions: v.invalidActions,
        version: parsed.envelope.version, seed: parsed.envelope.seed,
        ts: Date.now()
      };
      if (existing) Object.assign(existing, entry);
      else db[board][key].push(entry);
      db[board][key].sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (a.won !== b.won) return a.won ? -1 : 1;
        if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
        if (a.ticks !== b.ticks) return a.ticks - b.ticks;
        return a.name < b.name ? -1 : 1;
      });
      db[board][key] = db[board][key].slice(0, 50);
      saveScores(db);
      sendJSON(res, 200, { ok: true, rank: db[board][key].indexOf(db[board][key].filter(function (s) { return s.name === name; })[0]) + 1 });
    });
    return;
  }
  if (url.indexOf('/api/') === 0) return sendErr(res, 404, 'unknown-endpoint');

  // static files (path-traversal safe)
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendErr(res, 405, 'method-not-allowed');
  var rel = url === '/' ? '/index.html' : decodeURIComponent(url);
  var file = path.normalize(path.join(ROOT, rel));
  if (file.indexOf(ROOT + path.sep) !== 0 && file !== ROOT) return sendErr(res, 403, 'forbidden');
  fs.readFile(file, function (err, data) {
    if (err) return sendErr(res, 404, 'not-found');
    var ext = path.extname(file).toLowerCase();
    send(res, 200, MIME[ext] || 'application/octet-stream', data);
  });
});

module.exports = { start: function (port) {
  server.listen(port || PORT);
  return server;
}, PORT: PORT, validateSubmission: validateSubmission };

if (require.main === module) {
  server.listen(PORT, function () {
    console.log('Sky Sling server listening on http://localhost:' + PORT);
  });
}
