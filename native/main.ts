// Sky Sling on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (rules.js), the content (content.js)
// and the session (session.js: modes, undo, achievements, progression) are
// the browser build's, unchanged in what they decide; this module is what
// boot.js did around them — the actions behind every button, starting each
// mode (Learn, Journey, Daily, Practice, Challenge), launches with their
// action identifiers (a repeated commit is rejected), the slingshot drag by
// mouse or finger and the keyboard / pad aim, fast-forward, undo in
// Practice, pause, the results with the leaderboard post and the board's top
// ten, the sound captions and announcements, and the lifecycle (a hidden
// window pauses the round, as visibilitychange did). Screens are drawn by
// screens.ts (starhermit:ui), the island by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: a shot resolves one rules tick (1/60 s,
// two 1/120 s physics steps) per fixed step while it is in flight (boot.js
// counted ticks from wall time between frames), so a paused game, a hidden
// window and slow frames never change a shot and play scripts replay exactly.
import "./classic.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { isDown, onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Rules, SessionMod, type Result, type SessionEvent } from "./classic.ts";
import * as audio from "./audio.ts";
import { N, S, T, reasonText, type Vars } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, keysFor } from "./screens.ts";
import { applyPalette, initStyles } from "./style.ts";

export type Overlay = "title" | "modes" | "stages" | "help" | "pause" | "settings" | "results";
export const session = new SessionMod.Session();

export const app = {
  /** The open panel (ui.js show(id): one at a time). */
  overlay: "title" as Overlay | null,
  /** Frame the panel opened on (the press that opened it must not also act on it). */
  openedFrame: -1,
  focusNext: null as string | null,
  gridMode: "journey" as "journey" | "practice",
  /** The bottom bar's line (#hint-text): the round's hint, a sound caption or the keyboard aim. */
  hint: { key: "", vars: null as Vars | null },
  results: null as { result: Result; stars: number | null; note: string } | null,
  /** English achievement name of the last unlock this round (#res-achievement). */
  achievement: null as string | null,
  lb: null as platform.Posted | "posting" | null,
  /** Signed in: the board's top ten for the results (undefined: loading, null: none). */
  board: undefined as platform.Row[] | null | undefined,
  toast: null as { text: () => string; until: number } | null,
};
const now = (): number => frame().time;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ helpers
let pendingAnnounce: string[] = [];
/** The live region (#live): at most one announcement a frame, flushed in onRender. */
export function announce(text: string): void { const t = text.trim(); if (t) pendingAnnounce.push(t); }
export function toast(text: () => string): void { app.toast = { text, until: now() + 3.2 }; announce(text()); }
export function setHint(key: string, vars: Vars | null = null): void { app.hint = { key, vars }; }
/** audio.js play(name) with its caption cue in the hint line (no audio-only gameplay). */
export function sfx(kind: audio.Sfx): void {
  audio.play(kind);
  const c = audio.CAPTIONS[kind];
  if (c) setHint(c);
}
/** ui.js show(id): one panel, focus on its first control. */
export function show(o: Overlay | null, focus: string | null = null): void {
  app.overlay = o;
  app.openedFrame = frame().frame;
  app.focusNext = o ? focus : null;
  ui.setFocus(null);
}
/** Which panel a modal (help / settings) returns to (boot.js overlayForScreen). */
export function overlayForScreen(): Overlay | null {
  if (session.screen === "paused") return "pause";
  if (session.screen === "results") return "results";
  if (session.screen === "active" || session.screen === "resolving") return null;
  return "title";
}
export const inRound = (): boolean => session.screen === "active" || session.screen === "resolving";

// ------------------------------------------------------------------ rounds (boot.js startRound)
let lastLaunchCmd: string | null = null;
/** Keyboard aim: the velocity the arrows adjust. */
export const kbAim = { active: false, vx: 9, vy: 7 };
let held: Record<string, number> = {};
export function startRound(mode: string, ref?: number): void {
  const res = session.startRound(mode, mode === "daily" ? platform.today() : ref);
  if (!res.ok) { toast(() => reasonText(res.reason)); return; }
  lastLaunchCmd = null;
  kbAim.active = false;
  held = {};
  app.achievement = null;
  app.results = null;
  drag = null;
  render.buildLevel(session.level!, session.state);
  render.hideAim();
  show(null);
  renderRoundHints();
  const tut = session.level!.tutorial;
  if (tut) announce(T("Lesson: {text}", { text: T(tut.text) }));
}
function renderRoundHints(): void {
  const tut = session.level && session.level.tutorial;
  setHint(tut ? tut.text : N("Drag to aim, release to launch"));
}
export function journeyNext(): number {
  let next = 0;
  for (let i = 0; i < Content.LEVEL_COUNT; i++) if (session.progress.stars[i]) next = i + 1;
  return Math.min(next, Content.LEVEL_COUNT - 1);
}
function toTitle(): void {
  session.setScreen("title", "nav");
  show("title", "btn-play");
}

// ------------------------------------------------------------------ actions (boot.js actions)
export const actions = {
  play(): void { audio.play("ui"); startRound("journey", journeyNext()); },
  daily(): void { audio.play("ui"); startRound("daily"); },
  journey(): void { audio.play("ui"); openGrid("journey"); },
  learn(): void { audio.play("ui"); startRound("learn", 0); },
  practice(): void { audio.play("ui"); openGrid("practice"); },
  challenge(): void { audio.play("ui"); startRound("challenge", 12); },
  settings(): void { audio.play("ui"); show("settings", "btn-settings-done"); },
  closeSettings(): void { audio.play("ui"); show(overlayForScreen(), "btn-play"); },
  help(): void { audio.play("ui"); show("help", "btn-help-close"); },
  closeHelp(): void { audio.play("ui"); show(overlayForScreen(), "btn-play"); },
  resume(): void { audio.play("ui"); session.resume(); show(null); },
  restart(): void { audio.play("ui"); startRound(session.mode || "journey", session.level ? session.level.index : 0); },
  next(): void {
    audio.play("ui");
    const lv = session.level;
    const idx = lv ? lv.index + 1 : 0;
    if (session.mode === "learn") {
      const lesson = Number((/lesson-(\d)/.exec(lv!.id) ?? [0, 0])[1]) | 0;
      if (lesson < Content.LESSONS.length) { startRound("learn", lesson); return; }
      toTitle(); return;
    }
    if (idx >= Content.LEVEL_COUNT) { toTitle(); return; }
    startRound(session.mode === "daily" ? "journey" : session.mode!, idx);
  },
  quitTitle(): void { audio.play("ui"); render.hideAim(); toTitle(); },
  backTitle(): void { audio.play("ui"); toTitle(); },
  backModes(): void { audio.play("ui"); show("modes", "mode-learn"); },
  pause(): void {
    if (!inRound()) return;
    audio.play("ui");
    drag = null;
    render.hideAim();
    session.pause();
    show("pause", "btn-resume");
  },
  undo(): void {
    const r = session.undo();
    if (!r.ok) { announce(T("Undo not available here.")); sfx("invalid"); return; }
    lastLaunchCmd = null; // the restored state can re-issue the same launch identifier
    render.sync(session.state!);
    announce(T("Shot undone."));
  },
  skip(): void {
    if (session.screen !== "resolving") return;
    session.skip();
    if (session.state) render.sync(session.state);
  },
};
function openGrid(mode: "journey" | "practice"): void {
  app.gridMode = mode;
  session.setScreen("mode-select", `${mode}-grid`);
  show("stages", "stage-1");
}
/** Practice undo is offered (boot.js setUndoEnabled). */
export function undoEnabled(): boolean { return session.mode === "practice" && session.snapshots.length > 0 && session.screen === "active"; }

// ------------------------------------------------------------------ launches (boot.js doLaunch)
function doLaunch(vx: number, vy: number): void {
  const s = session.state;
  if (!s) return;
  // derived from the round state, not a counter, so a repeated commit of the same shot is rejected
  const id = `launch-${s.shotsUsed}-${s.tick}`;
  if (id === lastLaunchCmd) return;
  const res = session.launch(id, vx, vy);
  if (res.ok) {
    lastLaunchCmd = id;
    render.hideAim(); // hand the bird back to the simulation
    sfx("launch");
    announce(T("Launched."));
    try { vibrate(15); } catch { /* none */ }
  } else {
    sfx("invalid");
    announce(T("Cannot launch: {reason}", { reason: reasonText(res.reason) }));
  }
}
/** Arrow keys / pad: adjust the keyboard aim (boot.js wireKeyboard). */
function aimStep(a: string): void {
  if (session.screen !== "active" || app.overlay || !session.legal().canLaunch) return;
  const step = platform.options.timingAssist ? 0.25 : 0.5;
  if (a === "aim_left") kbAim.vx = Math.max(1, kbAim.vx - step);
  else if (a === "aim_right") kbAim.vx = Math.min(Rules.MAX_SPEED * 0.9, kbAim.vx + step);
  else if (a === "aim_up") kbAim.vy = Math.min(Rules.MAX_SPEED * 0.9, kbAim.vy + step);
  else if (a === "aim_down") kbAim.vy = Math.max(-4, kbAim.vy - step);
  kbAim.active = true;
  ui.setFocus(null);
  render.showAim(-kbAim.vx / Rules.LAUNCH_POWER, -kbAim.vy / Rules.LAUNCH_POWER);
  setHint(N("Aim: vx {vx}, vy {vy} — {key} to launch"), { vx: kbAim.vx.toFixed(1), vy: kbAim.vy.toFixed(1), key: keysFor("launch") });
}
const AIMS = ["aim_left", "aim_right", "aim_up", "aim_down"];
onAction((e) => {
  if (ui.capturingKeys()) return;
  const a = e.action;
  if (!e.pressed) { delete held[a]; return; }
  if (a === "pause") {
    if (!fresh()) return;
    if (session.screen === "paused") { if (app.overlay === "pause") actions.resume(); return; }
    if (inRound() && !app.overlay) actions.pause();
    return;
  }
  if (app.overlay) return;
  // fast-forward is only meaningful while a shot is resolving
  if (a === "skip") { actions.skip(); return; }
  if (session.screen !== "active") return;
  if (a === "restart") { actions.restart(); return; }
  if (a === "undo") { actions.undo(); return; }
  if (!session.legal().canLaunch) return;
  if (AIMS.includes(a)) { held[a] = 0; aimStep(a); return; }
  if (a === "launch" && kbAim.active) { ui.setFocus(null); doLaunch(kbAim.vx, kbAim.vy); kbAim.active = false; }
});

// ------------------------------------------------------------------ the slingshot drag (boot.js wirePointer)
/** Rectangles (window pixels) where a press belongs to the HUD, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
/** The playfield (window pixels), set by screens.ts. */
export const view: render.ViewRect = { x: 0, y: 0, width: 1, height: 1 };
const inView = (x: number, y: number): boolean => x >= view.x && y >= view.y && x <= view.x + view.width && y <= view.y + view.height;
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number };
const events: PEvent[] = [];
let lastTouch = -1e9;
let drag: { id: number; sx: number; sy: number; cx: number; cy: number } | null = null;
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  events.push({ kind: e.phase === "start" ? "down" : e.phase === "end" ? "up" : e.phase === "move" ? "move" : "cancel", x: e.x, y: e.y, id: e.id });
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1 });
});
onPointerMove((x, y) => { if (drag && drag.id === -1 && now() - lastTouch >= 0.6) events.push({ kind: "move", x, y, id: -1 }); });
/** Pixel drag → world pull: the playfield is about 14 m tall on screen. */
function toPull(d: { sx: number; sy: number; cx: number; cy: number }): { dx: number; dy: number } {
  const mpp = 14 / Math.max(1, view.height);
  return { dx: (d.cx - d.sx) * mpp, dy: -(d.cy - d.sy) * mpp };
}
function pointerInput(): void {
  for (const ev of events.splice(0)) {
    if (ev.kind === "down") {
      if (drag || app.overlay || session.screen !== "active" || !session.legal().canLaunch || !inView(ev.x, ev.y) || onHud(ev.x, ev.y)) continue;
      ui.setFocus(null);
      drag = { id: ev.id, sx: ev.x, sy: ev.y, cx: ev.x, cy: ev.y };
      kbAim.active = false;
      sfx("drag");
      continue;
    }
    if (!drag || drag.id !== ev.id) continue;
    drag.cx = ev.x; drag.cy = ev.y;
    const p = toPull(drag);
    if (ev.kind === "move") { render.showAim(p.dx, p.dy); continue; }
    drag = null;
    render.hideAim();
    const pull = Math.sqrt(p.dx * p.dx + p.dy * p.dy);
    if (ev.kind === "cancel" || pull < 0.3 || session.screen !== "active") continue; // a tap, not a launch
    // velocity: opposite the drag on both axes (pull back and down to send the shot forward and up)
    const scale = Math.min(pull, Rules.MAX_PULL) / pull;
    doLaunch(-p.dx * scale * Rules.LAUNCH_POWER, -p.dy * scale * Rules.LAUNCH_POWER);
  }
}

// ------------------------------------------------------------------ session events (boot.js wireSession)
session.on((evt: SessionEvent) => {
  if (evt.type === "sim") {
    const s = evt.sim, st = session.state!;
    if (s.type === "impact") { sfx("impact"); render.spawnImpact(st.bird.x, st.bird.y, false); }
    else if (s.type === "block-down") {
      sfx(s.mat === "stone" ? "stone" : "wood");
      const b = st.blocks.find((x) => x.id === s.id) ?? st.bird;
      render.spawnImpact(b.x, b.y, true, s.mat, "block");
    } else if (s.type === "target-down") {
      sfx("target");
      announce(T("Target down!"));
      const t = st.targets.find((x) => x.id === s.id);
      if (t) render.spawnImpact(t.x, t.y, true, null, "pop");
    } else if (s.type === "win") sfx("win");
    else if (s.type === "lose") sfx("lose");
  } else if (evt.type === "results") onResults(evt.result);
  else if (evt.type === "achievement") {
    const meta = SessionMod.ACHIEVEMENTS.find((a) => a.key === evt.key);
    if (meta) { app.achievement = meta.name; announce(T("Achievement unlocked: {name}", { name: T(meta.name) })); }
  } else if (evt.type === "progress") platform.saveProgress(session.progress);
  else if (evt.type === "screen" && evt.to === "active" && app.overlay === null) show(null);
});

function onResults(result: Result): void {
  if (session.state) render.sync(session.state);
  // stars are a journey-progression reward; other modes show none
  const stars = result.won && session.mode === "journey" ? session.progress.stars[session.level!.index] || 1 : null;
  app.lb = null;
  app.board = undefined;
  app.results = { result, stars, note: session.mode === "practice" ? N("Practice — unranked.") : "" };
  if (platform.signedIn() && /^(journey|daily|challenge)$/.test(session.mode ?? "")) {
    // Signed in: post the run to the platform high-score board (score-script.js), then show the top ten.
    app.lb = "posting";
    const r = app.results;
    void platform.postScore(result.score.total).then((res) => {
      if (app.results !== r) return;
      app.lb = res;
      void platform.topTen().then((rows) => { if (app.results === r) app.board = rows; });
    });
  } else app.board = null;
  show("results", result.won ? "btn-next" : "btn-retry");
  announce(result.won ? T("Stage clear. Score {n}.", { n: result.score.total }) : T("Out of shots. Score {n}.", { n: result.score.total }));
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}

export const account = {
  signIn(): void { void requestSignIn().catch(() => undefined); },
  invite(): void {
    const link = platform.inviteLink();
    if (!link) return;
    try { clipboard.writeText(link); toast(() => S("copied")); } catch { toast(() => `${S("copyFailed")}: ${link}`); }
  },
};

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  if (session.screen === "resolving") session.tick();
  // held aim keys repeat after half a second, 30 a second (the browser's key repeat)
  for (const a of Object.keys(held)) {
    if (!isDown(a)) { delete held[a]; continue; }
    const n = ++held[a]!;
    if (n >= 30 && n % 2 === 0) aimStep(a);
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  session.progress = platform.progress();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  // scenic backdrop behind the title until a round starts
  render.buildLevel(Content.getLevel(0)!);
  render.setActive(true);
  toTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
// cloud progress merged in (another device, the browser build's slot): the session plays on with it
platform.onProgressMerged(() => { session.progress = platform.progress(); });
onSessionEnded(() => toast(() => S("signedOut"))); // keep playing locally
onSuspend(() => {
  hidden = true;
  // backgrounding pauses solo simulation, and says so (resumable from the pause panel)
  if (inRound() && !app.overlay) actions.pause();
  platform.flush();
});
onResume(() => { hidden = false; });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyPalette(ui.preferences().highContrast);
  audio.update();
  if (app.toast && app.toast.until < now()) app.toast = null;
});
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
onRender(() => {
  hudRects.length = 0;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput();
  if (session.state) render.sync(session.state);
  const f = frame();
  render.update(frameDt, f.width, f.height, view);
  if (pendingAnnounce.length) {
    try { ui.announce(pendingAnnounce.join(" ").slice(0, 500)); } catch { /* next frame */ }
    pendingAnnounce = [];
  }
});
