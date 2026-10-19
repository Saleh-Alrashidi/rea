/**
 * Hash router and the app's route table.
 *
 * `register(pattern, loader, options)` maps a path pattern to a lazily
 * imported page module (`pages/*.js`, see the page contract in `main.js`).
 * Patterns are literal paths whose `:name` placeholders match numeric IDs
 * (1–20 digits), also inside a segment (`/views/app-:installId`). Nothing
 * else matches, so malformed IDs fall through to the not-found page instead
 * of reaching a page.
 *
 * Mounting: each mount gets a fresh root element inside the outlet; the
 * previous page's cleanup runs first. Routes whose `key(params)` equals the
 * mounted page's key (the board's views and its task view, a note opened
 * over the notes grid) do not remount: the page sees the change through
 * `onChange`. Pages should subscribe at the start of `mount`, before their
 * first await.
 */

import { h } from "./dom.js";

const ID_SOURCE = "(\\d{1,20})";
const PLACEHOLDER = /(:[A-Za-z][A-Za-z0-9]*)/;
export const DEFAULT_PATH = "/home";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a route pattern.
 * @param {string} pattern e.g. "/boards/:boardId/views/app-:installId"
 * @returns {{ regex: RegExp, names: string[] }}
 */
export function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) {
    throw new TypeError("Route patterns start with /");
  }
  const names = [];
  const source = pattern
    .split(PLACEHOLDER)
    .map((part) => {
      if (!part.startsWith(":")) return escapeRegExp(part);
      names.push(part.slice(1));
      return ID_SOURCE;
    })
    .join("");
  return { regex: new RegExp(`^${source}/?$`), names };
}

/** The route path of a location hash ("#/boards/1" → "/boards/1"). */
export function pathFromHash(hash) {
  const text = String(hash ?? "").replace(/^#/, "");
  return text === "" || text === "/" ? "" : text;
}

/**
 * The in-app hash of a URL the server produced (`Board.url`, a search
 * result, a notification): "#/…" fragments and same-origin links to the
 * app root are accepted; anything else returns null so data can never
 * navigate the page elsewhere.
 *
 * @param {string} url
 * @param {string} [origin] defaults to the page origin
 * @returns {string | null}
 */
export function hashFromUrl(url, origin = globalThis.location?.origin) {
  if (typeof url !== "string" || url === "") return null;
  if (url.startsWith("#/")) return url;
  let parsed;
  try {
    parsed = new URL(url, `${origin}/`);
  } catch {
    return null;
  }
  const sameApp = parsed.origin === origin && parsed.pathname === "/";
  return sameApp && parsed.hash.startsWith("#/") ? parsed.hash : null;
}

// --------------------------------------------------------- hash builders

export const homeHash = () => "#/home";
export const myWorkHash = () => "#/my-work";
export const sharedHash = () => "#/shared";
export const docsHash = () => "#/docs";
export const notesHash = () => "#/notes";
export const teamsHash = () => "#/teams";
export const adminHash = () => "#/admin";
export const adminContentHash = () => "#/admin/content";
export const importHash = () => "#/import";
export const workspaceHash = (id) => `#/workspaces/${id}`;
export const workspaceSettingsHash = (id) => `#/workspaces/${id}/settings`;
export const boardHash = (id) => `#/boards/${id}`;
export const docHash = (id) => `#/docs/${id}`;
export const noteHash = (id) => `#/notes/${id}`;
export const formHash = (id) => `#/forms/${id}`;
export const teamHash = (id) => `#/teams/${id}`;

/** Board views reachable by URL (app views carry an install ID). */
export const BOARD_VIEWS = Object.freeze([
  "list",
  "table",
  "kanban",
  "activity",
  "forms",
  "app",
]);

/**
 * Hash of a board view (`{ view, installId }`). Without a known view it is
 * the board's own link, which opens the board's default view (SPEC-5
 * §3.1); table and list have explicit routes.
 */
export function viewHash(boardId, { view, installId } = {}) {
  if (view === "app" && installId) {
    return `${boardHash(boardId)}/views/app-${installId}`;
  }
  if (view && view !== "app" && BOARD_VIEWS.includes(view)) {
    return `${boardHash(boardId)}/views/${view}`;
  }
  return boardHash(boardId);
}

/** `#/boards/<id>/items/<itemId>` */
export function itemHash(boardId, itemId) {
  return `${boardHash(boardId)}/items/${itemId}`;
}

// ------------------------------------------------------------ the router

/**
 * @typedef {object} Route
 * @property {string} name     registration name ("board", "home", …)
 * @property {string} path     matched path ("/boards/12/views/kanban")
 * @property {Record<string, string | null>} params
 * @property {string} key      mount identity (same key → no remount)
 */

/** Matches a hash or path against `routes` (pure; no mounting). */
function resolveRoute(r, hashOrPath) {
  const path = pathFromHash(hashOrPath) || DEFAULT_PATH;
  for (const route of r.routes) {
    const match = route.regex.exec(path);
    if (!match) continue;
    const params = { ...route.params };
    route.names.forEach((name, index) => (params[name] = match[index + 1]));
    const key = route.key ? route.key(params) : `${route.name}:${path}`;
    return { name: route.name, path, params, key, loader: route.loader };
  }
  const key = `not-found:${path}`;
  return { name: "not-found", path, params: {}, key, loader: r.fallback };
}

function runCleanup(cleanup) {
  if (typeof cleanup !== "function") return;
  try {
    cleanup();
  } catch (error) {
    globalThis.console?.error?.("Page cleanup failed", error);
  }
}

function teardown(r) {
  const previous = r.mounted;
  r.mounted = null;
  if (!previous) return;
  runCleanup(previous.cleanup);
  previous.root.remove();
}

function notify(r, route) {
  for (const listener of Array.from(r.listeners)) {
    try {
      listener(route);
    } catch (error) {
      globalThis.console?.error?.("Route listener failed", error);
    }
  }
}

async function mountRoute(r, route, { initial, hash }) {
  const token = ++r.seq;
  const { outlet, ctx, loading, failed } = r.host;
  teardown(r);
  r.guards.clear();
  const root = h("div", { class: "page-root" });
  const entry = { key: route.key, root, cleanup: null, hash };
  r.mounted = entry;
  outlet.dataset.page = route.name;
  outlet.replaceChildren(root);
  outlet.scrollTop = 0;
  root.append(loading());
  notify(r, route);
  try {
    const module = await route.loader();
    if (token !== r.seq) return;
    root.replaceChildren();
    const cleanup = await module.mount(root, ctx, { ...route.params });
    if (token !== r.seq || r.mounted !== entry) runCleanup(cleanup);
    else entry.cleanup = cleanup;
  } catch (error) {
    if (token !== r.seq) return;
    globalThis.console?.error?.(`Page ${route.name} failed`, error);
    root.replaceChildren(failed(error, () => reloadRoute(r)));
  }
  if (!initial && token === r.seq) outlet.focus({ preventScroll: true });
}

/**
 * Whether the mounted page may be left for `route`: a page's leave guard
 * returns a question (unsaved changes) the user must confirm. Declining
 * puts the page's own hash back.
 */
function mayLeave(r, route) {
  if (!r.mounted || r.mounted.key === route.key) return true;
  for (const guard of r.guards) {
    const question = guard();
    if (!question) continue;
    if (r.win.confirm(question)) return true;
    r.win.location.replace(r.mounted.hash);
    return false;
  }
  return true;
}

function applyLocation(r, { initial = false } = {}) {
  const hash = r.win.location.hash;
  if (pathFromHash(hash) === "") {
    r.win.location.replace(`#${DEFAULT_PATH}`);
    if (!initial) return;
  }
  const route = resolveRoute(r, hash);
  if (!mayLeave(r, route)) return;
  r.current = route;
  if (r.mounted && r.mounted.key === route.key) {
    r.mounted.hash = hash;
    notify(r, route);
    return;
  }
  mountRoute(r, route, { initial, hash });
}

function reloadRoute(r) {
  const hash = r.mounted?.hash ?? r.win.location.hash;
  if (r.current) mountRoute(r, r.current, { initial: false, hash });
}

/**
 * Creates a router. `window` is injectable for tests.
 * @param {{ window?: Window }} [options]
 */
export function createRouter({ window: win = globalThis.window } = {}) {
  const r = {
    win,
    routes: [],
    listeners: new Set(),
    guards: new Set(),
    fallback: null,
    current: null,
    mounted: null,
    seq: 0,
    host: null,
  };
  const router = {
    /**
     * Adds a route. `options.name` names the page (default: the pattern),
     * `options.params` adds fixed params, `options.key(params)` returns the
     * mount identity shared by routes that update one mounted page.
     */
    register(pattern, loader, options = {}) {
      r.routes.push({
        ...compilePattern(pattern),
        loader,
        name: options.name ?? pattern,
        params: options.params ?? {},
        key: options.key ?? null,
      });
      return router;
    },
    /** Sets the page module for unknown paths. */
    setFallback(loader) {
      r.fallback = loader;
      return router;
    },
    /** Matches a hash or path (pure): `{ name, path, params, key, loader }`. */
    resolve: (hashOrPath) => resolveRoute(r, hashOrPath),
    /**
     * Starts listening to `hashchange` and mounts the current route into
     * `outlet`. `loading()` and `failed(error, retry)` build the content
     * shown while a page module loads and when it fails.
     */
    start({ outlet, ctx, loading, failed }) {
      r.host = { outlet, ctx, loading, failed };
      win.addEventListener("hashchange", () => applyLocation(r));
      applyLocation(r, { initial: true });
    },
    /** Navigates to a "#/…" hash or "/…" path (`replace` keeps history). */
    navigate(target, { replace = false } = {}) {
      const hash = `#${pathFromHash(target) || DEFAULT_PATH}`;
      if (win.location.hash === hash) applyLocation(r);
      else if (replace) win.location.replace(hash);
      else win.location.hash = hash;
    },
    /** The current route (`{ name, path, params, key }`) or null. */
    current: () =>
      r.current && {
        name: r.current.name,
        path: r.current.path,
        params: { ...r.current.params },
        key: r.current.key,
      },
    /** Calls `listener(route)` after every route change; returns unsubscribe. */
    onChange(listener) {
      r.listeners.add(listener);
      return () => r.listeners.delete(listener);
    },
    /** Remounts the current page. */
    reload: () => reloadRoute(r),
    /**
     * Registers a leave guard for the mounted page: `guard()` returns a
     * question to confirm before navigating to another page (unsaved
     * changes) or null. Returns unregister; guards end with their page.
     */
    guard(guard) {
      r.guards.add(guard);
      return () => r.guards.delete(guard);
    },
  };
  return router;
}

// ------------------------------------------------------- the route table

const page = (name) => () => import(`./pages/${name}.js`);
const BOARD = page("board");
const boardKey = (params) => `board:${params.boardId}`;
/** A board route whose `view` param is fixed (null: the default view). */
const boardRoute = (path, view) => [
  `/boards/:boardId${path}`,
  BOARD,
  { name: "board", key: boardKey, params: { view } },
];
const NOTES = page("notes");
const ADMIN = page("admin");

/**
 * `[pattern, loader, options]` for every route of SPEC-2 §5.1, SPEC-4 §6
 * and SPEC-5 §3.1.
 */
export const APP_ROUTES = Object.freeze([
  ["/home", page("home"), { name: "home" }],
  ["/my-work", page("my-work"), { name: "my-work" }],
  ["/shared", page("shared"), { name: "shared" }],
  ["/workspaces/:workspaceId", page("workspace"), { name: "workspace" }],
  [
    "/workspaces/:workspaceId/settings",
    page("workspace-settings"),
    { name: "workspace-settings" },
  ],
  // The board's own link opens its default view; an item route keeps
  // the view the user came from (both have no `view`).
  boardRoute("", null),
  boardRoute("/views/list", "list"),
  boardRoute("/views/table", "table"),
  boardRoute("/views/kanban", "kanban"),
  boardRoute("/views/activity", "activity"),
  boardRoute("/views/forms", "forms"),
  boardRoute("/views/app-:installId", "app"),
  boardRoute("/items/:itemId", null),
  ["/docs", page("docs"), { name: "docs" }],
  ["/docs/:docId", page("doc-editor"), { name: "doc-editor" }],
  ["/notes", NOTES, { name: "notes", key: () => "notes" }],
  ["/notes/:noteId", NOTES, { name: "notes", key: () => "notes" }],
  ["/forms/:formId", page("form-builder"), { name: "form-builder" }],
  ["/teams", page("teams"), { name: "teams" }],
  ["/teams/:teamId", page("teams"), { name: "team" }],
  [
    "/admin",
    ADMIN,
    { name: "admin", key: () => "admin", params: { tab: "users" } },
  ],
  [
    "/admin/content",
    ADMIN,
    { name: "admin", key: () => "admin", params: { tab: "content" } },
  ],
  // SPEC-4 §6: the importer (admins; the Admin page links to it).
  ["/import", page("import"), { name: "import" }],
]);

/** Loader of the not-found page (also the fallback for unknown paths). */
export const NOT_FOUND_PAGE = page("not-found");

/** Registers `APP_ROUTES` and the not-found fallback on `router`. */
export function registerAppRoutes(router) {
  for (const [pattern, loader, options] of APP_ROUTES) {
    router.register(pattern, loader, options);
  }
  return router.setFallback(NOT_FOUND_PAGE);
}
