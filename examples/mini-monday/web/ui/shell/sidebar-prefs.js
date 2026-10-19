/**
 * The sidebar's per-user conveniences (SPEC-6 §3.3), kept in this
 * browser's localStorage: which Spaces and folders are expanded and the
 * Favorites list. Both are only conveniences: storage that is missing,
 * full, blocked or holds something unexpected reads as empty, and a
 * failed write changes nothing on screen.
 *
 * Favorites are node keys ("board:12", "folder:3", …; `sidebar-model.js`)
 * in the order they were added. A favorite the tree does not show (not
 * loaded, or no longer accessible) stays stored but is not listed, so
 * regaining access brings it back.
 */

import { parseKey } from "./sidebar-model.js";

/** At most this many favorites and expanded entries are kept. */
export const MAX_ENTRIES = 200;

const favoritesKey = (userId) => `worklane-favorites:${userId}`;
const treeKey = (userId) => `worklane-sidebar-tree:${userId}`;

function readJson(key, storage) {
  try {
    const text = storage?.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value, storage) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // A convenience only.
  }
}

const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The valid, distinct node keys of `value` (an array), capped. */
export function readFavorites(value) {
  if (!Array.isArray(value)) return [];
  const keys = value.filter((key) => parseKey(key) !== null);
  return [...new Set(keys)].slice(0, MAX_ENTRIES);
}

/** `keys` with `key` added at the end, or removed when it is there. */
export function toggleFavorite(keys, key) {
  if (keys.includes(key)) return keys.filter((each) => each !== key);
  return [...keys, key].slice(-MAX_ENTRIES);
}

/** The nodes of `keys` that `byKey` (a Map of shown nodes) holds, in order. */
export const favoriteNodes = (keys, byKey) =>
  keys.map((key) => byKey.get(key)).filter(Boolean);

/** The `{ [key]: boolean }` entries of `value` with valid keys, capped. */
export function readExpanded(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    ([key, open]) => parseKey(key) !== null && typeof open === "boolean",
  );
  return Object.fromEntries(entries.slice(-MAX_ENTRIES));
}

/**
 * The stored conveniences of user `userId`: `{ favorites, expanded,
 * setFavorites(keys), setExpanded(key, open) }`. `storage` defaults to
 * localStorage (injectable for tests).
 */
export function sidebarPrefs(userId, storage = defaultStorage()) {
  const prefs = {
    favorites: readFavorites(readJson(favoritesKey(userId), storage)),
    expanded: readExpanded(readJson(treeKey(userId), storage)),
    setFavorites(keys) {
      prefs.favorites = readFavorites(keys);
      writeJson(favoritesKey(userId), prefs.favorites, storage);
    },
    setExpanded(key, open) {
      const { [key]: _old, ...rest } = prefs.expanded;
      prefs.expanded = readExpanded({ ...rest, [key]: open });
      writeJson(treeKey(userId), prefs.expanded, storage);
    },
  };
  return prefs;
}
