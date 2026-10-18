/**
 * Worklane host app entry: loads the shell data (me, account, workspaces),
 * builds the page context, mounts the shell (top bar, sidebar, command
 * palette, notification stream) and starts the hash router.
 *
 * ## Page contract (SPEC-2 §5.1)
 *
 * Every `pages/*.js` module exports
 * `async function mount(container, ctx, params) → (() => void) | void`.
 * `container` is a fresh element for this mount (detached after cleanup, so
 * late async renders are harmless); `params` holds the route's ID params
 * (strings) and fixed params such as the board `view`. The returned function
 * runs before the next page mounts. Routes that share a mount key (board
 * views and item cards, notes and an open note, admin tabs) do not remount:
 * subscribe with `ctx.router.onChange` at the start of `mount`.
 *
 * @typedef {object} PageContext
 * @property {typeof import("./api.js")} api
 *   The HTTP client: `api.request(query, variables)` → `data` (throws an
 *   `ApiError` with `.code`, e.g. "NOT_FOUND", "FORBIDDEN",
 *   "VERSION_CONFLICT" with `.version`), `api.graphql(...)` for the raw
 *   body, `api.subscribeBoardEvents`, `api.subscribeMyEvents`.
 * @property {object} me
 *   The signed-in user: `{ id, name, email, initials, is_admin, role,
 *   title, color, status }`. Replaced (not mutated) by `refreshShell()`;
 *   read `ctx.me` each time instead of keeping a copy.
 * @property {object} account
 *   `{ id, name, user_count, role_counts_json }`, refreshed like `me`.
 * @property {object} router
 *   `navigate(hash, { replace })`, `current()` → `{ name, path, params,
 *   key }`, `onChange(listener)` → unsubscribe, `reload()`. Hash builders
 *   (`boardHash`, `docHash`, `noteHash`, …) are exported by `router.js`.
 * @property {typeof import("./ui/components/toast.js").toast} toast
 *   `show({ message, type, timeout, action })`, `success(message)`,
 *   `info(message)`, `error(error, fallback)`.
 * @property {{ confirm: Function, form: Function, open: Function }} dialog
 *   `confirm(options)` → Promise<boolean>, `form({ title, fields,
 *   submitLabel })` → Promise<values | null>, `open(options)` → handle
 *   (see `ui/components/dialog.js`).
 * @property {(options: { resourceKind: "workspace" | "board" | "doc" | "note",
 *   resourceId: string }) => Promise<{ changed: boolean, lostAccess: boolean }>} openShare
 *   Opens the shared share dialog. Afterwards the shell is refreshed when
 *   something changed, and the app goes Home when the user removed their
 *   own access.
 * @property {() => Promise<void>} refreshShell
 *   Reloads me, account, workspaces (sidebar), forms and the unread count,
 *   and drops the cached user/team directory. Call it after creating,
 *   renaming, sharing or deleting anything the sidebar lists.
 * @property {ReturnType<typeof import("./ui/shell/bus.js").createBus>} bus
 *   Event emitter: `on(type, listener)` → off, `emit(type, data)`,
 *   `watchBoard(boardId, listener)` → unwatch (board SSE). Events:
 *   "notification", "board-change", "theme", "shell", "workspace" (see
 *   `ui/shell/bus.js`).
 */

import * as api from "./api.js";
import { clear, h } from "./dom.js";
import { createRouter, registerAppRoutes } from "./router.js";
import { createCommandPalette } from "./ui/components/command-palette.js";
import {
  confirmDialog,
  formDialog,
  openDialog,
} from "./ui/components/dialog.js";
import { emptyState } from "./ui/components/empty-state.js";
import { can } from "./ui/components/permissions.js";
import { openShareDialog } from "./ui/components/share-dialog.js";
import { skeletonPage } from "./ui/components/skeleton.js";
import { mountToasts, toast } from "./ui/components/toast.js";
import { BUS_EVENTS, createBus } from "./ui/shell/bus.js";
import { createShell } from "./ui/shell/shell.js";
import { loadShellData } from "./ui/shell/shell-data.js";
import { initTheme } from "./ui/shell/theme.js";

const doc = () => globalThis.document;

function elements() {
  const d = doc();
  return {
    app: d.getElementById("app"),
    topbar: d.getElementById("topbar"),
    sidebar: d.getElementById("sidebar"),
    backdrop: d.getElementById("sidebar-backdrop"),
    page: d.getElementById("page"),
  };
}

function pageFailed(error, retry) {
  return emptyState({
    icon: "alert",
    title: "This page didn’t load",
    text: error?.message || "Something went wrong while opening this page.",
    action: { label: "Try again", icon: "refresh", onClick: retry },
  });
}

function renderOffline(page) {
  doc().title = "Worklane";
  clear(page).append(
    h(
      "div",
      { class: "page-root" },
      emptyState({
        icon: "alert",
        title: "Can’t reach Worklane",
        text: "The server did not answer. Start it and reload this page.",
        action: {
          label: "Reload",
          icon: "refresh",
          onClick: () => globalThis.location.reload(),
        },
      }),
    ),
  );
}

/** Quick actions of the command palette, filtered by account role. */
function paletteActions(ctx, flows) {
  const create = can(ctx.me, "create_content");
  return [
    create && {
      id: "new-board",
      label: "New board",
      icon: "grid",
      keywords: ["create"],
      run: () => flows.board(),
    },
    create && {
      id: "new-doc",
      label: "New doc",
      icon: "docs",
      keywords: ["create", "document"],
      run: () => flows.doc(),
    },
    can(ctx.me, "create_note") && {
      id: "new-note",
      label: "New note",
      icon: "notes",
      keywords: ["create"],
      run: () => flows.note(),
    },
    {
      id: "go-home",
      label: "Go to Home",
      icon: "home",
      run: () => ctx.router.navigate("#/home"),
    },
    {
      id: "go-my-work",
      label: "Go to My work",
      icon: "myWork",
      run: () => ctx.router.navigate("#/my-work"),
    },
    {
      id: "go-shared",
      label: "Go to Shared with me",
      icon: "shared",
      run: () => ctx.router.navigate("#/shared"),
    },
    {
      id: "go-notes",
      label: "Go to Notes",
      icon: "notes",
      run: () => ctx.router.navigate("#/notes"),
    },
  ].filter(Boolean);
}

async function openShare(ctx, options) {
  const result = await openShareDialog({ ctx, ...options });
  if (result.changed) await ctx.refreshShell();
  if (result.lostAccess) ctx.router.navigate("#/home");
  return result;
}

async function start() {
  const dom = elements();
  initTheme();
  mountToasts(doc().getElementById("toasts"));
  dom.page.replaceChildren(skeletonPage());
  let data;
  try {
    data = await loadShellData();
  } catch (error) {
    globalThis.console?.error?.("Startup failed", error);
    renderOffline(dom.page);
    return;
  }
  const router = registerAppRoutes(createRouter());
  const bus = createBus({ subscribeBoardEvents: api.subscribeBoardEvents });
  /** @type {PageContext} */
  const ctx = {
    api,
    me: data.me,
    account: data.account,
    router,
    toast,
    dialog: { confirm: confirmDialog, form: formDialog, open: openDialog },
    openShare: (options) => openShare(ctx, options),
    refreshShell: () => shell.refresh(),
    bus,
  };
  let palette = null;
  const shell = createShell({
    ctx,
    data,
    elements: dom,
    openPalette: () => palette.open(),
  });
  palette = createCommandPalette({
    router,
    actions: () => paletteActions(ctx, shell.flows),
  });
  try {
    api.subscribeMyEvents((event) => bus.emit(BUS_EVENTS.notification, event));
  } catch (error) {
    globalThis.console?.error?.("Notification stream unavailable", error);
  }
  router.start({
    outlet: dom.page,
    ctx,
    loading: () => skeletonPage(),
    failed: pageFailed,
  });
}

start();
