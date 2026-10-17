'use strict';

/*
 * Sky Sling - ui: responsive DOM shell, screen routing, focus management,
 * live regions, settings binding, accessibility mirror.
 * UI state never touches simulation state directly.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.ui = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  var SCREENS = ['ov-title', 'ov-mode-select', 'ov-level-select', 'ov-help',
                 'ov-pause', 'ov-settings', 'ov-results', 'ov-error', 'ov-compat'];

  var _lastFocus = null;
  var _actions = {};   // action name -> handler

  // Localization (i18n.js): English-keyed lookups; N() marks a key for extraction.
  function I18N() { var g = typeof self !== 'undefined' ? self : globalThis; return (g.SkySling || {}).i18n || null; }
  function T(key, vars) {
    var I = I18N();
    if (I) return I.T(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; });
  }
  function N(key) { return key; }

  function $(id) { return document.getElementById(id); }

  function init(actionHandlers) {
    _actions = actionHandlers || {};
    // delegated overlay buttons
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var name = btn.getAttribute('data-action');
      if (_actions[name]) { _actions[name](btn); }
    });
    return true;
  }

  // ---- screen routing with focus save/restore -------------------------------
  function show(id) {
    SCREENS.forEach(function (sid) {
      var el = $(sid);
      if (el) el.classList.toggle('hidden', sid !== id);
    });
    if (id) {
      _lastFocus = document.activeElement;
      var panel = $(id);
      var focusable = panel && panel.querySelector('button, [href], input, select, [tabindex]');
      // open at the top: focusing a bottom button (Close) would scroll a tall
      // panel past its heading on phones and zoomed large screens.
      if (panel) panel.scrollTop = 0;
      if (focusable) setTimeout(function () { focusable.focus({ preventScroll: true }); if (panel) panel.scrollTop = 0; }, 0);
    } else if (_lastFocus && document.contains(_lastFocus) && _lastFocus.offsetParent) {
      // only restore focus to a control that is still on screen, and only once:
      // hiding overlays happens on every settled shot, and re-focusing a stale
      // control each time would yank focus away mid-round.
      _lastFocus.focus();
      _lastFocus = null;
    } else {
      _lastFocus = null;
    }
  }

  function visible(id) {
    var el = $(id);
    return el && !el.classList.contains('hidden');
  }

  // ---- HUD -------------------------------------------------------------------
  function setHUD(fields) {
    if (fields.objective != null) $('hud-objective').textContent = fields.objective;
    if (fields.targets != null) $('hud-targets').textContent = fields.targets;
    if (fields.hint != null) $('hud-hint').textContent = fields.hint;
    if (fields.score != null) $('hud-score').textContent = String(fields.score);
    if (fields.shots != null) $('hud-shots').textContent = String(fields.shots);
    if (fields.best != null) $('hud-best').textContent = String(fields.best);
    if (fields.mode != null) $('hud-mode').textContent = fields.mode;
    if (fields.hintText != null) $('hint-text').textContent = fields.hintText;
  }

  // ---- profile / sync status (hosted only; hidden in local play) ----------------------
  function setProfileName(name) {
    _profileName = name;
    var el = $('player-name');
    if (!el) return;
    if (name) {
      el.textContent = name;
      el.hidden = false;
      el.setAttribute('title', T('Playing as {name}', { name: name }));
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  var SYNC_LABELS = {
    synced: N('Progress synced to cloud'),
    saving: N('Saving…'),
    offline: N('Cloud unavailable — local save')
  };
  var _sync = null, _profileName = null;
  function setSyncStatus(status) {
    var el = $('sync-status');
    if (!el) return;
    _sync = status;
    var label = SYNC_LABELS[status] ? T(SYNC_LABELS[status]) : '';
    el.textContent = label;
    el.hidden = !label;
  }

  // Platform high-score board on the results screen: rows = [{rank, nickname, score,
  // userId}]; meId highlights the signed-in player's row. null clears.
  var _board = null;
  function showBoard(rows, meId) {
    _board = rows && rows.length ? [rows, meId] : null;
    var el = $('res-board');
    if (!el) return;
    el.innerHTML = '';
    if (!rows || !rows.length) { el.classList.add('hidden'); return; }
    var h = document.createElement('h3');
    h.textContent = T('Leaderboard (top {n})', { n: rows.length });
    var ol = document.createElement('ol');
    rows.forEach(function (e, i) {
      var li = document.createElement('li');
      li.textContent = (e.rank != null ? e.rank : i + 1) + '. ' + e.nickname + ' — ' + e.score;
      if (meId != null && e.userId === String(meId)) li.classList.add('me');
      ol.appendChild(li);
    });
    el.appendChild(h);
    el.appendChild(ol);
    el.classList.remove('hidden');
  }

  // ---- accessibility mirrors ---------------------------------------------------
  function announce(text) { $('live').textContent = ''; setTimeout(function () { $('live').textContent = text; }, 20); }
  function alert(text) { $('live-alert').textContent = ''; setTimeout(function () { $('live-alert').textContent = text; }, 20); }
  // audio cues arrive as English caption keys (see audio.js caption calls)
  function caption(text) { $('hint-text').textContent = T(text); }

  var PHASES = { aim: N('aiming'), flight: N('in flight'), over: N('round over') };

  // Concise navigable board model (not every decorative object).
  function mirrorBoard(state) {
    if (!state) { $('sr-board').textContent = ''; return; }
    var alive = state.targets.filter(function (t) { return t.alive; }).length;
    var blocks = state.blocks.filter(function (b) { return b.alive; }).length;
    $('sr-board').textContent = T('Board: {alive} of {total} targets standing, {blocks} blocks remaining. Shots used {used} of {shots}. Phase: {phase}.', {
      alive: alive, total: state.targets.length, blocks: blocks, used: state.shotsUsed, shots: state.shots,
      phase: T(PHASES[state.phase] || state.phase)
    });
  }

  // ---- results ------------------------------------------------------------------
  // rankedNote: '' | key | [key, vars] — kept so a language switch re-renders it.
  var _results = null;
  function noteText(note) {
    if (!note) return '';
    return Array.isArray(note) ? T(note[0], note[1]) : T(note);
  }
  function renderResults() {
    if (!_results) return;
    var result = _results.result, stars = _results.stars;
    $('res-title').textContent = result.won ? T('Stage Clear!') : T('Out of Shots');
    $('res-score').textContent = T('{n} points', { n: result.score.total });
    var tb = $('res-breakdown').querySelector('tbody');
    tb.innerHTML = '';
    [[T('Targets'), result.score.targets],
     [T('Blocks'), result.score.blocks],
     [T('Unused-shot bonus'), result.score.shotsBonus]
    ].forEach(function (row) {
      var tr = document.createElement('tr');
      var a = document.createElement('td'); a.textContent = row[0];
      var b = document.createElement('td'); b.textContent = row[1];
      tr.appendChild(a); tr.appendChild(b); tb.appendChild(tr);
    });
    $('res-stars').textContent = (result.won && stars != null)
      ? '\u2605'.repeat(stars) + '\u2606'.repeat(3 - stars) : '';
    $('res-ranked').textContent = noteText(_results.note);
  }
  function showResults(result, stars, rankedNote) {
    _results = { result: result, stars: stars, note: rankedNote || '' };
    renderResults();
    showBoard(null);
    show('ov-results');
    announce(T(result.won ? 'Stage clear. Score {n}.' : 'Out of shots. Score {n}.', { n: result.score.total }));
  }
  function setRankedNote(note) {
    if (_results) _results.note = note || '';
    $('res-ranked').textContent = noteText(note);
  }

  // name = null clears the banner (called at round start so an achievement from
  // an earlier round never re-appears on the next results screen)
  var _achievement = null;   // English achievement name (translated on display)
  function showAchievement(name) {
    _achievement = name || null;
    $('res-achievement').textContent = name ? T('Achievement unlocked: {name}', { name: T(name) }) : '';
  }

  // ---- level select grid -----------------------------------------------------------
  function buildLevelGrid(count, stars, unlocked, onPick) {
    var grid = $('level-grid');
    grid.innerHTML = '';
    for (var i = 0; i < count; i++) {
      (function (idx) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'listitem');
        var s = stars[idx] || 0;
        b.innerHTML = (idx + 1) + '<span class="stars">' +
          '\u2605'.repeat(s) + '\u2606'.repeat(Math.max(0, 3 - s)) + '</span>';
        b.setAttribute('aria-label', s ? T('Stage {n}, {stars} stars', { n: idx + 1, stars: s }) : T('Stage {n}', { n: idx + 1 }));
        if (idx > unlocked) { b.classList.add('locked'); b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
        else b.addEventListener('click', function () { onPick(idx); });
        grid.appendChild(b);
      })(i);
    }
  }

  // ---- settings binding ----------------------------------------------------------------
  function bindSettings(settings, onChange) {
    document.querySelectorAll('[data-setting-range]').forEach(function (el) {
      var key = el.getAttribute('data-setting-range');
      el.value = settings[key];
      el.addEventListener('input', function () { onChange(key, parseFloat(el.value)); });
    });
    document.querySelectorAll('[data-setting-check]').forEach(function (el) {
      var key = el.getAttribute('data-setting-check');
      el.checked = !!settings[key];
      el.addEventListener('change', function () { onChange(key, el.checked); });
    });
    document.querySelectorAll('[data-setting-select]').forEach(function (el) {
      var key = el.getAttribute('data-setting-select');
      el.value = String(settings[key]);
      el.addEventListener('change', function () { onChange(key, parseInt(el.value, 10)); });
    });
  }

  // Re-sync the settings controls after settings changed outside the panel.
  function refreshSettings(settings) {
    document.querySelectorAll('[data-setting-range]').forEach(function (el) { el.value = settings[el.getAttribute('data-setting-range')]; });
    document.querySelectorAll('[data-setting-check]').forEach(function (el) { el.checked = !!settings[el.getAttribute('data-setting-check')]; });
    document.querySelectorAll('[data-setting-select]').forEach(function (el) { el.value = String(settings[el.getAttribute('data-setting-select')]); });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('sh-toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  function applyA11yClasses(settings) {
    document.body.classList.toggle('reduced-motion', !!settings.reducedMotion);
    document.body.classList.toggle('high-contrast', !!settings.highContrast);
    document.body.classList.toggle('large-text', !!settings.largeText);
    document.body.classList.toggle('left-handed', !!settings.leftHanded);
  }

  function showError(msg) {
    $('err-text').textContent = T(String(msg));
    show('ov-error');
    alert(T('Error: {msg}', { msg: T(String(msg)) }));
  }

  // Language switch: re-render the stateful pieces in place (data-i18n markup
  // is re-applied by i18n.js; the HUD is redrawn every frame by boot.js).
  function relabel() {
    if (_profileName) setProfileName(_profileName);
    if (_sync) setSyncStatus(_sync);
    if (_results) renderResults();
    if (_board) showBoard(_board[0], _board[1]);
    if (_achievement) showAchievement(_achievement);
  }

  function showCountdown(text) {
    var el = $('countdown');
    if (text == null) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  function setUndoEnabled(on) { $('btn-undo').disabled = !on; }

  return {
    init: init, show: show, visible: visible,
    setHUD: setHUD, announce: announce, alert: alert, caption: caption,
    setProfileName: setProfileName, setSyncStatus: setSyncStatus, showBoard: showBoard,
    mirrorBoard: mirrorBoard, showResults: showResults, showAchievement: showAchievement,
    buildLevelGrid: buildLevelGrid, bindSettings: bindSettings, refreshSettings: refreshSettings, toast: toast,
    applyA11yClasses: applyA11yClasses, showError: showError,
    showCountdown: showCountdown, setUndoEnabled: setUndoEnabled,
    setRankedNote: setRankedNote, relabel: relabel, T: T, N: N
  };
});
