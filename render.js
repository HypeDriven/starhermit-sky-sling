'use strict';

/*
 * Sky Sling - render: Three.js scene graph, semantic entity views, camera,
 * lighting, VFX, graphics quality. Consumes immutable rules snapshots; never
 * mutates simulation state. Deterministic visual seed per level.
 *
 * Graphics settings come from gfx.js (presets + per-category overrides) and
 * apply live: shadows, post chain (GTAO -> bloom -> output -> grade -> AA),
 * sky reflections, particle density, ambient motion, scene detail and the
 * pixel ratio (preset cap x render scale x adaptive scale).
 */
(function (root, factory) {
  var deps = (typeof module !== 'undefined')
    ? { R: require('./rules'), C: require('./content'), G: require('./gfx') }
    : { R: (root.SkySling || {}).rules, C: (root.SkySling || {}).content, G: (root.SkySling || {}).gfx };
  var api = factory(deps.R, deps.C, deps.G);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.render = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R, C, G) {

  // Authored framing constants (no magic offsets in the loop).
  // halfWidth/halfHeight: the world extent around the look-at point that must
  // stay on screen (sling at x≈2.4 through the first structures).
  var CAM = { y: 7.5, z: 18, lookX: 9, lookY: 2.4, fov: 42, halfWidth: 8, halfHeight: 5.5 };
  var ARC_POINTS = 28;
  // Play volume the key-light shadow frustum is fitted to (sling, structures, palms).
  var PLAY_BOX = { minX: -8, maxX: 31, minY: -0.5, maxY: 12, minZ: -6, maxZ: 6 };
  var SUN_POS = [34, 17, -130];

  var MAT_COLORS = { wood: 0xa8703c, stone: 0x8b8f96, ice: 0xbfe6f2 };

  // Colour grade + vignette, applied in display space after the output pass.
  var GradeShader = {
    uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;',
      'varying vec2 vUv;',
      'void main() {',
      '  vec4 src = texture2D(tDiffuse, vUv);',
      '  vec3 c = clamp(src.rgb, 0.0, 1.0);',
      // gentle S-curve, a touch more saturation, warm highlights / cool shadows
      '  vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.18);',
      '  float l = dot(s, vec3(0.299, 0.587, 0.114));',
      '  s = mix(vec3(l), s, 1.1);',
      '  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.25, 0.85, l));',
      '  c = mix(c, s, uAmount);',
      '  float d = length(vUv - 0.5);',
      '  c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);',
      '  gl_FragColor = vec4(c, src.a);',
      '}'
    ].join('\n')
  };

  function addons() {
    var a = (typeof window !== 'undefined' && window.THREE_ADDONS) || null;
    return a && !a.failed ? a : null;
  }

  // Unmasked GPU name from a throwaway context (the main context's antialias
  // attribute depends on the preset this string selects).
  function probeGpu() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return '';
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (e) { return ''; }
  }

  function isTouchDevice() {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
  }

  function Renderer(canvas) {
    this.ok = false;
    this.canvas = canvas;
    this.reducedMotion = false;
    this.blockMeshes = [];
    this.targetMeshes = [];
    this.effects = [];
    this.trajectory = null;
    this.time = 0;
    this.aiming = false;   // while true, sync() leaves the bird where showAim put it
    this.saved = {};
    this.q = G.resolve({}, 'balanced');
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.size = [0, 0];
    this.pixelRatio = 1;
    this.postKey = null;
    this.composer = null;
    this.postFailed = false;
    this._tex = {};
    this._envCache = {};
  }

  Renderer.prototype.init = function (savedGfx) {
    var THREE = (typeof window !== 'undefined' && window.THREE) || (typeof globalThis !== 'undefined' && globalThis.THREE);
    if (!THREE || !this.canvas) return false;
    this.THREE = THREE;
    if (savedGfx) this.saved = savedGfx;
    if (this.gpu == null) {
      this.gpu = probeGpu();
      this.detected = G.detectPreset(this.gpu, { touch: isTouchDevice() });
    }
    this.q = G.resolve(this.saved, this.detected);
    // Canvas MSAA is fixed at context creation; later switches to MSAA use a
    // multisampled composer target instead.
    this.ctxMsaa = this.q.antialias === 'msaa';
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.ctxMsaa, powerPreference: 'high-performance' });
    } catch (e) { return false; }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAM.fov, 16 / 9, 0.1, 400);
    this.camera.position.set(CAM.lookX, CAM.y, CAM.z);
    this.camera.lookAt(CAM.lookX, CAM.lookY, 0);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    // lighting: one dominant key, soft sky fill, a warm back/rim light from the
    // visible sun, and contact grounding through fitted shadows
    this.hemi = new THREE.HemisphereLight(0xdff2ff, 0x8a7a5a, 0.8);
    this.scene.add(this.hemi);
    var key = new THREE.DirectionalLight(0xfff2dd, 1.7);
    key.position.set(-8, 14, 10);
    key.target.position.set(12, 3, 0);
    this.scene.add(key.target);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    this.keyLight = key;
    this.scene.add(key);
    this._fitShadow();
    var rim = new THREE.DirectionalLight(0xffe0b0, 0.12);
    rim.target.position.set(12, 2, 0);
    rim.position.fromArray(SUN_POS).sub(rim.target.position).normalize().multiplyScalar(40).add(rim.target.position);
    this.scene.add(rim.target);
    this.scene.add(rim);
    this.rimLight = rim;

    this.size = [0, 0];
    this.postKey = null;
    this.composer = null;
    // layers: 0 environment, 1 gameplay, 2 ghosts/trajectory, 3 effects
    this.ok = true;
    this.setGraphics(this.saved);
    return true;
  };

  // Fit the orthographic shadow camera tightly around the play volume as seen
  // from the key light.
  Renderer.prototype._fitShadow = function () {
    var THREE = this.THREE, key = this.keyLight;
    var dir = key.position.clone().sub(key.target.position).normalize();
    var eye = key.target.position.clone().add(dir.multiplyScalar(60));
    var view = new THREE.Matrix4().lookAt(eye, key.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(eye);
    view.invert();
    var b = PLAY_BOX, v = new THREE.Vector3();
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    [b.minX, b.maxX].forEach(function (x) {
      [b.minY, b.maxY].forEach(function (y) {
        [b.minZ, b.maxZ].forEach(function (z) {
          v.set(x, y, z).applyMatrix4(view);
          mn[0] = Math.min(mn[0], v.x); mx[0] = Math.max(mx[0], v.x);
          mn[1] = Math.min(mn[1], v.y); mx[1] = Math.max(mx[1], v.y);
          mn[2] = Math.min(mn[2], v.z); mx[2] = Math.max(mx[2], v.z);
        });
      });
    });
    key.position.copy(eye);
    var cam = key.shadow.camera;
    cam.left = mn[0] - 0.5; cam.right = mx[0] + 0.5;
    cam.bottom = mn[1] - 0.5; cam.top = mx[1] + 0.5;
    cam.near = Math.max(0.5, -mx[2] - 2); cam.far = -mn[2] + 2;
    cam.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------- graphics settings

  /* Apply saved graphics settings ({} = Auto). Applies live, no reload. */
  Renderer.prototype.setGraphics = function (saved) {
    this.saved = saved || {};
    var prev = this.q;
    this.q = G.resolve(this.saved, this.detected);
    if (!this.ok) return;
    var g = this.q;
    var size = G.SHADOW_MAP[g.shadows];
    var shadowChanged = this.renderer.shadowMap.enabled !== (size > 0);
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      if (this.keyLight.shadow.map) { this.keyLight.shadow.map.dispose(); this.keyLight.shadow.map = null; }
    }
    this._applyReflections();
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null;         // rebuild the post chain on the next frame
    this.size = [0, 0];          // re-apply the pixel ratio
    this._fpsVisible(g.showFps);
    // scene detail / particle density change what buildLevel makes
    if (this.level && prev && (prev.detail !== g.detail)) this.buildLevel(this.level, this._lastState);
    else if (shadowChanged) {
      this.scene.traverse(function (o) {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; });
      });
    }
    if (typeof document !== 'undefined') {
      this.canvas.setAttribute('data-gfx-preset', g.preset);
      document.body.setAttribute('data-gfx-preset', g.preset);
    }
  };

  /* What the settings panel shows: GPU, auto choice, resolved tiers, pixels, fps. */
  Renderer.prototype.graphicsInfo = function () {
    return {
      gpu: this.gpu || '',
      detected: this.detected,
      resolved: this.q,
      pixels: [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)],
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed
    };
  };

  Renderer.prototype._fpsVisible = function (on) {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  };

  Renderer.prototype._applyReflections = function () {
    if (!this.ok) return;
    var on = this.q.reflections === 'on';
    this.scene.environment = on && this.theme ? this._envFor(this.theme) : null;
    this.scene.environmentIntensity = 0.55;
    this.hemi.intensity = on ? 0.5 : 0.8;
  };

  // Sky-based image lighting: a PMREM of the theme's sky gradient and sun, so
  // water, ice and glossy pieces reflect the sky they sit under.
  Renderer.prototype._envFor = function (theme) {
    if (this._envCache[theme.id]) return this._envCache[theme.id];
    var THREE = this.THREE;
    var envScene = new THREE.Scene();
    var dome = this._makeSkyDome(theme, 50);
    envScene.add(dome);
    var sun = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.4, 2.1) }));
    var sd = new THREE.Vector3().fromArray(SUN_POS).normalize().multiplyScalar(42);
    sun.position.copy(sd);
    envScene.add(sun);
    var rt = this.pmrem.fromScene(envScene, 0.02, 0.1, 100);
    dome.geometry.dispose(); dome.material.dispose(); sun.geometry.dispose(); sun.material.dispose();
    this._envCache[theme.id] = rt.texture;
    return rt.texture;
  };

  Renderer.prototype.setReducedMotion = function (on) { this.reducedMotion = !!on; };

  Renderer.prototype._motion = function () {
    return !this.reducedMotion && this.q.background === 'animated';
  };

  // Kept for callers (window resize/orientation): re-apply size next frame.
  Renderer.prototype.resize = function () {
    if (!this.ok) return;
    this.size = [0, 0];
    this._ensureSize();
  };

  Renderer.prototype._ensureSize = function (rescale) {
    var w = this.canvas.clientWidth || 640, h = this.canvas.clientHeight || 360;
    if (w === 0 || h === 0) return;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var ratio = Math.min(dpr, this.q.cap) * this.q.scale * this.adaptiveScale;
    if (w === this.size[0] && h === this.size[1] && ratio === this.pixelRatio && !rescale) return;
    this.size = [w, h];
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Framing is authored for a wide viewport; on narrower ones (portrait phones)
    // the horizontal field would crop the slingshot out of view, so dolly back
    // until the authored play area fits both axes.
    var tanHalfV = Math.tan((CAM.fov * Math.PI) / 360);
    var dist = Math.max(CAM.z,
      CAM.halfWidth / (tanHalfV * this.camera.aspect),
      CAM.halfHeight / tanHalfV);
    this.camera.position.set(CAM.lookX, CAM.y, dist);
    this.camera.lookAt(CAM.lookX, CAM.lookY, 0);
    this.camera.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------- post-processing

  Renderer.prototype._needsPost = function () {
    var g = this.q;
    return g.post || (g.antialias === 'msaa' && !this.ctxMsaa);
  };

  Renderer.prototype._postKeyFor = function (w, h) {
    var g = this.q;
    if (!this._needsPost() || !addons()) return 'none';
    return [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|');
  };

  Renderer.prototype._buildPost = function (w, h) {
    var THREE = this.THREE, g = this.q, A = addons();
    if (this.composer) { this.composer.dispose(); this.composer = null; }
    this.gradePass = null;
    if (!this._needsPost()) return;
    if (!A) { this.postFailed = true; return; }
    try {
      var pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
      var target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0
      });
      var composer = new A.EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new A.RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        var ao = new A.GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = A.GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        // sky, sun sprite and clouds are backdrop: keep them out of the AO buffers
        var selfR = this, aoRender = ao.render;
        ao.render = function () {
          var hide = selfR.noAO || [];
          for (var i = 0; i < hide.length; i++) hide[i].visible = false;
          try { aoRender.apply(this, arguments); } finally {
            for (var j = 0; j < hide.length; j++) hide[j].visible = true;
          }
        };
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // high threshold: only the sun, glints and bright highlights bloom
        composer.addPass(new A.UnrealBloomPass(new THREE.Vector2(w, h), 0.25, 0.3, 0.92));
      }
      composer.addPass(new A.OutputPass());
      if (g.grade === 'on') {
        this.gradePass = new A.ShaderPass(GradeShader);
        composer.addPass(this.gradePass);
      }
      if (g.antialias === 'smaa') composer.addPass(new A.SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        var fxaa = new A.ShaderPass(A.FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
      this.postFailed = false;
    } catch (e) {
      // post-processing is an enhancement: render directly if it cannot be built
      this.postFailed = true;
      this.composer = null;
    }
  };

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  Renderer.prototype._adapt = function (dtMs) {
    var f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    var sum = 0;
    for (var i = 0; i < f.length; i++) sum += f[i];
    var avg = sum / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    var el = typeof document !== 'undefined' && document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = Math.round(this.fps) + ' fps · ' + (Math.round(this.pixelRatio * 100) / 100) + '×';
    if (!this.q.adaptive) return false;
    var before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  };

  // ---------------------------------------------------------------- procedural textures

  function canvasTex(THREE, key, cache, size, draw, opts) {
    if (cache[key]) return cache[key];
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    draw(ctx, size, R.mulberry32(hashStr(key)));
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = opts && opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    cache[key] = t;
    return t;
  }

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function noiseSpeckle(ctx, n, rnd, alphaMax, light, dark, size, rMax) {
    for (var i = 0; i < n; i++) {
      var x = rnd() * size, y = rnd() * size, r = 0.5 + rnd() * rMax;
      ctx.fillStyle = (rnd() < 0.5 ? light : dark) + (rnd() * alphaMax).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Wood: planks with grain lines and knots (texture is a multiplier over the
  // material colour, so wood stays wood-brown). Grain runs along +U.
  function drawWood(ctx, s, rnd) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s, s);
    for (var i = 0; i < 70; i++) {
      var y = rnd() * s;
      ctx.strokeStyle = 'rgba(90,50,20,' + (0.08 + rnd() * 0.18).toFixed(3) + ')';
      ctx.lineWidth = 0.6 + rnd() * 1.8;
      ctx.beginPath(); ctx.moveTo(0, y);
      for (var x = 0; x <= s; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 2.5 * rnd());
      ctx.stroke();
    }
    // plank seams (the readable "wood" glyph)
    ctx.fillStyle = 'rgba(60,32,12,0.55)';
    [s / 3, (2 * s) / 3].forEach(function (y) { ctx.fillRect(0, y - 1.5, s, 3); });
    for (var k = 0; k < 3; k++) {
      var kx = rnd() * s, ky = rnd() * s;
      ctx.strokeStyle = 'rgba(80,40,15,0.45)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(kx, ky, 7, 3.5, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // bevel darkening at the edges
    edgeShade(ctx, s, 'rgba(50,25,10,0.35)');
  }

  // Stone: mottled speckle with dark chips and cracks (the "stone" glyph).
  function drawStone(ctx, s, rnd) {
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, s, s);
    noiseSpeckle(ctx, 900, rnd, 0.25, 'rgba(255,255,255,', 'rgba(40,40,45,', s, 3);
    for (var i = 0; i < 16; i++) {
      var x = rnd() * s, y = rnd() * s, r = 3 + rnd() * 6;
      ctx.fillStyle = 'rgba(50,50,58,0.55)';
      ctx.beginPath();
      for (var a = 0; a < 6; a++) {
        var ang = a / 6 * Math.PI * 2, rr = r * (0.6 + rnd() * 0.5);
        ctx[a ? 'lineTo' : 'moveTo'](x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
      }
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(40,40,48,0.5)'; ctx.lineWidth = 1.4;
    for (var c = 0; c < 4; c++) {
      var cx = rnd() * s, cy = rnd() * s;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      for (var j = 0; j < 5; j++) { cx += (rnd() - 0.5) * 40; cy += (rnd() - 0.2) * 30; ctx.lineTo(cx, cy); }
      ctx.stroke();
    }
    edgeShade(ctx, s, 'rgba(30,30,36,0.4)');
  }

  // Ice: frosty streaks and a few bright cracks (the "ice" glyph).
  function drawIce(ctx, s, rnd) {
    ctx.fillStyle = '#e8f6fb'; ctx.fillRect(0, 0, s, s);
    for (var i = 0; i < 40; i++) {
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.2 + rnd() * 0.5).toFixed(3) + ')';
      ctx.lineWidth = 0.5 + rnd() * 2;
      var x = rnd() * s, y = rnd() * s, l = 20 + rnd() * 60;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y - l * 0.6); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120,170,200,0.55)'; ctx.lineWidth = 1.2;
    for (var c = 0; c < 3; c++) {
      var cx = rnd() * s, cy = rnd() * s;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      for (var j = 0; j < 4; j++) { cx += (rnd() - 0.5) * 50; cy += (rnd() - 0.5) * 50; ctx.lineTo(cx, cy); }
      ctx.stroke();
    }
    edgeShade(ctx, s, 'rgba(255,255,255,0.7)');
  }

  function edgeShade(ctx, s, color) {
    var w = s * 0.06;
    [[0, 0, s, w, 0, 0, 0, w], [0, s - w, s, w, 0, s, 0, s - w], [0, 0, w, s, 0, 0, w, 0], [s - w, 0, w, s, s, 0, s - w, 0]].forEach(function (e) {
      var g = ctx.createLinearGradient(e[4], e[5], e[6], e[7]);
      g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(e[0], e[1], e[2], e[3]);
    });
  }

  function drawSand(ctx, s, rnd) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s, s);
    noiseSpeckle(ctx, 2600, rnd, 0.22, 'rgba(255,250,235,', 'rgba(120,95,60,', s, 1.4);
  }

  function drawGrass(ctx, s, rnd) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s, s);
    for (var i = 0; i < 60; i++) {
      var x = rnd() * s, y = rnd() * s, r = 10 + rnd() * 30;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      var a = (0.04 + rnd() * 0.07).toFixed(3);
      g.addColorStop(0, rnd() < 0.5 ? 'rgba(255,255,200,' + a + ')' : 'rgba(20,60,20,' + a + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (var b = 0; b < 1400; b++) {
      var bx = rnd() * s, by = rnd() * s;
      ctx.strokeStyle = (rnd() < 0.5 ? 'rgba(30,70,25,' : 'rgba(235,255,210,') + (0.1 + rnd() * 0.15).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + (rnd() - 0.5) * 3, by - 3 - rnd() * 4); ctx.stroke();
    }
  }

  // Tileable ripple normal map from a sum of periodic waves.
  function drawWaterNormal(ctx, s, rnd) {
    var img = ctx.createImageData(s, s), d = img.data;
    var waves = [];
    for (var i = 0; i < 7; i++) {
      waves.push({ kx: Math.round((rnd() - 0.5) * 10) || 1, ky: Math.round((rnd() - 0.5) * 10) || 2, ph: rnd() * 6.28, a: 0.4 + rnd() });
    }
    var TWO_PI = Math.PI * 2;
    for (var y = 0; y < s; y++) {
      for (var x = 0; x < s; x++) {
        var dx = 0, dy = 0;
        for (var w = 0; w < waves.length; w++) {
          var W = waves[w];
          var c = Math.cos(TWO_PI * (W.kx * x + W.ky * y) / s + W.ph) * W.a;
          dx += c * W.kx; dy += c * W.ky;
        }
        var nx = -dx * 0.03, ny = -dy * 0.03, nz = 1;
        var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        var o = (y * s + x) * 4;
        d[o] = (nx / l * 0.5 + 0.5) * 255; d[o + 1] = (ny / l * 0.5 + 0.5) * 255; d[o + 2] = (nz / l * 0.5 + 0.5) * 255; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawRadial(ctx, s) {
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.7, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  }

  function drawGlow(ctx, s) {
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.22, 'rgba(255,245,220,0.35)');
    g.addColorStop(1, 'rgba(255,240,210,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  }

  Renderer.prototype._texture = function (name) {
    var THREE = this.THREE, cache = this._tex;
    switch (name) {
      case 'wood': return canvasTex(THREE, 'wood', cache, 256, drawWood);
      case 'wood-v':
        if (!cache['wood-v']) {
          var t = this._texture('wood').clone();
          t.center.set(0.5, 0.5); t.rotation = Math.PI / 2; t.needsUpdate = true;
          cache['wood-v'] = t;
        }
        return cache['wood-v'];
      case 'stone': return canvasTex(THREE, 'stone', cache, 256, drawStone);
      case 'ice': return canvasTex(THREE, 'ice', cache, 256, drawIce);
      case 'sand': return canvasTex(THREE, 'sand', cache, 256, drawSand);
      case 'grass': return canvasTex(THREE, 'grass', cache, 256, drawGrass);
      case 'water-n': return canvasTex(THREE, 'water-n', cache, 128, drawWaterNormal, { linear: true });
      case 'radial': return canvasTex(THREE, 'radial', cache, 128, drawRadial, { linear: true });
      case 'glow': return canvasTex(THREE, 'glow', cache, 128, drawGlow);
    }
    return null;
  };

  // ---------------------------------------------------------------- scene building

  Renderer.prototype._skyColors = function (theme) {
    var THREE = this.THREE;
    var base = new THREE.Color(theme.sky);
    // ACES desaturates bright values, so the dome is authored a little deeper
    // and more saturated than the theme swatch
    var hsl = {}; base.getHSL(hsl);
    var horizon = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), hsl.l * 0.92);
    var zenith = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.3), hsl.l * 0.55);
    return { horizon: horizon, zenith: zenith, water: new THREE.Color(theme.water) };
  };

  // Gradient sky dome (vertex colours): water tone below the horizon, a pale
  // horizon band, deepening toward the zenith.
  Renderer.prototype._makeSkyDome = function (theme, radius) {
    var THREE = this.THREE, col = this._skyColors(theme);
    var geo = new THREE.SphereGeometry(radius, 32, 20);
    var pos = geo.attributes.position, colors = new Float32Array(pos.count * 3), c = new THREE.Color();
    for (var i = 0; i < pos.count; i++) {
      var t = pos.getY(i) / radius;
      if (t < 0) c.copy(col.horizon);
      else c.copy(col.horizon).lerp(col.zenith, Math.min(1, Math.pow(t * 2.2, 0.6)));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -10;
    return mesh;
  };

  // Build the whole scene for a level. Called on round start (and behind the
  // title); old GPU resources are disposed explicitly. `state` optionally
  // re-syncs a rebuilt scene (graphics detail changed mid-round).
  Renderer.prototype.buildLevel = function (level, state) {
    if (!this.ok) return;
    var THREE = this.THREE;
    var theme = C.THEMES.filter(function (t) { return t.id === level.theme; })[0] || C.THEMES[0];
    var detailed = this.q.detail === 'detailed';
    var self = this;
    this.disposeScene();
    this.level = level;
    this.theme = theme;
    this.blockMeshes = [];
    this.targetMeshes = [];
    this.effects = [];
    this.animated = [];   // { obj, kind, phase }
    this.aiming = false;
    this._applyReflections();

    var sky = this._skyColors(theme);
    this.scene.background = sky.horizon.clone();
    this.scene.fog = new THREE.Fog(sky.horizon.clone(), 50, 170);

    // environment layer: sky, sun, clouds, sea, island, palms (deterministic decor stream)
    var env = new THREE.Group();
    env.name = 'environment';
    var rnd = R.mulberry32((level.seed ^ 0xdec0) >>> 0);

    var dome = this._makeSkyDome(theme, 220);
    dome.position.set(CAM.lookX, 0, 0);
    env.add(dome);

    var sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._texture('glow'), color: new THREE.Color(1.5, 1.4, 1.25), transparent: true,
      depthWrite: false, fog: false, blending: THREE.AdditiveBlending
    }));
    sun.position.fromArray(SUN_POS);
    sun.scale.set(26, 26, 1);
    sun.renderOrder = -9;
    env.add(sun);

    // drifting clouds: clusters of soft puffs far behind the island
    var cloudMat = new THREE.MeshLambertMaterial({ color: 0xf4f7fa, emissive: new THREE.Color(sky.horizon).multiplyScalar(0.3), fog: false });
    var puffGeo = new THREE.SphereGeometry(1, 14, 10);
    var nClouds = detailed ? 8 : 3;
    this.clouds = [];
    this.noAO = [dome, sun];   // hidden from the GTAO depth/normal pass
    for (var ci = 0; ci < nClouds; ci++) {
      var cloud = new THREE.Group();
      var puffs = 4 + Math.floor(rnd() * 4);
      for (var pi = 0; pi < puffs; pi++) {
        var puff = new THREE.Mesh(puffGeo, cloudMat);
        var r = 1.6 + rnd() * 1.8;
        puff.scale.set(r * 1.3, r * 0.8, r);
        puff.position.set((pi - puffs / 2) * 2.0 + rnd() * 1.2, rnd() * 1.1, rnd() * 2);
        cloud.add(puff);
      }
      cloud.position.set(-70 + ci * (170 / nClouds) + rnd() * 12, 6 + rnd() * 7, -105 - rnd() * 35);
      cloud.userData.speed = 0.25 + rnd() * 0.35;
      env.add(cloud);
      this.clouds.push(cloud);
      this.noAO.push(cloud);
    }

    var waterMat = new THREE.MeshStandardMaterial({ color: theme.water, roughness: detailed ? 0.3 : 0.55, metalness: 0.0 });
    if (detailed) {
      waterMat.normalMap = this._texture('water-n');
      waterMat.normalScale = new THREE.Vector2(0.3, 0.3);
      waterMat.normalMap.repeat.set(36, 36);
    }
    var water = new THREE.Mesh(new THREE.PlaneGeometry(440, 440), waterMat);
    water.rotation.x = -Math.PI / 2; water.position.y = -1.2;
    water.receiveShadow = true;
    env.add(water);
    this.water = water;

    if (detailed) {
      // turquoise shallows around the island and a pulsing foam line
      var shallowCol = new THREE.Color(theme.water).lerp(new THREE.Color(0x7fe6d8), 0.45);
      var shallows = new THREE.Mesh(new THREE.CircleGeometry(38, 64), new THREE.MeshStandardMaterial({
        color: shallowCol, roughness: 0.2, transparent: true, alphaMap: this._texture('radial'), depthWrite: false
      }));
      shallows.rotation.x = -Math.PI / 2; shallows.position.set(10, -1.17, 0);
      env.add(shallows);
      var foam = new THREE.Mesh(new THREE.TorusGeometry(28.2, 0.22, 6, 120), new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.6, transparent: true, opacity: 0.8
      }));
      foam.rotation.x = -Math.PI / 2; foam.position.set(10, -1.16, 0);
      env.add(foam);
      this.animated.push({ obj: foam, kind: 'foam', phase: 0 });
    }

    var sandMat = new THREE.MeshStandardMaterial({ color: theme.sand, roughness: 0.95 });
    var grassMat = new THREE.MeshStandardMaterial({ color: theme.foliage, roughness: 0.9 });
    if (detailed) {
      sandMat.map = this._texture('sand'); sandMat.map.repeat.set(6, 1);
      grassMat.map = this._texture('grass'); grassMat.map.repeat.set(5, 5);
    }
    var island = new THREE.Mesh(new THREE.CylinderGeometry(26, 30, 2.4, 64), sandMat);
    island.position.set(10, -1.2, 0);
    island.receiveShadow = true;
    env.add(island);

    var grassTop = new THREE.Mesh(new THREE.CylinderGeometry(24, 26, 0.25, 64), grassMat);
    grassTop.position.set(10, -0.12, 0);
    grassTop.receiveShadow = true;
    env.add(grassTop);

    for (var p = 0; p < 5; p++) {
      env.add(this._makePalm(-6 + rnd() * 4, -4 + p * 2 + rnd(), 0.8 + rnd() * 0.5, theme, detailed, rnd));
      if (rnd() < 0.5) env.add(this._makePalm(20 + rnd() * 6, -5 + rnd() * 10, 0.7 + rnd() * 0.6, theme, detailed, rnd));
    }
    if (detailed) {
      // rocks along the beach and grass tufts (instanced) for ground texture
      var rockMat = new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.85, flatShading: true });
      var rockGeo = new THREE.DodecahedronGeometry(1, 0);
      for (var k = 0; k < 9; k++) {
        var ang = -Math.PI * 0.15 + rnd() * Math.PI * 1.3;
        var rock = new THREE.Mesh(rockGeo, rockMat);
        var rs = 0.4 + rnd() * 0.9;
        rock.scale.set(rs * 1.3, rs * 0.7, rs);
        rock.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
        rock.position.set(10 + Math.cos(ang) * (25.5 + rnd() * 2), -0.2, -Math.sin(ang) * (25.5 + rnd() * 2) * 0.35 - 3);
        rock.castShadow = true; rock.receiveShadow = true;
        env.add(rock);
      }
    }
    this.scene.add(env);
    this.envGroup = env;

    // gameplay layer
    var game = new THREE.Group();
    game.name = 'gameplay';

    // slingshot: fork + rubber band
    var slingMat = new THREE.MeshStandardMaterial({ color: 0x7a4e28, roughness: 0.7 });
    if (detailed) slingMat.map = this._texture('wood-v');
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 1.6, 12), slingMat);
    trunk.position.set(R.SLING_X, 0.8, 0);
    var armL = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.9, 12), slingMat);
    armL.position.set(R.SLING_X - 0.22, 1.85, 0); armL.rotation.z = 0.5;
    var armR = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.9, 12), slingMat);
    armR.position.set(R.SLING_X + 0.22, 1.85, 0); armR.rotation.z = -0.5;
    [trunk, armL, armR].forEach(function (m) { m.castShadow = true; m.receiveShadow = true; game.add(m); });

    // band: two rubber strands meeting at the pouch (shown while aiming)
    var bandMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.6 });
    var strandGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
    strandGeo.translate(0, 0.5, 0);
    this.band = new THREE.Group();
    this.bandL = new THREE.Mesh(strandGeo, bandMat);
    this.bandR = new THREE.Mesh(strandGeo, bandMat);
    this.pouch = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 6), bandMat);
    this.pouch.scale.set(0.7, 1.1, 1.2);
    this.band.add(this.bandL); this.band.add(this.bandR); this.band.add(this.pouch);
    this.band.visible = false;
    game.add(this.band);

    // bird: glossy body, belly, eye with highlight, brow, beak, crest and tail
    this.bird = new THREE.Group();
    var birdBody = new THREE.Group();
    this.birdBody = birdBody;
    this.bird.add(birdBody);
    var birdMat = new THREE.MeshPhysicalMaterial({ color: theme.accent, roughness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.25 });
    var body = new THREE.Mesh(new THREE.SphereGeometry(R.BIRD_R, 28, 20), birdMat);
    body.castShadow = true;
    birdBody.add(body);
    var bellyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.accent).lerp(new THREE.Color(0xfff2dc), 0.6), roughness: 0.6 });
    var belly = new THREE.Mesh(new THREE.SphereGeometry(R.BIRD_R * 0.78, 18, 12), bellyMat);
    belly.position.set(0.07, -0.1, 0.1);
    belly.scale.set(0.9, 0.75, 0.8);
    birdBody.add(belly);
    var eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    var pupilMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.2 });
    var glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    var e1 = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 8), eyeMat);
    e1.position.set(0.16, 0.1, 0.26);
    var p1 = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 6), pupilMat);
    p1.position.set(0.21, 0.1, 0.33);
    var g1 = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 4), glintMat);
    g1.position.set(0.225, 0.125, 0.375);
    var brow = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.035, 0.05), pupilMat);
    brow.position.set(0.16, 0.21, 0.27); brow.rotation.z = -0.35;
    [e1, p1, g1, brow].forEach(function (m) { birdBody.add(m); });
    var beak = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.2, 10),
      new THREE.MeshStandardMaterial({ color: 0xf0b040, roughness: 0.4 }));
    beak.rotation.z = -Math.PI / 2; beak.position.set(0.37, 0, 0.04);
    birdBody.add(beak);
    var featherMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.accent).multiplyScalar(0.7), roughness: 0.6 });
    for (var f = 0; f < 3; f++) {
      var tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.26, 6), featherMat);
      tail.position.set(-0.36, 0.02 + (f - 1) * 0.06, 0);
      tail.rotation.z = Math.PI / 2 + (f - 1) * 0.35;
      birdBody.add(tail);
      var crest = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.16, 6), featherMat);
      crest.position.set(0.02 + (f - 1) * 0.06, 0.38, 0);
      crest.rotation.z = (1 - f) * 0.4;
      birdBody.add(crest);
    }
    this.bird.position.set(R.SLING_X, R.SLING_Y, 0);
    game.add(this.bird);
    this.animated.push({ obj: birdBody, kind: 'bob', phase: 0 });

    // blocks: shared materials per material type (textured when detailed)
    var A = addons();
    var mats = {};
    function blockMat(kind, vertical) {
      var key = kind + (vertical ? '-v' : '');
      if (mats[key]) return mats[key];
      var m;
      if (kind === 'ice') {
        m = new THREE.MeshPhysicalMaterial({
          color: detailed ? 0xa6daf0 : MAT_COLORS.ice, roughness: 0.12, transparent: true, opacity: 0.86,
          clearcoat: detailed ? 1 : 0, clearcoatRoughness: 0.1,
          emissive: new THREE.Color(detailed ? 0x24566c : 0x1b3a48), envMapIntensity: 0.8
        });
      } else if (kind === 'stone') {
        m = new THREE.MeshStandardMaterial({ color: MAT_COLORS.stone, roughness: 0.88, envMapIntensity: 0.6 });
      } else {
        m = new THREE.MeshStandardMaterial({ color: MAT_COLORS.wood, roughness: 0.72 });
      }
      if (detailed) {
        m.map = self._texture(kind === 'wood' && vertical ? 'wood-v' : kind);
        if (kind === 'stone') { m.bumpMap = m.map; m.bumpScale = 1.5; }
      }
      mats[key] = m;
      return m;
    }
    level.blocks.forEach(function (b) {
      var depth = Math.min(b.w, 1.1);
      var geo = (detailed && A && A.RoundedBoxGeometry)
        ? new A.RoundedBoxGeometry(b.w, b.h, depth, 2, Math.min(0.06, b.w * 0.2, b.h * 0.2))
        : new THREE.BoxGeometry(b.w, b.h, depth);
      var mesh = new THREE.Mesh(geo, blockMat(b.mat, b.h > b.w * 1.2));
      mesh.position.set(b.x, b.y, 0);
      mesh.castShadow = true; mesh.receiveShadow = true;
      game.add(mesh);
      self.blockMeshes.push(mesh);
    });

    // targets: round critters with eyes, pupils and a leaf sprout — shape-coded, not colour-only
    var bumbleMat = new THREE.MeshPhysicalMaterial({ color: 0x77c04a, roughness: 0.55, clearcoat: 0.45, clearcoatRoughness: 0.35 });
    var sproutMat = new THREE.MeshStandardMaterial({ color: 0x3f8a2a, roughness: 0.6 });
    var cheekMat = new THREE.MeshStandardMaterial({ color: 0xf29a8a, roughness: 0.7 });
    level.targets.forEach(function (t, ti) {
      var g = new THREE.Group();
      var inner = new THREE.Group();
      g.add(inner);
      var bodyT = new THREE.Mesh(new THREE.SphereGeometry(t.r, 24, 16), bumbleMat);
      bodyT.castShadow = true; bodyT.receiveShadow = true;
      inner.add(bodyT);
      var te1 = new THREE.Mesh(new THREE.SphereGeometry(t.r * 0.22, 10, 8), eyeMat);
      te1.position.set(-t.r * 0.3, t.r * 0.25, t.r * 0.82);
      var te2 = te1.clone(); te2.position.x = t.r * 0.3;
      var tp1 = new THREE.Mesh(new THREE.SphereGeometry(t.r * 0.11, 8, 6), pupilMat);
      tp1.position.set(-t.r * 0.28, t.r * 0.24, t.r * 1.01);
      var tp2 = tp1.clone(); tp2.position.x = t.r * 0.32;
      [te1, te2, tp1, tp2].forEach(function (m) { inner.add(m); });
      var ck1 = new THREE.Mesh(new THREE.SphereGeometry(t.r * 0.12, 8, 6), cheekMat);
      ck1.scale.set(1, 0.6, 0.4); ck1.position.set(-t.r * 0.55, -t.r * 0.05, t.r * 0.82);
      var ck2 = ck1.clone(); ck2.position.x = t.r * 0.55;
      inner.add(ck1); inner.add(ck2);
      var stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, t.r * 0.35, 5), sproutMat);
      stalk.position.set(0, t.r * 1.1, 0);
      var leaf = new THREE.Mesh(new THREE.SphereGeometry(t.r * 0.22, 8, 6), sproutMat);
      leaf.scale.set(1.4, 0.35, 0.7); leaf.position.set(t.r * 0.18, t.r * 1.25, 0); leaf.rotation.z = 0.5;
      inner.add(stalk); inner.add(leaf);
      g.position.set(t.x, t.y, 0);
      game.add(g);
      self.targetMeshes.push(g);
      self.animated.push({ obj: inner, kind: 'breathe', phase: ti * 1.7, r: t.r });
    });

    this.scene.add(game);
    this.gameGroup = game;

    // ghost/trajectory layer: dotted arc preview (never raycastable). Slightly
    // over-bright so it glows softly when bloom is on.
    var dotGeo = new THREE.SphereGeometry(0.075, 10, 6);
    var dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.15, 1.15, 1.1), transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false });
    this.arcDots = [];
    for (var d = 0; d < ARC_POINTS; d++) {
      var dot = new THREE.Mesh(dotGeo, dotMat);
      dot.visible = false;
      dot.scale.setScalar(1 - (d / ARC_POINTS) * 0.55);
      dot.raycast = function () {}; // cosmetic only
      this.scene.add(dot);
      this.arcDots.push(dot);
    }
    this.resize();
    if (state) this.sync(state);
  };

  // Palm: segmented curved trunk, drooping fronds, coconuts. The crown sways.
  Renderer.prototype._makePalm = function (x, z, s, theme, detailed, rnd) {
    var THREE = this.THREE;
    var g = new THREE.Group();
    var barkA = new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 });
    var barkB = new THREE.MeshStandardMaterial({ color: 0x74573a, roughness: 0.9 });
    var segs = detailed ? 6 : 1, lean = 0.12 + rnd() * 0.12;
    var top = new THREE.Vector3(0, 0, 0);
    for (var i = 0; i < segs; i++) {
      var h = (2.2 * s) / segs;
      var seg = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * s * (1 - i / (segs * 2.2)), 0.14 * s * (1 - i / (segs * 2.5)), h * 1.04, 8), i % 2 ? barkB : barkA);
      var bend = lean * (i / segs) * (i / segs) * 2.2;
      seg.position.set(top.x + Math.sin(bend) * h / 2, top.y + Math.cos(bend) * h / 2, 0);
      seg.rotation.z = -bend;
      seg.castShadow = true;
      g.add(seg);
      top.set(top.x + Math.sin(bend) * h, top.y + Math.cos(bend) * h, 0);
    }
    var crown = new THREE.Group();
    crown.position.copy(top);
    var leafMat = new THREE.MeshStandardMaterial({ color: theme.foliage, roughness: 0.8, side: THREE.DoubleSide });
    var fronds = detailed ? 8 : 5;
    for (var f = 0; f < fronds; f++) {
      var ang = (f / fronds) * Math.PI * 2 + rnd() * 0.3;
      var frond;
      if (detailed) {
        var geo = new THREE.PlaneGeometry(0.42 * s, 1.7 * s, 1, 8);
        var pos = geo.attributes.position;
        for (var v = 0; v < pos.count; v++) {
          var yy = pos.getY(v) / (1.7 * s) + 0.5;           // 0 at base, 1 at tip
          var w = Math.sin(Math.PI * Math.min(1, yy * 1.1)) * (1 - yy * 0.4);
          pos.setX(v, pos.getX(v) * w);
          pos.setZ(v, -yy * yy * 0.9 * s);                  // droop
          pos.setY(v, yy * 1.7 * s);
        }
        geo.computeVertexNormals();
        frond = new THREE.Mesh(geo, leafMat);
        frond.rotation.order = 'YXZ';
        frond.rotation.y = ang;
        frond.rotation.x = -1.05;
      } else {
        frond = new THREE.Mesh(new THREE.ConeGeometry(0.28 * s, 1.3 * s, 4), leafMat);
        frond.position.set(Math.cos(ang) * 0.5 * s, 0, Math.sin(ang) * 0.5 * s);
        frond.rotation.z = Math.cos(ang) * 1.2;
        frond.rotation.x = Math.sin(ang) * 1.2;
      }
      frond.castShadow = true;
      crown.add(frond);
    }
    if (detailed) {
      var nutMat = new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 0.7 });
      for (var n = 0; n < 3; n++) {
        var nut = new THREE.Mesh(new THREE.SphereGeometry(0.1 * s, 8, 6), nutMat);
        nut.position.set(Math.cos(n * 2.1) * 0.13 * s, -0.1 * s, Math.sin(n * 2.1) * 0.13 * s);
        crown.add(nut);
      }
    }
    g.add(crown);
    g.position.set(x, 0, z);
    g.rotation.y = rnd() * Math.PI * 2;
    this.animated.push({ obj: crown, kind: 'sway', phase: rnd() * 6.28 });
    return g;
  };

  // Orient a unit-height strand from a to b.
  Renderer.prototype._strand = function (mesh, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy) || 0.001;
    mesh.position.set(ax, ay, 0.02);
    mesh.scale.set(1, len, 1);
    mesh.rotation.set(0, 0, Math.atan2(-dx, dy));
  };

  // Show the approximate arc for pull vector (dx,dy) from the pouch.
  Renderer.prototype.showAim = function (dx, dy) {
    if (!this.ok) return;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.05) { this.hideAim(); return; }
    // (dx,dy) is the pull offset from the pouch: the pouch follows the drag and
    // the shot leaves along the opposite vector, exactly like doLaunch(). The
    // pouch used to be placed at -(dx,dy), which mirrored both the pouch and the
    // previewed arc against the shot that was actually fired.
    var pull = Math.min(len, R.MAX_PULL);
    var px = R.SLING_X + (dx / len) * pull;
    var py = R.SLING_Y + (dy / len) * pull;
    var vx = (R.SLING_X - px) * R.LAUNCH_POWER;
    var vy = (R.SLING_Y - py) * R.LAUNCH_POWER;

    this.aiming = true;
    this.bird.position.set(px, py, 0);
    this._strand(this.bandL, R.SLING_X - 0.43, R.SLING_Y + 0.04, px, py);
    this._strand(this.bandR, R.SLING_X + 0.43, R.SLING_Y + 0.04, px, py);
    this.pouch.position.set(px - 0.12, py, 0.02);
    this.band.visible = true;

    var x = px, y = py, tvx = vx, tvy = vy;
    var dt = 0.07;
    for (var i = 0; i < this.arcDots.length; i++) {
      tvy -= R.GRAVITY * dt; x += tvx * dt; y += tvy * dt;
      var dot = this.arcDots[i];
      if (y < 0) { dot.visible = false; continue; }
      dot.visible = true;
      dot.position.set(x, y, 0);
    }
  };

  Renderer.prototype.hideAim = function () {
    if (!this.ok || !this.band) return;
    this.aiming = false;
    this.band.visible = false;
    for (var i = 0; i < this.arcDots.length; i++) this.arcDots[i].visible = false;
    if (this.bird) this.bird.position.set(R.SLING_X, R.SLING_Y, 0);
  };

  // Sync views from a rules snapshot (rendering consumes, never mutates).
  Renderer.prototype.sync = function (state) {
    if (!this.ok || !state || !this.bird) return;
    this._lastState = state;
    // the per-frame sync must not fight showAim(): while the player is pulling
    // back, the pouch position is owned by the aim preview, not by the rules
    // state (which still has the bird resting on the sling).
    if (!this.aiming) this.bird.position.set(state.bird.x, state.bird.y, 0);
    this.bird.visible = true;
    for (var i = 0; i < state.blocks.length; i++) {
      var m = this.blockMeshes[i], b = state.blocks[i];
      if (!m) continue;
      m.visible = b.alive;
      if (b.alive) m.position.set(b.x, b.y, 0);
    }
    for (var j = 0; j < state.targets.length; j++) {
      var g = this.targetMeshes[j], t = state.targets[j];
      if (!g) continue;
      g.visible = t.alive;
    }
  };

  // Bounded, seeded impact effect. kind: 'impact' | 'block' | 'pop'; mat tints debris.
  Renderer.prototype.spawnImpact = function (x, y, big, mat, kind) {
    if (!this.ok || this.reducedMotion) return;
    var THREE = this.THREE;
    var high = this.q.particles === 'high';
    kind = kind || (big ? 'block' : 'impact');
    if (!this._sparkGeo) {
      this._sparkGeo = new THREE.SphereGeometry(1, 6, 4);
      this._chunkGeo = new THREE.BoxGeometry(1, 1, 1);
      this._puffGeo = new THREE.SphereGeometry(1, 12, 8);
    }
    var group = new THREE.Group();
    var parts = [], mats = [];
    var rnd = R.mulberry32(((x * 131 + y * 57) | 0) >>> 0); // seeded cosmetic variants
    var sparkMat = new THREE.MeshBasicMaterial({ color: kind === 'pop' ? new THREE.Color(0.9, 1.6, 0.6) : new THREE.Color(1.6, 1.45, 1.1), transparent: true, depthWrite: false });
    mats.push(sparkMat);
    var nSpark = (kind === 'impact' ? 6 : 12) * (high ? 1.6 : 0.6) | 0;
    for (var i = 0; i < nSpark; i++) {
      var p = new THREE.Mesh(this._sparkGeo, sparkMat);
      p.scale.setScalar(0.05 + rnd() * 0.06);
      p.position.set(x, y, 0.2);
      p.userData.vx = (rnd() - 0.5) * 7;
      p.userData.vy = rnd() * 5.5;
      p.userData.g = 0.6;
      group.add(p); parts.push(p);
    }
    if (high && kind !== 'impact') {
      var chunkMat = new THREE.MeshStandardMaterial({
        color: kind === 'pop' ? 0x5da83a : (MAT_COLORS[mat] || MAT_COLORS.wood), roughness: 0.7, transparent: true
      });
      mats.push(chunkMat);
      for (var c = 0; c < 8; c++) {
        var ch = new THREE.Mesh(this._chunkGeo, chunkMat);
        var cs = 0.08 + rnd() * 0.12;
        ch.scale.set(cs * (kind === 'pop' ? 1.8 : 1), cs * (kind === 'pop' ? 0.3 : 1), cs);
        ch.position.set(x + (rnd() - 0.5) * 0.4, y + (rnd() - 0.5) * 0.4, 0.2);
        ch.userData.vx = (rnd() - 0.5) * 5;
        ch.userData.vy = 1 + rnd() * 4;
        ch.userData.spin = (rnd() - 0.5) * 12;
        ch.userData.g = kind === 'pop' ? 0.25 : 1;
        group.add(ch); parts.push(ch);
      }
      var puffMat = new THREE.MeshBasicMaterial({ color: kind === 'pop' ? 0xe8ffd8 : 0xf3ead8, transparent: true, opacity: 0.5, depthWrite: false });
      mats.push(puffMat);
      var puff = new THREE.Mesh(this._puffGeo, puffMat);
      puff.position.set(x, y, 0.1);
      puff.scale.setScalar(0.2);
      puff.userData.puff = true;
      group.add(puff); parts.push(puff);
    }
    this.scene.add(group);
    this.effects.push({ group: group, parts: parts, mats: mats, age: 0, life: kind === 'impact' ? 0.6 : 0.9 });
  };

  Renderer.prototype.update = function (dt, hidden) {
    if (!this.ok || hidden) return;
    this.time += dt;
    // pooled effect updates (bounded lifetime)
    for (var i = this.effects.length - 1; i >= 0; i--) {
      var e = this.effects[i];
      e.age += dt;
      var k = Math.max(0, 1 - e.age / e.life);
      for (var j = 0; j < e.parts.length; j++) {
        var p = e.parts[j];
        if (p.userData.puff) { p.scale.setScalar(0.2 + (1 - k) * 1.3); continue; }
        p.userData.vy -= R.GRAVITY * dt * p.userData.g;
        p.position.x += p.userData.vx * dt;
        p.position.y += p.userData.vy * dt;
        if (p.userData.spin) { p.rotation.z += p.userData.spin * dt; p.rotation.x += p.userData.spin * 0.6 * dt; }
      }
      e.mats[0].opacity = k;
      if (e.mats[1]) e.mats[1].opacity = Math.min(1, k * 2);
      if (e.mats[2]) e.mats[2].opacity = 0.5 * k;
      if (e.age >= e.life) {
        this.scene.remove(e.group);
        e.mats.forEach(function (m) { m.dispose(); });
        this.effects.splice(i, 1);
      }
    }
    // ambient motion (off under reduced motion or a static background)
    if (!this._motion() || !this.animated) return;
    var t = this.time;
    for (var a = 0; a < this.animated.length; a++) {
      var an = this.animated[a], o = an.obj;
      if (an.kind === 'sway') { o.rotation.z = Math.sin(t * 0.9 + an.phase) * 0.05; o.rotation.x = Math.cos(t * 0.7 + an.phase) * 0.03; }
      else if (an.kind === 'breathe') { var sc = 1 + Math.sin(t * 2.1 + an.phase) * 0.035; o.scale.set(1 / Math.sqrt(sc), sc, 1 / Math.sqrt(sc)); o.position.y = (sc - 1) * an.r; }
      else if (an.kind === 'bob') { o.position.y = this.aiming ? 0 : Math.sin(t * 2.4) * 0.025; }
      else if (an.kind === 'foam') { o.material.opacity = 0.55 + Math.sin(t * 1.3) * 0.25; o.scale.setScalar(1 + Math.sin(t * 1.3) * 0.004); }
    }
    if (this.water && this.water.material.normalMap) {
      this.water.material.normalMap.offset.set(t * 0.012, t * 0.007);
    }
    if (this.clouds) {
      for (var c = 0; c < this.clouds.length; c++) {
        var cl = this.clouds[c];
        cl.position.x += cl.userData.speed * dt;
        if (cl.position.x > 110) cl.position.x = -90;
      }
    }
  };

  Renderer.prototype.frame = function (dt, hidden) {
    if (!this.ok) return;
    this.update(dt, hidden);
    if (hidden) return;
    var rescale = this._adapt(Math.min(250, dt * 1000) || 16);
    this._ensureSize(rescale);
    var key = this._postKeyFor(this.size[0], this.size[1]);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(this.size[0], this.size[1]);
    }
    if (this.composer) {
      try { this.composer.render(dt); return; } catch (e) {
        this.composer = null; this.postFailed = true; this.postKey = 'failed';
      }
    }
    this.renderer.render(this.scene, this.camera);
  };

  Renderer.prototype.disposeScene = function () {
    if (!this.ok) return;
    var self = this;
    [this.envGroup, this.gameGroup].forEach(function (g) {
      if (!g) return;
      g.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); });
          else o.material.dispose();
        }
      });
      self.scene.remove(g);
    });
    if (this.arcDots) {
      this.arcDots.forEach(function (d) {
        self.scene.remove(d);
        d.geometry.dispose(); d.material.dispose();  // shared geo/material: disposing twice is a no-op
      });
      this.arcDots = null;
    }
    // impact sparks live directly on the scene, not in the level groups
    (this.effects || []).forEach(function (e) {
      self.scene.remove(e.group);
      e.mats.forEach(function (m) { m.dispose(); });
    });
    this.effects = [];
    this.animated = [];
    this.clouds = null; this.water = null; this.noAO = [];
    this.envGroup = null; this.gameGroup = null; this.bird = null; this.birdBody = null; this.band = null;
  };

  return { Renderer: Renderer, CAM: CAM, GradeShader: GradeShader };
});
