# Sky Sling — Product and Game Specification

**Document status:** running specification of the game as implemented on the StarHermit engine (§3); §1–2 and §4–7 keep the original design intent.  
**Game index:** 50  
**Genre:** Projectile physics puzzle  
**Players:** 1 player; optional asynchronous score comparison  
**Targets:** the StarHermit client (native) and browsers through the engine's web runtime, desktop and phones in landscape and portrait  
**Rendering:** `starhermit:scene` (ported from three.js r185) with a `starhermit:ui` interface layer

## 1. Product vision

Sky Sling is a game in which players launch round characters with a drag slingshot to collapse structures and reach limited-shot goals. Its signature setting is a breezy island range of toy-like structures. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Launch round characters with a drag slingshot to collapse structures and reach limited-shot goals.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **drag to aim, preview an approximate arc, launch, resolve destruction, and plan remaining shots**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Score goal completion, remaining shots, and optional collectibles. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Implementation on the StarHermit engine

Sky Sling is a StarHermit engine **script game** (TypeScript on host API 1.22), pinned in `starhermit.txt` to the published engine 1.23.0 with `engine.minor=20` (three.js r185 parity) and the capabilities `platform`, `storage` and `clipboard`. The same package plays natively in the StarHermit client and in browsers through the engine's web runtime: `launch=index.html` is the loader `npm run package` writes (with `starhermit-files.json`, the file index), so both are regenerated after every change.

### Files

- `rules.js`, `content.js`, `session.js` — the pure rules (fixed 1/120 s physics steps, two per 1/60 s tick, quantized launch velocities, support collapse, scoring, hashes, replay envelopes), the 45 Journey stages, the lessons, the Daily and the five themes, and the session (modes, practice undo, achievements, progression). They are classic scripts the engine loads with `loadClassic` (`native/classic.ts`) and the Node tests and `server.js` require unchanged. The session's Daily takes the day from the platform clock (`startRound('daily', date)`).
- `progress.js` — the progress document (the browser build's `{ v, sum, stars, bestScores, achievements, counters, dailyExcluded }`, checksummed), its normalization, the two-device merge (the same result as `session.adoptProgress`), reading the browser build's cloud slot, and the game's own options.
- `i18n.js`, `locales/*.js`, `sh-strings.js` — the string tables (US English as the key; es-ES and fr-CA list their differences) and the account strings.
- `native/main.ts` (entry: actions, rounds, launches, aim input, session events, results, lifecycle), `native/screens.ts` (every screen on `starhermit:ui`), `native/render.ts` (the island on `starhermit:scene`), `native/quality.ts` (the look per graphics level), `native/audio.ts`, `native/platform.ts` (save, options, player, clock, leaderboard), `native/i18n.ts`, `native/style.ts`.
- `tools/ui-style.css` → `assets/ui-style.json` (`npm run css`, `starhermit css`), the class-based rewrite of the old `style.css`.
- `score-script.js` — the platform script (`server=`), unchanged: it range-checks a finished run's total and posts it to the `high-score` board. `server.js` is the local dev server (static files plus the old replay-validating `/api/v1` routes); it is left out of the package.

### Controls

| Action | Keys (default) | Gamepad | Pointer / touch |
|---|---|---|---|
| `aim_left` / `aim_right` | ← / → (less / more power, vx ∓0.5 m/s) | D-pad / left stick left / right | — |
| `aim_up` / `aim_down` | ↑ / ↓ (aim higher / lower, vy ±0.5 m/s) | D-pad / left stick up / down | — |
| `launch` | Space, Enter, Numpad Enter (after an aim key) | South (A) | release the drag |
| `pause` | Escape, P (pause / resume) | Start | ❚❚ Pause, ☰ |
| `skip` | S (fast-forward a shot in flight) | right shoulder | ⏩ |
| `restart` | R | Select | ↻ |
| `undo` | U (Practice) | West (X) | ↩ |

Pressing or touching anywhere on the island (outside the HUD) and dragging pulls the pouch back: the pull is the drag distance at 14 m per playfield height, capped at 2.6 m, and the shot leaves opposite to it at 7.5 m/s per metre; the bird, band and the dotted arc follow the drag, a pull under 0.3 m is a tap (no launch). Keyboard and pad aim keep their velocity between shots and rounds (starting at vx 9, vy 7); held aim keys repeat after half a second at 30 a second, on fixed steps; Timing assist halves the step. Launch commands carry an identifier derived from the round state, so a repeated commit of the same shot is rejected. Players rebind keys and pads in the runtime's Options (the old camelCase action names became snake_case; bindings saved under the old names do not carry over).

### Screens and layouts

The island always draws behind the HUD and the panels. The **HUD**: a top bar (☰ menu — pauses a round, the title, the mode chip, the player's name when signed in, the cloud-save line — "Progress synced to cloud", "Saving…" or "Cloud unavailable — local save" — and ? help), the Goal / Targets / Hint rail and the Score / Shots left / Best rail, and the bottom bar (❚❚ Pause, the hint line that also shows the sound captions and the keyboard aim, ⏩ fast-forward, ↩ undo in Practice, ↻ restart). A concise board model ("Board: N of M targets standing, …") is a screen-reader target over the playfield. **Panels** (one at a time, over the island, as the old overlays): title (Play — the furthest unlocked Journey stage, Daily Challenge, Journey, Settings, How to Play, Sign in with StarHermit / Invite a friend, the Journey progress line), the mode list (Learn, Journey, Daily Challenge, Practice, Challenge; reached from the stage grid's Back), the stage grid (45 stages with stars; Journey unlocks one past the furthest cleared, Practice opens all), How to play (rule cards with the player's current keys and the gamepad), Pause (Resume, Restart, Help, Settings, Leave round), Settings and the results (title, points, the Targets / Blocks / Unused-shot bonus breakdown, Journey stars, the newest achievement, the ranked note, the leaderboard line and top ten, Retry, Next stage when won, Menu). Escape is each panel's way back (resume from Pause); a scrolling panel keeps its closing button pinned below its body.

Layouts follow the window's logical size, as the old media queries did: **wide** (≥ 1024 px: the rails under the top bar, dividers and the Hint section), **compact** (the rails at the bottom corners above the bottom bar, smaller text, no Hint), **landscape phones** (≤ 500 px tall: compact rails under the top bar, tighter panels) and **portrait phones** (≤ 640 px wide: the bars on panel backgrounds, the island between them and the two rails side by side under it; ≤ 420 px the Pause button shows its glyph only). Left-handed controls swap the rails. The runtime's UI scale and text size replace `ui-scale.js` and the old Larger text option.

### Settings

The game's Settings panel keeps its own options — **Left-handed controls** and **Timing assist (longer aim window)**, engine settings synced with the account — and opens the runtime's Options (sound volumes and mute, graphics level and frame rate, language, larger text, high contrast, reduced motion, vibration) and its key bindings. High contrast applies the old high-contrast palette; reduced motion stops the ambient motion and the impact effects. The old Haptics toggle is the runtime's vibration option (a launch vibrates 15 ms).

### Graphics

render.ts is the old render.js on `starhermit:scene`: the authored camera (fov 42, dollying back until the play area fits the playfield), the hemisphere fill, the key light with shadows and the warm rim light (r185 intensities ÷ π), the vertex-coloured sky dome with the additive sun sprite and merged cloud clusters, the sea with its ripple normal map, shallows and foam ring, the island, palms and rocks, the slingshot, bird, blocks and Bumbles with the procedural wood, stone, ice, sand and grass canvases, the dotted arc, and the seeded sparks, debris and puffs; ACES tone mapping. The sky reflections (the browser build's PMREM of its sky scene) are an equirectangular float image of the theme's dome and sun prefiltered with `fromEquirectangular`, at environment intensity 0.55. The runtime's quality tier picks the old preset and its budget (native/quality.ts, gfx.js's tables; sparks scale within a tier by the level, at most 2×):

| Tier | Shadows | AO | Bloom / grade | Antialias | Reflections | Detail / motion | Materials | Textures | Clouds | Sparks |
|---|---|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | MSAA | off | plain, still | Lambert | — | 3 | 10 |
| Balanced | 1024 | off | on | FXAA | on | detailed, animated | Standard | 256 px | 6 | 16 |
| High | 2048 | on (half res) | on | SMAA | on | detailed, animated | Physical | 256 px | 8 | 20 |
| Ultra | 4096 | high (full res) | on | MSAA | on | detailed, animated | Physical | 512 px | 10 | 28 |

Bloom is UnrealBloom's 0.25 / 0.3 / 0.92 before the tone mapping; the grade is the old GradeShader in display space (S-curve, saturation 1.1, cool shadows / warm highlights, 0.2 vignette). The runtime owns Auto, render scale, the pixel-ratio cap, adaptive resolution and the frame-rate limit and readout; the old per-effect overrides are not offered.

### Sound

native/audio.ts plays the authored clips (`sfx/manifest.json`: one or two per event, the variant from audio.js's seeded stream) on the effects bus and the menu clicks on the interface bus, with their text captions in the hint line (aiming, whoosh, impact, target down, stage clear, out of shots, not allowed). The island pad (triangle blips every 0.9 s) and the sea wind (82 / 83.7 Hz sines with a slow swell) are rendered once into loops and played on the music bus from the first press (the runtime has no ambience bus; the wind's swell is 0.1 Hz so its 10 s loop joins). The runtime's Options own the volumes, mute and the voice limit.

### Time and determinism

A shot in flight advances one rules tick per 60 Hz fixed step (never by wall time), so pauses, hidden windows and slow frames never change a shot and play scripts replay exactly; fast-forward resolves the shot at once into the same end state. A hidden window pauses the round (resumable from the Pause panel).

### Platform integration

- **Save:** the progress document is the engine save (`saves`, on the device and in the player's cloud slot) as `{ progress }`; a conflict between devices merges both (highest stars, best scores and counters, the union of achievements and excluded dailies); a save adopted from another device is merged into the session. The browser build's cloud slot (`game:<slug>`, the same document) is read as a foreign save when its checksum holds, merged and replaced once. Guests' old browser `localStorage` progress does not migrate.
- **Settings KV:** the browser build's `leftHanded` and `timingAssist` values are adopted (unless set on the engine since) and its other keys (volumes, graphics, motion, contrast, text size, haptics, camera) are removed: the runtime's Options replace them.
- **Leaderboard:** signed in, every finished Journey, Daily or Challenge run (won or lost; not Learn or Practice) posts its total through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores: { 'high-score': n } }`); the results show "Leaderboard rank: #N" (or posted / not posted) and the board's top ten. Solo scores keep score-script.js's range check (0–100,000), as decided for every port; there is no multiplayer, so nothing is refereed beyond it.
- **Daily:** one seed per UTC day of the platform clock (`serverNow`), the device's clock when it has not answered.
- **Account:** Sign in with StarHermit (signed out), Invite a friend (copies the invite link), the player's display name in the top bar; signing out keeps playing locally with a toast.
- **No multiplayer:** the browser build never opened rooms or sockets beyond the score post (`server=` names only the leaderboard script); the engine build uses none either.

### Localization

Every string is looked up through `T()` in the runtime's interface language (Options › Language, else the account's or device's; es-MX → es-419, en-AU → en-GB, pt-PT → pt-BR, …) in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT, and switches on the next frame, mid-round included.

### Checks

- `npm run test:unit`: `tests/game.test.js` (rules, content, session and dev-server validation: legality, scoring, deterministic replay, fuzzing, golden sessions, save checksum), `tests/progress.test.js`, `tests/i18n.test.js` (every key in native/*.ts translated in all locales with matching placeholders and no unused rows).
- `npm run test:native` (`tests/native.mjs`): the web index matches the files, `tsc`, `starhermit check` with zero warnings, and the play scripts in `tests/native/` as signed-out render checks — Journey 1–5 by keys to their results (`journey.play`), the Challenge with Retry, Learn by finger swipes on a DPR-3 portrait phone, Practice sideways (DPR 3) with a fast-forwarded shot, undo, Help and Settings, and today's Daily generated at test time. `npm run plays` regenerates the scripts from the rules with the keyboard bot (`tools/plan.mjs`).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged game in GPU Chrome at 1280×800, a 390×844 phone and an 844×390 phone (DPR 3): mouse and finger pulls on the sling, fast-forward, results, undo, pause and help, with no console errors.

### Known limitations

- The client's dev-server path (submitting the Daily's replay envelope to `server.js`'s `/api/v1/scores`) is not part of the engine build; on the platform the Daily posts through score-script.js like the other ranked modes.
- Achievements stay in the progress document (the browser build posted none to the platform).
- Only the newest achievement of a round shows on its results (as before).
- Hosted (signed-in) paths — score posting, cloud merges, the settings KV — are covered by unit tests, not live-tested here.

## 4. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 5. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 6. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Graphics and performance

- Produce fixed-camera captures for every quality tier, deterministic seed sweeps, no-post baselines, debug-view mosaics, and 10-minute temporal stability runs.
- Profile CPU, GPU, memory, shader compilation, draw calls, triangles, texture memory, and garbage collection on representative desktop and mobile classes.
- Verify effects cannot obscure legal targets, alter picking, leak resources, or continue expensive updates while hidden.

### Platform and network

- Test expired/rotated tokens, privacy settings, rate limits, offline start, reconnect at each game state, duplicate commands, out-of-order events, server restart, and version mismatch.
- Verify achievement idempotency, leaderboard validation, cloud-save conflict merging and the old cloud slot's migration (`tests/progress.test.js`), complete locale coverage (`tests/i18n.test.js`), and the played paths natively and in the browser (§3 Checks).
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

## 7. Definition of done and non-goals

This specification is ready for implementation when rules examples, content schema, wireframes for all responsive breakpoints, visual target frames, accessibility annotations, authoritative message schema, achievement definitions, leaderboard definitions, and performance test devices are approved.

This document does **not** authorize implementation, asset production, monetization work, native wrappers, real-money systems, or copying any existing product. The initial build should favor one excellent core loop and a coherent original visual identity over feature breadth.
