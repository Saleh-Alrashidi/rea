/**
 * Host app entry: application state, hash routing, region rendering, the
 * board's live change stream and the app-view host handlers.
 *
 * Rendering is per region (sidebar, header, view, card). A region is rebuilt
 * from state with focus and unsaved text carried over (`ui/focus.js`); it is
 * deferred while a popover is open or an unkeyed editor has focus, and
 * rendered once that ends.
 */

import { createActions } from "./ui/actions.js";
import { mountAppView } from "./ui/app-view.js";
import {
  itemCountText,
  renderBoardHeader,
  renderPlainHeader,
} from "./ui/board-header.js";
import { loadBoards, loadSession } from "./ui/board-data.js";
import { createBoardSync } from "./ui/board-sync.js";
import { renderMessage } from "./ui/empty-state.js";
import { createRegions } from "./ui/regions.js";
import { createItemCard } from "./ui/item-card.js";
import { renderKanban } from "./ui/kanban-view.js";
import { closePopover, isPopoverOpen, onPopoverClose } from "./ui/popover.js";
import { boardHash, itemHash, parseRoute, viewHash } from "./ui/router.js";
import { renderSidebar } from "./ui/sidebar.js";
import { renderTable } from "./ui/table-view.js";
import { currentTheme, initTheme, toggleTheme } from "./ui/theme.js";
import { mountToasts } from "./ui/toast.js";

const NEW_ITEM_NAME = "New item";

const state = {
  me: null,
  users: new Map(),
  boards: [],
  boardId: null,
  board: null,
  /** "loading" | "ready" | "missing" | "error" | "empty" | "offline" */
  boardStatus: "loading",
  route: parseRoute(""),
  lastView: new Map(),
  search: "",
  collapsed: new Map(),
  /** Open item card: `{ itemId, status, detail }` or null. */
  card: null,
  draft: "",
  pendingMutations: 0,
  mutationSeq: 0,
  sidebarOpen: false,
  refreshFailed: false,
};

const dom = {};
let actions = null;
let itemCard = null;
/** Mounted app view: `{ key, view, handle }`. */
let appMount = null;
let sync = null;

const doc = () => globalThis.document;

function navigate(hash) {
  if (globalThis.location.hash === hash) onRouteChange();
  else globalThis.location.hash = hash;
}

/** The board view shown under the current route (items keep the last one). */
function currentViewSpec() {
  const { route } = state;
  if (route.view) return { view: route.view, installId: route.installId };
  return (
    state.lastView.get(route.boardId) ?? { view: "table", installId: null }
  );
}

function filteredItems() {
  const term = state.search.trim().toLowerCase();
  const items = state.board?.items ?? [];
  if (!term) return items;
  return items.filter((item) => item.name.toLowerCase().includes(term));
}

function collapsedGroups() {
  let groups = state.collapsed.get(state.boardId);
  if (!groups) {
    groups = new Set();
    state.collapsed.set(state.boardId, groups);
  }
  return groups;
}

function openItem(itemId) {
  navigate(itemHash(state.boardId, itemId));
}

function closeCard() {
  navigate(viewHash(state.boardId, currentViewSpec()));
}

function toggleGroup(groupId) {
  const groups = collapsedGroups();
  if (!groups.delete(groupId)) groups.add(groupId);
  render(["view"]);
}

// ---------------------------------------------------------------- rendering

const REGIONS = {
  sidebar: { element: () => dom.sidebar, draw: drawSidebar },
  header: { element: () => dom.header, draw: drawHeader },
  view: { element: () => dom.view, draw: drawView },
  card: { element: () => itemCard.element, draw: drawCard },
};

const regions = createRegions(REGIONS);
const { render, flushPending, focusAfterRender } = regions;

function drawSidebar() {
  renderSidebar(dom.sidebar, {
    boards: state.boards,
    activeBoardId: state.boardId,
    me: state.me,
    theme: currentTheme(),
    onNewBoard: () => actions.createBoard(),
    onToggleTheme() {
      toggleTheme();
      render(["sidebar"]);
      emitContext();
    },
    onClose: () => setSidebarOpen(false),
  });
}

const PLAIN_TITLES = {
  loading: "Loading…",
  missing: "Board not found",
  error: "Something went wrong",
  empty: "Welcome",
  offline: "Can’t reach mini-monday",
};

function drawHeader() {
  const onToggleSidebar = () => setSidebarOpen(!state.sidebarOpen);
  if (state.boardStatus !== "ready") {
    doc().title = "mini-monday";
    renderPlainHeader(dom.header, {
      title: PLAIN_TITLES[state.boardStatus] ?? "mini-monday",
      onToggleSidebar,
    });
    return;
  }
  doc().title = `${state.board.name} · mini-monday`;
  renderBoardHeader(dom.header, {
    board: state.board,
    route: currentViewSpec(),
    search: state.search,
    visibleCount: itemCountText(filteredItems().length, state.search),
    sidebarOpen: state.sidebarOpen,
    onRename: (name) => actions.renameBoard(name),
    onDescribe: (text) => actions.describeBoard(text),
    onDelete: () => actions.deleteBoard(),
    onNewItem: newItem,
    onSearch: setSearch,
    onToggleSidebar,
  });
}

function drawStatus() {
  const firstBoard = state.boards[0];
  const messages = {
    loading: { iconName: "board", title: "Loading board…", busy: true },
    missing: {
      iconName: "board",
      title: "This board doesn’t exist",
      text: "It may have been deleted.",
      action: firstBoard && {
        label: "Open the first board",
        onClick: () => navigate(boardHash(firstBoard.id)),
      },
    },
    error: {
      iconName: "alert",
      title: "We couldn’t load this board",
      text: "Check that the mini-monday server is running.",
      action: { label: "Try again", onClick: () => sync.refresh() },
    },
    empty: {
      iconName: "board",
      title: "Create your first board",
      text: "Boards hold groups of items with status, people, dates and more.",
      action: { label: "New board", onClick: () => actions.createBoard() },
    },
    offline: {
      iconName: "alert",
      title: "Can’t reach mini-monday",
      text: "The server did not answer. Start it and reload this page.",
      action: { label: "Reload", onClick: () => globalThis.location.reload() },
    },
  };
  dom.view.dataset.viewKey = state.boardStatus;
  renderMessage(dom.view, messages[state.boardStatus] ?? messages.loading);
}

function drawView() {
  if (state.boardStatus !== "ready") {
    unmountApp();
    drawStatus();
    return;
  }
  const spec = currentViewSpec();
  if (spec.view === "app") {
    mountApp(spec.installId);
    return;
  }
  unmountApp();
  const key = `${state.boardId}:${spec.view}`;
  const keepScroll = dom.view.dataset.viewKey === key;
  const { scrollTop, scrollLeft } = dom.view;
  const ctx = {
    board: state.board,
    items: filteredItems(),
    search: state.search,
    users: state.users,
    collapsed: collapsedGroups(),
    actions,
    openItem,
    toggleGroup,
  };
  if (spec.view === "kanban") renderKanban(dom.view, ctx);
  else renderTable(dom.view, ctx);
  dom.view.dataset.viewKey = key;
  dom.view.scrollTop = keepScroll ? scrollTop : 0;
  dom.view.scrollLeft = keepScroll ? scrollLeft : 0;
}

function drawCard() {
  const { card } = state;
  if (!card) {
    itemCard.hide();
    return;
  }
  const item =
    state.board?.items.find((entry) => entry.id === card.itemId) ?? card.detail;
  let status = card.status;
  if (state.boardStatus !== "ready") {
    status = state.boardStatus === "loading" ? "loading" : "error";
  } else if (item) {
    status = "ready";
  }
  itemCard.render({
    status,
    item,
    detail: card.detail,
    board: state.board,
    users: state.users,
    actions,
    draft: state.draft,
    onDraft: (text) => (state.draft = text),
  });
  itemCard.show();
}

// ---------------------------------------------------------------- app views

/** Context object of the bridge protocol for an app view. */
function appContext(view) {
  return {
    boardId: state.boardId,
    instanceId: String(view.app_install_id),
    instanceType: "board_view",
    viewId: String(view.id),
    user: {
      id: String(state.me.id),
      name: state.me.name,
      isAdmin: Boolean(state.me.is_admin),
    },
    account: { id: "1" },
    // The API exposes no app ID or client ID for a board view.
    app: { id: null, clientId: null },
    theme: currentTheme(),
    location: globalThis.location.href,
  };
}

const appHost = {
  getContext: (view) => appContext(view),
  getFilter: () => ({ term: state.search }),
  getItemIds: () => filteredItems().map((item) => item.id),
  openItem,
};

function emitContext() {
  if (appMount) appMount.handle.emit("context", appContext(appMount.view));
}

function mountApp(installId) {
  const key = `${state.boardId}:app:${installId}`;
  if (appMount?.key === key) return;
  unmountApp();
  dom.view.dataset.viewKey = key;
  const view = state.board.views.find(
    (entry) =>
      entry.type === "app" && String(entry.app_install_id) === installId,
  );
  if (!view) {
    renderMessage(dom.view, {
      iconName: "app",
      title: "App view not found",
      text: "The app may have been removed from this board.",
      action: {
        label: "Open the main table",
        onClick: () => navigate(boardHash(state.boardId)),
      },
    });
    return;
  }
  dom.view.classList.add("app-active");
  appMount = {
    key,
    view,
    handle: mountAppView(dom.view, { view, host: appHost }),
  };
}

function unmountApp() {
  dom.view.classList.remove("app-active");
  if (!appMount) return;
  appMount.handle.destroy();
  appMount = null;
}

// ------------------------------------------------------------------ routing

function selectBoard(boardId) {
  state.boardId = boardId;
  state.board = null;
  state.search = "";
  state.refreshFailed = false;
  state.boardStatus = boardId ? "loading" : "empty";
  unmountApp();
  sync.subscribe(boardId);
  if (boardId) sync.refresh();
}

function redirectToFirstBoard() {
  const first = state.boards[0];
  if (first) {
    globalThis.location.replace(boardHash(first.id));
    return;
  }
  selectBoard(null);
  state.card = null;
  render();
}

function syncCard(itemId) {
  if (!itemId) {
    state.card = null;
    return;
  }
  if (state.card?.itemId === itemId) return;
  state.card = { itemId, status: "loading", detail: null };
  state.draft = "";
  if (state.boardStatus === "ready") {
    sync.reloadCard().then(() => render(["card"]));
  }
}

function onRouteChange() {
  if (state.boardStatus === "offline") return;
  const route = parseRoute(globalThis.location.hash);
  closePopover();
  setSidebarOpen(false);
  state.route = route;
  if (!route.boardId) {
    redirectToFirstBoard();
    return;
  }
  if (route.view) {
    state.lastView.set(route.boardId, {
      view: route.view,
      installId: route.installId,
    });
  }
  if (route.boardId !== state.boardId) selectBoard(route.boardId);
  syncCard(route.itemId);
  render();
}

// ------------------------------------------------------------------ toolbar

function setSearch(term) {
  state.search = term;
  render(["view"]);
  const count = doc().getElementById("toolbar-count");
  if (count) count.textContent = itemCountText(filteredItems().length, term);
  appMount?.handle.emit("filter", { term });
}

async function newItem() {
  const group = state.board.groups[0];
  if (group) collapsedGroups().delete(group.id);
  if (state.search) {
    state.search = "";
    render(["header", "view"]);
  }
  const id = await actions.createItem({
    groupId: group?.id ?? null,
    name: NEW_ITEM_NAME,
  });
  if (!id) return;
  if (currentViewSpec().view === "table") focusAfterRender(`name:${id}`);
  else openItem(id);
}

function setSidebarOpen(open) {
  state.sidebarOpen = open;
  dom.shell.classList.toggle("sidebar-open", open);
  for (const button of doc().querySelectorAll(".sidebar-toggle")) {
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (open) dom.sidebar.querySelector("a, button")?.focus();
}

function onItemDeleted(itemId) {
  if (state.card?.itemId === itemId) closeCard();
}

function onBoardDeleted(boardId) {
  state.boards = state.boards.filter((board) => board.id !== boardId);
  if (state.boardId === boardId) navigate("#/");
}

function wireGlobalEvents() {
  const d = doc();
  globalThis.addEventListener("hashchange", onRouteChange);
  // Let the newly focused element settle before deciding what is busy.
  d.addEventListener("focusout", () => globalThis.setTimeout(flushPending, 0));
  onPopoverClose(() => globalThis.setTimeout(flushPending, 0));
  d.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.sidebarOpen || isPopoverOpen()) return;
    setSidebarOpen(false);
    d.querySelector(".sidebar-toggle")?.focus();
  });
  d.getElementById("sidebar-backdrop")?.addEventListener("click", () =>
    setSidebarOpen(false),
  );
}

async function start() {
  const d = doc();
  dom.shell = d.getElementById("app");
  dom.sidebar = d.getElementById("sidebar");
  dom.header = d.getElementById("board-header");
  dom.view = d.getElementById("board-view");
  mountToasts(d.getElementById("toasts"));
  sync = createBoardSync({
    state,
    render,
    forwardEvent: (change) => appMount?.handle.emit("events", change),
    afterBoards() {
      render(["sidebar"]);
      if (!state.route.boardId) redirectToFirstBoard();
    },
  });
  initTheme(() => {
    render(["sidebar"]);
    emitContext();
  });
  actions = createActions({
    state,
    render: () => render(),
    refresh: () => sync.refresh(),
    refreshBoards: () => sync.refreshBoards(),
    navigate,
    focusAfterRender,
    onItemDeleted,
    onBoardDeleted,
  });
  itemCard = createItemCard({ onClose: closeCard });
  wireGlobalEvents();
  render();
  try {
    const [session, boards] = await Promise.all([loadSession(), loadBoards()]);
    state.me = session.me;
    state.users = new Map(session.users.map((user) => [String(user.id), user]));
    state.boards = boards;
  } catch (error) {
    globalThis.console?.error?.("Startup failed", error);
    state.boardStatus = "offline";
    render();
    return;
  }
  onRouteChange();
}

start();
