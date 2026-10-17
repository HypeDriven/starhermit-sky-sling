'use strict';

/*
 * Sky Sling - bootstrap: host handshake, capability detection, lifecycle,
 * input routing (pointer/touch/keyboard), game loop, platform API adapter.
 */
(function () {
  var SS = window.SkySling;
  var R = SS.rules, C = SS.content, A = SS.audio, UI = SS.ui;
  var I18N = SS.i18n, T = I18N.T, N = I18N.N;

  // Player-facing names for mode ids and rule/session rejection reasons.
  var MODE_NAMES = { learn: N('Learn'), journey: N('Journey'), daily: N('Daily'), practice: N('Practice'), challenge: N('Challenge') };
  var REASONS = {
    'round-over': N('The round is over.'), 'resolving': N('Wait for the shot to settle.'),
    'no-shots-left': N('No shots left.'), 'velocity-not-a-number': N('Invalid aim.'),
    'velocity-out-of-range': N('That shot is too strong.'), 'must-launch-rightward': N('Aim to the right.'),
    'malformed-command': N('Invalid command.'), 'unknown-command': N('Invalid command.'),
    'not-active': N('The round is not active.'), 'no-round': N('No round in progress.'),
    'no-such-level': N('That stage does not exist.')
  };
  function reasonText(r) { return T(REASONS[r] || r); }

  var session = new SS.session.Session();
  var platform = SS.platform;   // launch-token auth, cloud mirror, read-only board
  var renderer = null;
  var lastTs = 0;
  var hidden = false;
  var lastLaunchCmd = null;   // action identifier: reject duplicate commits
  var countdownTimer = null;

  // keyboard aim state (velocity vector adjusted by arrows)
  var kbAim = { active: false, vx: 9, vy: 7 };

  // ---- hosted leaderboard: post the run, show the rank, then the top ten ---------
  var lbSeq = 0;
  var lbState = null;   // { posting } | { posted, rank } — re-rendered on a language switch
  function renderLeaderboardLine() {
    var line = document.getElementById('res-lb');
    if (!lbState) return;
    var L = SS.shStrings.strings(I18N.getLang());
    line.textContent = lbState.posting ? L.lbPosting
      : !lbState.posted ? L.lbNotPosted
        : lbState.rank ? L.lbRank.replace('{rank}', lbState.rank) : L.lbPosted;
  }
  function postToLeaderboard(total) {
    var line = document.getElementById('res-lb');
    var seq = ++lbSeq;
    lbState = { posting: true };
    renderLeaderboardLine();
    line.classList.remove('hidden');
    platform.submitPlatformScore(total).then(function (r) {
      if (seq !== lbSeq) return;
      lbState = r;
      renderLeaderboardLine();
      showHostedBoard();
    });
  }
  function showHostedBoard() {
    UI.showBoard(null);
    platform.leaderboardInfo().then(function (info) {
      if (!info || !info.leaderboardId) return null;
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
            nickname: nick || (id != null ? T('Player {id}', { id: String(id).slice(0, 8) }) : T('Player'))
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
    renderer.setReducedMotion(session.settings.reducedMotion || prefersReducedMotion());
    if (!renderer.init(gfxSaved())) { UI.show('ov-compat'); return false; }
    // scenic backdrop behind the title until a round starts
    if (!session.level) renderer.buildLevel(C.getLevel(0));
    if (gfxPanel) gfxPanel.refresh();
    window.addEventListener('resize', function () { renderer.resize(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { renderer.resize(); }, 60); });
    return true;
  }

  // ---- graphics settings (gfx.js model, gfxui.js panel) ----------------------------
  var gfxPanel = null;
  var gfxTimer = null;
  function gfxSaved() {
    var g = session.settings.graphics;
    return g && typeof g === 'object' ? g : {};
  }
  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  function mountGraphicsPanel() {
    var host = document.getElementById('gfx-controls');
    if (!host || !SS.gfxui) return;
    gfxPanel = SS.gfxui.mount(host, gfxApi, I18N.getLang());
  }
  var gfxApi = {
    get: gfxSaved,
    set: function (saved) {
      session.saveSettings({ graphics: saved });
      if (renderer && renderer.ok) renderer.setGraphics(saved);
    },
    info: function () { return renderer && renderer.ok ? renderer.graphicsInfo() : null; }
  };
  // keep the summary (pixels, fps) current while the settings panel is open
  function watchGraphicsPanel(open) {
    if (gfxTimer) { clearInterval(gfxTimer); gfxTimer = null; }
    if (!open || !gfxPanel) return;
    gfxPanel.refresh();
    gfxTimer = setInterval(function () {
      if (!UI.visible('ov-settings')) { clearInterval(gfxTimer); gfxTimer = null; return; }
      gfxPanel.refresh();
    }, 1000);
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
      objective: s.over ? (s.won ? T('Cleared!') : T('Out of shots')) :
        T('Collapse every Bumble ({n} left)', { n: alive }),
      targets: alive + ' / ' + s.targets.length,
      score: score.total,
      shots: s.shots - s.shotsUsed,
      best: session.mode === 'journey' ? (session.progress.bestScores[s.index] || 0) : '',
      mode: session.mode ? T(MODE_NAMES[session.mode] || session.mode) : ''
    });
    UI.mirrorBoard(s);
    UI.setUndoEnabled(session.mode === 'practice' && session.snapshots.length > 0 && session.screen === 'active');
  }

  // ---- round start ---------------------------------------------------------------------
  var pendingRound = null;   // a round requested before the renderer was ready
  function startRound(mode, ref) {
    if (!renderer || !renderer.ok) { pendingRound = [mode, ref]; return; }
    var res = session.startRound(mode, ref);
    if (!res.ok) { UI.showError(reasonText(res.reason)); return; }
    lastLaunchCmd = null;
    kbAim.active = false;
    UI.showAchievement(null);
    renderer.buildLevel(session.level);
    renderer.sync(session.state);
    UI.show(null);
    UI.showCountdown(null);
    renderRoundHints();
    var tut = session.level.tutorial;
    if (tut) UI.announce(T('Lesson: {text}', { text: T(tut.text) }));
    syncHUD();
  }
  // Tutorial texts are English content keys (content.js), shown in the game language.
  function renderRoundHints() {
    var tut = session.level && session.level.tutorial;
    UI.setHUD({ hint: tut ? T(tut.text) : '', hintText: tut ? T(tut.text) : T('Drag to aim, release to launch') });
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

  function renderTitleProgress() {
    var cleared = Object.keys(session.progress.stars).length;
    document.getElementById('title-progress').textContent =
      cleared ? T('Journey: {n} / {total} stages cleared', { n: cleared, total: C.LEVEL_COUNT }) : '';
  }
  function toTitle() {
    session.setScreen('title', 'nav');
    renderTitleProgress();
    UI.show('ov-title');
  }

  // Boot / cloud-merge refresh of the title: never yank away a menu (help,
  // settings, mode or stage select) the player opened while the 3D view loaded.
  function settleTitle() {
    var menus = ['ov-help', 'ov-settings', 'ov-mode-select', 'ov-level-select'];
    if (!menus.some(function (id) { return UI.visible(id); })) { toTitle(); return; }
    if (session.screen !== 'mode-select') session.setScreen('title', 'nav');
    renderTitleProgress();
  }

  // Journey / Practice stage grid (rebuilt in place on a language switch).
  var gridMode = null;
  function buildStageGrid(mode) {
    gridMode = mode;
    var unlocked = 0;
    for (var i = 0; i < C.LEVEL_COUNT; i++) if (session.progress.stars[i]) unlocked = i + 1;
    document.getElementById('levels-h').textContent = mode === 'practice' ? T('Practice stages') : T('Journey stages');
    UI.buildLevelGrid(C.LEVEL_COUNT, session.progress.stars, mode === 'practice' ? C.LEVEL_COUNT : unlocked, function (idx) {
      startRound(mode, idx);
    });
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
      buildStageGrid('journey');
      session.setScreen('mode-select', 'journey-grid');
      UI.show('ov-level-select');
    },
    learn: function () { A.unlock(); A.play('ui'); startRound('learn', 0); },
    practice: function () {
      A.unlock(); A.play('ui');
      // practice is "any stage": all stages unlocked, still star-marked, unranked
      buildStageGrid('practice');
      session.setScreen('mode-select', 'practice-grid');
      UI.show('ov-level-select');
    },
    challenge: function () { A.unlock(); A.play('ui'); startRound('challenge', 12); },
    settings: function () { A.play('ui'); UI.show('ov-settings'); watchGraphicsPanel(true); },
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
      if (!r.ok) { UI.alert(T('Undo not available here.')); A.play('invalid'); }
      else {
        // the restored state can re-issue the same launch identifier
        lastLaunchCmd = null;
        renderer.sync(session.state); syncHUD(); UI.announce(T('Shot undone.'));
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
      UI.announce(T('Launched.'));
      if (session.settings.haptics && navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
    } else {
      A.play('invalid');
      UI.alert(T('Cannot launch: {reason}', { reason: reasonText(res.reason) }));
    }
  }

  // ---- keyboard controls ----------------------------------------------------------------------
  function wireKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      var k = platform.actionFor(e.code);
      if (k === 'pause') {
        if (session.screen === 'paused') { actions.resume(); }
        else if (session.screen === 'active' || session.screen === 'resolving') {
          session.pause(); UI.show('ov-pause');
        }
        e.preventDefault(); return;
      }
      // fast-forward is only meaningful while a shot is resolving, so it has to
      // be handled before the aim-phase guard below
      if (k === 'skip') {
        if (session.screen === 'resolving') { document.getElementById('btn-skip').click(); e.preventDefault(); }
        return;
      }
      if (session.screen !== 'active') return;
      if (k === 'restart') { actions.restart(); e.preventDefault(); return; }
      if (k === 'undo') { document.getElementById('btn-undo').click(); e.preventDefault(); return; }
      if (!session.legal().canLaunch) return;
      var step = session.settings.timingAssist ? 0.25 : 0.5;
      if (k === 'aimLeft')  { kbAim.vx = Math.max(1, kbAim.vx - step); kbAim.active = true; }
      else if (k === 'aimRight') { kbAim.vx = Math.min(R.MAX_SPEED * 0.9, kbAim.vx + step); kbAim.active = true; }
      else if (k === 'aimUp')   { kbAim.vy = Math.min(R.MAX_SPEED * 0.9, kbAim.vy + step); kbAim.active = true; }
      else if (k === 'aimDown') { kbAim.vy = Math.max(-4, kbAim.vy - step); kbAim.active = true; }
      else if (k === 'launch') {
        if (kbAim.active) { doLaunch(kbAim.vx, kbAim.vy); kbAim.active = false; }
        e.preventDefault(); return;
      } else return;
      e.preventDefault();
      // preview keyboard aim as a pull vector
      renderer.showAim(-kbAim.vx / R.LAUNCH_POWER, -kbAim.vy / R.LAUNCH_POWER);
      UI.setHUD({ hintText: T('Aim: vx {vx}, vy {vy} — {key} to launch', { vx: kbAim.vx.toFixed(1), vy: kbAim.vy.toFixed(1), key: platform.keyLabel('launch') }) });
    });
  }

  // ---- session events ---------------------------------------------------------------------------
  function wireSession() {
    session.on(function (evt) {
      if (evt.type === 'sim') {
        var s = evt.sim;
        if (s.type === 'impact') { A.play('impact'); renderer.spawnImpact(session.state.bird.x, session.state.bird.y, false); }
        else if (s.type === 'block-down') {
          A.play(s.mat === 'stone' ? 'stone' : 'wood');
          var blk = findById(session.state.blocks, s.id) || session.state.bird;
          renderer.spawnImpact(blk.x, blk.y, true, s.mat, 'block');
        }
        else if (s.type === 'target-down') {
          A.play('target'); UI.announce(T('Target down!'));
          var tg = findById(session.state.targets, s.id);
          if (tg) renderer.spawnImpact(tg.x, tg.y, true, null, 'pop');
        }
        else if (s.type === 'win') A.play('win');
        else if (s.type === 'lose') A.play('lose');
      } else if (evt.type === 'results') {
        onResults(evt.result);
      } else if (evt.type === 'achievement') {
        var meta = SS.session.ACHIEVEMENTS.filter(function (a) { return a.key === evt.key; })[0];
        if (meta) { UI.showAchievement(meta.name); UI.announce(T('Achievement unlocked: {name}', { name: T(meta.name) })); }
      } else if (evt.type === 'settings') {
        if (!applyingRemoteSettings) platform.pushSettings(evt.settings); // platform settings KV mirror
      } else if (evt.type === 'progress') {
        platform.scheduleCloudSave(session.progress); // debounced cloud mirror
      } else if (evt.type === 'screen' && (evt.to === 'active')) {
        UI.show(null);
      }
    });
  }

  function findById(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
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
    lbSeq++;
    lbState = null;
    document.getElementById('res-lb').classList.add('hidden');
    if (platform.hosted && /^(journey|daily|challenge)$/.test(session.mode)) {
      // Signed in: post the run to the platform high-score board (score-script.js).
      UI.showResults(result, stars, '');
      postToLeaderboard(result.score.total);
    } else if (result.ranked) {
      var envelope = session.finishEnvelope();
      if (platform.hosted) {
        UI.showResults(result, stars, '');
      } else {
        note = N('Submitting to daily board…');
        UI.showResults(result, stars, note);
        platform.submitScore({
          board: 'daily', key: session.level.id,
          name: platform.nickname || 'guest', score: result.score.total,
          envelope: envelope
        }).then(function (res) {
          UI.setRankedNote(res && res.ok
            ? (typeof res.rank === 'number' ? [N('Ranked: submitted (validated server-side). Rank #{rank}.'), { rank: res.rank }]
              : N('Ranked: submitted (validated server-side).'))
            : [N('Daily board unavailable ({error}) — score kept locally.'), { error: (res && res.error) || 'offline' }]);
        });
      }
    } else {
      note = session.mode === 'practice' ? N('Practice — unranked.') : '';
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
        if (renderer.init(gfxSaved())) {
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
      renderer.setReducedMotion(s.reducedMotion || prefersReducedMotion());
    }
  }

  // ---- StarHermit account controls + platform preferences --------------------------------------------
  var applyingRemoteSettings = false;
  function accountStrings() { return SS.shStrings.strings(I18N.getLang()); }
  function labelAccount() {
    var L = accountStrings();
    document.getElementById('btn-signin').textContent = L.signIn;
    document.getElementById('btn-invite').textContent = L.invite;
  }
  function wireAccount() {
    var bIn = document.getElementById('btn-signin'), bInv = document.getElementById('btn-invite');
    labelAccount();
    bIn.addEventListener('click', function () { platform.signIn(); });
    bInv.addEventListener('click', function () {
      var link = platform.inviteLink();
      if (!link) return;
      var L = accountStrings();
      var done = function () { UI.toast(L.copied); };
      var fail = function () { UI.toast(L.copyFailed + ': ' + link); };
      try { navigator.clipboard.writeText(link).then(done, fail); } catch (_) { fail(); }
    });
    platform.onSignedOut = function () {
      UI.setProfileName(null);
      refreshAccount();
      UI.toast(accountStrings().signedOut);
    };
    refreshAccount();
  }
  function refreshAccount() {
    document.getElementById('btn-signin').hidden = !platform.canSignIn();
    document.getElementById('btn-invite').hidden = !platform.inviteLink();
  }
  function renderKeyHelp() {
    var el = document.getElementById('help-keys');
    if (!el) return;
    var k = platform.keyLabel;
    el.innerHTML = '';
    var parts = [[k('aimLeft') + k('aimRight') + k('aimUp') + k('aimDown'), N('aim')], [k('launch'), N('launch')],
      [k('pause'), N('pause')], [k('restart'), N('restart')], [k('undo'), N('undo in practice')],
      [k('skip'), N('fast-forward')]];
    parts.forEach(function (p, i) {
      var kbd = document.createElement('kbd');
      kbd.textContent = p[0];
      el.appendChild(kbd);
      el.appendChild(document.createTextNode(' ' + T(p[1]) + (i < parts.length - 1 ? ', ' : '.')));
    });
  }
  // Signed in: platform settings win over local ones, then the player's key bindings.
  function loadPlatformPrefs() {
    if (!platform.hosted) return;
    platform.loadSettings().then(function (remote) {
      if (!Object.keys(remote).length) return;
      applyingRemoteSettings = true;
      session.saveSettings(remote);
      applyingRemoteSettings = false;
      UI.refreshSettings(session.settings);
      applySettings();
      if (renderer && renderer.ok) renderer.setGraphics(gfxSaved());
      if (gfxPanel) gfxPanel.refresh();
    });
    platform.loadControls().then(renderKeyHelp);
  }

  // ---- boot -----------------------------------------------------------------------------------------------
  // Another device saved first: reload the cloud doc, merge it into local
  // progress and save the merge (adoptProgress mirrors it back to the cloud).
  function resolveSaveConflict() {
    platform.loadCloud().then(function (doc) {
      if (!(doc && session.adoptProgress(doc))) platform.scheduleCloudSave(session.progress);
      if (session.screen === 'title') renderTitleProgress();
    });
  }

  // Language switch (Settings → Language, or the account preference arriving):
  // re-render every dynamic string in place, mid-round included.
  function refreshLanguage() {
    UI.relabel();
    labelAccount();
    renderKeyHelp();
    renderTitleProgress();
    renderLeaderboardLine();
    if (session.level && session.state && !session.state.over) renderRoundHints();
    if (gridMode && UI.visible('ov-level-select')) buildStageGrid(gridMode);
    if (gfxPanel) { mountGraphicsPanel(); if (renderer && renderer.ok) gfxPanel.refresh(); }
    if (session.state) syncHUD();
  }

  function boot() {
    I18N.initLanguage();
    I18N.onLanguage(refreshLanguage);
    UI.init(actions);
    // hosted iff a launch token was read (fragment, stripped; query = local dev)
    platform.init();
    platform.onSyncStatus = function (status) { UI.setSyncStatus(status); };
    wireAccount();
    renderKeyHelp();
    loadPlatformPrefs();
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
    mountGraphicsPanel();
    waitForTHREE(function (hasTHREE) {
      if (!hasTHREE || !setupRenderer()) { UI.show('ov-compat'); return; }
      // cloud progress is merged into local progress (session.adoptProgress:
      // best of both) once ready; a later save conflict does the same
      platform.onSaveConflict = resolveSaveConflict;
      platform.loadCloud().then(function (doc) {
        if (doc && session.adoptProgress(doc) && session.screen === 'title') settleTitle();
      });
      settleTitle();
      if (pendingRound) { var pr = pendingRound; pendingRound = null; startRound(pr[0], pr[1]); }
      requestAnimationFrame(loop);
    }, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
