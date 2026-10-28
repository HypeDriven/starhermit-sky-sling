// The browser build's pure scripts, shared with the Node tests and the dev
// server, evaluated as classic scripts (their globals are SkySling.*): the
// rules (rules.js: fixed-step slingshot physics, legal actions, scoring,
// hashes and replays), the content (content.js: the 45 Journey stages, the
// lessons, the Daily, the themes), the session (session.js: mode
// orchestration, undo, achievements, progression), the progress document and
// the game's options (progress.js), the string tables (locales/*.js through
// i18n.js) and the account strings (sh-strings.js).
import { loadClassic } from "starhermit:script";

for (const f of [
  "rules.js", "content.js", "session.js", "progress.js",
  "locales/en-GB.js", "locales/es.js", "locales/de.js", "locales/fr.js", "locales/pt.js", "locales/it.js",
  "i18n.js", "sh-strings.js",
]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export type Mat = "wood" | "stone" | "ice";
export interface BlockDef { x: number; y: number; w: number; h: number; mat: Mat }
export interface TargetDef { x: number; y: number; r: number }
export interface Level {
  id: string; version: number; index: number; seed: number; shots: number; par: number; blocks: BlockDef[]; targets: TargetDef[];
  theme: string; tutorial: { step: number; text: string } | null; mastery: boolean; dailyKey?: number;
}
export interface Block extends BlockDef { id: number; hp: number; alive: boolean; vy: number; falling: boolean }
export interface Target extends TargetDef { id: number; alive: boolean }
export interface State {
  version: number; seed: number; index: number; shots: number; shotsUsed: number; tick: number;
  phase: "aim" | "flight" | "over"; over: boolean; won: boolean; reason: string; invalidActions: number;
  bird: { x: number; y: number; vx: number; vy: number; active: boolean };
  blocks: Block[]; targets: Target[]; destroyedBlocks: number; destroyedTargets: number;
}
export interface Score { targets: number; blocks: number; shotsBonus: number; total: number }
export interface Theme { id: string; name: string; sky: number; water: number; sand: number; foliage: number; accent: number }
export interface Progress {
  v: number; sum: string; stars: Record<string, number>; bestScores: Record<string, number>; achievements: Record<string, boolean>;
  counters: { launches: number; clears: number; streak: number }; dailyExcluded: (string | number)[];
}
export interface Options { leftHanded: boolean; timingAssist: boolean }
export interface Result {
  won: boolean; reason: string; score: Score; invalidActions: number; ticks: number; shotsUsed: number; shots: number; ranked: boolean;
}
export type Screen = "boot" | "title" | "mode-select" | "active" | "resolving" | "paused" | "results";
export type SimEvent =
  | { type: "impact"; id: number; dmg: number } | { type: "block-down"; id: number; mat: Mat } | { type: "target-down"; id: number }
  | { type: "win" } | { type: "lose" } | { type: "settled" };
export type SessionEvent =
  | { type: "sim"; sim: SimEvent } | { type: "results"; result: Result } | { type: "achievement"; key: string }
  | { type: "progress"; progress: Progress } | { type: "screen"; from: Screen; to: Screen; reason: string }
  | { type: "invalid"; reason: string } | { type: "launch"; vx: number; vy: number } | { type: "undo" }
  | { type: "settings" } | { type: "round-start"; mode: string; level: Level };
export interface Session {
  screen: Screen; mode: string | null; level: Level | null; state: State | null; snapshots: string[]; progress: Progress; ranked: boolean;
  on(fn: (e: SessionEvent) => void): void;
  setScreen(screen: Screen, reason?: string): void;
  startRound(mode: string, ref?: number | Date): { ok: boolean; reason?: string };
  legal(): { canLaunch: boolean; reason: string };
  launch(cmdId: string, vx: number, vy: number): { ok: boolean; reason?: string };
  tick(): SimEvent[];
  skip(): void;
  undo(): { ok: boolean; reason?: string };
  pause(): void;
  resume(): void;
}

interface RulesApi {
  RULES_VERSION: number; GRAVITY: number; STEP: number; SLING_X: number; SLING_Y: number; BIRD_R: number;
  MAX_PULL: number; LAUNCH_POWER: number; MAX_SPEED: number;
  mulberry32(seed: number): () => number;
  computeScore(s: State): Score;
}
interface ContentApi {
  CONTENT_VERSION: number; LEVEL_COUNT: number; THEMES: Theme[]; LESSONS: { id: string; levelIndex: number; title: string; text: string }[];
  getLevel(i: number): Level | null;
}
interface SessionApi {
  Session: new () => Session;
  ACHIEVEMENTS: { key: string; name: string; desc: string }[];
}
interface ProgressApi {
  DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[];
  emptyProgress(): Progress; normalizeProgress(raw: unknown): Progress; mergeProgress(remote: unknown, local: unknown): Progress;
  same(a: unknown, b: unknown): boolean; readForeign(text: string | null): Progress | null;
  pickOption(key: string, v: unknown): boolean | undefined;
}
interface I18nApi {
  LOCALES: string[];
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): void;
  getLang(): string;
}
export interface AccountStrings {
  signIn: string; invite: string; copied: string; copyFailed: string; signedOut: string;
  lbPosting: string; lbRank: string; lbPosted: string; lbNotPosted: string;
}

const SS = (globalThis as unknown as {
  SkySling: {
    rules: RulesApi; content: ContentApi; session: SessionApi; progress: ProgressApi; i18n: I18nApi;
    shStrings: { strings(lang: string): AccountStrings };
  };
}).SkySling;
export const Rules = SS.rules;
export const Content = SS.content;
export const SessionMod = SS.session;
export const Prog = SS.progress;
export const I18n = SS.i18n;
export const ShStrings = SS.shStrings;
