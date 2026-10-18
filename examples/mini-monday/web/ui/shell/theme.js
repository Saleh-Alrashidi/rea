/**
 * Theme mode: "system" (follow `prefers-color-scheme`), "light" or "dark".
 * The choice is remembered per browser (a convenience only: storage
 * failures fall back to "system") and applied as `<html data-theme>`, which
 * `styles/tokens.css` reads.
 */

const STORAGE_KEY = "worklane-theme";
const MODES = new Set(["system", "light", "dark"]);
const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set();

/** Theme modes in menu order. */
export const THEME_MODES = Object.freeze([
  { mode: "system", label: "System", icon: "monitor" },
  { mode: "light", label: "Light", icon: "sun" },
  { mode: "dark", label: "Dark", icon: "moon" },
]);

function root() {
  return globalThis.document.documentElement;
}

function readStored() {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return MODES.has(value) ? value : "system";
  } catch {
    return "system";
  }
}

function systemTheme() {
  return globalThis.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

function apply(mode) {
  if (mode === "system") delete root().dataset.theme;
  else root().dataset.theme = mode;
}

function notify() {
  const detail = { mode: themeMode(), theme: currentTheme() };
  for (const listener of Array.from(listeners)) listener(detail);
}

/** The chosen mode: "system", "light" or "dark". */
export function themeMode() {
  const chosen = root().dataset.theme;
  return MODES.has(chosen) ? chosen : "system";
}

/** The theme in effect: "light" or "dark". */
export function currentTheme() {
  const mode = themeMode();
  return mode === "system" ? systemTheme() : mode;
}

/** Applies the stored mode and follows system changes while in "system". */
export function initTheme() {
  apply(readStored());
  globalThis.matchMedia?.(DARK_QUERY).addEventListener?.("change", () => {
    if (themeMode() === "system") notify();
  });
}

/** Sets and remembers the mode, then notifies listeners. */
export function setThemeMode(mode) {
  const next = MODES.has(mode) ? mode : "system";
  apply(next);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted; the choice still applies to this page.
  }
  notify();
}

/** Calls `listener({ mode, theme })` when the effective theme may change. */
export function onThemeChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
