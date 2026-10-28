// The game's data and the StarHermit platform, on the runtime's modules
// (what platform.js did over the JS SDK):
// - the save (starhermit:storage `saves`, on the device and in the player's
//   cloud slot) is { progress }, the browser build's checksummed progress
//   document (progress.js); two devices' saves merge on a conflict through
//   progress.js mergeProgress, as the browser build's saveconflict handler
//   did (session.adoptProgress); the slot the browser build wrote (the JS
//   SDK's game:<slug> doc: that progress document) shows as foreign: it is
//   merged in and the slot replaced once;
// - the game's own options (leftHanded, timingAssist) are engine `settings`
//   (same keys, synced with the account); the browser build's values in the
//   account's settings KV are adopted (unless set here since), then its KV
//   keys are removed (volumes, graphics, reduced motion, contrast, text size
//   and haptics are the runtime's Options);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   finished ranked run's total through score-script.js (a practice session
//   whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did) with the rank, and the board's top ten.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Prog, type Options, type Progress } from "./classic.ts";

type Key = keyof Options;

// --- the game's options --------------------------------------------------------------------
export const options: Options = { ...Prog.DEFAULT_OPTIONS };
const listeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { listeners.add(fn); }
function changed(): void { for (const fn of listeners) fn(); }
function readOption(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Prog.pickOption(key, v);
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends Key>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as unknown as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  changed();
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: string, value: unknown): void {
  const v = Prog.pickOption(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as unknown as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    changed();
  } catch { /* keep the device's */ }
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const k of keys) if ((Prog.OPTION_KEYS as string[]).includes(k)) adoptOption(k, store.legacy(k));
  for (const k of keys) if (Prog.BROWSER_KEYS.includes(k)) store.removeLegacy(k);
}

// --- the save ------------------------------------------------------------------------------
let data: Progress = Prog.emptyProgress();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }
const docOf = (p: Progress): JsonValue => ({ progress: p as unknown as JsonValue });
const progressOf = (d: unknown): unknown => (d && typeof d === "object" ? (d as { progress?: unknown }).progress : null);

function persist(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(docOf(data), { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** The progress document (the session's own copy: it changes it, then saveProgress()). */
export function progress(): Progress { return data; }
/** The session saved its progress document (session.js _saveProgress): store it. */
export function saveProgress(p: Progress): void { data = p; persist(); }

/** Merges another progress document into the live one; whether anything changed (then saved). */
function adopt(other: unknown): boolean {
  const next = Prog.mergeProgress(other, data);
  if (Prog.same(next, data)) return false;
  data = next;
  persist();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: docOf(Prog.mergeProgress(progressOf(remote.data), progressOf(mine?.data ?? null))) }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(progressOf(cur.data))) merged();
  }
});
/** The browser build's cloud doc: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Prog.readForeign(old.text);
  let grew = false;
  if (doc) {
    const next = Prog.mergeProgress(doc, data);
    grew = !Prog.same(next, data);
    data = next;
  }
  persist({ replaceForeign: true });
  if (grew) merged();
}

/** For the top bar's sync line (ui.js setSyncStatus): local (a guest) | saving | synced | offline. */
export function syncState(): "local" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  data = Prog.normalizeProgress(progressOf(cur?.data ?? null));
  for (const k of Prog.OPTION_KEYS) readOption(k);
  store.onChange((k) => {
    if (!(Prog.OPTION_KEYS as string[]).includes(k)) return;
    readOption(k as Key);
    changed();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  changed();
  refreshPlayer();
  void serverTime().then(() => { synced = true; }, () => undefined);
}

// --- the player and the clock ------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

let synced = false;
/** Whether the platform's clock answered (the Daily's day follows it, else the device's). */
export function clockSynced(): boolean { return synced; }
/** Now (ms) by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  let ms = Date.now();
  try { ms = serverNow() ?? ms; } catch { /* device clock */ }
  return ms;
}
/** Today by the platform's clock (content.js makeDaily takes the UTC day of it). */
export function today(): Date { return new Date(nowMs()); }

// --- the high-score board ----------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
export interface Row { rank: number; name: string; score: number }

/** Signed in only: post a finished ranked run's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

/** The board's top ten (boot.js showHostedBoard); null when unavailable or signed out. */
export async function topTen(): Promise<Row[] | null> {
  if (!player()) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 10 });
    return r.items.slice(0, 10).map((e, i) => ({ rank: e.rank ?? i + 1, name: e.displayName || e.username || "", score: Number.isFinite(e.score) ? e.score : 0 }));
  } catch { return null; }
}
