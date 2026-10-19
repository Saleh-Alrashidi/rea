import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ROUTES,
  NOT_FOUND_PAGE,
  boardHash,
  compilePattern,
  createRouter,
  docHash,
  formHash,
  hashFromUrl,
  itemHash,
  noteHash,
  registerAppRoutes,
  teamHash,
  viewHash,
  workspaceHash,
  workspaceSettingsHash,
} from "../web/router.js";
import {
  defaultView,
  itemViewKind,
  missingViews,
  viewTabsOf,
} from "../web/ui/board/board-views.js";

const ORIGIN = "http://localhost:4100";

/** A window whose hash changes fire `hashchange` asynchronously. */
function fakeWindow(initial = "") {
  const listeners = [];
  let hash = initial;
  const fire = () =>
    queueMicrotask(() => listeners.forEach((listener) => listener()));
  return {
    location: {
      get hash() {
        return hash;
      },
      set hash(next) {
        hash = next.startsWith("#") ? next : `#${next}`;
        fire();
      },
      replace(next) {
        hash = next;
        fire();
      },
    },
    addEventListener(type, listener) {
      if (type === "hashchange") listeners.push(listener);
    },
  };
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.attributes = new Map();
    this.scrollTop = 0;
    this.focusCount = 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  focus() {
    this.focusCount += 1;
  }
}

function installDocument(t) {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  t.after(() => {
    delete globalThis.document;
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const appRouter = () =>
  registerAppRoutes(createRouter({ window: fakeWindow() }));

test("route patterns match numeric IDs only, also inside a segment", () => {
  const { regex, names } = compilePattern(
    "/boards/:boardId/views/app-:installId",
  );
  assert.deepEqual(names, ["boardId", "installId"]);
  assert.deepEqual(regex.exec("/boards/12/views/app-7").slice(1), ["12", "7"]);
  for (const path of [
    "/boards/x/views/app-7",
    "/boards/1/views/app-",
    "/boards/1/views/app-7/x",
  ]) {
    assert.equal(regex.exec(path), null, path);
  }
  // Literal text is escaped, not treated as a regular expression.
  assert.equal(compilePattern("/a.b").regex.test("/aXb"), false);
  assert.throws(() => compilePattern("boards"), TypeError);
});

test("every SPEC-2 route resolves to its page and params", () => {
  const router = appRouter();
  const cases = [
    ["#/home", "home", {}],
    ["#/my-work", "my-work", {}],
    ["#/shared", "shared", {}],
    ["#/workspaces/3", "workspace", { workspaceId: "3" }],
    ["#/workspaces/3/settings", "workspace-settings", { workspaceId: "3" }],
    // SPEC-5 §3.1: the board's own link opens its default view.
    ["#/boards/12", "board", { boardId: "12", view: null }],
    ["#/boards/12/views/table", "board", { boardId: "12", view: "table" }],
    ["#/boards/12/views/list", "board", { boardId: "12", view: "list" }],
    ["#/boards/12/views/kanban", "board", { boardId: "12", view: "kanban" }],
    [
      "#/boards/12/views/activity",
      "board",
      { boardId: "12", view: "activity" },
    ],
    ["#/boards/12/views/forms", "board", { boardId: "12", view: "forms" }],
    [
      "#/boards/12/views/app-7",
      "board",
      { boardId: "12", view: "app", installId: "7" },
    ],
    [
      "#/boards/12/items/40",
      "board",
      { boardId: "12", view: null, itemId: "40" },
    ],
    ["#/docs", "docs", {}],
    ["#/docs/5", "doc-editor", { docId: "5" }],
    ["#/notes", "notes", {}],
    ["#/notes/6", "notes", { noteId: "6" }],
    ["#/forms/8", "form-builder", { formId: "8" }],
    ["#/teams", "teams", {}],
    ["#/teams/2", "team", { teamId: "2" }],
    ["#/admin", "admin", { tab: "users" }],
    ["#/admin/content", "admin", { tab: "content" }],
  ];
  for (const [hash, name, params] of cases) {
    const route = router.resolve(hash);
    assert.equal(route.name, name, hash);
    assert.deepEqual(route.params, params, hash);
  }
  // The default route is Home; unknown or malformed paths are not found.
  assert.equal(router.resolve("").name, "home");
  assert.equal(router.resolve("#/").name, "home");
  for (const hash of [
    "#/boards/x",
    "#/boards/1/views/app-",
    "#/boards/1/items/1/x",
    "#/boards/1/views/grid",
    "#/nope",
    "#/docs/../admin",
  ]) {
    const route = router.resolve(hash);
    assert.equal(route.name, "not-found", hash);
    assert.equal(route.loader, NOT_FOUND_PAGE, hash);
  }
});

test("board views and item cards share one mount; other pages do not", () => {
  const router = appRouter();
  const key = (hash) => router.resolve(hash).key;
  assert.equal(key("#/boards/12"), key("#/boards/12/views/kanban"));
  assert.equal(key("#/boards/12"), key("#/boards/12/views/list"));
  assert.equal(key("#/boards/12"), key("#/boards/12/views/table"));
  assert.equal(key("#/boards/12"), key("#/boards/12/items/40"));
  assert.notEqual(key("#/boards/12"), key("#/boards/13"));
  assert.equal(key("#/notes"), key("#/notes/6"));
  assert.equal(key("#/admin"), key("#/admin/content"));
  assert.notEqual(key("#/docs/1"), key("#/docs/2"));
});

test("hash builders produce routes that resolve back", () => {
  const router = appRouter();
  const built = [
    [viewHash("3", { view: "kanban" }), "#/boards/3/views/kanban"],
    [viewHash("3", { view: "app", installId: "9" }), "#/boards/3/views/app-9"],
    // Table and list have explicit routes; no view is the default view.
    [viewHash("3", { view: "table" }), "#/boards/3/views/table"],
    [viewHash("3", { view: "list" }), "#/boards/3/views/list"],
    [viewHash("3", { view: null }), "#/boards/3"],
    [viewHash("3", { view: "app" }), "#/boards/3"],
    [viewHash("3", { view: "bogus" }), "#/boards/3"],
    [itemHash("3", "4"), "#/boards/3/items/4"],
    [boardHash("3"), "#/boards/3"],
    [docHash("5"), "#/docs/5"],
    [noteHash("6"), "#/notes/6"],
    [formHash("8"), "#/forms/8"],
    [teamHash("2"), "#/teams/2"],
    [workspaceHash("1"), "#/workspaces/1"],
    [workspaceSettingsHash("1"), "#/workspaces/1/settings"],
  ];
  for (const [hash, expected] of built) {
    assert.equal(hash, expected);
    assert.notEqual(router.resolve(hash).name, "not-found", hash);
  }
});

const view = (id, type, name, extra = {}) => ({
  id,
  type,
  name,
  app_install_id: null,
  ...extra,
});
const CLICKUP_VIEWS = [
  view("1", "list", "List"),
  view("2", "table", "Main table"),
  view("3", "kanban", "Kanban"),
];
const MONDAY_VIEWS = [
  view("4", "table", "Main table"),
  view("5", "kanban", "Kanban"),
  view("6", "app", "Status summary", { app_install_id: 9 }),
];

test("a board's default view is its first non-app view", () => {
  assert.equal(defaultView({ views: CLICKUP_VIEWS }), "list");
  assert.equal(defaultView({ views: MONDAY_VIEWS }), "table");
  assert.equal(
    defaultView({ views: [MONDAY_VIEWS[2], ...CLICKUP_VIEWS] }),
    "list",
  );
  // Not loaded yet, or no item views: the table.
  assert.equal(defaultView(null), "table");
  assert.equal(defaultView({ views: [MONDAY_VIEWS[2]] }), "table");
});

test("view tabs follow Board.views; editors may add the missing ones", () => {
  assert.deepEqual(
    viewTabsOf({ views: CLICKUP_VIEWS }).map((tab) => [
      tab.view,
      tab.label,
      tab.icon,
    ]),
    [
      ["list", "List", "list"],
      ["table", "Main table", "table"],
      ["kanban", "Kanban", "kanban"],
    ],
  );
  assert.deepEqual(viewTabsOf({ views: MONDAY_VIEWS }).at(-1), {
    view: "app",
    installId: "9",
    label: "Status summary",
    icon: "app",
  });
  assert.deepEqual(missingViews({ views: MONDAY_VIEWS }), ["list"]);
  assert.deepEqual(missingViews({ views: CLICKUP_VIEWS }), []);
  const full = Array.from({ length: 20 }, (_, index) =>
    view(String(index), "app", "App", { app_install_id: index + 1 }),
  );
  assert.deepEqual(missingViews({ views: full }), []);
});

test("items open as a task view from List, else as the item card", () => {
  const clickup = { views: CLICKUP_VIEWS };
  const monday = { views: MONDAY_VIEWS };
  // A direct link (or the board's own link) follows the default view.
  assert.equal(itemViewKind({ board: clickup }), "task");
  assert.equal(
    itemViewKind({ board: clickup, lastView: { view: null } }),
    "task",
  );
  assert.equal(itemViewKind({ board: monday }), "card");
  // Otherwise the view the user came from decides.
  assert.equal(
    itemViewKind({ board: clickup, lastView: { view: "table" } }),
    "card",
  );
  assert.equal(
    itemViewKind({ board: monday, lastView: { view: "list" } }),
    "task",
  );
  assert.equal(
    itemViewKind({ board: clickup, lastView: { view: "activity" } }),
    "card",
  );
});

test("hashFromUrl accepts only in-app links", () => {
  assert.equal(hashFromUrl("#/docs/1", ORIGIN), "#/docs/1");
  assert.equal(hashFromUrl(`${ORIGIN}/#/boards/1`, ORIGIN), "#/boards/1");
  assert.equal(hashFromUrl("/#/notes/2", ORIGIN), "#/notes/2");
  for (const url of [
    "https://evil.test/#/boards/1",
    "http://127.0.0.1:4100/#/boards/1",
    "javascript:alert(1)//#/boards/1",
    `${ORIGIN}/f/token#/boards/1`,
    `${ORIGIN}/`,
    "#boards",
    "",
    null,
    42,
  ]) {
    assert.equal(hashFromUrl(url, ORIGIN), null, String(url));
  }
});

/** A router over fake pages that record their lifecycle. */
function lifecycleRouter(t, { initial = "#/a" } = {}) {
  installDocument(t);
  const win = fakeWindow(initial);
  const log = [];
  const page = (name, extra = {}) => ({
    async mount(container, ctx, params) {
      log.push(["mount", name, params]);
      container.append(new FakeElement(name));
      return () => log.push(["cleanup", name]);
    },
    ...extra,
  });
  const router = createRouter({ window: win });
  router.register("/a", async () => page("a"), { name: "a" });
  router.register("/b/:id", async () => page("b"), {
    name: "b",
    key: () => "b",
  });
  router.register("/b/:id/more", async () => page("b"), {
    name: "b",
    key: () => "b",
    params: { more: true },
  });
  router.setFallback(async () => page("missing"));
  const outlet = new FakeElement("main");
  const failures = [];
  router.start({
    outlet,
    ctx: { marker: true },
    loading: () => new FakeElement("loading"),
    failed: (error, retry) => {
      failures.push({ error, retry });
      return new FakeElement("failed");
    },
  });
  return { router, win, log, outlet, failures };
}

test("the router mounts, keeps same-key pages and cleans up on leave", async (t) => {
  const { router, log, outlet } = lifecycleRouter(t);
  const routes = [];
  router.onChange((route) => routes.push(route.path));
  await settle();
  assert.deepEqual(log, [["mount", "a", {}]]);
  assert.equal(outlet.dataset.page, "a");
  assert.equal(outlet.children.length, 1);

  router.navigate("#/b/1");
  await settle();
  router.navigate("#/b/1/more");
  await settle();
  assert.deepEqual(log.slice(1), [
    ["cleanup", "a"],
    ["mount", "b", { id: "1" }],
  ]);
  assert.deepEqual(router.current().params, { id: "1", more: true });
  assert.deepEqual(routes, ["/b/1", "/b/1/more"]);
  // Only the current page's root stays in the outlet.
  assert.equal(outlet.children.length, 1);
  assert.equal(outlet.children[0].children[0].tagName, "B");

  router.navigate("#/elsewhere");
  await settle();
  assert.deepEqual(log.slice(3), [
    ["cleanup", "b"],
    ["mount", "missing", {}],
  ]);
  assert.equal(router.current().name, "not-found");
});

test("a page that finishes mounting after navigation is cleaned up", async (t) => {
  installDocument(t);
  const win = fakeWindow("#/slow");
  const log = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const router = createRouter({ window: win });
  router.register("/slow", async () => ({
    async mount() {
      await gate;
      log.push("slow mounted");
      return () => log.push("slow cleaned");
    },
  }));
  router.register("/fast", async () => ({
    mount: () => {
      log.push("fast mounted");
    },
  }));
  router.start({
    outlet: new FakeElement("main"),
    ctx: {},
    loading: () => new FakeElement("loading"),
    failed: () => new FakeElement("failed"),
  });
  await settle();
  router.navigate("#/fast");
  await settle();
  release();
  await settle();
  assert.deepEqual(log, ["fast mounted", "slow mounted", "slow cleaned"]);
});

test("a failing page shows the failure view with a retry", async (t) => {
  installDocument(t);
  const win = fakeWindow("#/broken");
  let attempts = 0;
  const router = createRouter({ window: win });
  router.register("/broken", async () => ({
    mount() {
      attempts += 1;
      throw new Error("boom");
    },
  }));
  const failures = [];
  const outlet = new FakeElement("main");
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  router.start({
    outlet,
    ctx: {},
    loading: () => new FakeElement("loading"),
    failed: (error, retry) => {
      failures.push(error.message);
      failures.retry = retry;
      return new FakeElement("failed");
    },
  });
  await settle();
  assert.deepEqual([...failures], ["boom"]);
  assert.equal(outlet.children[0].children[0].tagName, "FAILED");
  failures.retry();
  await settle();
  assert.equal(attempts, 2);
});

test("an empty hash redirects to Home", async (t) => {
  const { win } = lifecycleRouter(t, { initial: "" });
  await settle();
  assert.equal(win.location.hash, "#/home");
});

test("every page module of the route table exports mount()", async () => {
  const loaders = new Set([
    ...APP_ROUTES.map(([, loader]) => loader),
    NOT_FOUND_PAGE,
  ]);
  for (const loader of loaders) {
    const module = await loader();
    assert.equal(typeof module.mount, "function");
  }
});
