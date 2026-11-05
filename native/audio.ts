// Sound, as the browser build's audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json: one or two clips per event, a SoundBank
// picking the variant) on the effects bus and the menu clicks on the interface
// bus; the gentle island pad (triangle blips C E G C' G E, one every 0.9 s,
// 0.08 s up to 0.10, down to 0.001 at 1.4 s) and the soft sea wind (sines at 82
// and 83.7 Hz at 0.06 with a slow swell of ±0.03) from the first press on. The
// browser build ran both live (a timer scheduler and oscillators); here they
// are rendered natively into loops (OfflineAudioContext) and played on the music
// bus: the runtime has no ambience bus, so the wind's gain folds in the old
// ambience slider's 50 % default against music's 60 %, and its swell is 0.1 Hz
// (0.13 Hz in the browser) so the 10 s loop joins. A clip still loading is
// silent. The runtime's Options own the volumes, the mute and the voice limit.
// Every clip loads at the start.
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, SoundBank, type AudioClip, type Sound } from "starhermit:audio";
import { files } from "starhermit:engine";

export type Sfx = "drag" | "launch" | "impact" | "wood" | "stone" | "target" | "win" | "lose" | "invalid" | "ui";
/** audio.js caption cues (English keys, shown in the hint line). */
export const CAPTIONS: Partial<Record<Sfx, string>> = {
  drag: "aiming", launch: "whoosh", impact: "impact", target: "target down", win: "stage clear", lose: "out of shots", invalid: "not allowed",
};
const banks = new Map<string, SoundBank>();

/** Reads the manifest, loads every clip into its event's bank and starts the loops' renders (onStart). */
export function loadSfx(): void {
  const byEvent = new Map<string, string[]>();
  try {
    const list = files.readJson("sfx/manifest.json") as unknown as { name: string; event: string }[];
    for (const it of list) {
      if (!it || typeof it.name !== "string" || typeof it.event !== "string") continue;
      byEvent.set(it.event, [...(byEvent.get(it.event) ?? []), it.name]);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
  for (const [event, names] of byEvent) {
    void Promise.all(names.map((n) => loadClip(`sfx/${n}.opus`).catch((e: unknown) => { console.warn(`sfx ${n}: ${String(e)}`); return null; }))).then((loaded) => {
      const ok = loaded.filter((c) => c !== null);
      if (ok.length) banks.set(event, new SoundBank({ clips: ok, bus: event === "ui" ? "interface" : "effects" }));
    });
  }
  const failed = (e: unknown): void => { console.warn(`audio render: ${String(e)}`); };
  renderMusic().then((c) => { musicClip = c; }, failed);
  renderWind().then((c) => { windClip = c; }, failed);
}

/** audio.js play(name): one of the event's clips. */
export function play(kind: Sfx): void {
  try { banks.get(kind)?.play(); } catch { /* the mixer is full this frame: skip it */ }
}

// -- the pad and the wind ---------------------------------------------------------------------
const RATE = 22050;
const NOTES = [261.6, 329.6, 392.0, 523.3, 392.0, 329.6];
const STEP = 0.9;
const MUSIC_N = Math.round(RATE * STEP * NOTES.length);
/** The pad (audio.js _startMusic's blip: linear to 0.10 in 0.08 s, exponential to 0.001 at 1.4 s, stopped at 1.5 s); a tail past the loop's end wraps to its start. */
async function renderMusic(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, MUSIC_N + Math.round(0.6 * RATE), RATE);
  NOTES.forEach((f, n) => {
    const t = n * STEP;
    const osc = off.createOscillator(), env = off.createGain();
    osc.type = "triangle";
    osc.frequency.value = f;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.1, t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    osc.connect(env).connect(off.destination);
    osc.start(t);
    osc.stop(t + 1.5);
  });
  const d = (await off.startRendering()).getChannelData(0), out = d.slice(0, MUSIC_N);
  for (let i = MUSIC_N; i < d.length; i++) out[i - MUSIC_N] = out[i - MUSIC_N]! + d[i]!;
  return createClip([out], RATE);
}
async function renderWind(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, RATE * 10, RATE);
  const g = off.createGain();
  g.gain.value = 0.06;
  const swell = off.createOscillator(), depth = off.createGain();
  swell.frequency.value = 0.1;
  depth.gain.value = 0.03;
  swell.connect(depth).connect(g.gain);
  swell.start();
  for (const f of [82, 83.7]) { const osc = off.createOscillator(); osc.frequency.value = f; osc.connect(g); osc.start(); }
  g.connect(off.destination);
  return createClip(await off.startRendering());
}
let musicClip: AudioClip | null = null, windClip: AudioClip | null = null;
let musicVoice: Sound | null = null, windVoice: Sound | null = null;
/** The wind at the old ambience slider's 50 % default against music's 60 % (both on the music bus here). */
const WIND_GAIN = 0.5 / 0.6;

/** Each frame: the loops, once the mixer runs. */
export function update(): void {
  if (context.state !== "running") return;
  if (musicClip && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", loop: true }); } catch { musicVoice = null; }
  }
  if (windClip && !windVoice) {
    try { windVoice = playClip(windClip, { bus: "music", gain: WIND_GAIN, loop: true }); } catch { windVoice = null; }
  }
}
