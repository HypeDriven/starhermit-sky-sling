// Sound, as the browser build's audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json: one or two clips per event, the
// variant picked by audio.js's seeded stream) on the effects bus and the
// menu clicks on the interface bus; the gentle island pad (triangle blips C E
// G C' G E, one every 0.9 s, 0.08 s up to 0.10, down to 0.001 at 1.4 s) and
// the soft sea wind (sines at 82 and 83.7 Hz at 0.06 with a slow swell of
// ±0.03) from the first press on. The browser build ran both live (a timer
// scheduler and oscillators); here they are rendered once into loops
// (createClip, a slice a frame on a sine table) and played on the music bus:
// the runtime has no ambience bus, so the wind's gain folds in the old
// ambience slider's 50 % default against music's 60 %, and its swell is
// 0.1 Hz (0.13 Hz in the browser) so the 10 s loop joins. The oscillator
// blips audio.js synthesized while a sample decoded are not ported (a live
// synthesis graph makes clip loads fail on the engine's web runtime), so a
// clip still loading is silent. The runtime's Options own the volumes, the
// mute and the voice limit. Clips load once the mixer runs (natively at once,
// in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { files } from "starhermit:engine";

export type Sfx = "drag" | "launch" | "impact" | "wood" | "stone" | "target" | "win" | "lose" | "invalid" | "ui";
/** audio.js caption cues (English keys, shown in the hint line). */
export const CAPTIONS: Partial<Record<Sfx, string>> = {
  drag: "aiming", launch: "whoosh", impact: "impact", target: "target down", win: "stage clear", lose: "out of shots", invalid: "not allowed",
};
const byEvent = new Map<string, string[]>();
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let variantSeed = 12345;
/** audio.js _variant(): the deterministic variant stream. */
function variant(): number {
  variantSeed = (Math.imul(variantSeed, 1103515245) + 12345) & 0x7fffffff;
  return variantSeed / 0x7fffffff;
}

/** Reads the manifest; the clips load once the mixer runs (see update). */
export function loadSfx(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name: string; event: string }[];
    for (const it of list) {
      if (!it || typeof it.name !== "string" || typeof it.event !== "string") continue;
      byEvent.set(it.event, [...(byEvent.get(it.event) ?? []), it.name]);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  wantClips = true;
}

/** audio.js play(name): one of the event's clips. */
export function play(kind: Sfx): void {
  const names = byEvent.get(kind);
  if (!names || !names.length) return;
  const name = names[Math.floor(variant() * names.length) % names.length]!;
  const clip = clips.get(name);
  if (!clip) return;
  const bus: Bus = kind === "ui" ? "interface" : "effects";
  try { playClip(clip, { bus }); }
  catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); } // a clip the mixer lost: load it again
}

// -- the pad and the wind ---------------------------------------------------------------------
const RATE = 22050;
const TABLE_N = 4096;
const SINE = new Float32Array(TABLE_N);
for (let i = 0; i < TABLE_N; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE_N);
const sine = (phase: number): number => SINE[Math.floor((phase - Math.floor(phase)) * TABLE_N) & (TABLE_N - 1)]!;
const tri = (phase: number): number => { const p = phase - Math.floor(phase); return p < 0.5 ? 4 * p - 1 : 3 - 4 * p; };

const NOTES = [261.6, 329.6, 392.0, 523.3, 392.0, 329.6];
const STEP = 0.9;
const MUSIC_N = Math.round(RATE * STEP * NOTES.length);
const music = new Float32Array(MUSIC_N);
const NOTE_LEN = Math.round(1.5 * RATE);
let noteAt = 0, noteSample = 0;
/** One slice of the pad (audio.js _startMusic's blip: linear to 0.10 in 0.08 s, exponential to 0.001 at 1.4 s, stopped at 1.5 s). */
function renderMusic(count: number): boolean {
  while (count > 0 && noteAt < NOTES.length) {
    const f = NOTES[noteAt]!, s0 = Math.round(noteAt * STEP * RATE);
    const end = Math.min(NOTE_LEN, noteSample + count);
    for (let i = noteSample; i < end; i++) {
      const t = i / RATE;
      const env = t < 0.08 ? (0.1 * t) / 0.08 : 0.1 * Math.pow(0.01, (t - 0.08) / 1.32);
      const k = (s0 + i) % MUSIC_N; // a tail past the loop's end wraps to its start
      music[k] = music[k]! + tri(f * t) * env;
    }
    count -= end - noteSample;
    noteSample = end;
    if (noteSample >= NOTE_LEN) { noteAt++; noteSample = 0; }
  }
  return noteAt >= NOTES.length;
}
const WIND_N = RATE * 10;
const wind = new Float32Array(WIND_N);
let windPos = 0;
function renderWind(count: number): boolean {
  const end = Math.min(WIND_N, windPos + count);
  for (let i = windPos; i < end; i++) {
    const t = i / RATE;
    wind[i] = (sine(82 * t) + sine(83.7 * t)) * (0.06 + 0.03 * sine(0.1 * t));
  }
  windPos = end;
  return windPos >= WIND_N;
}
let musicClip: AudioClip | null = null, windClip: AudioClip | null = null;
let musicVoice: Sound | null = null, windVoice: Sound | null = null;
let rendered = false;
/** The wind at the old ambience slider's 50 % default against music's 60 % (both on the music bus here). */
const WIND_GAIN = 0.5 / 0.6;
const SLICE = 6000;

/** Each frame: the clips once the mixer runs (one at a time), the loops rendered a slice a frame, then started. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const list of byEvent.values()) for (const n of list) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!rendered) {
    if (!musicClip) {
      if (!renderMusic(SLICE)) return;
      try { musicClip = createClip([music], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); rendered = true; }
      return;
    }
    if (!windClip) {
      if (!renderWind(SLICE)) return;
      try { windClip = createClip([wind], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
      rendered = true;
      return;
    }
  }
  if (musicClip && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", loop: true }); } catch { musicVoice = null; }
    return;
  }
  if (windClip && !windVoice) {
    try { windVoice = playClip(windClip, { bus: "music", gain: WIND_GAIN, loop: true }); } catch { windVoice = null; }
  }
}
