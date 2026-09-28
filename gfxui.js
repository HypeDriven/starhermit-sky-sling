'use strict';

/*
 * Sky Sling - Graphics settings section: quality preset, render scale,
 * per-effect overrides, adaptive resolution, frame-rate readout and a cost
 * summary. Strings are localized here (locale from navigator.language); the
 * rest of the game is English-only.
 */
(function (root, factory) {
  var api = factory((root.SkySling || {}).gfx || (typeof module !== 'undefined' ? require('./gfx') : null));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.gfxui = api;
})(typeof self !== 'undefined' ? self : globalThis, function (G) {

  var CAT_ORDER = ['shadows', 'ao', 'bloom', 'grade', 'antialias', 'reflections', 'particles', 'background', 'detail'];

  var EN = {
    title: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
    low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
    scale: 'Render scale', fromPreset: 'From preset ({tier})',
    cat: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
      reflections: 'Sky reflections', particles: 'Particles', background: 'Sky & sea motion', detail: 'Scene detail' },
    tier: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Still', animated: 'Animated', plain: 'Plain', detailed: 'Detailed' },
    adaptive: 'Adaptive resolution', fps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device; effects are rendered without it.',
    gpuUnknown: 'Unknown GPU',
    words: { noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
      bloom: 'bloom', reflections: 'sky reflections', noAA: 'no anti-aliasing' }
  };

  function extend(base, patch) {
    var out = {};
    Object.keys(base).forEach(function (k) {
      out[k] = (patch[k] && typeof base[k] === 'object') ? extend(base[k], patch[k]) : (patch[k] != null ? patch[k] : base[k]);
    });
    return out;
  }

  var ES = {
    title: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
    scale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
    cat: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes',
      reflections: 'Reflejos del cielo', particles: 'Partículas', background: 'Movimiento de cielo y mar', detail: 'Detalle del escenario' },
    tier: { off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto', static: 'Quieto', animated: 'Animado', plain: 'Simple', detailed: 'Detallado' },
    adaptive: 'Resolución adaptativa', fps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; se muestra sin efectos.',
    gpuUnknown: 'GPU desconocida',
    words: { noShadows: 'sin sombras', shadows: 'sombras', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
      bloom: 'resplandor', reflections: 'reflejos del cielo', noAA: 'sin suavizado' }
  };

  var FR = {
    title: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    low: 'Basse', balanced: 'Équilibrée', high: 'Élevée', ultra: 'Ultra',
    scale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    cat: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
      reflections: 'Reflets du ciel', particles: 'Particules', background: 'Mouvement du ciel et de la mer', detail: 'Détail du décor' },
    tier: { off: 'Non', on: 'Oui', low: 'Basses', medium: 'Moyennes', high: 'Élevées', static: 'Fixe', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé' },
    adaptive: 'Résolution adaptative', fps: 'Afficher les images par seconde',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le rendu se fait sans effets.',
    gpuUnknown: 'GPU inconnu',
    words: { noShadows: 'sans ombres', shadows: 'ombres', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
      bloom: 'halo', reflections: 'reflets du ciel', noAA: 'sans anticrénelage' }
  };

  var STRINGS = {
    'en-US': EN,
    'en-GB': extend(EN, {
      cat: { grade: 'Colour grade', background: 'Sky & sea motion' },
      postFailed: 'Post-processing is unavailable on this device; effects are rendered without it.'
    }),
    'es-419': ES,
    'es-ES': extend(ES, {
      tier: { off: 'Desactivado', on: 'Activado' },
      fps: 'Mostrar imágenes por segundo'
    }),
    'de-DE': {
      title: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
      low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
      scale: 'Renderskalierung', fromPreset: 'Laut Voreinstellung ({tier})',
      cat: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
        reflections: 'Himmelsspiegelungen', particles: 'Partikel', background: 'Himmel- und Meeresbewegung', detail: 'Szenendetails' },
      tier: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
        static: 'Ruhig', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert' },
      adaptive: 'Adaptive Auflösung', fps: 'Bildrate anzeigen',
      postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne Effekte gerendert.',
      gpuUnknown: 'Unbekannte GPU',
      words: { noShadows: 'keine Schatten', shadows: 'Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
        bloom: 'Leuchteffekt', reflections: 'Himmelsspiegelungen', noAA: 'keine Kantenglättung' }
    },
    'fr-FR': FR,
    'fr-CA': extend(FR, {
      fps: 'Afficher la fréquence d’images',
      cat: { antialias: 'Lissage des contours' },
      words: { noAA: 'sans lissage' }
    }),
    'pt-BR': {
      title: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
      low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
      scale: 'Escala de renderização', fromPreset: 'Conforme a predefinição ({tier})',
      cat: { shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Suavização de bordas',
        reflections: 'Reflexos do céu', particles: 'Partículas', background: 'Movimento do céu e do mar', detail: 'Detalhe do cenário' },
      tier: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
        static: 'Parado', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado' },
      adaptive: 'Resolução adaptável', fps: 'Mostrar taxa de quadros',
      postFailed: 'O pós-processamento não está disponível neste dispositivo; a imagem é exibida sem efeitos.',
      gpuUnknown: 'GPU desconhecida',
      words: { noShadows: 'sem sombras', shadows: 'sombras', ao: 'oclusão ambiente', aoHigh: 'oclusão ambiente completa',
        bloom: 'brilho', reflections: 'reflexos do céu', noAA: 'sem suavização' }
    },
    'it-IT': {
      title: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
      low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
      scale: 'Scala di rendering', fromPreset: 'Da preimpostazione ({tier})',
      cat: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
        reflections: 'Riflessi del cielo', particles: 'Particelle', background: 'Movimento di cielo e mare', detail: 'Dettaglio scena' },
      tier: { off: 'No', on: 'Sì', low: 'Basse', medium: 'Medie', high: 'Alte', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
        static: 'Fermo', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato' },
      adaptive: 'Risoluzione adattiva', fps: 'Mostra frequenza fotogrammi',
      postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il rendering avviene senza effetti.',
      gpuUnknown: 'GPU sconosciuta',
      words: { noShadows: 'senza ombre', shadows: 'ombre', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
        bloom: 'bagliore', reflections: 'riflessi del cielo', noAA: 'senza antialiasing' }
    }
  };
  // fill any gaps (e.g. AA acronyms) from English
  Object.keys(STRINGS).forEach(function (k) { STRINGS[k] = extend(EN, STRINGS[k]); });

  function pickLocale(lang) {
    var l = String(lang || 'en-US');
    if (STRINGS[l]) return l;
    var lower = l.toLowerCase();
    if (/^en-(gb|ie|au|nz|za|in)/.test(lower)) return 'en-GB';
    if (lower === 'es-es' || lower === 'es') return 'es-ES';
    if (/^es-/.test(lower)) return 'es-419';
    if (lower === 'fr-ca') return 'fr-CA';
    if (/^fr/.test(lower)) return 'fr-FR';
    if (/^pt/.test(lower)) return 'pt-BR';
    if (/^de/.test(lower)) return 'de-DE';
    if (/^it/.test(lower)) return 'it-IT';
    return 'en-US';
  }

  function strings(lang) { return STRINGS[pickLocale(lang)]; }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }

  /*
   * mount(container, api): api = { get(): saved, set(saved), info(): renderer.graphicsInfo() | null }
   * Returns { refresh() } — call when the settings panel opens.
   */
  function mount(container, api, lang) {
    var T = strings(lang || (typeof navigator !== 'undefined' && navigator.language));
    container.innerHTML = '';
    var legend = container.parentNode && container.parentNode.querySelector('legend');
    if (legend) legend.textContent = T.title;

    function row(labelText, control, forId, extra) {
      var lab = el('label', { 'for': forId, 'class': 'gfx-row' });
      lab.appendChild(el('span', { 'class': 'gfx-label' }, labelText));
      var right = el('span', { 'class': 'gfx-control' });
      right.appendChild(control);
      if (extra) right.appendChild(extra);
      lab.appendChild(right);
      container.appendChild(lab);
    }

    var preset = el('select', { id: 'gfx-preset', 'data-gfx': 'preset' });
    ['auto'].concat(G.PRESETS).forEach(function (p) { preset.appendChild(el('option', { value: p }, p === 'auto' ? '' : T[p])); });
    row(T.quality, preset, 'gfx-preset');

    var scale = el('input', { id: 'gfx-scale', 'data-gfx': 'render_scale', type: 'range', min: '50', max: '200', step: '10' });
    var scaleOut = el('output', { id: 'gfx-scale-value', 'for': 'gfx-scale', 'class': 'gfx-scale-value' }, '100%');
    row(T.scale, scale, 'gfx-scale', scaleOut);

    var selects = {};
    CAT_ORDER.forEach(function (cat) {
      var s = el('select', { id: 'gfx-' + cat, 'data-gfx': cat });
      s.appendChild(el('option', { value: 'preset' }, ''));
      G.CATEGORIES[cat].forEach(function (tier) { s.appendChild(el('option', { value: tier }, T.tier[tier] || tier)); });
      selects[cat] = s;
      row(T.cat[cat], s, 'gfx-' + cat);
    });

    function check(id, key, label) {
      var lab = el('label', { 'for': id, 'class': 'gfx-row gfx-check' });
      var box = el('input', { id: id, type: 'checkbox', 'data-gfx': key });
      lab.appendChild(box);
      lab.appendChild(el('span', { 'class': 'gfx-label' }, label));
      container.appendChild(lab);
      return box;
    }
    var adaptive = check('gfx-adaptive', 'adaptive', T.adaptive);
    var fps = check('gfx-fps', 'show_fps', T.fps);

    var summary = el('p', { id: 'gfx-summary', 'class': 'dim gfx-summary', 'aria-live': 'polite' });
    container.appendChild(summary);
    var note = el('p', { id: 'gfx-note', 'class': 'accent gfx-note', role: 'note' }, T.postFailed);
    note.hidden = true;
    container.appendChild(note);

    function saved() { return Object.assign({}, api.get() || {}); }
    function commit(s) { api.set(s); refresh(); }

    preset.addEventListener('change', function () { commit(G.choosePreset(saved(), preset.value)); });
    scale.addEventListener('input', function () {
      var s = saved(); s.render_scale = Number(scale.value) / 100;
      scaleOut.textContent = scale.value + '%';
      commit(s);
    });
    CAT_ORDER.forEach(function (cat) {
      selects[cat].addEventListener('change', function () {
        var s = saved();
        if (selects[cat].value === 'preset') delete s[cat]; else s[cat] = selects[cat].value;
        commit(s);
      });
    });
    adaptive.addEventListener('change', function () { var s = saved(); s.adaptive = adaptive.checked; commit(s); });
    fps.addEventListener('change', function () { var s = saved(); s.show_fps = fps.checked; commit(s); });

    function refresh() {
      var s = saved();
      var info = api.info() || {};
      var detected = info.detected || 'balanced';
      var r = G.resolve(s, detected);
      preset.options[0].textContent = T.auto.replace('{tier}', T[detected]);
      preset.value = G.PRESETS.indexOf(s.preset) >= 0 ? s.preset : 'auto';
      var pct = Math.round(r.userScale * 100);
      scale.value = String(pct);
      scaleOut.textContent = pct + '%';
      CAT_ORDER.forEach(function (cat) {
        var own = G.presetTier(r.preset, cat);
        selects[cat].options[0].textContent = T.fromPreset.replace('{tier}', T.tier[own] || own);
        selects[cat].value = G.CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : 'preset';
      });
      adaptive.checked = r.adaptive;
      fps.checked = r.showFps;
      var parts = [info.gpu || T.gpuUnknown, G.describe(r, info.pixels && info.pixels[0] ? info.pixels : null, T.words)];
      summary.textContent = parts.join(' · ');
      note.hidden = !info.postFailed;
    }

    refresh();
    return { refresh: refresh };
  }

  return { mount: mount, strings: strings, pickLocale: pickLocale, STRINGS: STRINGS, CAT_ORDER: CAT_ORDER };
});
