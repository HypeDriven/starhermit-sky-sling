// Localization: the engine's string tables (assets/strings.json: the nine
// StarHermit locales, US-English text as the key) in the interface language the
// runtime reports (the player's choice in Options › Language, else the
// account's preferred language or the device's). Every string is drawn through
// T() each frame, so a change shows on the next frame, mid-round included. The
// account lines are the engine's own `starhermit.*` strings.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));
export function currentLocale(): string { return strings.locale; }

export type Vars = Record<string, string | number>;
const fill = (s: string, vars: Vars): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m));
/** A game string by its English key in the player's language (unknown strings pass through); `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  if (strings.has(key)) return strings.t(key, vars ?? undefined);
  return vars ? fill(key, vars) : key;
}
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
const ACCOUNT = {
  signIn: "signIn", invite: "invite", copied: "inviteCopied", copyFailed: "inviteFailed", signedOut: "signedOut",
  lbPosting: "leaderboardPosting", lbRank: "leaderboardRank", lbPosted: "leaderboardPosted", lbNotPosted: "leaderboardNotPosted",
} as const;
/** An account line (the engine's) in the player's language. */
export function S(key: keyof typeof ACCOUNT, vars?: Vars): string { return strings.t(`starhermit.${ACCOUNT[key]}`, vars); }
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
