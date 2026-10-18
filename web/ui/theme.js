/**
 * Light/dark theme. The system preference applies until the user picks a
 * theme, which is remembered per browser (a convenience only; storage
 * failures fall back to the system theme).
 */

const STORAGE_KEY = "mini-monday-theme";
const THEMES = new Set(["light", "dark"]);
const DARK_QUERY = "(prefers-color-scheme: dark)";

function root() {
  return globalThis.document.documentElement;
}

function readStored() {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return THEMES.has(value) ? value : null;
  } catch {
    return null;
  }
}

function systemTheme() {
  return globalThis.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** The theme in effect: "light" or "dark". */
export function currentTheme() {
  const chosen = root().dataset.theme;
  return THEMES.has(chosen) ? chosen : systemTheme();
}

/** Applies a stored choice and calls `onChange()` when the theme changes. */
export function initTheme(onChange) {
  const stored = readStored();
  if (stored) root().dataset.theme = stored;
  globalThis.matchMedia?.(DARK_QUERY).addEventListener?.("change", () => {
    if (!THEMES.has(root().dataset.theme)) onChange();
  });
}

/** Switches between light and dark and remembers the choice. */
export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  root().dataset.theme = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted; the choice still applies to this page.
  }
  return next;
}
