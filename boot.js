'use strict';

/*
 * Sky Sling - bootstrap: host handshake, capability detection, lifecycle,
 * input routing (pointer/touch/keyboard), game loop, platform API adapter.
 */
(function () {
  var SS = window.SkySling;
  var R = SS.rules, C = SS.content, A = SS.audio, UI = SS.ui;

  var session = new SS.session.Session();
  var platform = SS.platform;   // launch-token auth, cloud mirror, read-only board
  var renderer = null;
  var lastTs = 0;
  var hidden = false;
  var lastLaunchCmd = null;   // action identifier: reject duplicate commits
  var countdownTimer = null;

  // keyboard aim state (velocity vector adjusted by arrows)
  var kbAim = { active: false, vx: 9, vy: 7 };

  // ---- hosted daily board (read-only; clients can never submit scores) -------------
  function showHostedDailyBoard(myScore) {
    UI.showBoard(null);
    platform.leaderboardInfo().then(function (info) {
      var note = 'Daily board is platform-owned — read-only. Your score: ' + myScore + '.';
      if (!info || !info.leaderboardId) {
        document.getElementById('res-ranked').textContent = note + ' No board for this game yet.';
        return null;
      }
      if (info.me && typeof info.me.score === 'number') {
        note += ' Board best: ' + info.me.score + '.';
      }
      document.getElementById('res-ranked').textContent = note;
      return platform.leaderboardEntries(info.leaderboardId, { page: 0, pageSize: 10 });
    }).then(function (list) {
      if (!list) return;
      var entries = list.entries || list || [];
      if (!entries.length) return;
      return Promise.all(entries.map(function (e) {
        var id = e.userId != null ? e.userId : (e.user_id != null ? e.user_id : e.id);
        return platform.nicknameFor(id).then(function (nick) {
          return {
            rank: typeof e.rank === 'number' ? e.rank : null,
            score: e.score,
            userId: id != null ? String(id) : null,
            nickname: nick || (id != null ? 'Player ' + String(id).slice(0, 8) : 'Player')
          };
        });
      })).then(function (rows) {
        UI.showBoard(rows, platform.userId);
      });
    }).catch(function () {});
  }

  // ---- renderer setup -----------------------------------------------------------
  function setupRenderer() {
    var canvas = document.getElementById('gl-canvas');
    renderer = new SS.render.Renderer(canvas);
    if (!renderer.init()) { UI.show('ov-compat'); return false; }
    renderer.setTier(session.settings.quality);
    renderer.setReducedMotion(session.settings.reducedMotion);
    window.addEventListener('resize', function () { renderer.resize(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { renderer.resize(); }, 60); });
    return true;
  }

  function waitForTHREE(cb, tries) {
    if (window.THREE) return cb(true);
    if (tries <= 0) return cb(false);
    setTimeout(function () { waitForTHREE(cb, tries - 1); }, 100);
  }

  // ---- HUD sync ---------------------------------------------------------------------
  function syncHUD() {
    var s = session.state;
    if (!s) return;
    var alive = s.targets.filter(function (t) { return t.alive; }).length;
    var score = R.computeScore(s);
    UI.setHUD({
      objective: s.over ? (s.won ? 'Cleared!' : 'Out of shots') :
        'Collapse every Bumble (' + alive + ' left)',
      targets: alive + ' / ' + s.targets.length,
      score: score.total,
      shots: s.shots - s.shotsUsed,
      best: session.mode === 'journey' ? (session.progress.bestScores[s.index] || 0) : '',
      mode: session.mode ? session.mode[0].toUpperCase() + session.mode.slice(1) : ''
    });
    UI.mirrorBoard(s);
    UI.setUndoEnabled(session.mode === 'practice' && session.snapshots.length > 0 && session.screen === 'active');
  }

  // ---- round start ---------------------------------------------------------------------
  function startRound(mode, ref) {
    var res = session.startRound(mode, ref);
    if (!res.ok) { UI.showError(res.reason); return; }
    lastLaunchCmd = null;
    kbAim.active = false;
    UI.showAchievement(null);
    renderer.buildLevel(session.level);
    renderer.sync(session.state);
    UI.show(null);
    UI.showCountdown(null);
    var tut = session.level.tutorial;
    UI.setHUD({ hint: tut ? tut.text : '', hintText: tut ? tut.text : 'Drag to aim, release to launch' });
    if (tut) UI.announce('Lesson: ' + tut.text);
    syncHUD();
  }

  // Which overlay a modal (help / settings / error) should return to when it
  // closes. Without this a modal opened from the title or the results screen
  // would close onto an empty screen.
  function overlayForScreen() {
    if (session.screen === 'paused') return 'ov-pause';
    if (session.screen === 'results') return 'ov-results';
    if (session.screen === 'active' || session.screen === 'resolving') return null;
    return 'ov-title';
  }

  function toTitle() {
    session.setScreen('title', 'nav');
    var cleared = Object.keys(session.progress.stars).length;
    document.getElementById('title-progress').textContent =
      cleared ? 'Journey: ' + cleared + ' / ' + C.LEVEL_COUNT + ' stages cleared' : '';
    UI.show('ov-title');
  }

  // ---- actions ---------------------------------------------------------------------------
  var actions = {
    play: function () {
      A.unlock(); A.play('ui');
      // short path to play: resume at furthest unlocked journey stage
      var next = 0;
      for (var i = 0; i < C.LEVEL_COUNT; i++) {
        if (session.progress.stars[i]) next = i + 1;
      }
      startRound('journey', Math.min(next, C.LEVEL_COUNT - 1));
    },
    daily: function () {
      A.unlock(); A.play('ui');
      platform.time().then(function () { startRound('daily'); });
    },
    journey: function () {
      A.play('ui');
      var unlocked = 0;
      for (var i = 0; i < C.LEVEL_COUNT; i++) if (session.progress.stars[i]) unlocked = i + 1;
      document.getElementById('levels-h').textContent = 'Journey stages';
      UI.buildLevelGrid(C.LEVEL_COUNT, session.progress.stars, unlocked, function (idx) {
        startRound('journey', idx);
      });
      session.setScreen('mode-select', 'journey-grid');
      UI.show('ov-level-select');
    },
    learn: function () { A.unlock(); A.play('ui'); startRound('learn', 0); },
    practice: function () {
      A.unlock(); A.play('ui');
      // practice is "any stage": all stages unlocked, still star-marked, unranked
      document.getElementById('levels-h').textContent = 'Practice stages';
      UI.buildLevelGrid(C.LEVEL_COUNT, session.progress.stars, C.LEVEL_COUNT, function (idx) {
        startRound('practice', idx);
      });
      session.setScreen('mode-select', 'practice-grid');
      UI.show('ov-level-select');
    },
    challenge: function () { A.unlock(); A.play('ui'); startRound('challenge', 12); },
    settings: function () { A.play('ui'); UI.show('ov-settings'); },
    'close-settings': function () { A.play('ui'); UI.show(overlayForScreen()); },
    help: function () { A.play('ui'); UI.show('ov-help'); },
    'close-help': function () { A.play('ui'); UI.show(overlayForScreen()); },
    resume: function () { A.play('ui'); session.resume(); UI.show(null); },
    restart: function () { A.play('ui'); startRound(session.mode || 'journey', session.level ? session.level.index : 0); },
    retry: function () { A.play('ui'); startRound(session.mode || 'journey', session.level ? session.level.index : 0); },
    next: function () {
      A.play('ui');
      var idx = session.level && typeof session.level.index === 'number' ? session.level.index + 1 : 0;
      if (session.mode === 'learn') {
        var lesson = (session.level.id.match(/lesson-(\d)/) || [0, 0])[1] | 0;
        if (lesson < C.LESSONS.length) return startRound('learn', lesson);
        return toTitle();
      }
      if (idx >= C.LEVEL_COUNT) return toTitle();
      startRound(session.mode === 'daily' ? 'journey' : session.mode, idx);
    },
    'quit-title': function () { A.play('ui'); toTitle(); },
    'back-title': function () { A.play('ui'); toTitle(); },
    'back-modes': function () { A.play('ui'); UI.show('ov-mode-select'); },
    'close-error': function () { UI.show(overlayForScreen()); }
  };

  // ---- pause / menu buttons ---------------------------------------------------------------
  function wireChrome() {
    document.getElementById('btn-pause').addEventListener('click', function () {
      A.play('ui'); session.pause(); UI.show('ov-pause');
    });
    document.getElementById('btn-menu').addEventListener('click', function () {
      A.play('ui'); session.pause(); UI.show('ov-pause');
    });
    document.getElementById('btn-help').addEventListener('click', actions.help);
    document.getElementById('btn-restart').addEventListener('click', actions.restart);
    document.getElementById('btn-undo').addEventListener('click', function () {
      var r = session.undo();
      if (!r.ok) { UI.alert('Undo not available here.'); A.play('invalid'); }
      else {
        // the restored state can re-issue the same launch identifier
        lastLaunchCmd = null;
        renderer.sync(session.state); syncHUD(); UI.announce('Shot undone.');
      }
    });
    document.getElementById('btn-skip').addEventListener('click', function () {
      if (session.screen === 'resolving') { session.skip(); renderer.sync(session.state); syncHUD(); }
    });
  }

  // ---- pointer slingshot input --------------------------------------------------------------
  function wirePointer() {
    var canvas = document.getElementById('gl-canvas');
    var dragging = false, pointerId = null;
    var startX = 0, startY = 0, curX = 0, curY = 0;

    function toPull(px, py) {
      // map pixel drag to world pull via canvas scale (playfield ≈ 14 m tall view)
      var h = canvas.clientHeight || 360;
      var metersPerPx = 14 / h;
      return { dx: (px - startX) * metersPerPx, dy: -(py - startY) * metersPerPx };
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (session.screen !== 'active') return;
      if (!session.legal().canLaunch) return;
      dragging = true; pointerId = e.pointerId;
      startX = curX = e.clientX; startY = curY = e.clientY;
      try { canvas.setPointerCapture(pointerId); } catch (_) {}
      A.unlock(); A.play('drag');
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pointerId) return;
      curX = e.clientX; curY = e.clientY;
      var p = toPull(curX, curY);
      renderer.showAim(p.dx, p.dy);
    });
    function release(e, cancelled) {
      if (!dragging || (e && e.pointerId !== pointerId)) return;
      dragging = false;
      var p = toPull(curX, curY);
      renderer.hideAim();
      var pull = Math.sqrt(p.dx * p.dx + p.dy * p.dy);
      if (cancelled || pull < 0.3) return; // treated as a tap, not a launch
      // velocity: opposite the drag on both axes (pull back and down to send the
      // shot forward and up), matching the aim preview and the keyboard aim
      var scale = Math.min(pull, R.MAX_PULL) / pull;
      var vx = -p.dx * scale * R.LAUNCH_POWER;
      var vy = -p.dy * scale * R.LAUNCH_POWER;
      doLaunch(vx, vy);
    }
    canvas.addEventListener('pointerup', function (e) { release(e, false); });
    canvas.addEventListener('pointercancel', function (e) { release(e, true); });
    canvas.addEventListener('lostpointercapture', function () { dragging = false; renderer.hideAim(); });
  }

  function doLaunch(vx, vy) {
    // Derived from round state, not a counter, so a repeated commit of the same
    // shot (double release / duplicated pointer event) is actually rejected.
    var id = 'launch-' + session.state.shotsUsed + '-' + session.state.tick;
    if (id === lastLaunchCmd) return;       // idempotent double-commit guard
    var res = session.launch(id, vx, vy);
    if (res.ok) {
      lastLaunchCmd = id;
      renderer.hideAim();   // hand the bird back to the simulation
      A.play('launch');
      UI.announce('Launched.');
      if (session.settings.haptics && navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
    } else {
      A.play('invalid');
      UI.alert('Cannot launch: ' + res.reason);
    }
  }

  // ---- keyboard controls ----------------------------------------------------------------------
  function wireKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      var k = e.key;
      if (k === 'Escape' || k === 'p' || k === 'P') {
        if (session.screen === 'paused') { actions.resume(); }
        else if (session.screen === 'active' || session.screen === 'resolving') {
          session.pause(); UI.show('ov-pause');
        }
        e.preventDefault(); return;
      }
      // fast-forward is only meaningful while a shot is resolving, so it has to
      // be handled before the aim-phase guard below
      if (k === 's' || k === 'S') {
        if (session.screen === 'resolving') { document.getElementById('btn-skip').click(); e.preventDefault(); }
        return;
      }
      if (session.screen !== 'active') return;
      if (k === 'r' || k === 'R') { actions.restart(); e.preventDefault(); return; }
      if (k === 'u' || k === 'U') { document.getElementById('btn-undo').click(); e.preventDefault(); return; }
      if (!session.legal().canLaunch) return;
      var step = session.settings.timingAssist ? 0.25 : 0.5;
      if (k === 'ArrowLeft')  { kbAim.vx = Math.max(1, kbAim.vx - step); kbAim.active = true; }
      else if (k === 'ArrowRight') { kbAim.vx = Math.min(R.MAX_SPEED * 0.9, kbAim.vx + step); kbAim.active = true; }
      else if (k === 'ArrowUp')   { kbAim.vy = Math.min(R.MAX_SPEED * 0.9, kbAim.vy + step); kbAim.active = true; }
      else if (k === 'ArrowDown') { kbAim.vy = Math.max(-4, kbAim.vy - step); kbAim.active = true; }
      else if (k === ' ' || k === 'Enter') {
        if (kbAim.active) { doLaunch(kbAim.vx, kbAim.vy); kbAim.active = false; }
        e.preventDefault(); return;
      } else return;
      e.preventDefault();
      // preview keyboard aim as a pull vector
      renderer.showAim(-kbAim.vx / R.LAUNCH_POWER, -kbAim.vy / R.LAUNCH_POWER);
      UI.setHUD({ hintText: 'Aim: vx ' + kbAim.vx.toFixed(1) + ', vy ' + kbAim.vy.toFixed(1) + ' — Space to launch' });
    });
  }

  // ---- session events ---------------------------------------------------------------------------
  function wireSession() {
    session.on(function (evt) {
      if (evt.type === 'sim') {
        var s = evt.sim;
        if (s.type === 'impact') { A.play('impact'); renderer.spawnImpact(session.state.bird.x, session.state.bird.y, false); }
        else if (s.type === 'block-down') { A.play(s.mat === 'stone' ? 'stone' : 'wood'); renderer.spawnImpact(session.state.bird.x, session.state.bird.y, true); }
        else if (s.type === 'target-down') { A.play('target'); UI.announce('Target down!'); }
        else if (s.type === 'win') A.play('win');
        else if (s.type === 'lose') A.play('lose');
      } else if (evt.type === 'results') {
        onResults(evt.result);
      } else if (evt.type === 'achievement') {
        var meta = SS.session.ACHIEVEMENTS.filter(function (a) { return a.key === evt.key; })[0];
        if (meta) { UI.showAchievement(meta.name); UI.announce('Achievement unlocked: ' + meta.name); }
      } else if (evt.type === 'progress') {
        platform.scheduleCloudSave(session.progress); // debounced cloud mirror
      } else if (evt.type === 'screen' && (evt.to === 'active')) {
        UI.show(null);
      }
    });
  }

  function onResults(result) {
    renderer.sync(session.state);
    // stars are a journey-progression reward; other modes show none rather than
    // an all-empty row that reads as "you earned zero stars"
    var stars = null;
    if (result.won && session.mode === 'journey') {
      stars = session.progress.stars[session.level.index] || 1;
    }
    var note = '';
    if (result.ranked) {
      var envelope = session.finishEnvelope();
      if (platform.hosted) {
        // platform leaderboard is read-only; scores can never be client-submitted
        note = 'Daily board is platform-owned — read-only. Your score: ' + result.score.total + '.';
        UI.showResults(result, stars, note);
        showHostedDailyBoard(result.score.total);
      } else {
        note = 'Submitting to daily board…';
        UI.showResults(result, stars, note);
        platform.submitScore({
          board: 'daily', key: session.level.id,
          name: platform.nickname || 'guest', score: result.score.total,
          envelope: envelope
        }).then(function (res) {
          var msg = res && res.ok
            ? 'Ranked: submitted (validated server-side).'
            : 'Daily board unavailable (' + ((res && res.error) || 'offline') + ') — score kept locally.';
          if (res && res.ok && typeof res.rank === 'number') msg += ' Rank #' + res.rank + '.';
          document.getElementById('res-ranked').textContent = msg;
        });
      }
    } else {
      note = session.mode === 'practice' ? 'Practice — unranked.' : '';
      UI.showResults(result, stars, note);
    }
    document.getElementById('btn-next').style.display = result.won ? '' : 'none';
    syncHUD();
  }

  // ---- main loop -----------------------------------------------------------------------------------
  function loop(ts) {
    requestAnimationFrame(loop);
    if (hidden) { lastTs = ts; return; }
    var dt = Math.min(0.1, (ts - lastTs) / 1000) || 0;
    lastTs = ts;
    // fixed-step simulation: accumulate at 1/60
    if (session.screen === 'resolving' && session.state) {
      var steps = Math.max(1, Math.round(dt * 60));
      for (var i = 0; i < steps && session.screen === 'resolving'; i++) {
        session.tick();
      }
    }
    if (session.state) {
      renderer.sync(session.state);
      syncHUD();
    }
    renderer.frame(dt, hidden);
  }

  // ---- lifecycle --------------------------------------------------------------------------------------
  function wireLifecycle() {
    document.addEventListener('visibilitychange', function () {
      hidden = document.hidden;
      A.setBackground(hidden);
      if (hidden && (session.screen === 'active' || session.screen === 'resolving')) {
        session.pause(); // backgrounding pauses solo simulation
        UI.show('ov-pause'); // ...and says so, so the round is resumable on return
      }
    });
    var canvas = document.getElementById('gl-canvas');
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
    });
    canvas.addEventListener('webglcontextrestored', function () {
      // rebuild GPU resources from retained CPU descriptors
      if (session.level) {
        renderer.ok = false;
        if (renderer.init()) {
          renderer.setTier(session.settings.quality);
          renderer.buildLevel(session.level);
          renderer.sync(session.state);
        }
      }
    });
  }

  // ---- settings -----------------------------------------------------------------------------------------
  function applySettings() {
    var s = session.settings;
    A.setLevel('music', s.music);
    A.setLevel('sfx', s.sfx);
    A.setLevel('ambience', s.ambience);
    A.setLevel('voice', s.voice);
    UI.applyA11yClasses(s);
    if (renderer && renderer.ok) {
      renderer.setTier(s.quality);
      renderer.setReducedMotion(s.reducedMotion);
    }
  }

  // ---- boot -----------------------------------------------------------------------------------------------
  function boot() {
    UI.init(actions);
    // hosted iff a launch token was read (fragment, stripped; query = local dev)
    platform.init();
    platform.onSyncStatus = function (status) { UI.setSyncStatus(status); };
    platform.loadProfile().then(function () {
      UI.setProfileName(platform.nickname); // null in local play → slot stays hidden
      UI.setSyncStatus(platform.syncStatus);
    });
    wireChrome(); wirePointer(); wireKeyboard(); wireSession(); wireLifecycle();
    UI.bindSettings(session.settings, function (key, val) {
      var patch = {}; patch[key] = val;
      session.saveSettings(patch);
      applySettings();
    });
    A.setCaptionHandler(UI.caption);
    applySettings();
    waitForTHREE(function (hasTHREE) {
      if (!hasTHREE || !setupRenderer()) { UI.show('ov-compat'); return; }
      // remote-preferred progress: adopt the cloud doc (on conflict) once ready
      platform.loadCloud().then(function (doc) {
        if (doc && session.adoptProgress(doc) && session.screen === 'title') toTitle();
      });
      toTitle();
      requestAnimationFrame(loop);
    }, 30);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
