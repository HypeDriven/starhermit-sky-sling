'use strict';
// Localization coverage (node --test): every player-facing English key the
// engine client shows (tests/i18n-keys.js: T()/N() calls in native/*.ts, the
// audio captions, tutorial texts and achievement names) is translated in
// every non-English locale with the same {placeholders} and no unused rows;
// // switches locale (the runtime's Options › Language drives it).
var test = require('node:test');
var assert = require('node:assert');
var ALL = require('./i18n-keys.js').ALL;
var I18N = { DICTS: JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../assets/strings.json'), 'utf8')) };
I18N.LOCALES = Object.keys(I18N.DICTS);

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

test('regional tables inherit', function () {
  assert.strictEqual(I18N.DICTS['it-IT'].Play, 'Gioca');
  assert.strictEqual(I18N.DICTS['es-ES'].Settings, 'Ajustes');
  assert.strictEqual(I18N.DICTS['es-ES'].Play, 'Jugar');
});
