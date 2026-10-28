// The look of the HUD, menus and panels: the browser build's style.css,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (selects, scroll bars, focus
// rings) take, in the old system-ui sans-serif. The old body.high-contrast
// palette is a token set here, applied while the runtime's high-contrast
// option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
let base: Tokens = {};
/** style.css body.high-contrast. */
const HIGH_CONTRAST: Tokens = {
  "panel-bg": "#000000", "panel-fg": "#ffffff", "btn-bg": "#000000", "btn-bg-hover": "#333333",
  accent: "#ffaa00", "accent-2": "#ffdd00", dim: "#dddddd", "chip-bg": "#000000",
};
let current: Tokens = {};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  current = { ...base };
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 10, radius: 10,
    text: "#eef4f8", muted: "#9fb2c0", panel: "#121c26", control: "#24384a", hovered: "#31506a",
    pressed: "#1b2a38", field: "#24384a", accent: "#ff8c5a", focus: "#ffd166", outline: "#9fb2c0",
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$panel-fg" } },
    paragraph: { text: { color: "$panel-fg" } },
    heading: { text: { color: "$panel-fg" } },
    widget: { focusRing: { color: "$focus-ring", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$dim", radius: 4 } } },
    // the old overlay panels sat over the island without a dimming backdrop
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#00000000" } } },
  });
}

let key = "";
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyPalette(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...base, ...(highContrast ? HIGH_CONTRAST : {}) };
  ui.setTokens(current);
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
