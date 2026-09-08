'use strict';

/*
 * Sky Sling - audio: WebAudio synthesized buses (music / sfx / ambience / voice),
 * event mapping, seeded variant selection, focus/background behavior.
 * No audio-only gameplay: every cue has a visual counterpart.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.audio = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

  var _ctx = null;
  var _buses = {};        // music, sfx, ambience, voice -> GainNode
  var _levels = { music: 0.6, sfx: 0.9, ambience: 0.5, voice: 0.0 };
  var _sources = { music: null, ambience: null };
  var _captions = null;   // optional callback(text) for text cues
  var _variantSeed = 12345;

  // Authored one-shot samples (sfx/<name>.opus, see sfx/manifest.json), mapped
  // onto the named events below. Fetched lazily after the user-gesture unlock;
  // synthesis remains the fallback while a clip is loading or unavailable.
  var _samples = {
    drag:    ['sling-stretch'],
    launch:  ['sling-release', 'bird-whoosh'],
    impact:  ['impact-thud'],
    wood:    ['wood-crack', 'wood-tumble'],
    stone:   ['stone-crunch', 'stone-rumble'],
    target:  ['target-pop'],
    win:     ['win-fanfare'],
    lose:    ['lose-deflate'],
    invalid: ['invalid-buzz'],
    ui:      ['ui-click', 'ui-chime']
  };
  var _sampleCache = {};  // name -> { state: 'loading'|'ready'|'error', buffer }

  function _variant() {
    // deterministic variant stream for replay-consistent pitch
    _variantSeed = (_variantSeed * 1103515245 + 12345) & 0x7fffffff;
    return _variantSeed / 0x7fffffff;
  }

  function _ensure() {
    if (_ctx) { if (_ctx.state === 'suspended') { try { _ctx.resume(); } catch (_) {} } return true; }
    try {
      var AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
               (typeof globalThis !== 'undefined' && globalThis.AudioContext);
      if (!AC) return false;
      _ctx = new AC();
      ['music', 'sfx', 'ambience', 'voice'].forEach(function (name) {
        var g = _ctx.createGain();
        g.gain.value = _levels[name];
        g.connect(_ctx.destination);
        _buses[name] = g;
      });
      _startAmbience();
      _startMusic();
      return true;
    } catch (e) { _ctx = null; return false; }
  }

  function _startAmbience() {
    // soft sea-wind: filtered noise-ish detuned sines, very quiet
    var g = _ctx.createGain(); g.gain.value = 1;
    var o1 = _ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 82;
    var o2 = _ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 83.7;
    var og = _ctx.createGain(); og.gain.value = 0.06;
    o1.connect(og); o2.connect(og); og.connect(g);
    // slow swell LFO
    var lfo = _ctx.createOscillator(); lfo.frequency.value = 0.13;
    var lg = _ctx.createGain(); lg.gain.value = 0.03;
    lfo.connect(lg); lg.connect(og.gain);
    o1.start(); o2.start(); lfo.start();
    g.connect(_buses.ambience);
    _sources.ambience = { nodes: [o1, o2, lfo], gain: g };
  }

  function _startMusic() {
    // gentle island pad: slow arpeggio via scheduled oscillator blips
    var timer = { id: null };
    var notes = [261.6, 329.6, 392.0, 523.3, 392.0, 329.6];
    var step = 0;
    function schedule() {
      if (!_ctx) return;
      // A suspended context (backgrounded tab) has a frozen clock: scheduling
      // into it would pile every missed note onto the same instant and fire
      // them all at once on resume.
      if (_ctx.state !== 'running') { timer.id = setTimeout(schedule, 900); return; }
      var t = _ctx.currentTime;
      var o = _ctx.createOscillator(), g = _ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = notes[step % notes.length];
      step++;
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.10, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
      o.connect(g); g.connect(_buses.music);
      o.start(t); o.stop(t + 1.5);
      timer.id = setTimeout(schedule, 900);
    }
    schedule();
    _sources.music = timer;
  }

  function _blip(bus, type, f0, f1, dur, gain) {
    if (!_ensure()) return;
    var t = _ctx.currentTime;
    var o = _ctx.createOscillator(), g = _ctx.createGain();
    var v = 0.94 + _variant() * 0.12; // seeded pitch variant
    o.type = type;
    o.frequency.setValueAtTime(f0 * v, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * v), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(_buses[bus]);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function _caption(text) { if (_captions) { try { _captions(text); } catch (_) {} } }

  function _loadSample(name) {
    var rec = _sampleCache[name];
    if (rec) return rec;
    rec = _sampleCache[name] = { state: 'loading', buffer: null };
    if (typeof fetch !== 'function') { rec.state = 'error'; return rec; }
    fetch('sfx/' + encodeURIComponent(name) + '.opus').then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.arrayBuffer();
    }).then(function (ab) {
      // callback form of decodeAudioData: works in every engine
      _ctx.decodeAudioData(ab, function (buf) {
        rec.buffer = buf; rec.state = 'ready';
      }, function () { rec.state = 'error'; });
    }).catch(function () { rec.state = 'error'; });
    return rec;
  }

  // Try the authored clip for an event; returns true if a sample actually
  // started. Kicks off the lazy load either way; false means "synthesize".
  function _trySample(eventName) {
    var names = _samples[eventName];
    if (!names || !names.length) return false;
    if (!_ensure()) return false;
    var name = names[Math.floor(_variant() * names.length) % names.length];
    var rec = _loadSample(name);
    if (rec.state !== 'ready' || !rec.buffer) return false;
    var src = _ctx.createBufferSource();
    src.buffer = rec.buffer;
    src.connect(_buses.sfx);
    src.start();
    return true;
  }

  var events = {
    drag:      function () { if (!_trySample('drag')) _blip('sfx', 'sine', 300, 380, 0.08, 0.12); _caption('aiming'); },
    launch:    function () { if (!_trySample('launch')) _blip('sfx', 'sine', 650, 180, 0.35, 0.4); _caption('whoosh'); },
    impact:    function () { if (!_trySample('impact')) _blip('sfx', 'square', 130, 60, 0.18, 0.35); _caption('impact'); },
    wood:      function () { if (!_trySample('wood')) _blip('sfx', 'triangle', 220, 90, 0.2, 0.3); },
    stone:     function () { if (!_trySample('stone')) _blip('sfx', 'sawtooth', 90, 45, 0.25, 0.28); },
    target:    function () { if (!_trySample('target')) _blip('sfx', 'triangle', 500, 900, 0.25, 0.35); _caption('target down'); },
    win:       function () {
      if (!_trySample('win')) {
        _blip('sfx', 'triangle', 523, 1046, 0.5, 0.35);
        setTimeout(function () { _blip('sfx', 'triangle', 659, 1318, 0.5, 0.3); }, 140);
      }
      _caption('stage clear');
    },
    lose:      function () { if (!_trySample('lose')) _blip('sfx', 'triangle', 220, 110, 0.6, 0.3); _caption('out of shots'); },
    invalid:   function () { if (!_trySample('invalid')) _blip('sfx', 'square', 180, 140, 0.12, 0.2); _caption('not allowed'); },
    ui:        function () { if (!_trySample('ui')) _blip('sfx', 'sine', 500, 620, 0.07, 0.15); }
  };

  function play(name) {
    var fn = events[name];
    if (fn) fn();
  }

  function setLevel(bus, v) {
    v = Math.max(0, Math.min(1, Number(v) || 0));
    _levels[bus] = v;
    if (_buses[bus]) _buses[bus].gain.value = v;
  }
  function getLevel(bus) { return _levels[bus]; }

  // Background tabs: duck everything, keep context alive for resume.
  function setBackground(hidden) {
    if (!_ctx) return;
    try {
      if (hidden) _ctx.suspend(); else _ctx.resume();
    } catch (_) {}
  }

  function setCaptionHandler(fn) { _captions = fn; }

  return {
    play: play,
    setLevel: setLevel, getLevel: getLevel,
    setBackground: setBackground,
    setCaptionHandler: setCaptionHandler,
    unlock: _ensure   // call from a user gesture
  };
});
