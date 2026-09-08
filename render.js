'use strict';

/*
 * Sky Sling - render: Three.js scene graph, semantic entity views, camera,
 * lighting, VFX, quality tiers. Consumes immutable rules snapshots; never
 * mutates simulation state. Deterministic visual seed per level.
 */
(function (root, factory) {
  var deps = (typeof module !== 'undefined')
    ? { R: require('./rules'), C: require('./content') }
    : { R: (root.SkySling || {}).rules, C: (root.SkySling || {}).content };
  var api = factory(deps.R, deps.C);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkySling = root.SkySling || {};
  root.SkySling.render = api;
})(typeof self !== 'undefined' ? self : globalThis, function (R, C) {

  // Authored framing constants (no magic offsets in the loop).
  // halfWidth/halfHeight: the world extent around the look-at point that must
  // stay on screen (sling at x≈2.4 through the first structures).
  var CAM = { y: 7.5, z: 18, lookX: 9, lookY: 2.4, fov: 42, halfWidth: 8, halfHeight: 5.5 };
  var ARC_POINTS = 28;

  var MAT_COLORS = { wood: 0xa8703c, stone: 0x8b8f96, ice: 0xbfe6f2 };

  function Renderer(canvas) {
    this.ok = false;
    this.canvas = canvas;
    this.tier = 2;
    this.reducedMotion = false;
    this.blockMeshes = [];
    this.targetMeshes = [];
    this.effects = [];
    this.trajectory = null;
    this.time = 0;
    this.aiming = false;   // while true, sync() leaves the bird where showAim put it
  }

  Renderer.prototype.init = function () {
    var THREE = (typeof window !== 'undefined' && window.THREE) || (typeof globalThis !== 'undefined' && globalThis.THREE);
    if (!THREE || !this.canvas) return false;
    this.THREE = THREE;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.tier > 0, powerPreference: 'default' });
    } catch (e) { return false; }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAM.fov, 16 / 9, 0.1, 300);
    this.camera.position.set(CAM.lookX, CAM.y, CAM.z);
    this.camera.lookAt(CAM.lookX, CAM.lookY, 0);

    // lighting: one dominant key, soft environment fill, contact grounding
    this.scene.add(new THREE.HemisphereLight(0xdff2ff, 0x8a7a5a, 0.7));
    var key = new THREE.DirectionalLight(0xfff2dd, 1.6);
    key.position.set(-8, 14, 10);
    key.castShadow = this.tier === 2;
    if (key.shadow) {
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -15; key.shadow.camera.right = 25;
      key.shadow.camera.top = 15; key.shadow.camera.bottom = -5;
    }
    this.keyLight = key;
    this.scene.add(key);

    // layers: 0 environment, 1 gameplay, 2 ghosts/trajectory, 3 effects
    this.ok = true;
    return true;
  };

  Renderer.prototype.setTier = function (t) {
    this.tier = t | 0;
    if (!this.ok) return;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var cap = this.tier === 2 ? 2 : (this.tier === 1 ? 1.5 : 1);
    this.renderer.setPixelRatio(Math.min(dpr, cap));
    this.renderer.shadowMap.enabled = this.tier === 2;
    if (this.keyLight) this.keyLight.castShadow = this.tier === 2;
    this.resize();
  };

  Renderer.prototype.setReducedMotion = function (on) { this.reducedMotion = !!on; };

  Renderer.prototype.resize = function () {
    if (!this.ok) return;
    var w = this.canvas.clientWidth || 640, h = this.canvas.clientHeight || 360;
    if (w === 0 || h === 0) return;
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

  // Build the whole scene for a level. Called on round start; old GPU
  // resources are disposed explicitly.
  Renderer.prototype.buildLevel = function (level) {
    if (!this.ok) return;
    var THREE = this.THREE;
    var theme = C.THEMES.filter(function (t) { return t.id === level.theme; })[0] || C.THEMES[0];
    this.disposeScene();
    this.level = level;
    this.blockMeshes = [];
    this.targetMeshes = [];
    this.effects = [];
    this.aiming = false;

    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.sky, 45, 120);

    // environment layer: sea, island, palms (deterministic decor stream)
    var env = new THREE.Group();
    env.name = 'environment';
    var water = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshStandardMaterial({ color: theme.water, roughness: 0.35, metalness: 0.1 }));
    water.rotation.x = -Math.PI / 2; water.position.y = -1.2;
    water.receiveShadow = true;
    env.add(water);

    var island = new THREE.Mesh(
      new THREE.CylinderGeometry(26, 30, 2.4, 48),
      new THREE.MeshStandardMaterial({ color: theme.sand, roughness: 0.95 }));
    island.position.set(10, -1.2, 0);
    island.receiveShadow = true;
    env.add(island);

    var grassTop = new THREE.Mesh(
      new THREE.CylinderGeometry(24, 26, 0.25, 48),
      new THREE.MeshStandardMaterial({ color: theme.foliage, roughness: 0.9 }));
    grassTop.position.set(10, -0.12, 0);
    grassTop.receiveShadow = true;
    env.add(grassTop);

    var rnd = R.mulberry32((level.seed ^ 0xdec0) >>> 0);
    if (this.tier > 0) {
      for (var p = 0; p < 5; p++) {
        env.add(this._makePalm(-6 + rnd() * 4, -4 + p * 2 + rnd(), 0.8 + rnd() * 0.5, theme));
        if (rnd() < 0.5) env.add(this._makePalm(20 + rnd() * 6, -5 + rnd() * 10, 0.7 + rnd() * 0.6, theme));
      }
    }
    this.scene.add(env);
    this.envGroup = env;

    // gameplay layer
    var game = new THREE.Group();
    game.name = 'gameplay';

    // slingshot: fork + pouch
    var slingMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.8 });
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 1.6, 10), slingMat);
    trunk.position.set(R.SLING_X, 0.8, 0);
    var armL = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.9, 10), slingMat);
    armL.position.set(R.SLING_X - 0.22, 1.85, 0); armL.rotation.z = 0.5;
    var armR = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.9, 10), slingMat);
    armR.position.set(R.SLING_X + 0.22, 1.85, 0); armR.rotation.z = -0.5;
    [trunk, armL, armR].forEach(function (m) { m.castShadow = true; game.add(m); });

    // band (updated while aiming)
    var bandGeo = new THREE.BufferGeometry();
    bandGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.band = new THREE.Line(bandGeo, new THREE.LineBasicMaterial({ color: 0x3a2a1a }));
    this.band.frustumCulled = false;
    this.band.visible = false;
    game.add(this.band);

    // bird
    var birdMat = new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.5 });
    this.bird = new THREE.Mesh(new THREE.SphereGeometry(R.BIRD_R, 24, 18), birdMat);
    var eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    var pupilMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    var e1 = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), eyeMat);
    e1.position.set(0.16, 0.1, 0.26);
    var p1 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), pupilMat);
    p1.position.set(0.21, 0.1, 0.33);
    this.bird.add(e1); this.bird.add(p1);
    var beak = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.18, 8),
      new THREE.MeshStandardMaterial({ color: 0xf0b040 }));
    beak.rotation.z = -Math.PI / 2; beak.position.set(0.36, 0, 0);
    this.bird.add(beak);
    this.bird.castShadow = true;
    this.bird.position.set(R.SLING_X, R.SLING_Y, 0);
    game.add(this.bird);

    // blocks
    var self = this;
    level.blocks.forEach(function (b) {
      var mat = new THREE.MeshStandardMaterial({
        color: MAT_COLORS[b.mat], roughness: b.mat === 'ice' ? 0.15 : 0.8,
        transparent: b.mat === 'ice', opacity: b.mat === 'ice' ? 0.85 : 1
      });
      var mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, Math.min(b.w, 1.1)), mat);
      mesh.position.set(b.x, b.y, 0);
      mesh.castShadow = true; mesh.receiveShadow = true;
      // material glyph: plank lines for wood, chips for stone (state readable w/o color)
      game.add(mesh);
      self.blockMeshes.push(mesh);
    });

    // targets: round critters with eyes — shape-coded, not color-only
    level.targets.forEach(function (t) {
      var g = new THREE.Group();
      var body = new THREE.Mesh(new THREE.SphereGeometry(t.r, 20, 14),
        new THREE.MeshStandardMaterial({ color: 0x77c04a, roughness: 0.6 }));
      body.castShadow = true;
      g.add(body);
      var te1 = new THREE.Mesh(new THREE.SphereGeometry(t.r * 0.22, 8, 6), eyeMat.clone());
      te1.position.set(-t.r * 0.3, t.r * 0.25, t.r * 0.85);
      var te2 = te1.clone(); te2.position.x = t.r * 0.3;
      g.add(te1); g.add(te2);
      g.position.set(t.x, t.y, 0);
      game.add(g);
      self.targetMeshes.push(g);
    });

    this.scene.add(game);
    this.gameGroup = game;

    // ghost/trajectory layer: dotted arc preview (never raycastable)
    var dotGeo = new THREE.SphereGeometry(0.07, 8, 6);
    var dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
    this.arcDots = [];
    for (var d = 0; d < ARC_POINTS; d++) {
      var dot = new THREE.Mesh(dotGeo, dotMat);
      dot.visible = false;
      dot.raycast = function () {}; // cosmetic only
      this.scene.add(dot);
      this.arcDots.push(dot);
    }
    this.resize();
  };

  Renderer.prototype._makePalm = function (x, z, s, theme) {
    var THREE = this.THREE;
    var g = new THREE.Group();
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * s, 0.14 * s, 2.2 * s, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 }));
    trunk.position.y = 1.1 * s;
    trunk.rotation.z = 0.12;
    g.add(trunk);
    for (var i = 0; i < 5; i++) {
      var leaf = new THREE.Mesh(new THREE.ConeGeometry(0.28 * s, 1.3 * s, 4),
        new THREE.MeshStandardMaterial({ color: theme.foliage, roughness: 0.85 }));
      leaf.position.set(Math.cos(i * 1.26) * 0.5 * s, 2.2 * s, Math.sin(i * 1.26) * 0.5 * s);
      leaf.rotation.z = Math.cos(i * 1.26) * 1.2;
      leaf.rotation.x = Math.sin(i * 1.26) * 1.2;
      g.add(leaf);
    }
    g.position.set(x, 0, z);
    return g;
  };

  // Show the approximate arc for pull vector (dx,dy) from the pouch.
  Renderer.prototype.showAim = function (dx, dy) {
    if (!this.ok) return;
    var THREE = this.THREE;
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
    var pos = this.band.geometry.attributes.position.array;
    pos[0] = R.SLING_X - 0.35; pos[1] = R.SLING_Y + 0.25; pos[2] = 0;
    pos[3] = px; pos[4] = py; pos[5] = 0;
    pos[6] = R.SLING_X + 0.35; pos[7] = R.SLING_Y + 0.25; pos[8] = 0;
    this.band.geometry.attributes.position.needsUpdate = true;
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
    if (!this.ok) return;
    this.aiming = false;
    this.band.visible = false;
    for (var i = 0; i < this.arcDots.length; i++) this.arcDots[i].visible = false;
    if (this.bird) this.bird.position.set(R.SLING_X, R.SLING_Y, 0);
  };

  // Sync views from a rules snapshot (rendering consumes, never mutates).
  Renderer.prototype.sync = function (state) {
    if (!this.ok || !state) return;
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

  Renderer.prototype.spawnImpact = function (x, y, big) {
    if (!this.ok || this.tier === 0 || this.reducedMotion) return;
    var THREE = this.THREE;
    var n = big ? 14 : 6;
    var group = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true });
    var parts = [];
    var rnd = R.mulberry32(((x * 131 + y * 57) | 0) >>> 0); // seeded cosmetic variants
    for (var i = 0; i < n; i++) {
      var p = new THREE.Mesh(new THREE.SphereGeometry(0.06 + rnd() * 0.06, 6, 4), mat.clone());
      p.position.set(x, y, 0);
      p.userData.vx = (rnd() - 0.5) * 6;
      p.userData.vy = rnd() * 5;
      group.add(p); parts.push(p);
    }
    this.scene.add(group);
    this.effects.push({ group: group, parts: parts, age: 0, life: 0.7 });
  };

  Renderer.prototype.update = function (dt, hidden) {
    if (!this.ok || hidden) return;
    this.time += dt;
    // pooled effect updates (bounded lifetime)
    for (var i = this.effects.length - 1; i >= 0; i--) {
      var e = this.effects[i];
      e.age += dt;
      for (var j = 0; j < e.parts.length; j++) {
        var p = e.parts[j];
        p.userData.vy -= R.GRAVITY * dt * 0.6;
        p.position.x += p.userData.vx * dt;
        p.position.y += p.userData.vy * dt;
        p.material.opacity = Math.max(0, 1 - e.age / e.life);
      }
      if (e.age >= e.life) {
        this.scene.remove(e.group);
        e.parts.forEach(function (p) { p.geometry.dispose(); p.material.dispose(); });
        this.effects.splice(i, 1);
      }
    }
  };

  Renderer.prototype.frame = function (dt, hidden) {
    if (!this.ok) return;
    this.update(dt, hidden);
    if (!hidden) this.renderer.render(this.scene, this.camera);
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
      e.parts.forEach(function (p) { p.geometry.dispose(); p.material.dispose(); });
    });
    this.effects = [];
    this.envGroup = null; this.gameGroup = null; this.bird = null; this.band = null;
  };

  return { Renderer: Renderer, CAM: CAM };
});
