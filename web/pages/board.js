/**
 * Board page (`#/boards/<id>` and its view and item routes): the header,
 * the table / kanban / app / activity / forms views and the item card.
 * What the user may change follows the board's `my_access`
 * (`ui/board/capabilities.js`): view-only users get read-only cells and no
 * add or delete controls, editors cannot change board settings or columns.
 *
 * One mount per board: switching views or opening an item card updates the
 * mounted page (`ctx.router.onChange`) instead of remounting it. Rendering
 * is per region (header, view, card). A region is rebuilt from state with
 * focus and unsaved text carried over (`components/focus.js`); it is
 * deferred while a popover is open or an unkeyed editor has focus, and
 * rendered once that ends.
 */

import { h } from "../dom.js";
import { boardHash, homeHash, itemHash, viewHash } from "../router.js";
import { loadDirectory } from "../ui/components/directory.js";
import { setDocumentTitle } from "../ui/components/page-header.js";
import { onPopoverClose } from "../ui/components/popover.js";
import { createActions } from "../ui/board/actions.js";
import {
  itemCountText,
  renderBoardHeader,
  renderPlainHeader,
} from "../ui/board/board-header.js";
import { createBoardSync } from "../ui/board/board-sync.js";
import { mountActivityView } from "../ui/board/activity-view.js";
import { boardCapabilities } from "../ui/board/capabilities.js";
import {
  createEmbeddedSlot,
  renderBoardStatus,
} from "../ui/board/embedded-views.js";
import { mountFormsView } from "../ui/board/forms-view.js";
import { createItemCard } from "../ui/board/item-card.js";
import { renderKanban } from "../ui/board/kanban-view.js";
import { createRegions } from "../ui/board/regions.js";
import { renderTable } from "../ui/board/table-view.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { rememberVisit } from "../ui/shell/recent.js";
import { currentTheme } from "../ui/shell/theme.js";

const NEW_ITEM_NAME = "New item";
const PLAIN_TITLES = {
  loading: "Loading…",
  missing: "Board not available",
  error: "Something went wrong",
};
/** Session memory per board: the last view and the collapsed groups. */
const lastViews = new Map();
const collapsedByBoard = new Map();

// ------------------------------------------------------------- helpers

function currentViewSpec(page) {
  const { route, boardId } = page.state;
  if (route.view) return { view: route.view, installId: route.installId };
  return lastViews.get(boardId) ?? { view: "table", installId: null };
}

function filteredItems(page) {
  const { board, search } = page.state;
  const term = search.trim().toLowerCase();
  const items = board?.items ?? [];
  if (!term) return items;
  return items.filter((item) => item.name.toLowerCase().includes(term));
}

function collapsedGroups(page) {
  const { boardId } = page.state;
  if (!collapsedByBoard.has(boardId)) collapsedByBoard.set(boardId, new Set());
  return collapsedByBoard.get(boardId);
}

/** What the user may do on the loaded board (read `ctx.me` fresh). */
const capsOf = (page) => boardCapabilities(page.state.board, page.ctx.me);
const navigate = (page, hash) => page.ctx.router.navigate(hash);
const openItem = (page, itemId) =>
  navigate(page, itemHash(page.state.boardId, itemId));
const closeCard = (page) =>
  navigate(page, viewHash(page.state.boardId, currentViewSpec(page)));

// ------------------------------------------------------------ drawing

function drawHeader(page) {
  const { state, dom } = page;
  if (state.boardStatus !== "ready") {
    setDocumentTitle(PLAIN_TITLES[state.boardStatus] ?? "Board");
    renderPlainHeader(dom.header, {
      title: PLAIN_TITLES[state.boardStatus] ?? "Board",
      loading: state.boardStatus === "loading",
    });
    return;
  }
  setDocumentTitle(state.board.name);
  renderBoardHeader(dom.header, {
    board: state.board,
    caps: capsOf(page),
    route: currentViewSpec(page),
    search: state.search,
    visibleCount: itemCountText(filteredItems(page).length, state.search),
    onRename: (name) => page.actions.renameBoard(name),
    onDescribe: (text) => page.actions.describeBoard(text),
    onKind: (kind) => page.actions.setBoardKind(kind),
    onDelete: () => page.actions.deleteBoard(),
    onShare: () => share(page),
    onCopyLink: () => copyBoardLink(page),
    onNewItem: () => newItem(page),
    onSearch: (term) => setSearch(page, term),
  });
}

function drawItemsView(page, spec) {
  const { state, dom } = page;
  const key = `${state.boardId}:${spec.view}`;
  const keepScroll = dom.view.dataset.viewKey === key;
  const { scrollTop, scrollLeft } = dom.view;
  const viewCtx = {
    board: state.board,
    items: filteredItems(page),
    search: state.search,
    users: state.users,
    collapsed: collapsedGroups(page),
    actions: page.actions,
    caps: capsOf(page),
    openItem: (itemId) => openItem(page, itemId),
    toggleGroup: (groupId) => toggleGroup(page, groupId),
  };
  if (spec.view === "kanban") renderKanban(dom.view, viewCtx);
  else renderTable(dom.view, viewCtx);
  dom.view.dataset.viewKey = key;
  dom.view.scrollTop = keepScroll ? scrollTop : 0;
  dom.view.scrollLeft = keepScroll ? scrollLeft : 0;
}

/**
 * Mounts the Activity or Forms view; it loads its own data. The access
 * level is part of the key, so a role change remounts it.
 */
function drawOwnView(page, view, key) {
  const { state, ctx } = page;
  const caps = capsOf(page);
  const boardId = state.boardId;
  const create =
    view === "activity"
      ? (root) =>
          mountActivityView(root, { boardId, getBoard: () => state.board })
      : (root) =>
          mountFormsView(root, {
            boardId,
            ctx,
            caps,
            createForm: () => page.actions.createForm(),
          });
  page.slot.mountView({ key: `${key}:${caps.access}`, create });
}

function drawView(page) {
  const { state, dom, slot } = page;
  if (state.boardStatus !== "ready") {
    slot.unmount();
    renderBoardStatus(dom.view, {
      status: state.boardStatus,
      onRetry: () => page.sync.refresh(),
      onHome: () => navigate(page, homeHash()),
    });
    return;
  }
  const spec = currentViewSpec(page);
  const key = `${state.boardId}:${spec.view}:${spec.installId ?? ""}`;
  if (spec.view === "app") {
    slot.mountApp({
      key,
      board: state.board,
      installId: spec.installId,
      host: page.appHost,
      onMissing: () => navigate(page, boardHash(state.boardId)),
    });
    return;
  }
  if (spec.view === "activity" || spec.view === "forms") {
    drawOwnView(page, spec.view, key);
    return;
  }
  slot.unmount();
  drawItemsView(page, spec);
}

function drawCard(page) {
  const { state, itemCard } = page;
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
    actions: page.actions,
    caps: capsOf(page),
    draft: state.draft,
    onDraft: (text) => (state.draft = text),
  });
  itemCard.show();
}

// ------------------------------------------------------------ app views

/** Context object of the bridge protocol for an app view. */
function appContext(page, view) {
  const { me } = page.ctx;
  return {
    boardId: page.state.boardId,
    instanceId: String(view.app_install_id),
    instanceType: "board_view",
    viewId: String(view.id),
    user: { id: String(me.id), name: me.name, isAdmin: Boolean(me.is_admin) },
    account: { id: "1" },
    // The API exposes no app ID or client ID for a board view.
    app: { id: null, clientId: null },
    theme: currentTheme(),
    location: globalThis.location.href,
  };
}

function emitContext(page) {
  const mounted = page.slot.current();
  if (mounted?.view) page.slot.emit("context", appContext(page, mounted.view));
}

// ------------------------------------------------------- routes & actions

function toggleGroup(page, groupId) {
  const groups = collapsedGroups(page);
  if (!groups.delete(groupId)) groups.add(groupId);
  page.render(["view"]);
}

function syncCard(page, itemId) {
  const { state } = page;
  if (!itemId) {
    state.card = null;
    return;
  }
  if (state.card?.itemId === itemId) return;
  state.card = { itemId, status: "loading", detail: null };
  state.draft = "";
  if (state.boardStatus === "ready") {
    page.sync.reloadCard().then(() => page.render(["card"]));
  }
}

function applyRoute(page, params) {
  const { state } = page;
  state.route = {
    view: params.view ?? null,
    installId: params.installId ?? null,
    itemId: params.itemId ?? null,
  };
  if (state.route.view) {
    lastViews.set(state.boardId, {
      view: state.route.view,
      installId: state.route.installId,
    });
  }
  syncCard(page, state.route.itemId);
  page.render();
}

function setSearch(page, term) {
  page.state.search = term;
  page.render(["view"]);
  const count = globalThis.document.getElementById("toolbar-count");
  if (count)
    count.textContent = itemCountText(filteredItems(page).length, term);
  page.slot.emit("filter", { term });
}

async function newItem(page) {
  const { state } = page;
  if (!capsOf(page).edit) return;
  const group = state.board.groups[0];
  if (group) collapsedGroups(page).delete(group.id);
  if (state.search) {
    state.search = "";
    page.render(["header", "view"]);
  }
  const id = await page.actions.createItem({
    groupId: group?.id ?? null,
    name: NEW_ITEM_NAME,
  });
  if (!id) return;
  if (currentViewSpec(page).view === "table") {
    page.focusAfterRender(`name:${id}`);
  } else openItem(page, id);
}

async function copyBoardLink(page) {
  const { origin } = globalThis.location;
  const url = new URL(boardHash(page.state.boardId), `${origin}/`).href;
  try {
    await globalThis.navigator.clipboard.writeText(url);
    page.ctx.toast.success("Board link copied");
  } catch {
    page.ctx.toast.show({ message: url, type: "info", timeout: 15_000 });
  }
}

async function share(page) {
  await page.ctx.openShare({
    resourceKind: "board",
    resourceId: page.state.boardId,
  });
  page.sync.refresh();
}

/**
 * Once per mount, when the board first loads: open its change stream (a
 * missing or inaccessible board never opens one), refresh once to catch
 * changes made before the stream opened, remember the visit and select the
 * board's workspace.
 */
function onBoardReady(page) {
  if (page.announced) return;
  page.announced = true;
  page.sync.subscribe(page.state.boardId);
  page.sync.scheduleRefresh();
  rememberVisit(page.ctx.me.id, "board", page.state.boardId);
  const board = page.state.board;
  if (board?.workspace && board.workspaceAccessible) {
    page.ctx.bus.emit(BUS_EVENTS.workspace, board.workspace.id);
  }
}

// ---------------------------------------------------------- lifecycle

function createState(ctx, boardId) {
  return {
    me: ctx.me,
    users: new Map(),
    boardId,
    board: null,
    /** "loading" | "ready" | "missing" | "error" */
    boardStatus: "loading",
    route: { view: "table", installId: null, itemId: null },
    search: "",
    /** Open item card: `{ itemId, status, detail }` or null. */
    card: null,
    draft: "",
    pendingMutations: 0,
    mutationSeq: 0,
    refreshFailed: false,
  };
}

function createPage(container, ctx, boardId) {
  const dom = {
    header: h("header", { class: "board-header-region", id: "board-header" }),
    view: h("section", {
      class: "board-view",
      id: "board-view",
      "aria-label": "Board",
    }),
  };
  container.append(h("div", { class: "board-page" }, dom.header, dom.view));
  const page = { ctx, dom, state: createState(ctx, boardId), cleanups: [] };
  const regions = createRegions({
    header: { element: () => dom.header, draw: () => drawHeader(page) },
    view: { element: () => dom.view, draw: () => drawView(page) },
    card: { element: () => page.itemCard.element, draw: () => drawCard(page) },
  });
  Object.assign(page, regions);
  page.slot = createEmbeddedSlot({ container: dom.view });
  page.itemCard = createItemCard({ onClose: () => closeCard(page) });
  page.appHost = {
    getContext: (view) => appContext(page, view),
    getFilter: () => ({ term: page.state.search }),
    getItemIds: () => filteredItems(page).map((item) => item.id),
    openItem: (itemId) => openItem(page, itemId),
  };
  return page;
}

function wire(page) {
  const { ctx, state } = page;
  const render = (parts) => {
    page.render(parts);
    if (state.boardStatus === "ready") onBoardReady(page);
  };
  page.sync = createBoardSync({
    state,
    render,
    forwardEvent: (change) => page.slot.emit("events", change),
    watchBoard: (boardId, listener) => ctx.bus.watchBoard(boardId, listener),
    refreshShell: () => ctx.refreshShell(),
  });
  page.actions = createActions({
    state,
    render: () => page.render(),
    refresh: () => page.sync.refresh(),
    refreshShell: () => ctx.refreshShell(),
    navigate: (hash) => navigate(page, hash),
    focusAfterRender: page.focusAfterRender,
    onItemDeleted(itemId) {
      if (state.card?.itemId === itemId) closeCard(page);
    },
    onBoardDeleted: () => navigate(page, homeHash()),
  });
  const flush = () => globalThis.setTimeout(page.flushPending, 0);
  // Let the newly focused element settle before deciding what is busy.
  globalThis.document.addEventListener("focusout", flush);
  page.cleanups.push(
    () => globalThis.document.removeEventListener("focusout", flush),
    onPopoverClose(flush),
    ctx.bus.on(BUS_EVENTS.theme, () => emitContext(page)),
    ctx.router.onChange((route) => {
      if (route.name === "board" && route.params.boardId === state.boardId) {
        applyRoute(page, route.params);
      }
    }),
  );
}

/**
 * Page contract: mounts the board of `params.boardId` with
 * `params.view` / `params.installId` / `params.itemId`.
 */
export async function mount(container, ctx, params) {
  const page = createPage(container, ctx, params.boardId);
  wire(page);
  applyRoute(page, params);
  page.sync.refresh();
  loadDirectory()
    .then((directory) => {
      page.state.users = directory.users;
      page.render(["view", "card"]);
    })
    .catch((error) =>
      globalThis.console?.error?.("Directory unavailable", error),
    );
  return () => {
    page.sync.destroy();
    page.slot.unmount();
    page.itemCard.hide();
    for (const cleanup of page.cleanups) cleanup();
  };
}
