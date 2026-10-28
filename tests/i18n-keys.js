'use strict';
// Key extraction for the i18n coverage test: literal T("…") / N("…") calls in
// the engine client (native/*.ts), the audio caption cues (native/audio.ts
// CAPTIONS), and the display fields of the content tables (tutorial texts,
// lesson texts, achievement names).
var fs = require('fs');
var path = require('path');
var C = require('../content');
var S = require('../session');

var ROOT = path.join(__dirname, '..');
function unescapeJs(s) { return s.replace(/\\(['"\\`])/g, '$1'); }

function sourceKeys() {
  var keys = new Set();
  var call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  var dir = path.join(ROOT, 'native');
  fs.readdirSync(dir).forEach(function (f) {
    if (!/\.ts$/.test(f)) return;
    var src = fs.readFileSync(path.join(dir, f), 'utf8');
    var m;
    while ((m = call.exec(src))) keys.add(unescapeJs(m[1] != null ? m[1] : m[2]));
    if (f === 'audio.ts') {
      var cap = /CAPTIONS[^{]*\{([^}]*)\}/.exec(src);
      var re = /:\s*"([^"]+)"/g, c;
      while (cap && (c = re.exec(cap[1]))) keys.add(c[1]);
    }
  });
  return keys;
}

function contentKeys() {
  var keys = new Set();
  for (var i = 0; i < C.LEVEL_COUNT; i++) { var t = C.getLevel(i).tutorial; if (t) keys.add(t.text); }
  C.LESSONS.forEach(function (l) { keys.add(l.text); });
  S.ACHIEVEMENTS.forEach(function (a) { keys.add(a.name); });
  return keys;
}

var ALL = new Set();
sourceKeys().forEach(function (k) { ALL.add(k); });
contentKeys().forEach(function (k) { ALL.add(k); });
module.exports = { ALL: ALL, sourceKeys: sourceKeys, contentKeys: contentKeys };
