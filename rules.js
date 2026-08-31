'use strict';

/*
 * Sky Sling - rules engine.
 * Pure, deterministic, serializable game rules. No DOM, no rendering,
 * no wall-clock time. All randomness flows through seeded streams.
 * Works in Node (module.exports) and the browser (SkySling.rules).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.rules = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  var RULES_VERSION = 3;

  // ---- world constants (meters, fixed-point friendly) ---------------------
  var GRAVITY = 9.8;
  var STEP = 1 / 120;            // fixed simulation step (seconds)
  var STEPS_PER_TICK = 2;        // one logical tick = 1/60 s
  var SLING_X = 2.4;             // slingshot pouch rest position
  var SLING_Y = 2.2;
  var BIRD_R = 0.35;
  var MAX_PULL = 2.6;            // max drag distance from pouch
  var LAUNCH_POWER = 7.5;        // velocity = pull * LAUNCH_POWER
  var MAX_SPEED = MAX_PULL * LAUNCH_POWER; // 19.5 m/s
  var REST_SPEED = 0.35;         // below this the bird settles
  var WORLD_MIN_X = -12, WORLD_MAX_X = 60;
  var VEL_Q = 100;               // velocity quantization (0.01 m/s)

  var MAT = {
    wood:  { hp: 30,  score: 100 },
    stone: { hp: 80,  score: 150 },
    ice:   { hp: 15,  score: 100 }
  };
  var TARGET_SCORE = 1000;
  var SHOT_BONUS = 500;

  // ---- seeded random stream (mulberry32) -----------------------------------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- helpers ---------------------------------------------------------------
  function q(v) { return Math.round(v * VEL_Q) / VEL_Q; } // quantize
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  // ---- state construction ----------------------------------------------------
  // level: { seed, index, shots, blocks:[{x,y,w,h,mat}], targets:[{x,y,r}] }
  function createState(level) {
    var blocks = level.blocks.map(function (b, i) {
      return {
        id: i, x: b.x, y: b.y, w: b.w, h: b.h, mat: b.mat,
        hp: MAT[b.mat].hp, alive: true, vy: 0, falling: false
      };
    });
    var targets = level.targets.map(function (t, i) {
      return { id: i, x: t.x, y: t.y, r: t.r || 0.4, alive: true };
    });
    return {
      version: RULES_VERSION,
      seed: level.seed, index: level.index,
      shots: level.shots, shotsUsed: 0,
      tick: 0,
      phase: 'aim',            // 'aim' | 'flight' | 'over'
      over: false, won: false, reason: '',
      invalidActions: 0,
      bird: { x: SLING_X, y: SLING_Y, vx: 0, vy: 0, active: false },
      blocks: blocks,
      targets: targets,
      destroyedBlocks: 0, destroyedTargets: 0,
      log: []                  // ordered applied commands (replay)
    };
  }

  // ---- legal-action API -------------------------------------------------------
  // Single source of truth used by play, tutorials and hints.
  function legalActions(state) {
    if (state.over) return { canLaunch: false, reason: 'round-over' };
    if (state.phase !== 'aim') return { canLaunch: false, reason: 'resolving' };
    if (state.shotsUsed >= state.shots) return { canLaunch: false, reason: 'no-shots-left' };
    return {
      canLaunch: true, reason: '',
      pull: { max: MAX_PULL, power: LAUNCH_POWER },
      minVx: 0.5, maxSpeed: MAX_SPEED
    };
  }

  function validateLaunch(state, vx, vy) {
    var legal = legalActions(state);
    if (!legal.canLaunch) return { ok: false, reason: legal.reason };
    if (typeof vx !== 'number' || typeof vy !== 'number' ||
        !isFinite(vx) || !isFinite(vy)) {
      return { ok: false, reason: 'velocity-not-a-number' };
    }
    var qx = q(vx), qy = q(vy);
    var sp = Math.sqrt(qx * qx + qy * qy);
    if (sp > MAX_SPEED + 1e-9) return { ok: false, reason: 'velocity-out-of-range' };
    if (qx < 0.5) return { ok: false, reason: 'must-launch-rightward' };
    return { ok: true, vx: qx, vy: qy };
  }

  // ---- commands ----------------------------------------------------------------
  // cmd: { id, type:'launch', vx, vy }
  function applyCommand(state, cmd) {
    if (!cmd || typeof cmd !== 'object') {
      state.invalidActions++;
      return { ok: false, reason: 'malformed-command' };
    }
    if (cmd.type !== 'launch') {
      state.invalidActions++;
      return { ok: false, reason: 'unknown-command' };
    }
    var v = validateLaunch(state, cmd.vx, cmd.vy);
    if (!v.ok) {
      state.invalidActions++;
      return { ok: false, reason: v.reason };
    }
    state.bird.x = SLING_X; state.bird.y = SLING_Y;
    state.bird.vx = v.vx; state.bird.vy = v.vy;
    state.bird.active = true;
    state.shotsUsed++;
    state.phase = 'flight';
    state.log.push({ id: cmd.id != null ? String(cmd.id) : ('c' + state.log.length), type: 'launch', vx: v.vx, vy: v.vy });
    return { ok: true };
  }

  // ---- physics ------------------------------------------------------------------
  function circleHitsBlock(bx, by, r, b) {
    var cx = clamp(bx, b.x - b.w / 2, b.x + b.w / 2);
    var cy = clamp(by, b.y - b.h / 2, b.y + b.h / 2);
    var dx = bx - cx, dy = by - cy;
    return dx * dx + dy * dy < r * r;
  }

  function overlaps(a, b) {
    return Math.abs(a.x - b.x) * 2 < (a.w + b.w) * 0.98 &&
           Math.abs(a.y - b.y) * 2 < (a.h + b.h) * 0.98;
  }

  function supported(state, b) {
    if (b.y - b.h / 2 <= 0.02) return true;
    for (var i = 0; i < state.blocks.length; i++) {
      var o = state.blocks[i];
      if (!o.alive || o.id === b.id) continue;
      var top = o.y + o.h / 2;
      var bottom = b.y - b.h / 2;
      if (Math.abs(top - bottom) <= 0.08) {
        var overlapX = Math.min(b.x + b.w / 2, o.x + o.w / 2) -
                       Math.max(b.x - b.w / 2, o.x - o.w / 2);
        if (overlapX >= Math.min(b.w, o.w) * 0.3) return true;
      }
    }
    return false;
  }

  function step(state) {
    var i, b, t;
    var bird = state.bird;
    var events = [];

    if (bird.active) {
      bird.vy -= GRAVITY * STEP;
      bird.x += bird.vx * STEP;
      bird.y += bird.vy * STEP;

      // bird vs blocks
      for (i = 0; i < state.blocks.length; i++) {
        b = state.blocks[i];
        if (!b.alive) continue;
        if (circleHitsBlock(bird.x, bird.y, BIRD_R, b)) {
          var speed = Math.sqrt(bird.vx * bird.vx + bird.vy * bird.vy);
          var dmg = speed * 6;
          b.hp -= dmg;
          events.push({ type: 'impact', id: b.id, dmg: dmg });
          if (b.hp <= 0) {
            b.alive = false;
            state.destroyedBlocks++;
            events.push({ type: 'block-down', id: b.id });
          }
          bird.vx *= 0.45; bird.vy *= 0.45;
        }
      }
      // bird vs targets
      for (i = 0; i < state.targets.length; i++) {
        t = state.targets[i];
        if (!t.alive) continue;
        var dx = bird.x - t.x, dy = bird.y - t.y;
        var rr = BIRD_R + t.r;
        if (dx * dx + dy * dy < rr * rr) {
          t.alive = false;
          state.destroyedTargets++;
          events.push({ type: 'target-down', id: t.id });
        }
      }
      // ground
      if (bird.y < BIRD_R) {
        bird.y = BIRD_R;
        if (Math.abs(bird.vy) > 1.2) bird.vy = -bird.vy * 0.25;
        else bird.vy = 0;
        bird.vx *= 0.86;
      }
      // settle / out of bounds
      var bs = Math.sqrt(bird.vx * bird.vx + bird.vy * bird.vy);
      if ((bs < REST_SPEED && bird.y <= BIRD_R + 0.01) ||
          bird.x > WORLD_MAX_X || bird.x < WORLD_MIN_X) {
        bird.active = false;
      }
    }

    // falling blocks (support collapse)
    var anyFalling = false;
    for (i = 0; i < state.blocks.length; i++) {
      b = state.blocks[i];
      if (!b.alive) continue;
      if (!b.falling && !supported(state, b)) b.falling = true;
      if (b.falling) {
        b.vy -= GRAVITY * STEP;
        b.y += b.vy * STEP;
        anyFalling = true;
        // land on ground
        if (b.y - b.h / 2 <= 0) {
          b.y = b.h / 2;
          if (b.vy < -3) { b.hp += b.vy * 8; } // impact damage
          b.vy = 0; b.falling = false;
          if (b.hp <= 0) {
            b.alive = false;
            state.destroyedBlocks++;
            events.push({ type: 'block-down', id: b.id });
          }
        } else {
          // land on another block
          for (var j = 0; j < state.blocks.length; j++) {
            var o = state.blocks[j];
            if (!o.alive || o.id === b.id) continue;
            var top = o.y + o.h / 2;
            var bottom = b.y - b.h / 2;
            var overlapX = Math.min(b.x + b.w / 2, o.x + o.w / 2) -
                           Math.max(b.x - b.w / 2, o.x - o.w / 2);
            if (overlapX > 0 && bottom <= top && bottom > top - 0.5 && b.vy <= 0) {
              b.y = top + b.h / 2;
              if (b.vy < -3) b.hp += b.vy * 8;
              b.vy = 0; b.falling = false;
              if (b.hp <= 0) {
                b.alive = false;
                state.destroyedBlocks++;
                events.push({ type: 'block-down', id: b.id });
              }
              break;
            }
          }
        }
        // falling block crushes targets
        if (b.alive) {
          for (var k = 0; k < state.targets.length; k++) {
            t = state.targets[k];
            if (!t.alive) continue;
            if (Math.abs(t.x - b.x) * 2 < b.w + t.r * 2 &&
                Math.abs(t.y - b.y) * 2 < b.h + t.r * 2) {
              t.alive = false;
              state.destroyedTargets++;
              events.push({ type: 'target-down', id: t.id });
            }
          }
        }
      }
    }

    // resolution phase ends when everything is settled
    if (state.phase === 'flight' && !bird.active && !anyFalling) {
      var remaining = 0;
      for (i = 0; i < state.targets.length; i++) if (state.targets[i].alive) remaining++;
      if (remaining === 0) {
        state.over = true; state.won = true;
        state.phase = 'over'; state.reason = 'targets-cleared';
        events.push({ type: 'win' });
      } else if (state.shotsUsed >= state.shots) {
        state.over = true; state.won = false;
        state.phase = 'over'; state.reason = 'out-of-shots';
        events.push({ type: 'lose' });
      } else {
        state.phase = 'aim';
        events.push({ type: 'settled' });
      }
    }
    return events;
  }

  // Advance exactly one logical tick (1/60 s). Returns event list.
  function tick(state) {
    if (state.over) return [];
    var ev = [];
    for (var s = 0; s < STEPS_PER_TICK; s++) {
      var e = step(state);
      for (var i = 0; i < e.length; i++) ev.push(e[i]);
    }
    state.tick++;
    return ev;
  }

  // Run until resolution finishes or the tick cap is hit (no unbounded loops).
  var MAX_TICKS_PER_SHOT = 60 * 30; // 30 s of simulated flight
  function resolve(state, maxTicks) {
    var cap = maxTicks || MAX_TICKS_PER_SHOT;
    var ev = [];
    var n = 0;
    while (state.phase === 'flight' && !state.over && n < cap) {
      var e = tick(state);
      for (var i = 0; i < e.length; i++) ev.push(e[i]);
      n++;
    }
    if (n >= cap && state.phase === 'flight') {
      // defensive settle: never hang
      state.bird.active = false;
      state.phase = state.shotsUsed >= state.shots ? 'over' : 'aim';
      if (state.phase === 'over') { state.over = true; state.won = false; state.reason = 'out-of-shots'; }
    }
    return ev;
  }

  // ---- scoring -------------------------------------------------------------------
  function computeScore(state) {
    var targets = state.destroyedTargets * TARGET_SCORE;
    var blocks = 0;
    for (var i = 0; i < state.blocks.length; i++) {
      if (!state.blocks[i].alive) blocks += MAT[state.blocks[i].mat].score;
    }
    var shotsBonus = state.won ? (state.shots - state.shotsUsed) * SHOT_BONUS : 0;
    return {
      targets: targets,
      blocks: blocks,
      shotsBonus: shotsBonus,
      total: targets + blocks + shotsBonus
    };
  }

  // Tie-break comparison: completion, fewer invalid actions, lower tick count,
  // then stable session id. Returns negative if a wins.
  function compareResults(a, b) {
    if (a.won !== b.won) return a.won ? -1 : 1;
    if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
    if (a.tick !== b.tick) return a.tick - b.tick;
    var sa = a.sessionId || '', sb = b.sessionId || '';
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }

  // ---- serialization / replay ------------------------------------------------------
  function serialize(state) {
    return JSON.stringify({
      version: state.version, seed: state.seed, index: state.index,
      shots: state.shots, shotsUsed: state.shotsUsed, tick: state.tick,
      phase: state.phase, over: state.over, won: state.won, reason: state.reason,
      invalidActions: state.invalidActions,
      bird: state.bird,
      blocks: state.blocks.map(function (b) {
        return { id: b.id, x: r3(b.x), y: r3(b.y), hp: r3(b.hp), alive: b.alive, falling: b.falling, vy: r3(b.vy) };
      }),
      targets: state.targets.map(function (t) { return { id: t.id, alive: t.alive }; }),
      destroyedBlocks: state.destroyedBlocks, destroyedTargets: state.destroyedTargets,
      log: state.log
    });
  }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  function hash(state) { return fnv1a(serialize(state)); }

  function deserialize(level, json) {
    var d = JSON.parse(json);
    var state = createState(level); // rebuild full geometry from versioned content
    state.shotsUsed = d.shotsUsed; state.tick = d.tick; state.phase = d.phase;
    state.over = d.over; state.won = d.won; state.reason = d.reason;
    state.invalidActions = d.invalidActions || 0;
    state.bird = d.bird;
    d.blocks.forEach(function (sb) {
      var b = state.blocks[sb.id];
      if (!b) return;
      b.x = sb.x; b.y = sb.y; b.hp = sb.hp; b.alive = sb.alive;
      b.falling = sb.falling; b.vy = sb.vy;
    });
    d.targets.forEach(function (st) {
      var t = state.targets[st.id];
      if (t) t.alive = st.alive;
    });
    state.destroyedBlocks = d.destroyedBlocks; state.destroyedTargets = d.destroyedTargets;
    state.log = d.log || [];
    return state;
  }

  // Replay envelope: { version, seed, index, initialHash, commands, hashes, result }
  function replay(level, envelope) {
    var state = createState(level);
    var initialHash = hash(state);
    if (envelope.initialHash && envelope.initialHash !== initialHash) {
      return { ok: false, reason: 'initial-hash-mismatch' };
    }
    var periodic = [];
    for (var i = 0; i < envelope.commands.length; i++) {
      var r = applyCommand(state, envelope.commands[i]);
      if (!r.ok) return { ok: false, reason: 'illegal-command-at-' + i };
      resolve(state);
      periodic.push(hash(state));
    }
    if (envelope.hashes) {
      for (i = 0; i < envelope.hashes.length; i++) {
        if (envelope.hashes[i] !== periodic[i]) {
          return { ok: false, reason: 'hash-mismatch-at-' + i };
        }
      }
    }
    return { ok: true, state: state, score: computeScore(state), hashes: periodic };
  }

  return {
    RULES_VERSION: RULES_VERSION,
    GRAVITY: GRAVITY, STEP: STEP, SLING_X: SLING_X, SLING_Y: SLING_Y,
    BIRD_R: BIRD_R, MAX_PULL: MAX_PULL, LAUNCH_POWER: LAUNCH_POWER,
    MAX_SPEED: MAX_SPEED, MAT: MAT,
    TARGET_SCORE: TARGET_SCORE, SHOT_BONUS: SHOT_BONUS,
    mulberry32: mulberry32, fnv1a: fnv1a,
    createState: createState, legalActions: legalActions,
    validateLaunch: validateLaunch, applyCommand: applyCommand,
    step: step, tick: tick, resolve: resolve,
    computeScore: computeScore, compareResults: compareResults,
    serialize: serialize, deserialize: deserialize, hash: hash, replay: replay
  };
});
