// Localization: the browser build's string tables (locales/*.js through
// i18n.js: the nine StarHermit locales, US-English text as the key) and the
// account strings (sh-strings.js), in the interface language the runtime
// reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replace the game's Language section (sh-language.js) and
// the DOM re-labelling: every string is drawn through T() each frame, so a
// change shows on the next frame, mid-round included.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { I18n, ShStrings, type AccountStrings } from "./classic.ts";

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (sh-language.js: es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US").replace("_", "-");
  const exact = I18n.LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  I18n.setLocale(next);
  locale = I18n.getLang();
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return I18n.T(key, vars ?? null); }
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account strings (signIn, invite, copied, copyFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: keyof AccountStrings, vars?: Vars): string {
  let s = ShStrings.strings(locale)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
/** Player-facing names for mode ids (boot.js MODE_NAMES). */
export function modeLabel(m: string | null): string {
  if (!m) return "";
  return T(({ learn: N("Learn"), journey: N("Journey"), daily: N("Daily"), practice: N("Practice"), challenge: N("Challenge") } as Record<string, string>)[m] ?? m);
}
/** boot.js REASONS: rules and session rejection reasons. */
const REASONS: Record<string, string> = {
  "round-over": N("The round is over."), resolving: N("Wait for the shot to settle."),
  "no-shots-left": N("No shots left."), "velocity-not-a-number": N("Invalid aim."),
  "velocity-out-of-range": N("That shot is too strong."), "must-launch-rightward": N("Aim to the right."),
  "malformed-command": N("Invalid command."), "unknown-command": N("Invalid command."),
  "not-active": N("The round is not active."), "no-round": N("No round in progress."),
  "no-such-level": N("That stage does not exist."),
};
export function reasonText(r: string | undefined): string { return T(REASONS[r ?? ""] ?? r ?? ""); }
