// The look per graphics level. The engine owns its effects: shadows and their
// map size, ambient occlusion, bloom, the grade and anti-aliasing come from
// levelSettings(). The game keeps its art (gfx.js BUDGETS and the rest of its
// TABLE) keyed by the runtime's quality tier, with the impact sparks scaled
// within the tier by the level's particle budget (at most 2×). The runtime owns
// the rest of what the old Graphics panel did: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// readout. The old panel's per-effect overrides are not offered.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Scene shading: Lambert (Low), Standard (Balanced), clear-coated Physical bird, critters and ice (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Sphere / cylinder / torus tessellation as a share of the authored counts. */
  segments: number;
  /** Procedural wood / stone / ice / sand / grass texture size in px. */
  texture: number;
  /** Drifting cloud clusters (Detailed). */
  clouds: number;
  /** Sparks per big hit at Particles high. */
  sparks: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "high";
  /** Background animated: palms sway, critters breathe, clouds drift, the water ripples. */
  animated: boolean;
  /** Scene detail Detailed: textures, rounded blocks, shallows, foam, rocks, segmented palms. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "particles" | "animated" | "detailed">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, particles: "high", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", segments: 0.5, texture: 128, clouds: 3, sparks: 10 },
  balanced: { material: "standard", segments: 0.75, texture: 256, clouds: 6, sparks: 16 },
  high: { material: "physical", segments: 1, texture: 256, clouds: 8, sparks: 20 },
  ultra: { material: "physical", segments: 1.5, texture: 512, clouds: 10, sparks: 28 },
};
/** Each tier's anchor level: its budgets are at this level's particle count. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPARK_MAX = 56;

/** The look for a graphics level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
