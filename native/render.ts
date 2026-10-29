// The island range on starhermit:scene, as the browser build's render.js drew
// it with three.js r185: the authored camera (fov 42 at y 7.5, looking at the
// sling and the first structures) that dollies back until the play area fits
// the playfield, the sky dome (vertex colours from the theme's sky, deeper
// toward the zenith), the additive sun sprite, the drifting clouds (merged
// puff clusters), the sea, the sandy island and its grass top, the seeded
// palms (segmented curved trunks and drooping fronds on detailed looks), the
// slingshot with its rubber band and pouch, the bird (glossy body, belly,
// eyes, brow, beak, crest and tail), the blocks (wood, stone and ice with
// their procedural grain, cracks and frost; rounded on detailed looks), the
// Bumble targets (eyes, cheeks and a leaf sprout), the dotted aim arc, and
// the seeded impact sparks, debris and puffs. On detailed looks the
// shallows, the pulsing foam ring, the beach rocks and the rippling water
// normal map; animated looks sway the palms, let the critters breathe and
// the bird bob, and drift the clouds; reduced motion stops all of it and the
// impact effects.
//
// From three.js r185: light intensities as the page wrote them (engine.minor
// 23+); the shadow box is the page's fitted ortho box; the sky reflections (a PMREM of the theme's sky dome and sun,
// pmrem.fromScene of a small scene in the browser build — the engine takes
// only RoomEnvironment there) are an equirectangular float image of the same
// dome and sun, prefiltered with fromEquirectangular, at the old
// environmentIntensity 0.55; the post chain (GTAO, UnrealBloom 0.25 / 0.3 /
// 0.92 before the output pass's ACES, the GradeShader in display space after
// it, FXAA / SMAA / MSAA) is renderer.ao / bloom / grade / antialias; the
// shallows' alphaMap is a map whose alpha holds the falloff. The key light's
// shadow follows the view (the engine fits directional shadows to the view,
// not to an orthographic frustum around the play volume). The scene fills
// the playfield rectangle the HUD leaves (the whole window except on portrait
// phones, where the canvas sat between the top bar and the rails), framed
// with setViewOffset. Rendering never touches the rules state.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, CanvasTexture, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DataTexture, DirectionalLight, DodecahedronGeometry, DoubleSide, EquirectangularReflectionMapping,
  FloatType, Fog, Group, HemisphereLight, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, NoColorSpace, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Quaternion, RepeatWrapping, RGBAFormat,
  RoundedBoxGeometry, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, TorusGeometry, type OrthographicCamera, Vector2, Vector3, mergeGeometries,
  renderer, scene, type BufferGeometry, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Content, Rules, type Level, type Mat, type State, type Theme } from "./classic.ts";
import type { Look } from "./quality.ts";

const PI = Math.PI;
// Authored framing constants (render.js CAM): the world extent around the
// look-at point that must stay on screen (the sling through the first structures).
const CAM = { y: 7.5, z: 18, lookX: 9, lookY: 2.4, fov: 42, halfWidth: 8, halfHeight: 5.5 };
const ARC_POINTS = 28;
const SUN_POS = new Vector3(34, 17, -130);
const MAT_COLORS: Record<Mat, number> = { wood: 0xa8703c, stone: 0x8b8f96, ice: 0xbfe6f2 };

const camera = new PerspectiveCamera(CAM.fov, 16 / 9, 0.1, 400);
camera.position.set(CAM.lookX, CAM.y, CAM.z);
camera.lookAt(CAM.lookX, CAM.lookY, 0);

// lighting: one dominant key, soft sky fill and a warm back/rim light from the visible sun
const hemi = new HemisphereLight(0xdff2ff, 0x8a7a5a, 0.8);
const key = new DirectionalLight(0xfff2dd, 1.7);
key.position.set(-8, 14, 10);
key.target.position.set(12, 3, 0);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.03;
const rim = new DirectionalLight(0xffe0b0, 0.12);
rim.target.position.set(12, 2, 0);
rim.position.copy(SUN_POS).sub(rim.target.position).normalize().multiplyScalar(40).add(rim.target.position);
scene.add(hemi, key, key.target, rim, rim.target);
fitShadow();

/** render.js _fitShadow: the orthographic shadow camera fitted tightly around the play volume as seen from the key light. */
function fitShadow(): void {
  const PLAY_BOX = { minX: -8, maxX: 31, minY: -0.5, maxY: 12, minZ: -6, maxZ: 6 };
  const dir = key.position.clone().sub(key.target.position).normalize();
  const eye = key.target.position.clone().add(dir.multiplyScalar(60));
  const view = new Matrix4().lookAt(eye, key.target.position, new Vector3(0, 1, 0));
  view.setPosition(eye);
  view.invert();
  const b = PLAY_BOX, v = new Vector3();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const z of [b.minZ, b.maxZ]) {
    v.set(x, y, z).applyMatrix4(view);
    for (let i = 0; i < 3; i++) { const c = i === 0 ? v.x : i === 1 ? v.y : v.z; mn[i] = Math.min(mn[i]!, c); mx[i] = Math.max(mx[i]!, c); }
  }
  key.position.copy(eye);
  const cam = key.shadow.camera as OrthographicCamera;
  cam.left = mn[0]! - 0.5; cam.right = mx[0]! + 0.5;
  cam.bottom = mn[1]! - 0.5; cam.top = mx[1]! + 0.5;
  cam.near = Math.max(0.5, -mx[2]! - 2); cam.far = -mn[2]! + 2;
  cam.updateProjectionMatrix();
}

let look: Look | null = null;
let level: Level | null = null;
let theme: Theme = Content.THEMES[0]!;
let lastState: State | null = null;
let reducedMotion = false;
let time = 0;

let envGroup: Group | null = null;
let gameGroup: Group | null = null;
let blockMeshes: Mesh[] = [];
let targetMeshes: Group[] = [];
let bird: Group | null = null;
let band: Group | null = null, bandL: Mesh | null = null, bandR: Mesh | null = null, pouch: Mesh | null = null;
let arcDots: Mesh[] = [];
let clouds: Mesh[] = [];
let water: Mesh<MeshStandardMaterial | MeshLambertMaterial> | null = null;
interface Anim { obj: Object3D; kind: "sway" | "breathe" | "bob" | "foam"; phase: number; r?: number }
let animated: Anim[] = [];
let aiming = false;
interface Effect { group: Group; parts: Mesh[]; mats: (MeshBasicMaterial | MeshStandardMaterial | MeshLambertMaterial)[]; age: number; life: number }
let effects: Effect[] = [];
const vel = new WeakMap<Object3D, { vx: number; vy: number; g: number; spin: number; puff: boolean }>();

function disposeTree(root: Object3D): void {
  const geos = new Set<BufferGeometry>(), mats = new Set<Material>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
}

// ---------------------------------------------------------------- procedural textures (render.js, unchanged painters)
type Ctx = OffscreenCanvasRenderingContext2D;
type Rnd = () => number;
const texCache = new Map<string, Texture>();
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** `authored` is the size the art is drawn for; `size` (the look's texture budget) scales it; `direct` draws at `size` itself. */
function canvasTex(name: string, authored: number, draw: (c: Ctx, s: number, rnd: Rnd) => void, opts: { linear?: boolean; direct?: boolean } | null, size?: number): Texture {
  size = size || authored;
  const ck = `${name}@${size}`;
  const hit = texCache.get(ck);
  if (hit) return hit;
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext("2d");
  if (opts && opts.direct) draw(ctx, size, Rules.mulberry32(hashStr(name)));
  else {
    if (size !== authored) ctx.scale(size / authored, size / authored);
    draw(ctx, authored, Rules.mulberry32(hashStr(name)));
  }
  const t = new CanvasTexture(cv);
  t.colorSpace = opts && opts.linear ? NoColorSpace : SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  texCache.set(ck, t);
  return t;
}
function noiseSpeckle(ctx: Ctx, n: number, rnd: Rnd, alphaMax: number, light: string, dark: string, size: number, rMax: number): void {
  for (let i = 0; i < n; i++) {
    const x = rnd() * size, y = rnd() * size, r = 0.5 + rnd() * rMax;
    ctx.fillStyle = (rnd() < 0.5 ? light : dark) + (rnd() * alphaMax).toFixed(3) + ")";
    ctx.beginPath(); ctx.arc(x, y, r, 0, PI * 2); ctx.fill();
  }
}
function edgeShade(ctx: Ctx, s: number, color: string): void {
  const w = s * 0.06;
  for (const e of [[0, 0, s, w, 0, 0, 0, w], [0, s - w, s, w, 0, s, 0, s - w], [0, 0, w, s, 0, 0, w, 0], [s - w, 0, w, s, s, 0, s - w, 0]] as const) {
    const g = ctx.createLinearGradient(e[4], e[5], e[6], e[7]);
    g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(e[0], e[1], e[2], e[3]);
  }
}
/** Wood: planks with grain lines and knots (a multiplier over the material colour). Grain runs along +U. */
function drawWood(ctx: Ctx, s: number, rnd: Rnd): void {
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    const y = rnd() * s;
    ctx.strokeStyle = `rgba(90,50,20,${(0.08 + rnd() * 0.18).toFixed(3)})`;
    ctx.lineWidth = 0.6 + rnd() * 1.8;
    ctx.beginPath(); ctx.moveTo(0, y);
    for (let x = 0; x <= s; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 2.5 * rnd());
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(60,32,12,0.55)";
  for (const y of [s / 3, (2 * s) / 3]) ctx.fillRect(0, y - 1.5, s, 3);
  for (let k = 0; k < 3; k++) {
    const kx = rnd() * s, ky = rnd() * s;
    ctx.strokeStyle = "rgba(80,40,15,0.45)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(kx, ky, 7, 3.5, 0, 0, PI * 2); ctx.stroke();
  }
  edgeShade(ctx, s, "rgba(50,25,10,0.35)");
}
/** Stone: mottled speckle with dark chips and cracks. */
function drawStone(ctx: Ctx, s: number, rnd: Rnd): void {
  ctx.fillStyle = "#f2f2f2"; ctx.fillRect(0, 0, s, s);
  noiseSpeckle(ctx, 900, rnd, 0.25, "rgba(255,255,255,", "rgba(40,40,45,", s, 3);
  for (let i = 0; i < 16; i++) {
    const x = rnd() * s, y = rnd() * s, r = 3 + rnd() * 6;
    ctx.fillStyle = "rgba(50,50,58,0.55)";
    ctx.beginPath();
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * PI * 2, rr = r * (0.6 + rnd() * 0.5);
      if (a) ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr); else ctx.moveTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = "rgba(40,40,48,0.5)"; ctx.lineWidth = 1.4;
  for (let c = 0; c < 4; c++) {
    let cx = rnd() * s, cy = rnd() * s;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    for (let j = 0; j < 5; j++) { cx += (rnd() - 0.5) * 40; cy += (rnd() - 0.2) * 30; ctx.lineTo(cx, cy); }
    ctx.stroke();
  }
  edgeShade(ctx, s, "rgba(30,30,36,0.4)");
}
/** Ice: frosty streaks and a few bright cracks. */
function drawIce(ctx: Ctx, s: number, rnd: Rnd): void {
  ctx.fillStyle = "#e8f6fb"; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(255,255,255,${(0.2 + rnd() * 0.5).toFixed(3)})`;
    ctx.lineWidth = 0.5 + rnd() * 2;
    const x = rnd() * s, y = rnd() * s, l = 20 + rnd() * 60;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y - l * 0.6); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(120,170,200,0.55)"; ctx.lineWidth = 1.2;
  for (let c = 0; c < 3; c++) {
    let cx = rnd() * s, cy = rnd() * s;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    for (let j = 0; j < 4; j++) { cx += (rnd() - 0.5) * 50; cy += (rnd() - 0.5) * 50; ctx.lineTo(cx, cy); }
    ctx.stroke();
  }
  edgeShade(ctx, s, "rgba(255,255,255,0.7)");
}
function drawSand(ctx: Ctx, s: number, rnd: Rnd): void {
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s, s);
  noiseSpeckle(ctx, 2600, rnd, 0.22, "rgba(255,250,235,", "rgba(120,95,60,", s, 1.4);
}
function drawGrass(ctx: Ctx, s: number, rnd: Rnd): void {
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 60; i++) {
    const x = rnd() * s, y = rnd() * s, r = 10 + rnd() * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = (0.04 + rnd() * 0.07).toFixed(3);
    g.addColorStop(0, rnd() < 0.5 ? `rgba(255,255,200,${a})` : `rgba(20,60,20,${a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.lineWidth = 1;
  for (let b = 0; b < 1400; b++) {
    const bx = rnd() * s, by = rnd() * s;
    ctx.strokeStyle = (rnd() < 0.5 ? "rgba(30,70,25," : "rgba(235,255,210,") + (0.1 + rnd() * 0.15).toFixed(3) + ")";
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + (rnd() - 0.5) * 3, by - 3 - rnd() * 4); ctx.stroke();
  }
}
/** Tileable ripple normal map from a sum of periodic waves. */
function drawWaterNormal(ctx: Ctx, s: number, rnd: Rnd): void {
  const img = ctx.createImageData(s, s), d = img.data;
  const waves: { kx: number; ky: number; ph: number; a: number }[] = [];
  for (let i = 0; i < 7; i++) {
    waves.push({ kx: Math.round((rnd() - 0.5) * 10) || 1, ky: Math.round((rnd() - 0.5) * 10) || 2, ph: rnd() * 6.28, a: 0.4 + rnd() });
  }
  const TWO_PI = PI * 2;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let dx = 0, dy = 0;
      for (const W of waves) {
        const c = Math.cos((TWO_PI * (W.kx * x + W.ky * y)) / s + W.ph) * W.a;
        dx += c * W.kx; dy += c * W.ky;
      }
      const nx = -dx * 0.03, ny = -dy * 0.03, nz = 1;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const o = (y * s + x) * 4;
      d[o] = ((nx / l) * 0.5 + 0.5) * 255; d[o + 1] = ((ny / l) * 0.5 + 0.5) * 255; d[o + 2] = ((nz / l) * 0.5 + 0.5) * 255; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
function drawRadial(ctx: Ctx, s: number): void {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.7, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
}
function drawGlow(ctx: Ctx, s: number): void {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.12, "rgba(255,255,255,0.95)");
  g.addColorStop(0.22, "rgba(255,245,220,0.35)");
  g.addColorStop(1, "rgba(255,240,210,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
}
type TexName = "wood" | "wood-v" | "stone" | "ice" | "sand" | "grass" | "water-n" | "radial" | "glow";
/** Surface textures at the look's budget size (authored at 256 px; the water ripple map at half of it). */
function texture(name: TexName): Texture {
  const size = look!.budget.texture;
  switch (name) {
    case "wood": return canvasTex("wood", 256, drawWood, null, size);
    case "wood-v": {
      const k = `wood-v@${size}`;
      let t = texCache.get(k);
      if (!t) {
        t = texture("wood").clone();
        t.center.set(0.5, 0.5); t.rotation = PI / 2; t.needsUpdate = true;
        texCache.set(k, t);
      }
      return t;
    }
    case "stone": return canvasTex("stone", 256, drawStone, null, size);
    case "ice": return canvasTex("ice", 256, drawIce, null, size);
    case "sand": return canvasTex("sand", 256, drawSand, null, size);
    case "grass": return canvasTex("grass", 256, drawGrass, null, size);
    case "water-n": return canvasTex("water-n", 128, drawWaterNormal, { linear: true, direct: true }, Math.max(64, size / 2));
    case "radial": return canvasTex("radial", 128, drawRadial, null);
    case "glow": return canvasTex("glow", 128, drawGlow, null);
  }
}

// ---------------------------------------------------------------- materials
type Lit = MeshLambertMaterial | MeshStandardMaterial;
interface LitParams {
  color?: number | Color; emissive?: number | Color; map?: Texture | null; bumpMap?: Texture | null; bumpScale?: number;
  normalMap?: Texture | null; normalScale?: Vector2; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number;
  transparent?: boolean; opacity?: number; depthWrite?: boolean; side?: typeof DoubleSide; flatShading?: boolean;
}
/** render.js _mat: Lambert on Low, Standard on Balanced (clearcoat dropped), Physical where asked for on High/Ultra. */
function mat(p: LitParams, physical = false): Lit {
  const tier = look!.budget.material;
  const { roughness, metalness, clearcoat, clearcoatRoughness, ...base } = p;
  if (tier === "lambert") return new MeshLambertMaterial(base);
  const std = { ...base, roughness: roughness ?? 1, metalness: metalness ?? 0 };
  if (physical && tier === "physical") return new MeshPhysicalMaterial({ ...std, clearcoat: clearcoat ?? 0, clearcoatRoughness: clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(std);
}
/** Tessellation at the budget's share of the authored segment count. */
function seg(n: number, min = 3): number { return Math.max(min, Math.round(n * look!.budget.segments)); }

// ---------------------------------------------------------------- sky and reflections
function skyColors(t: Theme): { horizon: Color; zenith: Color } {
  const base = new Color(t.sky);
  // ACES desaturates bright values, so the dome is authored a little deeper and more saturated than the swatch
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  return {
    horizon: new Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), hsl.l * 0.92),
    zenith: new Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.3), hsl.l * 0.55),
  };
}
/** The dome's colour at height t (−1 … 1) of its radius: the horizon band below 0, deepening toward the zenith. */
function domeColor(col: { horizon: Color; zenith: Color }, t: number, out: Color): Color {
  if (t < 0) return out.copy(col.horizon);
  return out.copy(col.horizon).lerp(col.zenith, Math.min(1, Math.pow(t * 2.2, 0.6)));
}
function makeSkyDome(t: Theme, radius: number): Mesh {
  const col = skyColors(t);
  const geo = new SphereGeometry(radius, 32, 20);
  const pos = geo.getAttribute("position")!;
  const colors = new Float32Array(pos.count * 3), c = new Color();
  for (let i = 0; i < pos.count; i++) {
    domeColor(col, pos.getY(i) / radius, c);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  const mesh = new Mesh(geo, new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }));
  mesh.renderOrder = -10;
  return mesh;
}
const envCache = new Map<string, Texture>();
/** render.js _envFor: the dome and the sun (radius 4 at 42, colour (2.6, 2.4, 2.1)) seen from the island, as a lat-long float image. */
function envFor(t: Theme): Texture | null {
  const hit = envCache.get(t.id);
  if (hit) return hit;
  const W = 128, H = 64;
  const col = skyColors(t);
  const data = new Float32Array(W * H * 4);
  const sun = SUN_POS.clone().normalize();
  const sunCos = Math.cos(Math.asin(4 / 42));
  const c = new Color();
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * PI; // row 0 is the top (+y)
    const cy = Math.sin(lat), cr = Math.cos(lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W - 0.5) * 2 * PI; // three.js equirectUv: u = atan2(z, x) / 2π + 0.5
      const dx = Math.cos(lon) * cr, dz = Math.sin(lon) * cr;
      const o = (y * W + x) * 4;
      if (dx * sun.x + cy * sun.y + dz * sun.z >= sunCos) { data[o] = 2.6; data[o + 1] = 2.4; data[o + 2] = 2.1; }
      else { domeColor(col, cy, c); data[o] = c.r; data[o + 1] = c.g; data[o + 2] = c.b; }
      data[o + 3] = 1;
    }
  }
  try {
    const img = new DataTexture(data, W, H, RGBAFormat, FloatType);
    img.mapping = EquirectangularReflectionMapping;
    img.needsUpdate = true;
    const env = new PMREMGenerator(renderer).fromEquirectangular(img).texture;
    envCache.set(t.id, env);
    return env;
  } catch (e) {
    console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
function applyReflections(): void {
  const on = !!look && look.reflections;
  scene.environment = on ? envFor(theme) : null;
  scene.environmentIntensity = 0.55;
  hemi.intensity = on ? 0.5 : 0.8;
}

// ---------------------------------------------------------------- the look
let lookKey = "";
export function applyLook(next: Look): void {
  const k = JSON.stringify(next);
  if (k === lookKey) return;
  const prev = look;
  lookKey = k;
  look = next;
  if (!prev || prev.budget.texture !== next.budget.texture) {
    for (const [name, t] of texCache) if (!name.startsWith("radial") && !name.startsWith("glow")) { t.dispose(); texCache.delete(name); }
  }
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const b = next.budget;
  const hi = next.ao === "high";
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.9, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: hi ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8, radiusExponent: 2 },
  };
  // UnrealBloomPass(0.25, 0.3, 0.92) before the output pass (linear light): only the sun, glints and bright highlights bloom.
  renderer.bloom = next.bloom ? { strength: 0.25, radius: 0.3, threshold: 0.92, resolution: b.bloomRes } : null;
  // render.js GradeShader after the output pass (display space): a 0.18 S-curve (slope 1.09 at mid grey), saturation 1.1,
  // cool shadows / warm highlights over smoothstep(0.25, 0.85) of luma, the 0.2 vignette over smoothstep(0.4, 0.9).
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.09, saturation: 1.1, shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.96], split: [0.25, 0.85],
    vignette: { amount: 0.2, inner: 0.4, outer: 0.9 },
  } : null;
  renderer.antialias = next.antialias;
  renderer.shadowMap.enabled = next.shadows > 0;
  key.castShadow = next.shadows > 0;
  if (next.shadows > 0) key.shadow.mapSize = next.shadows;
  // scene detail, the shading model, tessellation and textures change what buildLevel makes
  if (level) buildLevel(level, lastState);
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
const motion = (): boolean => !reducedMotion && !!look && look.animated;

// ---------------------------------------------------------------- scene building
function disposeScene(): void {
  for (const g of [envGroup, gameGroup]) if (g) { disposeTree(g); scene.remove(g); }
  for (const d of arcDots) scene.remove(d);
  if (arcDots[0]) { arcDots[0].geometry.dispose(); (arcDots[0].material as Material).dispose(); }
  arcDots = [];
  for (const e of effects) { scene.remove(e.group); for (const m of e.mats) m.dispose(); }
  effects = [];
  animated = [];
  clouds = [];
  water = null;
  envGroup = gameGroup = null;
  bird = band = null; bandL = bandR = pouch = null;
  blockMeshes = []; targetMeshes = [];
}

/** Builds the whole scene for a level (round start, behind the title, a look change); `state` re-syncs it. */
export function buildLevel(lv: Level, state: State | null = null): void {
  if (!look) { level = lv; return; }
  const detailed = look.detailed;
  disposeScene();
  level = lv;
  theme = Content.THEMES.find((t) => t.id === lv.theme) ?? Content.THEMES[0]!;
  aiming = false;
  applyReflections();

  const sky = skyColors(theme);
  scene.background = sky.horizon.clone();
  scene.fog = new Fog(sky.horizon.clone(), 50, 170);

  // environment layer: sky, sun, clouds, sea, island, palms (deterministic decor stream)
  const env = new Group();
  env.name = "environment";
  const rnd = Rules.mulberry32((lv.seed ^ 0xdec0) >>> 0);

  const dome = makeSkyDome(theme, 220);
  dome.position.set(CAM.lookX, 0, 0);
  env.add(dome);

  const sun = new Sprite(new SpriteMaterial({
    map: texture("glow"), color: new Color(1.5, 1.4, 1.25), transparent: true, depthWrite: false, fog: false, blending: AdditiveBlending,
  }));
  sun.position.copy(SUN_POS);
  sun.scale.set(26, 26, 1);
  sun.renderOrder = -9;
  env.add(sun);

  // drifting clouds: clusters of soft puffs far behind the island, each merged into one mesh
  const cloudMat = new MeshLambertMaterial({ color: 0xf4f7fa, emissive: sky.horizon.clone().multiplyScalar(0.3), fog: false });
  const puffGeo = new SphereGeometry(1, seg(14, 6), seg(10, 4));
  const nClouds = detailed ? look.budget.clouds : 3;
  const puffMatrix = new Matrix4(), puffQuat = new Quaternion();
  for (let ci = 0; ci < nClouds; ci++) {
    const puffs = 4 + Math.floor(rnd() * 4), parts: BufferGeometry[] = [];
    for (let pi = 0; pi < puffs; pi++) {
      const r = 1.6 + rnd() * 1.8;
      puffMatrix.compose(new Vector3((pi - puffs / 2) * 2.0 + rnd() * 1.2, rnd() * 1.1, rnd() * 2), puffQuat, new Vector3(r * 1.3, r * 0.8, r));
      parts.push(puffGeo.clone().applyMatrix4(puffMatrix));
    }
    const merged = mergeGeometries(parts) ?? puffGeo.clone();
    for (const p of parts) p.dispose();
    const cloud = new Mesh(merged, cloudMat);
    cloud.position.set(-70 + ci * (170 / nClouds) + rnd() * 12, 6 + rnd() * 7, -105 - rnd() * 35);
    cloud.userData.speed = 0.25 + rnd() * 0.35;
    env.add(cloud);
    clouds.push(cloud);
  }
  puffGeo.dispose();

  const waterMat = mat({ color: theme.water, roughness: detailed ? 0.3 : 0.55, metalness: 0.0 });
  if (detailed && !(waterMat instanceof MeshLambertMaterial)) {
    const n = texture("water-n");
    n.repeat.set(36, 36);
    waterMat.normalMap = n;
    waterMat.normalScale = new Vector2(0.3, 0.3);
  }
  const sea = new Mesh(new PlaneGeometry(440, 440), waterMat);
  sea.rotation.x = -PI / 2; sea.position.y = -1.2;
  sea.receiveShadow = true;
  env.add(sea);
  water = sea;

  if (detailed) {
    // turquoise shallows around the island (the radial falloff as the map's alpha) and a pulsing foam line
    const shallowCol = new Color(theme.water).lerp(new Color(0x7fe6d8), 0.45);
    const shallows = new Mesh(new CircleGeometry(38, seg(64, 16)), mat({ color: shallowCol, roughness: 0.2, transparent: true, map: texture("radial"), depthWrite: false }));
    shallows.rotation.x = -PI / 2; shallows.position.set(10, -1.17, 0);
    env.add(shallows);
    const foam = new Mesh(new TorusGeometry(28.2, 0.22, seg(6, 3), seg(120, 32)), mat({ color: 0xffffff, roughness: 0.6, transparent: true, opacity: 0.8 }));
    foam.rotation.x = -PI / 2; foam.position.set(10, -1.16, 0);
    env.add(foam);
    animated.push({ obj: foam, kind: "foam", phase: 0 });
  }

  const sandMat = mat({ color: theme.sand, roughness: 0.95 });
  const grassMat = mat({ color: theme.foliage, roughness: 0.9 });
  if (detailed) {
    sandMat.map = texture("sand"); sandMat.map.repeat.set(6, 1);
    grassMat.map = texture("grass"); grassMat.map.repeat.set(5, 5);
  }
  const island = new Mesh(new CylinderGeometry(26, 30, 2.4, seg(64, 16)), sandMat);
  island.position.set(10, -1.2, 0);
  island.receiveShadow = true;
  env.add(island);
  const grassTop = new Mesh(new CylinderGeometry(24, 26, 0.25, seg(64, 16)), grassMat);
  grassTop.position.set(10, -0.12, 0);
  grassTop.receiveShadow = true;
  env.add(grassTop);

  for (let p = 0; p < 5; p++) {
    env.add(makePalm(-6 + rnd() * 4, -4 + p * 2 + rnd(), 0.8 + rnd() * 0.5, detailed, rnd));
    if (rnd() < 0.5) env.add(makePalm(20 + rnd() * 6, -5 + rnd() * 10, 0.7 + rnd() * 0.6, detailed, rnd));
  }
  if (detailed) {
    // rocks along the beach
    const rockMat = mat({ color: 0x9a968c, roughness: 0.85, flatShading: true });
    const rockGeo = new DodecahedronGeometry(1, 0);
    for (let k = 0; k < 9; k++) {
      const ang = -PI * 0.15 + rnd() * PI * 1.3;
      const rock = new Mesh(rockGeo, rockMat);
      const rs = 0.4 + rnd() * 0.9;
      rock.scale.set(rs * 1.3, rs * 0.7, rs);
      rock.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      rock.position.set(10 + Math.cos(ang) * (25.5 + rnd() * 2), -0.2, -Math.sin(ang) * (25.5 + rnd() * 2) * 0.35 - 3);
      rock.castShadow = true; rock.receiveShadow = true;
      env.add(rock);
    }
  }
  scene.add(env);
  envGroup = env;

  // gameplay layer
  const game = new Group();
  game.name = "gameplay";
  const slingMat = mat({ color: 0x7a4e28, roughness: 0.7, map: detailed ? texture("wood-v") : null });
  const trunk = new Mesh(new CylinderGeometry(0.09, 0.13, 1.6, seg(12, 6)), slingMat);
  trunk.position.set(Rules.SLING_X, 0.8, 0);
  const armL = new Mesh(new CylinderGeometry(0.07, 0.09, 0.9, seg(12, 6)), slingMat);
  armL.position.set(Rules.SLING_X - 0.22, 1.85, 0); armL.rotation.z = 0.5;
  const armR = new Mesh(new CylinderGeometry(0.07, 0.09, 0.9, seg(12, 6)), slingMat);
  armR.position.set(Rules.SLING_X + 0.22, 1.85, 0); armR.rotation.z = -0.5;
  for (const m of [trunk, armL, armR]) { m.castShadow = true; m.receiveShadow = true; game.add(m); }

  // band: two rubber strands meeting at the pouch (shown while aiming)
  const bandMat = mat({ color: 0x3a2a1a, roughness: 0.6 });
  const strandGeo = new CylinderGeometry(0.035, 0.035, 1, 6);
  strandGeo.translate(0, 0.5, 0);
  band = new Group();
  bandL = new Mesh(strandGeo, bandMat);
  bandR = new Mesh(strandGeo, bandMat);
  pouch = new Mesh(new SphereGeometry(0.16, 10, 6), bandMat);
  pouch.scale.set(0.7, 1.1, 1.2);
  band.add(bandL, bandR, pouch);
  band.visible = false;
  game.add(band);

  // bird: glossy body, belly, eye with highlight, brow, beak, crest and tail
  bird = new Group();
  const birdBody = new Group();
  bird.add(birdBody);
  const birdMat = mat({ color: theme.accent, roughness: 0.45, clearcoat: 0.7, clearcoatRoughness: 0.25 }, true);
  const body = new Mesh(new SphereGeometry(Rules.BIRD_R, seg(28, 12), seg(20, 8)), birdMat);
  body.castShadow = true;
  birdBody.add(body);
  const bellyMat = mat({ color: new Color(theme.accent).lerp(new Color(0xfff2dc), 0.6), roughness: 0.6 });
  const belly = new Mesh(new SphereGeometry(Rules.BIRD_R * 0.78, seg(18, 8), seg(12, 6)), bellyMat);
  belly.position.set(0.07, -0.1, 0.1);
  belly.scale.set(0.9, 0.75, 0.8);
  birdBody.add(belly);
  const eyeMat = mat({ color: 0xffffff, roughness: 0.3 });
  const pupilMat = mat({ color: 0x1a1a1a, roughness: 0.2 });
  const glintMat = new MeshBasicMaterial({ color: 0xffffff });
  const e1 = new Mesh(new SphereGeometry(0.095, 12, 8), eyeMat);
  e1.position.set(0.16, 0.1, 0.26);
  const p1 = new Mesh(new SphereGeometry(0.05, 10, 6), pupilMat);
  p1.position.set(0.21, 0.1, 0.33);
  const g1 = new Mesh(new SphereGeometry(0.016, 6, 4), glintMat);
  g1.position.set(0.225, 0.125, 0.375);
  const brow = new Mesh(new BoxGeometry(0.18, 0.035, 0.05), pupilMat);
  brow.position.set(0.16, 0.21, 0.27); brow.rotation.z = -0.35;
  birdBody.add(e1, p1, g1, brow);
  const beak = new Mesh(new ConeGeometry(0.085, 0.2, 10), mat({ color: 0xf0b040, roughness: 0.4 }));
  beak.rotation.z = -PI / 2; beak.position.set(0.37, 0, 0.04);
  birdBody.add(beak);
  const featherMat = mat({ color: new Color(theme.accent).multiplyScalar(0.7), roughness: 0.6 });
  for (let f = 0; f < 3; f++) {
    const tail = new Mesh(new ConeGeometry(0.05, 0.26, 6), featherMat);
    tail.position.set(-0.36, 0.02 + (f - 1) * 0.06, 0);
    tail.rotation.z = PI / 2 + (f - 1) * 0.35;
    birdBody.add(tail);
    const crest = new Mesh(new ConeGeometry(0.035, 0.16, 6), featherMat);
    crest.position.set(0.02 + (f - 1) * 0.06, 0.38, 0);
    crest.rotation.z = (1 - f) * 0.4;
    birdBody.add(crest);
  }
  bird.position.set(Rules.SLING_X, Rules.SLING_Y, 0);
  game.add(bird);
  animated.push({ obj: birdBody, kind: "bob", phase: 0 });

  // blocks: shared materials per material type (textured when detailed)
  const mats = new Map<string, Lit>();
  const blockMat = (kind: Mat, vertical: boolean): Lit => {
    const k = kind + (vertical ? "-v" : "");
    let m = mats.get(k);
    if (m) return m;
    if (kind === "ice") {
      m = mat({
        color: detailed ? 0xa6daf0 : MAT_COLORS.ice, roughness: 0.12, transparent: true, opacity: 0.86,
        clearcoat: detailed ? 1 : 0, clearcoatRoughness: 0.1, emissive: new Color(detailed ? 0x24566c : 0x1b3a48),
      }, true);
    } else if (kind === "stone") m = mat({ color: MAT_COLORS.stone, roughness: 0.88 });
    else m = mat({ color: MAT_COLORS.wood, roughness: 0.72 });
    if (detailed) {
      m.map = texture(kind === "wood" && vertical ? "wood-v" : kind);
      if (kind === "stone") { m.bumpMap = m.map; m.bumpScale = 1.5; }
    }
    mats.set(k, m);
    return m;
  };
  for (const b of lv.blocks) {
    const depth = Math.min(b.w, 1.1);
    const geo = detailed ? new RoundedBoxGeometry(b.w, b.h, depth, 2, Math.min(0.06, b.w * 0.2, b.h * 0.2)) : new BoxGeometry(b.w, b.h, depth);
    const mesh = new Mesh(geo, blockMat(b.mat, b.h > b.w * 1.2));
    mesh.position.set(b.x, b.y, 0);
    mesh.castShadow = true; mesh.receiveShadow = true;
    game.add(mesh);
    blockMeshes.push(mesh);
  }

  // targets: round critters with eyes, pupils, cheeks and a leaf sprout — shape-coded, not colour-only
  const bumbleMat = mat({ color: 0x77c04a, roughness: 0.55, clearcoat: 0.45, clearcoatRoughness: 0.35 }, true);
  const sproutMat = mat({ color: 0x3f8a2a, roughness: 0.6 });
  const cheekMat = mat({ color: 0xf29a8a, roughness: 0.7 });
  const sphW = seg(24, 12), sphH = seg(16, 8);
  lv.targets.forEach((t, ti) => {
    const g = new Group();
    const inner = new Group();
    g.add(inner);
    const bodyT = new Mesh(new SphereGeometry(t.r, sphW, sphH), bumbleMat);
    bodyT.castShadow = true; bodyT.receiveShadow = true;
    inner.add(bodyT);
    const eyeGeo = new SphereGeometry(t.r * 0.22, 10, 8), pupGeo = new SphereGeometry(t.r * 0.11, 8, 6), cheekGeo = new SphereGeometry(t.r * 0.12, 8, 6);
    for (const sx of [-1, 1]) {
      const eye = new Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * t.r * 0.3, t.r * 0.25, t.r * 0.82);
      const pup = new Mesh(pupGeo, pupilMat);
      pup.position.set(sx < 0 ? -t.r * 0.28 : t.r * 0.32, t.r * 0.24, t.r * 1.01);
      const ck = new Mesh(cheekGeo, cheekMat);
      ck.scale.set(1, 0.6, 0.4); ck.position.set(sx * t.r * 0.55, -t.r * 0.05, t.r * 0.82);
      inner.add(eye, pup, ck);
    }
    const stalk = new Mesh(new CylinderGeometry(0.018, 0.022, t.r * 0.35, 5), sproutMat);
    stalk.position.set(0, t.r * 1.1, 0);
    const leaf = new Mesh(new SphereGeometry(t.r * 0.22, 8, 6), sproutMat);
    leaf.scale.set(1.4, 0.35, 0.7); leaf.position.set(t.r * 0.18, t.r * 1.25, 0); leaf.rotation.z = 0.5;
    inner.add(stalk, leaf);
    g.position.set(t.x, t.y, 0);
    game.add(g);
    targetMeshes.push(g);
    animated.push({ obj: inner, kind: "breathe", phase: ti * 1.7, r: t.r });
  });
  scene.add(game);
  gameGroup = game;

  // the dotted arc preview: slightly over-bright so it glows softly when bloom is on
  const dotGeo = new SphereGeometry(0.075, 10, 6);
  const dotMat = new MeshBasicMaterial({ color: new Color(1.15, 1.15, 1.1), transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false });
  for (let d = 0; d < ARC_POINTS; d++) {
    const dot = new Mesh(dotGeo, dotMat);
    dot.visible = false;
    dot.scale.setScalar(1 - (d / ARC_POINTS) * 0.55);
    scene.add(dot);
    arcDots.push(dot);
  }
  if (state) sync(state);
}

/** Palm: segmented curved trunk, drooping fronds, coconuts. The crown sways. */
function makePalm(x: number, z: number, s: number, detailed: boolean, rnd: Rnd): Group {
  const g = new Group();
  const barkA = mat({ color: 0x8a6a42, roughness: 0.9 });
  const barkB = mat({ color: 0x74573a, roughness: 0.9 });
  const segs = detailed ? 6 : 1, lean = 0.12 + rnd() * 0.12;
  const top = new Vector3(0, 0, 0);
  for (let i = 0; i < segs; i++) {
    const h = (2.2 * s) / segs;
    const part = new Mesh(new CylinderGeometry(0.1 * s * (1 - i / (segs * 2.2)), 0.14 * s * (1 - i / (segs * 2.5)), h * 1.04, seg(8, 5)), i % 2 ? barkB : barkA);
    const bend = lean * (i / segs) * (i / segs) * 2.2;
    part.position.set(top.x + (Math.sin(bend) * h) / 2, top.y + (Math.cos(bend) * h) / 2, 0);
    part.rotation.z = -bend;
    part.castShadow = true;
    g.add(part);
    top.set(top.x + Math.sin(bend) * h, top.y + Math.cos(bend) * h, 0);
  }
  const crown = new Group();
  crown.position.copy(top);
  const leafMat = mat({ color: theme.foliage, roughness: 0.8, side: DoubleSide });
  const fronds = detailed ? 8 : 5;
  for (let f = 0; f < fronds; f++) {
    const ang = (f / fronds) * PI * 2 + rnd() * 0.3;
    let frond: Mesh;
    if (detailed) {
      const geo = new PlaneGeometry(0.42 * s, 1.7 * s, 1, seg(8, 4));
      const pos = geo.getAttribute("position")!;
      for (let v = 0; v < pos.count; v++) {
        const yy = pos.getY(v) / (1.7 * s) + 0.5; // 0 at base, 1 at tip
        const w = Math.sin(PI * Math.min(1, yy * 1.1)) * (1 - yy * 0.4);
        pos.setX(v, pos.getX(v) * w);
        pos.setZ(v, -yy * yy * 0.9 * s); // droop
        pos.setY(v, yy * 1.7 * s);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      frond = new Mesh(geo, leafMat);
      frond.rotation.order = "YXZ";
      frond.rotation.y = ang;
      frond.rotation.x = -1.05;
    } else {
      frond = new Mesh(new ConeGeometry(0.28 * s, 1.3 * s, 4), leafMat);
      frond.position.set(Math.cos(ang) * 0.5 * s, 0, Math.sin(ang) * 0.5 * s);
      frond.rotation.z = Math.cos(ang) * 1.2;
      frond.rotation.x = Math.sin(ang) * 1.2;
    }
    frond.castShadow = true;
    crown.add(frond);
  }
  if (detailed) {
    const nutMat = mat({ color: 0x5a3d22, roughness: 0.7 });
    for (let n = 0; n < 3; n++) {
      const nut = new Mesh(new SphereGeometry(0.1 * s, seg(8, 5), seg(6, 4)), nutMat);
      nut.position.set(Math.cos(n * 2.1) * 0.13 * s, -0.1 * s, Math.sin(n * 2.1) * 0.13 * s);
      crown.add(nut);
    }
  }
  g.add(crown);
  g.position.set(x, 0, z);
  g.rotation.y = rnd() * PI * 2;
  animated.push({ obj: crown, kind: "sway", phase: rnd() * 6.28 });
  return g;
}

// ---------------------------------------------------------------- aim, sync, effects
/** Orients a unit-height strand from a to b. */
function strand(mesh: Mesh, ax: number, ay: number, bx: number, by: number): void {
  const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy) || 0.001;
  mesh.position.set(ax, ay, 0.02);
  mesh.scale.set(1, len, 1);
  mesh.rotation.set(0, 0, Math.atan2(-dx, dy));
}
/** The approximate arc for pull vector (dx, dy) from the pouch: the pouch follows the drag, the shot leaves along the opposite vector. */
export function showAim(dx: number, dy: number): void {
  if (!bird || !band || !bandL || !bandR || !pouch) return;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.05) { hideAim(); return; }
  const pull = Math.min(len, Rules.MAX_PULL);
  const px = Rules.SLING_X + (dx / len) * pull;
  const py = Rules.SLING_Y + (dy / len) * pull;
  const vx = (Rules.SLING_X - px) * Rules.LAUNCH_POWER;
  const vy = (Rules.SLING_Y - py) * Rules.LAUNCH_POWER;
  aiming = true;
  bird.position.set(px, py, 0);
  strand(bandL, Rules.SLING_X - 0.43, Rules.SLING_Y + 0.04, px, py);
  strand(bandR, Rules.SLING_X + 0.43, Rules.SLING_Y + 0.04, px, py);
  pouch.position.set(px - 0.12, py, 0.02);
  band.visible = true;
  let x = px, y = py, tvy = vy;
  const dt = 0.07;
  for (const dot of arcDots) {
    tvy -= Rules.GRAVITY * dt; x += vx * dt; y += tvy * dt;
    if (y < 0) { dot.visible = false; continue; }
    dot.visible = true;
    dot.position.set(x, y, 0);
  }
}
export function hideAim(): void {
  aiming = false;
  if (band) band.visible = false;
  for (const d of arcDots) d.visible = false;
  if (bird) bird.position.set(Rules.SLING_X, Rules.SLING_Y, 0);
}
/** Views from a rules snapshot (rendering consumes, never mutates). While aiming the pouch owns the bird's place. */
export function sync(state: State): void {
  lastState = state;
  if (!bird) return;
  if (!aiming) bird.position.set(state.bird.x, state.bird.y, 0);
  state.blocks.forEach((b, i) => {
    const m = blockMeshes[i];
    if (!m) return;
    m.visible = b.alive;
    if (b.alive) m.position.set(b.x, b.y, 0);
  });
  state.targets.forEach((t, j) => { const g = targetMeshes[j]; if (g) g.visible = t.alive; });
}
/** A bounded, seeded impact effect. kind: impact | block | pop; mat tints debris. */
export function spawnImpact(x: number, y: number, big: boolean, m: Mat | null = null, kind?: "impact" | "block" | "pop"): void {
  if (!look || reducedMotion) return;
  const high = look.particles === "high";
  const k = kind ?? (big ? "block" : "impact");
  sharedFx ??= { spark: new SphereGeometry(1, 6, 4), chunk: new BoxGeometry(1, 1, 1), puff: new SphereGeometry(1, 12, 8) };
  const group = new Group();
  const parts: Mesh[] = [], mats: Effect["mats"] = [];
  const rnd = Rules.mulberry32(((x * 131 + y * 57) | 0) >>> 0); // seeded cosmetic variants
  const sparkMat = new MeshBasicMaterial({ color: k === "pop" ? new Color(0.9, 1.6, 0.6) : new Color(1.6, 1.45, 1.1), transparent: true, depthWrite: false });
  mats.push(sparkMat);
  const nSpark = Math.max(2, Math.round(look.budget.sparks * (k === "impact" ? 0.5 : 1) * (high ? 1 : 0.4)));
  for (let i = 0; i < nSpark; i++) {
    const p = new Mesh(sharedFx.spark, sparkMat);
    p.scale.setScalar(0.05 + rnd() * 0.06);
    p.position.set(x, y, 0.2);
    vel.set(p, { vx: (rnd() - 0.5) * 7, vy: rnd() * 5.5, g: 0.6, spin: 0, puff: false });
    group.add(p); parts.push(p);
  }
  if (high && k !== "impact") {
    const chunkMat = mat({ color: k === "pop" ? 0x5da83a : MAT_COLORS[m ?? "wood"] ?? MAT_COLORS.wood, roughness: 0.7, transparent: true });
    mats.push(chunkMat);
    for (let c = 0; c < 8; c++) {
      const ch = new Mesh(sharedFx.chunk, chunkMat);
      const cs = 0.08 + rnd() * 0.12;
      ch.scale.set(cs * (k === "pop" ? 1.8 : 1), cs * (k === "pop" ? 0.3 : 1), cs);
      ch.position.set(x + (rnd() - 0.5) * 0.4, y + (rnd() - 0.5) * 0.4, 0.2);
      vel.set(ch, { vx: (rnd() - 0.5) * 5, vy: 1 + rnd() * 4, spin: (rnd() - 0.5) * 12, g: k === "pop" ? 0.25 : 1, puff: false });
      group.add(ch); parts.push(ch);
    }
    const puffMat = new MeshBasicMaterial({ color: k === "pop" ? 0xe8ffd8 : 0xf3ead8, transparent: true, opacity: 0.5, depthWrite: false });
    mats.push(puffMat);
    const puff = new Mesh(sharedFx.puff, puffMat);
    puff.position.set(x, y, 0.1);
    puff.scale.setScalar(0.2);
    vel.set(puff, { vx: 0, vy: 0, g: 0, spin: 0, puff: true });
    group.add(puff); parts.push(puff);
  }
  scene.add(group);
  effects.push({ group, parts, mats, age: 0, life: k === "impact" ? 0.6 : 0.9 });
}
let sharedFx: { spark: BufferGeometry; chunk: BufferGeometry; puff: BufferGeometry } | null = null;

// ---------------------------------------------------------------- camera and per frame
export interface ViewRect { x: number; y: number; width: number; height: number }
let frameKey = "";
/** render.js _ensureSize: on narrower playfields (portrait phones) dolly back until the authored play area fits both axes. */
function fitCamera(view: ViewRect, w: number, h: number): void {
  camera.aspect = view.width / Math.max(1, view.height);
  const tanHalfV = Math.tan((CAM.fov * PI) / 360);
  const dist = Math.max(CAM.z, CAM.halfWidth / (tanHalfV * camera.aspect), CAM.halfHeight / tanHalfV);
  camera.position.set(CAM.lookX, CAM.y, dist);
  camera.lookAt(CAM.lookX, CAM.lookY, 0);
  camera.setViewOffset(view.width, view.height, -view.x, -view.y, w, h);
  camera.updateProjectionMatrix();
}
/** Whether the island draws (always: it is the backdrop of every menu too). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

/** Each frame: the framing for the window and the playfield (window px), effects and ambient motion. */
export function update(dt: number, w: number, h: number, view: ViewRect): void {
  const fk = `${w}x${h}:${Math.round(view.x)}:${Math.round(view.y)}:${Math.round(view.width)}:${Math.round(view.height)}`;
  if (w > 0 && h > 0 && view.width > 0 && view.height > 0 && fk !== frameKey) {
    frameKey = fk;
    fitCamera(view, w, h);
  }
  dt = Math.min(0.1, dt);
  time += dt;
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i]!;
    e.age += dt;
    const k = Math.max(0, 1 - e.age / e.life);
    for (const p of e.parts) {
      const u = vel.get(p)!;
      if (u.puff) { p.scale.setScalar(0.2 + (1 - k) * 1.3); continue; }
      u.vy -= Rules.GRAVITY * dt * u.g;
      p.position.x += u.vx * dt;
      p.position.y += u.vy * dt;
      if (u.spin) { p.rotation.z += u.spin * dt; p.rotation.x += u.spin * 0.6 * dt; }
    }
    e.mats[0]!.opacity = k;
    if (e.mats[1]) e.mats[1].opacity = Math.min(1, k * 2);
    if (e.mats[2]) e.mats[2].opacity = 0.5 * k;
    if (e.age >= e.life) {
      scene.remove(e.group);
      for (const m of e.mats) m.dispose();
      effects.splice(i, 1);
    }
  }
  // ambient motion (off under reduced motion or a static background)
  if (!motion()) return;
  const t = time;
  for (const an of animated) {
    const o = an.obj;
    if (an.kind === "sway") { o.rotation.z = Math.sin(t * 0.9 + an.phase) * 0.05; o.rotation.x = Math.cos(t * 0.7 + an.phase) * 0.03; }
    else if (an.kind === "breathe") { const sc = 1 + Math.sin(t * 2.1 + an.phase) * 0.035; o.scale.set(1 / Math.sqrt(sc), sc, 1 / Math.sqrt(sc)); o.position.y = (sc - 1) * an.r!; }
    else if (an.kind === "bob") o.position.y = aiming ? 0 : Math.sin(t * 2.4) * 0.025;
    else if (an.kind === "foam") {
      const fm = (o as Mesh<MeshStandardMaterial | MeshLambertMaterial>).material;
      fm.opacity = 0.55 + Math.sin(t * 1.3) * 0.25;
      o.scale.setScalar(1 + Math.sin(t * 1.3) * 0.004);
    }
  }
  const n = water && water.material instanceof MeshStandardMaterial ? water.material.normalMap : null;
  if (n) n.offset.set(t * 0.012, t * 0.007);
  for (const cl of clouds) {
    cl.position.x += (cl.userData.speed as number) * dt;
    if (cl.position.x > 110) cl.position.x = -90;
  }
}
