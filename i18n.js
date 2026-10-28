/* Sky Sling — localization core (classic script / CommonJS).
 *
 * Every player-facing string is authored in US English and looked up by that
 * English text: T('Play') → the current locale's translation (en-US is the key
 * itself). Placeholders use {name}. N('…') marks a string for extraction
 * without translating it at that point.
 *
 * The locale comes from sh-language.js (window.StarHermitLanguage): the game's
 * Language setting (`ui.language`), Automatic → the StarHermit account's
 * preferred language → navigator.languages → en-US. `?lang=` forces a locale
 * for one page load (QA links) and hides the selector. A change re-applies
 * `data-i18n` markup, sets <html lang>, and notifies onLanguage listeners so
 * every screen, HUD and dialog re-renders in place.
 *
 * Dictionaries live in locales/*.js (loaded before this file in the page,
 * required in Node).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, {
      'en-GB': require('./locales/en-GB.js'), es: require('./locales/es.js'), de: require('./locales/de.js'),
      fr: require('./locales/fr.js'), pt: require('./locales/pt.js'), it: require('./locales/it.js'),
    });
  } else { root.SkySling = root.SkySling || {}; root.SkySling.i18n = factory(root, root.SkySlingLocales || {}); }
})(typeof self !== 'undefined' ? self : globalThis, function (root, L) {
  'use strict';
  const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const es = L.es || {}, fr = L.fr || {};
  /** Locale → { English key: translation }. en-US is the identity; en-GB lists spelling changes. */
  const DICTS = {
    'en-US': {},
    'en-GB': L['en-GB'] || {},
    'es-419': es.ES_419 || {},
    'es-ES': Object.assign({}, es.ES_419 || {}, es.ES_ES || {}),
    'de-DE': L.de || {},
    'fr-FR': fr.FR_FR || {},
    'fr-CA': Object.assign({}, fr.FR_FR || {}, fr.FR_CA || {}),
    'pt-BR': L.pt || {},
    'it-IT': L.it || {},
  };
  let lang = 'en-US';
  let dict = DICTS[lang];
  const listeners = [];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function fmt(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
  }
  /** Translate an English source string (unknown strings, e.g. player names, pass through). */
  function T(key, vars) {
    if (key == null) return '';
    const s = String(key);
    const out = has(dict, s) ? dict[s] : s;
    return vars ? fmt(out, vars) : out;
  }
  const N = (key) => key;
  function getLang() { return lang; }
  function onLanguage(fn) { listeners.push(fn); }

  /** Re-apply data-i18n (text), data-i18n-html (authored markup), data-i18n-aria (aria-label) and data-i18n-title (title). */
  function applyMarkup(doc) {
    doc = doc || root.document;
    if (!doc || !doc.querySelectorAll) return;
    doc.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = T(n.dataset.i18n); });
    doc.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', T(n.dataset.i18nAria)); });
    doc.querySelectorAll('[data-i18n-title]').forEach((n) => { n.setAttribute('title', T(n.dataset.i18nTitle)); });
    // authored rich text (e.g. <kbd> keys) from our own dictionaries only
    doc.querySelectorAll('[data-i18n-html]').forEach((n) => { n.innerHTML = T(n.dataset.i18nHtml); });
  }

  function setLocale(next) {
    const resolved = DICTS[next] ? next : 'en-US';
    const changed = resolved !== lang;
    lang = resolved;
    dict = DICTS[lang];
    const doc = root.document;
    if (doc && doc.documentElement) {
      doc.documentElement.lang = lang;
      if (doc.readyState !== 'loading') applyMarkup(doc);
    }
    if (changed) listeners.slice().forEach((fn) => { try { fn(lang); } catch (e) { console.error(e); } });
  }

  /** Wire the StarHermit language preference (browser only). Returns the sh-language instance or null. */
  function initLanguage() {
    const SHL = root.StarHermitLanguage;
    let forced = null;
    try { forced = new URLSearchParams((root.location && root.location.search) || '').get('lang'); } catch (e) { /* opaque origin */ }
    const forcedLocale = forced && SHL ? SHL.match(forced, LOCALES) : null;
    if (!SHL) { setLocale('en-US'); return null; }
    return SHL.create({
      game: 'sky-sling', supported: LOCALES, panel: !forcedLocale,
      apply: (locale) => setLocale(forcedLocale || locale),
    });
  }

  return { LOCALES, DICTS, T, N, fmt, getLang, onLanguage, applyMarkup, setLocale, initLanguage };
});
