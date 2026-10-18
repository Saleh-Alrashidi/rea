/**
 * The shell controller: owns the shell data (`shell-data.js`), the current
 * workspace, the top bar and sidebar, the navigation drawer (under 900 px)
 * or collapsed sidebar (wider screens) and `refreshShell()`.
 *
 * The current workspace follows what pages show (the `workspace` bus event
 * and workspace routes), falls back to the last one chosen in this browser
 * (a per-user convenience in localStorage) and then to the first accessible
 * workspace.
 */

import { invalidateDirectory } from "../components/directory.js";
import { isPopoverOpen } from "../components/popover.js";
import { BUS_EVENTS } from "./bus.js";
import { createFlows } from "./create.js";
import { createNotifications } from "./notifications.js";
import { loadShellData } from "./shell-data.js";
import { renderSidebar } from "./sidebar.js";
import { onThemeChange } from "./theme.js";
import { createTopbar } from "./topbar.js";
import { createUserMenu } from "./user-menu.js";

const DRAWER_QUERY = "(max-width: 899px)";
const COLLAPSED_KEY = "worklane-sidebar-collapsed";
const WORKSPACE_ROUTES = new Set(["workspace", "workspace-settings"]);

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

const workspaceKey = (sh) => `worklane-workspace:${sh.data.me.id}`;

function currentWorkspace(sh) {
  const list = sh.data.workspaces;
  return list.find((entry) => entry.id === sh.workspaceId) ?? list[0] ?? null;
}

function drawSidebar(sh) {
  const { ctx, flows } = sh;
  renderSidebar(sh.elements.sidebar, {
    me: ctx.me,
    workspaces: sh.data.workspaces,
    currentWorkspace: currentWorkspace(sh),
    route: sh.route,
    onSelectWorkspace(id) {
      selectWorkspace(sh, id);
      ctx.router.navigate(`#/workspaces/${id}`);
    },
    onNewWorkspace: () => flows.workspace(),
    onCreate: (kind) => flows[kind]({ workspaceId: currentWorkspace(sh)?.id }),
    onClose: () => setDrawer(sh, false),
  });
}

function selectWorkspace(sh, id) {
  const known = sh.data.workspaces.some((entry) => entry.id === String(id));
  if (!known || sh.workspaceId === String(id)) return;
  sh.workspaceId = String(id);
  writeStorage(workspaceKey(sh), sh.workspaceId);
  drawSidebar(sh);
}

function applyLayout(sh) {
  const { app, sidebar } = sh.elements;
  const drawer = isDrawer();
  app.classList.toggle("sidebar-open", drawer && sh.drawerOpen);
  app.classList.toggle("sidebar-collapsed", !drawer && sh.collapsed);
  sh.topbar.update({ sidebarOpen: drawer ? sh.drawerOpen : !sh.collapsed });
  sidebar.inert = drawer && !sh.drawerOpen;
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

/** Reloads the shell data (single flight); pages call it after changes. */
function refresh(sh) {
  sh.refreshing ??= reloadShell(sh).finally(() => (sh.refreshing = null));
  return sh.refreshing;
}

function onRoute(sh, route) {
  sh.route = route;
  if (WORKSPACE_ROUTES.has(route.name)) {
    selectWorkspace(sh, route.params.workspaceId);
  }
  if (sh.drawerOpen) setDrawer(sh, false, { focus: false });
  drawSidebar(sh);
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
  ctx.bus.on(BUS_EVENTS.workspace, (id) => selectWorkspace(sh, id));
  ctx.bus.on(BUS_EVENTS.notification, (event) =>
    sh.notifications.onNotification(event),
  );
  onThemeChange((detail) => {
    sh.topbar.updateTheme();
    ctx.bus.emit(BUS_EVENTS.theme, detail);
  });
}

/**
 * Mounts the shell. Returns `refresh()` (`ctx.refreshShell`), the creation
 * `flows` and `selectWorkspace(id)`.
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
    workspaceId: null,
    route: null,
    drawerOpen: false,
    collapsed: readStorage(COLLAPSED_KEY) === "1",
    refreshing: null,
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
  sh.workspaceId = readStorage(workspaceKey(sh));
  sh.notifications.setCount(data.unread);
  wireEvents(sh);
  applyLayout(sh);
  drawSidebar(sh);
  return {
    refresh: () => refresh(sh),
    flows: sh.flows,
    selectWorkspace: (id) => selectWorkspace(sh, id),
  };
}
