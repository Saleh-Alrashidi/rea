/**
 * Chromium for the browser tests (see `e2e-lib.mjs` for the skip rules):
 * Playwright from `playwright` or `playwright-core`, and a browser from
 * MM_E2E_CHROMIUM, Playwright's own download or its browser cache.
 */
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const CHROME_PATHS = {
  linux: [
    ["chrome-linux", "chrome"],
    ["chrome-linux64", "chrome"],
  ],
  darwin: [["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]],
  win32: [["chrome-win", "chrome.exe"]],
};

/** The Playwright module, or null when neither package is installed. */
export async function loadPlaywright() {
  for (const name of ["playwright", "playwright-core"]) {
    try {
      const module = await import(name);
      return module.chromium ? module : module.default;
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  return null;
}

const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

/** A Chromium from the Playwright browser cache, newest revision first. */
async function installedChromium() {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(homedir(), ".cache", "ms-playwright");
  const names = (await readdir(root).catch(() => []))
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const name of names) {
    for (const parts of CHROME_PATHS[process.platform] ?? []) {
      const file = path.join(root, name, ...parts);
      if (await exists(file)) return file;
    }
  }
  return null;
}

/** Launches headless Chromium, or returns null when none is installed. */
export async function launchBrowser(chromium) {
  // Chromium refuses its sandbox when run as root (as in containers).
  const args = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const executablePath = process.env.MM_E2E_CHROMIUM || undefined;
  try {
    return await chromium.launch({ headless: true, args, executablePath });
  } catch (error) {
    if (executablePath || !/Executable doesn't exist/.test(error.message)) {
      throw error;
    }
  }
  // The installed Playwright may expect a browser revision that is missing.
  const fallback = await installedChromium();
  if (!fallback) return null;
  return chromium.launch({ headless: true, args, executablePath: fallback });
}
