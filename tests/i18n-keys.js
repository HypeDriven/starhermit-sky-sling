'use strict';
// Key extraction for the i18n coverage test: literal T('…') / N('…') calls in
// the game scripts, audio caption cues, data-i18n markup in index.html, and
// the display fields of the content tables (tutorial texts, achievements).
var fs = require('fs');
var path = require('path');
var C = require('../content');
var S = require('../session');

var ROOT = path.join(__dirname, '..');
var SKIP = { 'i18n.js': 1, 'gfxui.js': 1, 'sh-strings.js': 1, 'sh-language.js': 1, 'game-options.js': 1, 'starhermit-sdk.js': 1 };
function unescapeJs(s) { return s.replace(/\\(['"\\`])/g, '$1'); }
function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&mdash;/g, '—').replace(/&amp;/g, '&');
}

function sourceKeys() {
  var keys = new Set();
  var call = /(?<![\w.$])(?:T|N|_caption)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  var ternary = /(?<![\w.$])T\([^'"\n()]*?\?\s*'((?:[^'\\\n]|\\.)*)'\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
  fs.readdirSync(ROOT).forEach(function (f) {
    if (!/\.js$/.test(f) || SKIP[f] || /\.min\.js$/.test(f) || f === 'test.js' || f === 'server.js') return;
    var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    var m;
    while ((m = call.exec(src))) keys.add(unescapeJs(m[1] != null ? m[1] : m[2]));
    while ((m = ternary.exec(src))) { keys.add(unescapeJs(m[1])); keys.add(unescapeJs(m[2])); }
  });
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var re = /data-i18n(?:-aria|-title|-html)?="([^"]+)"/g, h;
  while ((h = re.exec(html))) keys.add(unescapeHtml(h[1]));
  return keys;
}

function contentKeys() {
  var keys = new Set();
  for (var i = 0; i < C.LEVEL_COUNT; i++) { var t = C.getLevel(i).tutorial; if (t) keys.add(t.text); }
  C.LESSONS.forEach(function (l) { keys.add(l.text); });
  S.ACHIEVEMENTS.forEach(function (a) { keys.add(a.name); });
  return keys;
}

var ALL = new Set(Array.from(sourceKeys()).concat(Array.from(contentKeys())));
module.exports = { ALL: ALL, sourceKeys: sourceKeys, contentKeys: contentKeys };

if (require.main === module) ALL.forEach(function (k) { console.log(JSON.stringify(k)); });
