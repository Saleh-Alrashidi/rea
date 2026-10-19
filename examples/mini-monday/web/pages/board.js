/**
 * Board page (`#/boards/<id>` and its view, item and update routes): the
 * header, the list / table / kanban / app / activity / forms views and
 * the task view. The board's own link opens its default view (the List
 * view, SPEC-6 §1.1); an item route shows the item in the task view over
 * the view the user came from, whichever it is, and an update route
 * (`…/items/<itemId>/updates/<updateId>`) the same, scrolled to that
 * update (SPEC-6 §2.3).
 * What the user may change follows the board's `my_access`
 * (`ui/board/capabilities.js`): view-only users get read-only cells and no
 * add or delete controls, editors cannot change board settings or columns.
 *
 * One mount per board: switching views or opening a task updates the
 * mounted page (`ctx.router.onChange`) instead of remounting it. Rendering
 * is per region (header, view, card: the task view). A region is rebuilt
 * from state with focus and unsaved text carried over
 * (`components/focus.js`); it is deferred while a popover is open or an
 * unkeyed editor has focus, and rendered once that ends.
 */

import { h } from "../dom.js";
import { boardHash, homeHash, itemHash, viewHash } from "../router.js";
import { loadDirectory } from "../ui/components/directory.js";
import { setDocumentTitle } from "../ui/components/page-header.js";
import { changesAccess } from "../ui/components/labels.js";
import { onPopoverClose } from "../ui/components/popover.js";
import { createActions } from "../ui/board/actions.js";
import {
  itemCountText,
  renderBoardHeader,
  renderPlainHeader,
} from "../ui/board/board-header.js";
import {
  collapsedGroups,
  lastView,
  listPrefs,
  rememberView,
} from "../ui/board/board-memory.js";
import { createBoardSync } from "../ui/board/board-sync.js";
import { defaultView } from "../ui/board/board-views.js";
import { mountActivityView } from "../ui/board/activity-view.js";
import { boardCapabilities } from "../ui/board/capabilities.js";
import {
  createEmbeddedSlot,
  renderBoardStatus,
} from "../ui/board/embedded-views.js";
import { mountFormsView } from "../ui/board/forms-view.js";
import { renderKanban } from "../ui/board/kanban-view.js";
import { listTools } from "../ui/board/list-toolbar.js";
import { addTaskFromToolbar, renderList } from "../ui/board/list-view.js";
import { createRegions } from "../ui/board/regions.js";
import { renderTable } from "../ui/board/table-view.js";
import { createTaskView } from "../ui/board/task-view.js";
import { UPDATES_PAGE } from "../ui/board/updates-data.js";
import { findUpdate } from "../ui/board/updates-model.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { rememberVisit } from "../ui/shell/recent.js";
import { currentTheme } from "../ui/shell/theme.js";

const NEW_ITEM_NAME = "New item";
/** The task view's status while the board is not ready. */
const BOARD_TASK_STATUS = Object.freeze({
  loading: "loading",
  missing: "missing",
});
const PLAIN_TITLES = {
  loading: "Loading…",
  missing: "Board not available",
  error: "Something went wrong",
};

// ------------------------------------------------------------- helpers

/**
 * The view on screen: the route's, or on an item route the one the user
 * came from; without one (the board's own link) the board's default.
 */
function currentViewSpec(page) {
  const { route, boardId, board } = page.state;
  const shown = route.itemId ? lastView(boardId) : route;
  if (shown?.view) return { view: shown.view, installId: shown.installId };
  return { view: defaultView(board), installId: null };
}

function filteredItems(page) {
  const { board, search } = page.state;
  const term = search.trim().toLowerCase();
  const items = board?.items ?? [];
  if (!term) return items;
  return items.filter((item) => item.name.toLowerCase().includes(term));
}

/** The toolbar's live count: tasks in List, items elsewhere. */
function countText(page) {
  const noun = currentViewSpec(page).view === "list" ? "task" : "item";
  return itemCountText(filteredItems(page).length, page.state.search, { noun });
}

/** Changes the List view's choices and redraws the toolbar and the list. */
function changeListPrefs(page, mutate) {
  mutate(listPrefs(page.state.boardId));
  page.render(["header", "view"]);
}

/** What the user may do on the loaded board (read `ctx.me` fresh). */
const capsOf = (page) => boardCapabilities(page.state.board, page.ctx.me);
const navigate = (page, hash) => page.ctx.router.navigate(hash);
const openItem = (page, itemId) =>
  navigate(page, itemHash(page.state.boardId, itemId));
const closeCard = (page) =>
  navigate(
    page,
    viewHash(page.state.boardId, lastView(page.state.boardId) ?? {}),
  );

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
  const route = currentViewSpec(page);
  const prefs = listPrefs(state.boardId);
  renderBoardHeader(dom.header, {
    board: state.board,
    caps: capsOf(page),
    route,
    search: state.search,
    visibleCount: countText(page),
    tools:
      route.view === "list"
        ? listTools({
            board: state.board,
            prefs,
            change: (mutate) => changeListPrefs(page, mutate),
          })
        : null,
    onRename: (name) => page.actions.renameBoard(name),
    onDescribe: (text) => page.actions.describeBoard(text),
    onKind: (kind) => page.actions.setBoardKind(kind),
    onDelete: () => page.actions.deleteBoard(),
    onShare: () => share(page),
    onCopyLink: () => copyBoardLink(page),
    onNewItem: () => newItem(page),
    onSearch: (term) => setSearch(page, term),
    onAddView: (type) => page.actions.addView(type),
  });
}

/** What the table and kanban views draw from. */
function itemsContext(page) {
  const { state } = page;
  return {
    board: state.board,
    items: filteredItems(page),
    search: state.search,
    users: state.users,
    collapsed: collapsedGroups(state.boardId),
    actions: page.actions,
    caps: capsOf(page),
    openItem: (itemId) => openItem(page, itemId),
    toggleGroup: (groupId) => toggleGroup(page, groupId),
  };
}

/**
 * The List view's context: the items context with its session choices.
 * The list searches the board's items itself (`search`), since matching
 * subtasks keep their parents visible.
 */
function listContext(page) {
  return {
    ...itemsContext(page),
    prefs: listPrefs(page.state.boardId),
    change: (mutate) => changeListPrefs(page, mutate),
    focusAfterRender: page.focusAfterRender,
  };
}

function drawItemsView(page, spec) {
  const { state, dom } = page;
  const key = `${state.boardId}:${spec.view}`;
  const keepScroll = dom.view.dataset.viewKey === key;
  const { scrollTop, scrollLeft } = dom.view;
  const viewCtx = itemsContext(page);
  if (spec.view === "kanban") renderKanban(dom.view, viewCtx);
  else if (spec.view === "list") renderList(dom.view, listContext(page));
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
  // The header and view styles follow the view (SPEC-5 §5).
  dom.root.dataset.view = currentViewSpec(page).view;
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

/** The item route's task view (SPEC-6 §1.1), from every view. */
function drawCard(page) {
  const { state } = page;
  const { card } = state;
  const panel = page.taskView;
  if (!card) {
    panel.hide();
    return;
  }
  const item =
    state.board?.items.find((entry) => entry.id === card.itemId) ?? card.detail;
  let status = card.status;
  if (state.boardStatus !== "ready") {
    // A board that is gone or closed to the user hides its tasks too.
    status = BOARD_TASK_STATUS[state.boardStatus] ?? "error";
  } else if (item) {
    status = "ready";
  }
  panel.render({
    status,
    item,
    itemId: card.itemId,
    detail: card.detail,
    board: state.board,
    users: state.users,
    actions: page.actions,
    caps: capsOf(page),
    me: page.ctx.me,
    people: state.people,
    updates: card.updates,
    target: card.target,
    repaint: () => page.render(["card"]),
  });
  panel.show();
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
  const groups = collapsedGroups(page.state.boardId);
  if (!groups.delete(groupId)) groups.add(groupId);
  page.render(["view"]);
}

/**
 * Opens the route's task in the task view (or closes it), and points the
 * view at the route's update, if any (SPEC-6 §2.3): each route change
 * makes a new target, so following a link again scrolls to it again.
 */
function syncCard(page, { itemId, updateId }) {
  const { state } = page;
  if (!itemId) {
    state.card = null;
    return;
  }
  page.targetSeq = (page.targetSeq ?? 0) + 1;
  const target = updateId ? { id: updateId, seq: page.targetSeq } : null;
  const ready = state.boardStatus === "ready";
  if (state.card?.itemId === itemId) {
    state.card.target = target;
    const list = state.card.updates.list;
    if (ready && target && list && !findUpdate(list, target.id)) {
      page.sync.reloadCard().then(() => page.render(["card"]));
    }
    return;
  }
  state.card = {
    itemId,
    status: "loading",
    detail: null,
    target,
    updates: {
      status: "loading",
      list: null,
      hasMore: false,
      limit: UPDATES_PAGE,
    },
  };
  if (ready) page.sync.reloadCard().then(() => page.render(["card"]));
}

const sameView = (a, b) => a.view === b.view && a.installId === b.installId;

function applyRoute(page, params) {
  const { state } = page;
  const shown = currentViewSpec(page);
  state.route = {
    view: params.view ?? null,
    installId: params.installId ?? null,
    itemId: params.itemId ?? null,
  };
  if (!state.route.itemId) rememberView(state.boardId, state.route);
  syncCard(page, {
    itemId: state.route.itemId,
    updateId: params.updateId ?? null,
  });
  // Opening or closing a task leaves the header and the view as they
  // are: rebuilding a wide board's table would freeze the page.
  const cardOnly = page.routed && sameView(shown, currentViewSpec(page));
  page.routed = true;
  page.render(cardOnly ? ["card"] : undefined);
}

function setSearch(page, term) {
  page.state.search = term;
  page.render(["view"]);
  const count = globalThis.document.getElementById("toolbar-count");
  if (count) count.textContent = countText(page);
  page.slot.emit("filter", { term });
}

async function newItem(page) {
  const { state } = page;
  if (!capsOf(page).edit) return;
  const group = state.board.groups[0];
  if (group) collapsedGroups(state.boardId).delete(group.id);
  if (state.search) {
    state.search = "";
    page.render(["header", "view"]);
  }
  if (currentViewSpec(page).view === "list") {
    // ClickUp's "+ Add task" starts typing a task in the first group.
    addTaskFromToolbar(listContext(page));
    return;
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
 * missing or inaccessible board never opens one), reload once to catch
 * changes made before the stream opened (redrawing only if there were
 * any), remember the visit and select the board's workspace.
 */
function onBoardReady(page) {
  if (page.announced) return;
  page.announced = true;
  page.sync.subscribe(page.state.boardId);
  page.sync.scheduleRefresh({ ifChanged: true });
  rememberVisit(page.ctx.me.id, "board", page.state.boardId);
  const board = page.state.board;
  if (board?.workspace && board.workspaceAccessible) {
    page.ctx.bus.emit(BUS_EVENTS.workspace, board.workspace.id);
  }
}

/**
 * The open task moved to another board (SPEC-6 §3.2): it opens there when
 * the user can open that board, else the task view closes with a note.
 */
function followTask(page, { itemId, boardId }) {
  if (boardId) {
    navigate(page, itemHash(boardId, itemId));
    return;
  }
  closeCard(page);
  page.ctx.toast.info("This task was moved to another board");
}

/** Reports whether this board's live updates are paused (the banner). */
function setLive(page, paused) {
  const key = `board:${page.state.boardId}`;
  page.ctx.bus.emit(BUS_EVENTS.live, { key, paused });
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
    route: { view: null, installId: null, itemId: null },
    search: "",
    /**
     * The open task: `{ itemId, status, detail, updates, target }` or
     * null (`syncCard`).
     */
    card: null,
    /** Who composers may mention: the directory's `{ users, teams }`. */
    people: { users: [], teams: [] },
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
  dom.root = h("div", { class: "board-page" }, dom.header, dom.view);
  container.append(dom.root);
  const page = { ctx, dom, state: createState(ctx, boardId), cleanups: [] };
  const regions = createRegions({
    header: { element: () => dom.header, draw: () => drawHeader(page) },
    view: { element: () => dom.view, draw: () => drawView(page) },
    card: { element: () => page.taskView.element, draw: () => drawCard(page) },
  });
  Object.assign(page, regions);
  page.slot = createEmbeddedSlot({ container: dom.view });
  page.taskView = createTaskView({ onClose: () => closeCard(page) });
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
    watchBoard: (boardId, listener, onEnd) =>
      ctx.bus.watchBoard(boardId, listener, onEnd),
    refreshShell: () => ctx.refreshShell(),
    onLivePaused: () => setLive(page, true),
    onTaskMoved: (moved) => followTask(page, moved),
  });
  page.actions = createActions({
    state,
    render: (parts) => page.render(parts),
    refresh: (options) => page.sync.refresh(options),
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
    // A new role or share can change what this board lets the user do.
    ctx.bus.on(BUS_EVENTS.notification, (event) => {
      if (changesAccess(event?.kind)) page.sync.scheduleRefresh();
    }),
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
      page.state.people = { users: directory.userList, teams: directory.teams };
      page.render(["view", "card"]);
    })
    .catch((error) =>
      globalThis.console?.error?.("Directory unavailable", error),
    );
  return () => {
    // This board's stream no longer matters once the page is gone.
    setLive(page, false);
    page.sync.destroy();
    page.slot.unmount();
    page.taskView.hide();
    for (const cleanup of page.cleanups) cleanup();
  };
}
