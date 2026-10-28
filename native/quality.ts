// The look per graphics level: the browser build's four presets and budgets
// (gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the impact sparks scaled within the tier by the level (frame().levelIndex,
// at most 2×, capped at 56), as the browser build scaled them by its hardware
// level. The runtime owns the rest of what the old Graphics section did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and its readout. The old section's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number; aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "high", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", segments: 0.5, texture: 128, clouds: 3, sparks: 10, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", segments: 0.75, texture: 256, clouds: 6, sparks: 16, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", segments: 1, texture: 256, clouds: 8, sparks: 20, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", segments: 1.5, texture: 512, clouds: 10, sparks: 28, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 56;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the level above the tier's first, at most 2× (gfx.js budgetFor).
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  return { preset, ...TABLE[preset], budget: b };
}
