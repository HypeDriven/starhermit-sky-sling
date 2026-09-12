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
      if (focusable) setTimeout(function () { focusable.focus(); }, 0);
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
    var el = $('player-name');
    if (!el) return;
    if (name) {
      el.textContent = name;
      el.hidden = false;
      el.setAttribute('title', 'Playing as ' + name);
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  var SYNC_LABELS = {
    synced: 'Progress synced to cloud',
    saving: 'Saving…',
    offline: 'Cloud unavailable — local save'
  };
  function setSyncStatus(status) {
    var el = $('sync-status');
    if (!el) return;
    var label = SYNC_LABELS[status] || '';
    el.textContent = label;
    el.hidden = !label;
  }

  // Read-only platform board on the results screen: rows = [{rank, nickname, score,
  // userId}]; meId highlights the signed-in player's row. null clears.
  function showBoard(rows, meId) {
    var el = $('res-board');
    if (!el) return;
    el.innerHTML = '';
    if (!rows || !rows.length) { el.classList.add('hidden'); return; }
    var h = document.createElement('h3');
    h.textContent = 'Daily board (top ' + rows.length + ')';
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
  function caption(text) { $('hint-text').textContent = text; }

  // Concise navigable board model (not every decorative object).
  function mirrorBoard(state) {
    if (!state) { $('sr-board').textContent = ''; return; }
    var alive = state.targets.filter(function (t) { return t.alive; }).length;
    var blocks = state.blocks.filter(function (b) { return b.alive; }).length;
    $('sr-board').textContent =
      'Board: ' + alive + ' of ' + state.targets.length + ' targets standing, ' +
      blocks + ' blocks remaining. Shots used ' + state.shotsUsed + ' of ' + state.shots +
      '. Phase: ' + state.phase + '.';
  }

  // ---- results ------------------------------------------------------------------
  function showResults(result, stars, rankedNote) {
    $('res-title').textContent = result.won ? 'Stage Clear!' : 'Out of Shots';
    $('res-score').textContent = result.score.total + ' points';
    var tb = $('res-breakdown').querySelector('tbody');
    tb.innerHTML = '';
    [['Targets', result.score.targets],
     ['Blocks', result.score.blocks],
     ['Unused-shot bonus', result.score.shotsBonus]
    ].forEach(function (row) {
      var tr = document.createElement('tr');
      var a = document.createElement('td'); a.textContent = row[0];
      var b = document.createElement('td'); b.textContent = row[1];
      tr.appendChild(a); tr.appendChild(b); tb.appendChild(tr);
    });
    $('res-stars').textContent = (result.won && stars != null)
      ? '\u2605'.repeat(stars) + '\u2606'.repeat(3 - stars) : '';
    $('res-ranked').textContent = rankedNote || '';
    showBoard(null);
    show('ov-results');
    announce((result.won ? 'Stage clear. ' : 'Out of shots. ') + 'Score ' + result.score.total + '.');
  }

  // name = null clears the banner (called at round start so an achievement from
  // an earlier round never re-appears on the next results screen)
  function showAchievement(name) {
    $('res-achievement').textContent = name ? 'Achievement unlocked: ' + name : '';
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
        b.setAttribute('aria-label', 'Stage ' + (idx + 1) + (s ? ', ' + s + ' stars' : ''));
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

  function applyA11yClasses(settings) {
    document.body.classList.toggle('reduced-motion', !!settings.reducedMotion);
    document.body.classList.toggle('high-contrast', !!settings.highContrast);
    document.body.classList.toggle('large-text', !!settings.largeText);
    document.body.classList.toggle('left-handed', !!settings.leftHanded);
  }

  function showError(msg) {
    $('err-text').textContent = String(msg);
    show('ov-error');
    alert('Error: ' + msg);
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
    buildLevelGrid: buildLevelGrid, bindSettings: bindSettings,
    applyA11yClasses: applyA11yClasses, showError: showError,
    showCountdown: showCountdown, setUndoEnabled: setUndoEnabled
  };
});
