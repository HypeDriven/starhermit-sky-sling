// The browser build's DOM shell (index.html + ui.js) as starhermit:ui, built
// every frame over the island: the top bar (☰ menu, the title, the mode, the
// player's name and the cloud-save line, ? help), the Goal / Targets / Hint
// rail and the Score / Shots left / Best rail, the bottom bar (❚❚ Pause, the
// hint and caption line, ⏩ fast-forward, ↩ undo in Practice, ↻ restart),
// the toast, and the panels — title, mode list, the stage grid, how to play,
// pause, settings and results. The old media queries are layouts picked by
// the window's logical size: wide (≥ 1024 px: the rails under the top bar),
// compact (the rails at the bottom corners, without the hint), landscape
// phones (≤ 500 px tall: compact rails under the top bar, tighter panels)
// and portrait phones (≤ 640 px wide: the bars on panels, the island between
// them and the two rails side by side under it). Left-handed controls swap
// the rails. The island fills the playfield rectangle left (main.ts view).
import { frame, openMenu } from "starhermit:engine";
import { bindings, primaryPointer, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Rules, SessionMod } from "./classic.ts";
import { N, S, T, modeLabel } from "./i18n.ts";
import * as platform from "./platform.ts";
import { account, actions, app, fresh, hudRects, inRound, later, leaderboardLine, session, startRound, undoEnabled, view } from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; phone: boolean; short: boolean; tiny: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, phone: lw <= 640 && lh > lw, short: lh <= 500 && lw > lh, tiny: lw <= 420 };
}
const lastSize = new Map<string, number>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside; `name` differing from the text is its accessible name. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  const weight = style === "btn-primary" ? "700" : "400";
  if (b.name && b.name !== b.text) {
    opts.content = () => { ui.style({ text: { weight } }).label(b.text); };
  } else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 36);
    opts.content = () => { ui.style({ text: { align: "center", weight } }).paragraph(b.text, inner); };
  }
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh() && !b.disabled) later(b.act);
}
/** Buttons at their own widths in centred rows that wrap at `width` (.panel .row: flex-wrap, gap 10). */
function flow(label: string, list: Btn[], width: number, gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, bw(b) >= width ? width : null);
    }, { spacing: gap, width, justify: "center" }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
function divider(id: string, w: number): void {
  ui.widget("", { role: "none", size: { width: w, height: 13 }, draw: (r, st) => draw.rect(r.x, r.y + 6 * st.scale, r.width, Math.max(1, st.scale), token("divider")) });
  void id;
}
/** A box over a window rectangle (window px) in a class, drawn as a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, cls: string): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: (r) => draw.box(r.x, r.y, r.width, r.height, cls) });
  });
}
/** The effective keys of an action, e.g. "U" or "←" (platform.js keyLabel over the player's bindings). */
export function keysFor(action: string): string {
  const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/") || "—";
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  hud(L);
  panel(L);
  toastBox(L);
  if (app.focusNext) {
    const age = frame().frame - app.openedFrame;
    if (age >= 1 && primaryPointer() !== "coarse") ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the HUD (index.html #game-region)
const SYNC: Record<string, string> = {
  synced: N("Progress synced to cloud"), saving: N("Saving…"), offline: N("Cloud unavailable — local save"), local: N("Cloud unavailable — local save"),
};
function hud(L: Layout): void {
  const f = frame(), sc = L.sc, sa = f.safeArea;
  const s = session.state;
  const live = !app.overlay;
  const compact = !L.wide;
  const phone = L.phone;

  // ---- the playfield, from the bars' sizes as last laid out (portrait phones: the bars on panels)
  {
    const pb = lastSize.get("bar") ?? 56, pt = lastSize.get("tray") ?? 62, pr = phone ? lastSize.get("rails") ?? 120 : 0;
    if (phone) {
      paint("bar-top", 0, 0, f.width, sa.top + pb * sc, "bar");
      const by = f.height - sa.bottom - (pt + pr) * sc;
      paint("bar-bottom", 0, by, f.width, f.height - by, "bar");
      view.x = 0; view.y = sa.top + pb * sc;
      view.width = f.width; view.height = Math.max(1, by - view.y);
    } else {
      view.x = 0; view.y = 0; view.width = f.width; view.height = f.height;
    }
  }

  // ---- top bar
  const left = ui.place("top-left", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.row("top-left-row", () => {
      button({ id: "btn-menu", text: "☰", name: T("Open menu"), act: actions.pause, disabled: !live || !inRound() });
      ui.style("hud-title").id("hud-title").label("Sky Sling");
    }, { spacing: 8, align: "center", padding: { top: phone ? 6 : 8, bottom: phone ? 6 : 8, start: 12, end: 0 } });
  });
  rect(left);
  const leftW = left.width / sc;
  const chips: { id: string; text: string; cls: string }[] = [];
  if (session.mode && session.level) chips.push({ id: "hud-mode", text: modeLabel(session.mode), cls: "chip-mode-text" });
  if (platform.signedIn() && platform.displayName()) chips.push({ id: "player-name", text: platform.displayName(), cls: "chip-dim-text" });
  chips.push({ id: "sync-status", text: T(SYNC[platform.syncState()]!), cls: "chip-dim-text" });
  const helpW = buttonWidth("?", "btn");
  const avail = Math.max(60, L.lw - leftW - helpW - 24 - 8 * (chips.length + 1));
  const right = ui.place("top-right", { anchor: "top-end", x: 0, y: 0 }, () => {
    ui.row("top-right-row", () => {
      // natural widths; the cloud-save line (last) wraps into what is left
      const nat = chips.map((c) => textWidth(c.text, c.cls) + 1);
      const others = nat.slice(0, -1).reduce((a, b) => a + b + 24, 0);
      chips.forEach((c, i) => {
        const ww = i === chips.length - 1 ? Math.max(40, Math.min(nat[i]!, avail - others)) : nat[i]!;
        ui.column(c.id, () => para(c.text, ww, c.cls, `${c.id}-t`), { style: "chip" });
      });
      button({ id: "btn-help", text: "?", name: T("Help"), act: actions.help, disabled: !live });
    }, { spacing: 8, align: "center", padding: { top: phone ? 6 : 8, bottom: phone ? 6 : 8, start: 0, end: 12 } });
  });
  rect(right);
  const barH = Math.max(left.height, right.height) / sc;

  // ---- bottom bar
  const pauseText = L.tiny ? "❚❚" : `❚❚ ${T("Pause")}`;
  const trayBtns: Btn[] = [
    { id: "btn-skip", text: "⏩", name: T("Fast-forward resolution"), act: actions.skip, disabled: !live || session.screen !== "resolving" },
    { id: "btn-undo", text: "↩", name: T("Undo shot (practice)"), act: actions.undo, disabled: !live || !undoEnabled() },
    { id: "btn-restart", text: "↻", name: T("Restart level"), act: actions.restart, disabled: !live || !session.level },
  ];
  const trayW = lastSize.get("trayW") ?? trayBtns.reduce((a, b) => a + buttonWidth(b.text, "btn") + 8, 0) + 12;
  const pauseW = buttonWidth(pauseText, "btn");
  const hintW = Math.max(40, L.lw - 12 - pauseW - 8 - trayW - 12);
  const hintText = app.hint.key ? T(app.hint.key, app.hint.vars) : "";
  const bottom = ui.place("bottom-bar", { anchor: "bottom-start", x: 0, y: 0 }, () => {
    ui.row("bottom-row", () => {
      button({ id: "btn-pause", text: pauseText, name: T("Pause"), act: actions.pause, disabled: !live || !inRound() });
      ui.column("hint-col", () => para(hintText, hintW, "hint-text", "hint-text"), { width: hintW });
    }, { spacing: 8, align: "center", padding: { top: 8, bottom: phone ? 10 : 8, start: 12, end: 0 } });
  });
  rect(bottom);
  const tray = ui.place("tray", { anchor: "bottom-end", x: 0, y: 0 }, () => {
    ui.row("tray-row", () => { for (const b of trayBtns) button(b); }, { spacing: 8, align: "center", height: bottom.height / sc, padding: { top: 0, bottom: phone ? 2 : 0, start: 0, end: 12 } });
  });
  rect(tray);
  lastSize.set("trayW", tray.width / sc);
  const trayH = bottom.height / sc;

  // ---- rails
  const lefty = platform.options.leftHanded;
  const railCls = "rail-text";
  const size = L.short ? 12.8 : compact ? 13.6 : 16;
  const k = size / 16;
  const objective = s ? (s.over ? (s.won ? T("Cleared!") : T("Out of shots")) : T("Collapse every Bumble ({n} left)", { n: s.targets.filter((t) => t.alive).length })) : "";
  const targets = s ? `${s.targets.filter((t) => t.alive).length} / ${s.targets.length}` : "";
  const tut = session.level?.tutorial;
  const hintRail = s && tut ? T(tut.text) : "";
  const score = s ? String(Rules.computeScore(s).total) : "";
  const shots = s ? String(s.shots - s.shotsUsed) : "";
  const best = s && session.mode === "journey" ? String(session.progress.bestScores[s.index] || 0) : "";
  const leftItems: [string, string, boolean][] = [[T("Goal"), objective, false], [T("Targets"), targets, false]];
  if (!compact) leftItems.push([T("Hint"), hintRail, false]);
  const rightItems: [string, string, boolean][] = [[T("Score"), score, true], [T("Shots left"), shots, true], [T("Best"), best, false]];
  const maxInner = phone ? (L.lw - 8 * 3) / 2 - 28 : L.short ? 150 : compact ? 180 : 270;
  const railW = (items: [string, string, boolean][]): number => {
    let w = 0;
    for (const [h, v, big] of items) {
      w = Math.max(w, textWidth(h, "rail-h") * k);
      if (v) w = Math.max(w, Math.min(maxInner, textWidth(v, big ? "rail-big" : railCls) * k));
    }
    return phone ? maxInner : Math.min(maxInner, Math.ceil(w) + 2);
  };
  const railBody = (id: string, items: [string, string, boolean][], align: "start" | "end", w: number): void => {
    ui.column(id, () => {
      items.forEach(([h, v, big], i) => {
        if (i && !compact) divider(`${id}-d${i}`, w);
        ui.style("rail-h", { text: { size: 15.2 * k } }).label(h);
        if (v) {
          const cls = big ? "rail-big" : railCls;
          const st: ui.Style = { text: { size: (big ? 25.6 : 16) * k, align } };
          if (textWidth(v, cls) * k <= w) ui.style(cls, st).id(`${id}-v${i}`).label(v);
          else ui.style(cls, st).id(`${id}-v${i}`).paragraph(v, w);
        }
      });
    }, { width: w, spacing: 2, align });
  };
  {
    const wl = railW(leftItems), wr = railW(rightItems);
    const pad = L.short ? { top: 6, bottom: 6, start: 8, end: 8 } : compact ? { top: 8, bottom: 8, start: 10, end: 10 } : { top: 10, bottom: 10, start: 14, end: 14 };
    if (phone) {
      const y = lastSize.get("rails") ?? 120;
      const top = L.lh - trayH - y;
      const r = ui.place("rails", { anchor: "top-start", x: 4, y: top - 4 }, () => {
        ui.row("rails-row", () => {
          const a = (): void => { ui.column("rail-left", () => railBody("rail-left-in", leftItems, "start", wl), { style: "rail", padding: pad, width: wl + 28, height: y - 8 }); };
          const b = (): void => { ui.column("rail-right", () => railBody("rail-right-in", rightItems, "end", wr), { style: "rail", padding: pad, width: wr + 28, height: y - 8, align: "end" }); };
          if (lefty) { b(); a(); } else { a(); b(); }
        }, { spacing: 8 });
      });
      // the content height (the taller rail) for the next frame
      void r;
      const want = Math.max(measureRail(leftItems, wl, k), measureRail(rightItems, wr, k)) + pad.top + pad.bottom + 8;
      lastSize.set("rails", want);
    } else {
      const topY = compact && !L.short ? null : (L.short ? barH + 2 : barH + 4);
      const place = (id: string, items: [string, string, boolean][], side: "start" | "end", w: number, align: "start" | "end"): void => {
        const anchor = topY == null ? (side === "start" ? "bottom-start" : "bottom-end") : (side === "start" ? "top-start" : "top-end");
        ui.place(id, { anchor, x: 10, y: topY == null ? trayH + 8 : topY }, () => {
          ui.column(`${id}-box`, () => railBody(`${id}-in`, items, align, w), { style: "rail", padding: pad, align });
        });
      };
      // left-handed: swap the rails (the score rail's text then aligns start)
      place("rail-left", leftItems, lefty ? "end" : "start", wl, "start");
      place("rail-right", rightItems, lefty ? "start" : "end", wr, lefty ? "start" : "end");
    }
  }

  // the screen-reader board model (#sr-board): a concise description over the playfield
  if (s) {
    const PHASES: Record<string, string> = { aim: N("aiming"), flight: N("in flight"), over: N("round over") };
    ui.target(T("Board: {alive} of {total} targets standing, {blocks} blocks remaining. Shots used {used} of {shots}. Phase: {phase}.", {
      alive: s.targets.filter((t) => t.alive).length, total: s.targets.length, blocks: s.blocks.filter((b) => b.alive).length,
      used: s.shotsUsed, shots: s.shots, phase: T(PHASES[s.phase] ?? s.phase),
    }), { x: view.x, y: view.y + view.height * 0.25, width: view.width, height: view.height * 0.4 }, { role: "label" });
  }
  lastSize.set("bar", barH);
  lastSize.set("tray", trayH);
}
function measureRail(items: [string, string, boolean][], w: number, k: number): number {
  let h = 0;
  items.forEach(([hd, v, big], i) => {
    if (i) h += 2;
    h += ui.measureText(hd, { style: ["rail-h", { text: { size: 15.2 * k } }] }).height / ui.preferences().scale;
    if (v) {
      const m = ui.measureText(v, { style: [big ? "rail-big" : "rail-text", { text: { size: (big ? 25.6 : 16) * k } }], width: w });
      h += 2 + m.height / ui.preferences().scale;
    }
  });
  return h;
}
function toastBox(L: Layout): void {
  if (!app.toast) return;
  const w = Math.min(L.lw * 0.92, 520);
  ui.place("sh-toast", { anchor: "bottom", y: 16 }, () =>
    ui.column("sh-toast-col", () => para(app.toast!.text(), w - 32, "toast-text", "sh-toast-text"), { style: "toast", align: "center" }));
}

// ------------------------------------------------------------------ panels (index.html #overlay-root)
function panel(L: Layout): void {
  const o = app.overlay;
  if (!o) return;
  const f = frame();
  const wide = o === "stages";
  const outer = Math.min(L.lw * (wide ? 0.94 : 0.92), wide ? 720 : 560);
  const padX = L.short ? 18 : L.lw <= 480 ? 14 : 28, padY = L.short ? 14 : L.lw <= 480 ? 16 : 24;
  const avail = Math.max(120, L.lh * (L.short ? 0.92 : 0.88));
  const key = `panel-${o}`;
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const opening = f.frame - app.openedFrame <= 6;
  const open = ui.dialog(o, "", true, () => {
    const body = (): void => {
      const w = outer - 2 * padX - (scroll ? 14 : 0);
      const r = ui.column(`${key}-col`, () => {
        if (o === "title") titlePanel(w, L);
        else if (o === "modes") modesPanel(w);
        else if (o === "stages") stagesPanel(w);
        else if (o === "help") helpPanel(w);
        else if (o === "pause") pausePanel(w);
        else if (o === "settings") settingsPanel(w);
        else resultsPanel(w, L);
      }, { style: "panel", width: outer - (scroll ? 14 : 0), spacing: L.short ? 6 : 10, align: "center", padding: { top: padY, bottom: padY, start: padX, end: padX } });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
  // Escape: the panel's way back (not on the frame it opened; the title and results stay)
  if (!open && fresh()) later(() => {
    if (o === "modes") actions.backTitle();
    else if (o === "stages") actions.backModes();
    else if (o === "help") actions.closeHelp();
    else if (o === "settings") actions.closeSettings();
    else if (o === "pause") actions.resume();
  });
}
function heading(cls: string, text: string, w: number, id?: string): void {
  if (textWidth(text, cls, "heading") <= w) (id ? ui.id(id) : ui).style(cls).heading(text);
  else (id ? ui.id(id) : ui).style(cls).paragraph(text, w);
}
function titlePanel(w: number, L: Layout): void {
  heading("title-h1", "Sky Sling", w, "title-h");
  para(T("A breezy island slingshot puzzle. Drag, aim, collapse."), w, "sub", "title-sub");
  button({ id: "btn-play", text: T("Play"), style: "btn-primary", act: actions.play });
  flow("title-row1", [
    { id: "btn-daily", text: T("Daily Challenge"), act: actions.daily },
    { id: "btn-journey", text: T("Journey"), act: actions.journey },
  ], w);
  flow("title-row2", [
    { id: "btn-settings", text: T("Settings"), act: actions.settings },
    { id: "btn-howto", text: T("How to Play"), act: actions.help },
  ], w);
  const acct: Btn[] = [];
  if (!platform.signedIn()) acct.push({ id: "btn-signin", text: S("signIn"), act: account.signIn });
  if (platform.inviteLink()) acct.push({ id: "btn-invite", text: S("invite"), act: account.invite });
  if (acct.length) flow("title-row3", acct, w);
  const cleared = Object.keys(session.progress.stars).length;
  if (cleared) para(T("Journey: {n} / {total} stages cleared", { n: cleared, total: Content.LEVEL_COUNT }), w, "dim", "title-progress");
  void L;
}
const MODES: { id: string; title: string; desc: string; act: () => void }[] = [
  { id: "learn", title: N("Learn"), desc: N("Interactive lessons, one rule at a time. ~2 min. Unranked."), act: () => actions.learn() },
  { id: "journey", title: N("Journey"), desc: N("45 authored stages with rising difficulty. Progress saved."), act: () => actions.journey() },
  { id: "daily", title: N("Daily Challenge"), desc: N("One shared seed per UTC day. Ranked board."), act: () => actions.daily() },
  { id: "practice", title: N("Practice"), desc: N("Any stage, undo allowed, unranked."), act: () => actions.practice() },
  { id: "challenge", title: N("Challenge"), desc: N("Tighter shot limits on hard layouts. Unranked."), act: () => actions.challenge() },
];
function modesPanel(w: number): void {
  heading("panel-h2", T("Select a mode"), w, "modes-h");
  ui.column("mode-list", () => {
    for (const m of MODES) {
      const tw = w - 36;
      const opts: ui.ButtonOptions = {
        content: () => ui.column(`mode-${m.id}-face`, () => { para(T(m.title), tw, "mode-strong"); para(T(m.desc), tw, "mode-small"); }, { width: tw, spacing: 2 }),
      };
      if (ui.style("mode-btn", { width: w }).id(`mode-${m.id}`).button(T(m.title), opts) && fresh()) later(m.act);
    }
  }, { width: w, spacing: 8 });
  button({ id: "btn-modes-back", text: T("Back"), act: actions.backTitle });
}
function stagesPanel(w: number): void {
  const mode = app.gridMode;
  heading("panel-h2", mode === "practice" ? T("Practice stages") : T("Journey stages"), w, "levels-h");
  const stars = session.progress.stars;
  let unlocked = 0;
  for (let i = 0; i < Content.LEVEL_COUNT; i++) if (stars[i]) unlocked = i + 1;
  if (mode === "practice") unlocked = Content.LEVEL_COUNT;
  // #level-grid: repeat(auto-fill, minmax(64px, 1fr)), gap 8
  const cols = Math.max(1, Math.floor((w + 8) / 72));
  const cw = (w - (cols - 1) * 8) / cols;
  ui.column("level-grid", () => {
    for (let r = 0; r * cols < Content.LEVEL_COUNT; r++) {
      ui.row(`level-row-${r}`, () => {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (idx >= Content.LEVEL_COUNT) break;
          const s = stars[idx] || 0;
          const name = s ? T("Stage {n}, {stars} stars", { n: idx + 1, stars: s }) : T("Stage {n}", { n: idx + 1 });
          const locked = idx > unlocked;
          const opts: ui.ButtonOptions = {
            content: () => ui.column(`stage-${idx + 1}-face`, () => {
              ui.style("level-num").label(String(idx + 1));
              ui.style("level-stars").label("★".repeat(s) + "☆".repeat(Math.max(0, 3 - s)));
            }, { width: cw - 12, spacing: 0, align: "center" }),
          };
          if (locked) opts.disabled = true;
          if (ui.style("level-btn", { width: cw }).id(`stage-${idx + 1}`).button(name, opts) && fresh() && !locked) later(() => startRound(mode, idx));
        }
      }, { spacing: 8 });
    }
  }, { width: w, spacing: 8 });
  button({ id: "btn-stages-back", text: T("Back"), act: actions.backModes });
}
function helpPanel(w: number): void {
  heading("panel-h2", T("How to play"), w, "help-h");
  const k = keysFor;
  const launch = T("Release or press <kbd>Space</kbd> to launch. Each launch uses one shot.").replace(/<kbd>[^<]*<\/kbd>/, k("launch"));
  const keys = [
    [k("aim_left") + k("aim_right") + k("aim_up") + k("aim_down"), N("aim")], [k("launch"), N("launch")], [k("pause"), N("pause")],
    [k("restart"), N("restart")], [k("undo"), N("undo in practice")], [k("skip"), N("fast-forward")],
  ].map((p, i, a) => `${p[0]} ${T(p[1]!)}${i < a.length - 1 ? "," : "."}`).join(" ");
  const cards: [string, string][] = [
    [T("Aim"), T("Drag back from the slingshot pouch — pull down and left to send the shot up and to the right. The dotted arc previews your shot.")],
    [T("Launch"), launch],
    [T("Collapse"), T("Knock out supports; falling blocks crush the green Bumbles. Clear every target before shots run out.")],
    [T("Materials"), T("Ice (pale, smooth) breaks easily, wood (brown) is sturdy, stone (grey) is tough.")],
    [T("Keyboard"), keys],
    [T("Gamepad"), T("Gamepad: the D-pad or left stick aims, A launches, the right shoulder fast-forwards, X undoes in practice, Start pauses.")],
    [T("Score"), T("Targets 1000 each, blocks by material, plus 500 per unused shot. Beat par for stars.")],
  ];
  // .rule-cards: repeat(auto-fit, minmax(200px, 1fr)), gap 10
  const cols = Math.max(1, Math.min(cards.length, Math.floor((w + 10) / 210)));
  const cw = (w - (cols - 1) * 10) / cols;
  ui.column("rule-cards", () => {
    for (let r = 0; r * cols < cards.length; r++) {
      const row = cards.slice(r * cols, r * cols + cols);
      const hgt = Math.max(...row.map(([h, p]) => cardHeight(h, p, cw - 24)));
      ui.row(`rule-row-${r}`, () => {
        row.forEach(([h, p], i) => ui.column(`rule-${r}-${i}`, () => {
          para(h, cw - 24, "rule-h3");
          para(p, cw - 24, "rule-p", i === 0 && r === 0 ? "help-aim" : undefined);
        }, { style: "rule-card", width: cw, height: hgt, spacing: 4 }));
      }, { spacing: 10 });
    }
  }, { width: w, spacing: 10 });
  button({ id: "btn-help-close", text: T("Close"), act: actions.closeHelp });
}
function cardHeight(h: string, p: string, w: number): number {
  const sc = ui.preferences().scale;
  const a = ui.measureText(h, { style: ["rule-h3"], width: w }).height / sc;
  const b = ui.measureText(p, { style: ["rule-p"], width: w }).height / sc;
  return a + b + 4 + 20 + 4;
}
function pausePanel(w: number): void {
  heading("panel-h2", T("Paused"), w, "pause-h");
  button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", act: actions.resume });
  flow("pause-row", [
    { id: "btn-pause-restart", text: T("Restart"), act: actions.restart },
    { id: "btn-pause-help", text: T("Help"), act: actions.help },
    { id: "btn-pause-settings", text: T("Settings"), act: actions.settings },
  ], w);
  button({ id: "btn-leave", text: T("Leave round"), act: actions.quitTitle });
}
/** A row with a check box and its label (index.html #ov-settings label > input[type=checkbox]); the label wraps. */
function toggle(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  const tw = w - 56;
  ui.row(`${id}-row`, () => {
    const res = ui.id(id).widget(T(label), {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : token("btn-bg"));
        draw.strokeRoundRect(bx, by, box, box, 4, token("dim"), 1);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: "#1a1005", align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
    ui.column(`${id}-txt`, () => para(T(label), tw, "text"), { width: tw });
  }, { spacing: 12, width: w, align: "center" });
}
function settingsPanel(w: number): void {
  heading("panel-h2", T("Settings"), w, "settings-h");
  para(T("Sound, graphics, language, larger text, high contrast, reduced motion and vibration are in the StarHermit Options."), w, "dim", "options-note");
  flow("settings-runtime", [
    { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
    { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
  ], w);
  const o = platform.options;
  ui.column("fs-a11y", () => {
    ui.style("legend").label(T("Accessibility"));
    toggle("opt-lefty", N("Left-handed controls"), o.leftHanded, w - 28, (v) => platform.setOption("leftHanded", v));
    toggle("opt-assist", N("Timing assist (longer aim window)"), o.timingAssist, w - 28, (v) => platform.setOption("timingAssist", v));
  }, { style: "fieldset", width: w, spacing: 4 });
  button({ id: "btn-settings-done", text: T("Done"), act: actions.closeSettings });
}
function resultsPanel(w: number, L: Layout): void {
  const r = app.results;
  if (!r) return;
  const res = r.result;
  heading("panel-h2", res.won ? T("Stage Clear!") : T("Out of Shots"), w, "res-title");
  ui.style("res-score").id("res-score").label(T("{n} points", { n: res.score.total }));
  const c2 = 90, c1 = Math.min(w - c2, Math.max(...[N("Targets"), N("Blocks"), N("Unused-shot bonus")].map((k) => textWidth(T(k), "cell"))) + 24);
  ui.column("res-breakdown", () => {
    ([[N("Targets"), res.score.targets], [N("Blocks"), res.score.blocks], [N("Unused-shot bonus"), res.score.shotsBonus]] as [string, number][]).forEach(([label, v], i) =>
      ui.row(`res-row-${i}`, () => {
        ui.column(`res-row-${i}-a`, () => para(T(label), c1 - 12, "cell"), { width: c1 });
        ui.column(`res-row-${i}-b`, () => ui.style("cell-num").label(String(v)), { width: c2, align: "end" });
      }, { width: c1 + c2 }));
  }, { width: c1 + c2, spacing: L.short ? 0 : 3 });
  if (res.won && r.stars != null) ui.style("res-stars").id("res-stars").label("★".repeat(r.stars) + "☆".repeat(3 - r.stars));
  if (app.achievement) para(T("Achievement unlocked: {name}", { name: T(app.achievement) }), w, "accent", "res-achievement");
  if (r.note) para(T(r.note), w, "dim", "res-ranked");
  const lb = leaderboardLine();
  if (lb) para(lb, w, "dim", "res-lb");
  if (app.board && app.board.length) {
    ui.style("board-h").label(T("Leaderboard (top {n})", { n: app.board.length }));
    const me = platform.displayName();
    for (const e of app.board) para(`${e.rank}. ${e.name || T("Player")} — ${e.score}`, w, e.name && e.name === me ? "board-me" : "dim");
  }
  const row: Btn[] = [{ id: "btn-retry", text: T("Retry"), style: "btn-primary", act: actions.restart }];
  if (res.won) row.push({ id: "btn-next", text: T("Next stage"), act: actions.next });
  flow("res-row", row, w);
  button({ id: "btn-menu-title", text: T("Menu"), act: actions.quitTitle });
}
void SessionMod;
