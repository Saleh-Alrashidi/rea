/**
 * The shell controller: owns the shell data (`shell-data.js`), the top
 * bar and sidebar (`sidebar.js`), the navigation drawer (under 900 px)
 * or collapsed sidebar (wider screens) and `refreshShell()`.
 *
 * The sidebar's Inbox mirrors the bell's unread count and opens its
 * list. Changes to where boards, docs, folders and Spaces sit
 * (SPEC-6 §3.3: `board_moved`, `doc_moved`, `workspace_moved`,
 * `folder_*`) that reach a watched board stream refresh the shell
 * (debounced); the sidebar refreshes it after its own changes too.
 */

import { countBadge } from "../components/badge.js";
import { invalidateDirectory } from "../components/directory.js";
import { changesAccess } from "../components/labels.js";
import { isPopoverOpen } from "../components/popover.js";
import { BUS_EVENTS } from "./bus.js";
import { createFlows } from "./create.js";
import { createNotifications } from "./notifications.js";
import { loadShellData } from "./shell-data.js";
import { createSidebar } from "./sidebar.js";
import { onThemeChange } from "./theme.js";
import { createTopbar } from "./topbar.js";
import { createUserMenu } from "./user-menu.js";

const DRAWER_QUERY = "(max-width: 899px)";
const COLLAPSED_KEY = "worklane-sidebar-collapsed";
/** Change events that move things in the sidebar's tree. */
const SIDEBAR_EVENTS = new Set([
  "board_moved",
  "doc_moved",
  "workspace_moved",
  "folder_created",
  "folder_updated",
  "folder_moved",
  "folder_deleted",
]);
/** Several moves arrive together (a deleted folder's boards): one refresh. */
const LIVE_REFRESH_MS = 150;

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // A convenience only.
  }
}

const isDrawer = () => globalThis.matchMedia?.(DRAWER_QUERY).matches ?? false;

function drawSidebar(sh) {
  sh.sidebar.update({ data: sh.data, route: sh.route });
}

/** Keeps `target` (the sidebar's Inbox badge) in step with the bell's. */
function mirrorUnread(bell, target) {
  const source = bell.querySelector(".count-badge");
  if (!source) return;
  const copy = () => {
    target.textContent = source.textContent;
    target.hidden = source.hidden;
  };
  copy();
  new MutationObserver(copy).observe(source, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
}

/** The sidebar's Inbox: the bell's list (the drawer closes first). */
function openInbox(sh) {
  if (sh.drawerOpen) setDrawer(sh, false, { focus: false });
  sh.notifications.element.click();
}

function createSidebarOf(sh) {
  const inboxBadge = countBadge(0);
  inboxBadge.classList.add("sidebar-inbox-count");
  mirrorUnread(sh.notifications.element, inboxBadge);
  return createSidebar({
    container: sh.elements.sidebar,
    ctx: sh.ctx,
    flows: sh.flows,
    inboxBadge,
    onInbox: () => openInbox(sh),
    onClose: () => setDrawer(sh, false),
  });
}

/**
 * Under 900 px the open sidebar is a modal drawer over a backdrop: the rest
 * of the shell (skip link, top bar, page) is inert, so Tab stays in the
 * drawer (its own close button, Escape and the backdrop close it).
 */
function applyLayout(sh) {
  const { app, sidebar, backdrop } = sh.elements;
  const drawer = isDrawer();
  const modal = drawer && sh.drawerOpen;
  app.classList.toggle("sidebar-open", modal);
  app.classList.toggle("sidebar-collapsed", !drawer && sh.collapsed);
  sh.topbar.update({ sidebarOpen: drawer ? sh.drawerOpen : !sh.collapsed });
  sidebar.inert = drawer && !sh.drawerOpen;
  for (const child of app.children) {
    if (child !== sidebar && child !== backdrop) child.inert = modal;
  }
  if (modal) {
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
  } else {
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
  }
}

function setDrawer(sh, open, { focus = true } = {}) {
  sh.drawerOpen = open;
  applyLayout(sh);
  if (open && focus) sh.elements.sidebar.querySelector("a, button")?.focus();
}

function toggleSidebar(sh) {
  if (isDrawer()) {
    setDrawer(sh, !sh.drawerOpen);
    return;
  }
  sh.collapsed = !sh.collapsed;
  writeStorage(COLLAPSED_KEY, sh.collapsed ? "1" : null);
  applyLayout(sh);
}

async function reloadShell(sh) {
  const { ctx } = sh;
  try {
    invalidateDirectory();
    const next = await loadShellData();
    sh.data = next;
    ctx.me = next.me;
    ctx.account = next.account;
    sh.notifications.setCount(next.unread);
    sh.userMenu.update();
    drawSidebar(sh);
    ctx.bus.emit(BUS_EVENTS.shell, { workspaces: next.workspaces });
  } catch (error) {
    globalThis.console?.error?.("Shell refresh failed", error);
  }
}

/**
 * Reloads the shell data; pages call it after changes. One reload runs
 * at a time; a call during one runs one more after it (which may see a
 * change the running one missed), shared by every such call.
 */
function refresh(sh) {
  if (sh.refreshing) {
    sh.again ??= sh.refreshing.then(() => {
      sh.again = null;
      return refresh(sh);
    });
    return sh.again;
  }
  sh.refreshing = reloadShell(sh).finally(() => (sh.refreshing = null));
  return sh.refreshing;
}

function onRoute(sh, route) {
  sh.route = route;
  if (sh.drawerOpen) setDrawer(sh, false, { focus: false });
  drawSidebar(sh);
}

/** Refreshes the shell shortly after a change that moves sidebar nodes. */
function onBoardChange(sh, change) {
  if (!SIDEBAR_EVENTS.has(change?.type)) return;
  globalThis.clearTimeout(sh.liveTimer);
  sh.liveTimer = globalThis.setTimeout(() => refresh(sh), LIVE_REFRESH_MS);
}

function onKeydown(sh, event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    sh.openPalette();
    return;
  }
  if (event.key !== "Escape" || !sh.drawerOpen || isPopoverOpen()) return;
  setDrawer(sh, false, { focus: false });
  sh.elements.app.querySelector(".sidebar-toggle")?.focus();
}

function wireEvents(sh) {
  const { ctx, elements } = sh;
  elements.backdrop.addEventListener("click", () => setDrawer(sh, false));
  globalThis.document.addEventListener("keydown", (event) =>
    onKeydown(sh, event),
  );
  globalThis
    .matchMedia?.(DRAWER_QUERY)
    .addEventListener?.("change", () => applyLayout(sh));
  ctx.router.onChange((route) => onRoute(sh, route));
  // A page shows something of this Space: the tree opens it.
  ctx.bus.on(BUS_EVENTS.workspace, (id) => sh.sidebar.reveal(id));
  ctx.bus.on(BUS_EVENTS.boardChange, (change) => onBoardChange(sh, change));
  ctx.bus.on(BUS_EVENTS.notification, (event) => {
    sh.notifications.onNotification(event);
    // The sidebar, `ctx.me` and the create controls follow the new access.
    if (changesAccess(event?.kind)) refresh(sh);
  });
  onThemeChange((detail) => {
    sh.topbar.updateTheme();
    ctx.bus.emit(BUS_EVENTS.theme, detail);
  });
}

/**
 * Mounts the shell. Returns `refresh()` (`ctx.refreshShell`), the creation
 * `flows` and `markNotificationRead(notification)`
 * (`ctx.markNotificationRead`).
 *
 * @param {{ ctx: object, data: import("./shell-data.js").ShellData,
 *   elements: { app: HTMLElement, topbar: HTMLElement, sidebar: HTMLElement,
 *     backdrop: HTMLElement }, openPalette(): void }} options
 */
export function createShell({ ctx, data, elements, openPalette }) {
  const sh = {
    ctx,
    data,
    elements,
    openPalette,
    flows: createFlows(ctx),
    route: null,
    drawerOpen: false,
    collapsed: readStorage(COLLAPSED_KEY) === "1",
    refreshing: null,
    again: null,
    liveTimer: null,
  };
  sh.notifications = createNotifications({
    router: ctx.router,
    toast: ctx.toast,
  });
  sh.userMenu = createUserMenu({ getMe: () => ctx.me, toast: ctx.toast });
  sh.topbar = createTopbar({
    onToggleSidebar: () => toggleSidebar(sh),
    onSearch: () => openPalette(),
    notifications: sh.notifications,
    userMenu: sh.userMenu,
  });
  elements.topbar.replaceChildren(sh.topbar.element);
  sh.notifications.setCount(data.unread);
  sh.sidebar = createSidebarOf(sh);
  wireEvents(sh);
  applyLayout(sh);
  drawSidebar(sh);
  return {
    refresh: () => refresh(sh),
    flows: sh.flows,
    markNotificationRead: (notification) =>
      sh.notifications.markOpened(notification),
  };
}
