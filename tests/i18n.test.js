'use strict';
// Localization coverage (node --test): every player-facing English key the
// engine client shows (tests/i18n-keys.js: T()/N() calls in native/*.ts, the
// audio captions, tutorial texts and achievement names) is translated in
// every non-English locale with the same {placeholders} and no unused rows;
// the StarHermit account strings cover all nine locales; T falls back and
// switches locale (the runtime's Options › Language drives it).
var test = require('node:test');
var assert = require('node:assert');
var ALL = require('./i18n-keys.js').ALL;
var I18N = require('../i18n.js');
var SH = require('../sh-strings.js');

function ph(s) { return (String(s).match(/\{(\w+)\}/g) || []).sort().join(','); }

test('nine locales', function () {
  assert.deepStrictEqual(I18N.LOCALES, ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']);
  assert.ok(ALL.size > 100, 'only ' + ALL.size + ' keys');
});

I18N.LOCALES.filter(function (l) { return l.indexOf('en-') !== 0; }).forEach(function (loc) {
  test(loc + ' covers every key with matching placeholders', function () {
    var d = I18N.DICTS[loc];
    var missing = Array.from(ALL).filter(function (k) { return !(k in d); });
    assert.deepStrictEqual(missing, [], loc + ' missing ' + missing.length);
    var bad = Array.from(ALL).filter(function (k) { return ph(d[k]) !== ph(k); });
    assert.deepStrictEqual(bad, [], loc + ' placeholder mismatch');
    var stray = Object.keys(d).filter(function (k) { return !ALL.has(k); });
    assert.deepStrictEqual(stray, [], loc + ' stray keys');
  });
});

test('help markup keeps its <kbd> keys in every locale', function () {
  var key = 'Release or press <kbd>Space</kbd> to launch. Each launch uses one shot.';
  I18N.LOCALES.slice(2).forEach(function (loc) { assert.ok(/<kbd>Space<\/kbd>/.test(I18N.DICTS[loc][key]), loc); });
});

test('account strings cover all nine locales', function () {
  I18N.LOCALES.forEach(function (loc) {
    assert.ok(SH.STRINGS[loc], loc);
    assert.strictEqual(SH.strings(loc), SH.STRINGS[loc]);
    assert.ok(SH.strings(loc).signIn && SH.strings(loc).lbRank.indexOf('{rank}') >= 0, loc);
  });
  assert.strictEqual(SH.strings('xx-YY'), SH.STRINGS['en-US']);
  assert.notStrictEqual(SH.strings('de-DE').signIn, SH.strings('en-US').signIn);
});

test('T formats, falls back and switches live', function () {
  var seen = [];
  I18N.onLanguage(function (l) { seen.push(l); });
  I18N.setLocale('it-IT');
  assert.strictEqual(I18N.T('Play'), 'Gioca');
  assert.strictEqual(I18N.T('Collapse every Bumble ({n} left)', { n: 2 }), 'Abbatti tutti i Bumble (ne restano 2)');
  assert.strictEqual(I18N.T('Aviator'), 'Aviator');
  I18N.setLocale('es-ES');
  assert.strictEqual(I18N.T('Settings'), 'Ajustes');
  assert.strictEqual(I18N.T('Play'), 'Jugar'); // inherited from es-419
  I18N.setLocale('xx');
  assert.strictEqual(I18N.getLang(), 'en-US');
  assert.deepStrictEqual(seen, ['it-IT', 'es-ES', 'en-US']);
});
