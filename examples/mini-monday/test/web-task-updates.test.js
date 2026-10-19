/**
 * The task view's Updates pane (SPEC-6 §2.3) on the fake DOM: cards in
 * the server's order built from `body_parts` only (mention chips, a
 * private task, safe links), the "…" menu by permission, likes, replies
 * and "Show N more replies", the composers with the mention picker
 * (keyboard, encoding picked mentions as tokens), the edit box's round
 * trip, the viewer's read-only pane and the empty, loading and error
 * states.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { h } from "../web/dom.js";
import { updateMenuItems } from "../web/ui/board/update-card.js";
import { createUpdatesUi, updatesPane } from "../web/ui/board/updates-pane.js";
import { findAll, fire, hasClass } from "./fake-dom.js";
import { installTaskDom, meetingsBoard, task } from "./web-task-fixtures.js";

const byClass = (root, name) => findAll(root, (node) => hasClass(node, name));
const oneOf = (root, name) => {
  const [found] = byClass(root, name);
  assert.ok(found, `.${name}`);
  return found;
};
const byKey = (root, key) =>
  findAll(root, (node) => node.dataset.focusKey === key)[0] ?? null;
const cardOf = (root, id) =>
  findAll(root, (node) => node.dataset.updateId === id)[0] ?? null;

const SAM = { id: "2", name: "Sam Lee", initials: "SL", email: "sam@x.test" };
const NOA = { id: "3", name: "Noa Cohen", initials: "NC" };
const ME = { id: "1", name: "Alex Rivera", initials: "AR" };

function update(id, extra = {}) {
  return {
    id,
    body: "",
    parts: [{ type: "text", text: `Update ${id}` }],
    creator: SAM,
    authorName: null,
    createdAt: "2026-10-02T09:00:00.000Z",
    editedAt: null,
    pinned: false,
    likesCount: 0,
    likedByMe: false,
    likers: [],
    canEdit: false,
    canDelete: false,
    replies: [],
    ...extra,
  };
}

const LIST = [
  update("30", {
    pinned: true,
    likesCount: 2,
    likers: [SAM, NOA],
    replies: ["31", "32", "33", "34", "35"].map((id) => update(id)),
  }),
  update("21", {
    creator: null,
    authorName: "Fox Mulder",
    parts: [
      { type: "text", text: "Minutes: " },
      {
        type: "link",
        text: "https://example.com/notes",
        url: "https://example.com/notes",
      },
      { type: "text", text: ".\nتم" },
    ],
  }),
  update("20", {
    creator: ME,
    canEdit: true,
    canDelete: true,
    editedAt: "2026-10-03T09:00:00.000Z",
    body: "@[Sam Lee](user:2) see @[Book room](item:2), @[Private task](item:77) @[Product](team:3)",
    parts: [
      { type: "user", text: "Sam Lee", id: "2" },
      { type: "text", text: " see " },
      { type: "item", text: "Book room", id: "2", boardId: "1" },
      { type: "text", text: ", " },
      { type: "item", text: null, id: "77", boardId: null },
      { type: "text", text: " " },
      { type: "team", text: "Product", id: "3" },
    ],
  }),
];

/** Records action calls; every action resolves true. */
function recorder() {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) => {
          calls.push([name, ...args]);
          return Promise.resolve(true);
        },
    },
  );
  return { calls, actions };
}

/**
 * Renders the pane of task "Agenda" into a container; `repaint()` (what
 * the task view's regions do) renders it again from the same `ui`.
 */
function renderPane(t, { edit = true, list = LIST, updates } = {}) {
  installTaskDom(t);
  const board = meetingsBoard([task("1", "Agenda"), task("2", "Book room")]);
  board.assignableUsers = [ME, SAM];
  const { calls, actions } = recorder();
  const container = h("div");
  globalThis.document.body.append(container);
  const ui = { updates: createUpdatesUi() };
  const props = {
    item: board.items[0],
    detail: { id: "1", creator: SAM, createdAt: null, updatesCount: 9 },
    board,
    users: new Map([[SAM.id, SAM]]),
    actions,
    caps: { edit, viewOnly: !edit },
    me: ME,
    people: { users: [ME, SAM, NOA], teams: [{ id: "3", name: "Product" }] },
    updates: updates ?? { status: "ready", list, hasMore: false, limit: 25 },
    target: null,
    ui,
    repaint: () => container.replaceChildren(updatesPane(props)),
    focusIn: (key) => byKey(container, key)?.focus(),
  };
  props.repaint();
  /** What the cards' menus act on (`update-card.js`). */
  const cx = { props, ui: ui.updates, calls };
  return { root: () => container, calls, props, cx, ui: ui.updates };
}

test("cards keep the server's order and render body parts only", (t) => {
  const { root } = renderPane(t);
  const pane = oneOf(root(), "task-updates");
  const tab = oneOf(pane, "updates-tab");
  assert.equal(tab.getAttribute("aria-selected"), "true");
  assert.equal(tab.textContent, "Updates9");
  const input = oneOf(pane, "update-composer-input");
  assert.equal(input.getAttribute("placeholder"), "Write an update…");
  assert.equal(oneOf(pane, "update-composer-submit").textContent, "Update");
  assert.deepEqual(
    byClass(pane, "update-card").map((node) => node.dataset.updateId),
    ["30", "21", "20"],
  );
  assert.equal(
    oneOf(cardOf(pane, "30"), "update-pinned").textContent,
    "Pinned to top",
  );
  const fox = cardOf(pane, "21");
  assert.equal(oneOf(fox, "update-author").textContent, "Fox Mulder");
  assert.equal(oneOf(fox, "update-source").textContent, "ClickUp");
  for (const time of byClass(pane, "update-time")) {
    assert.ok(time.getAttribute("title"), time.textContent);
  }
  const body = oneOf(fox, "update-body");
  assert.equal(body.getAttribute("dir"), "auto");
  assert.equal(body.textContent, "Minutes: https://example.com/notes.\nتم");
  const [link] = findAll(body, (node) => node.tagName === "A");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(link.getAttribute("target"), "_blank");
  // Mention chips: a person, a task (its task view), a private task, a team.
  const own = cardOf(pane, "20");
  assert.equal(oneOf(own, "update-edited").textContent, "(edited)");
  assert.equal(oneOf(own, "mention-user").textContent, "@Sam Lee");
  assert.equal(oneOf(own, "mention-user").tagName, "BUTTON");
  assert.equal(
    oneOf(own, "mention-task").getAttribute("href"),
    "#/boards/1/items/2",
  );
  assert.equal(oneOf(own, "mention-private").textContent, "Private task");
  assert.equal(oneOf(own, "mention-team").getAttribute("href"), "#/teams/3");
  assert.equal(
    oneOf(own, "update-body").textContent,
    "@Sam Lee see Book room, Private task @Product",
  );
  // Who created the task closes the feed.
  assert.match(
    oneOf(pane, "updates-created").textContent,
    /^Sam Lee created this task/,
  );
});

test("likes, replies and 'Show N more replies'", (t) => {
  const { root, calls, props } = renderPane(t);
  const pinned = () => cardOf(root(), "30");
  const like = oneOf(pinned(), "update-like");
  assert.equal(like.getAttribute("aria-pressed"), "false");
  fire(like, "click");
  assert.deepEqual(calls.at(-1), ["likeUpdate", LIST[0]]);
  // The count lists the likers on hover and focus.
  const count = oneOf(pinned(), "update-like-count");
  assert.equal(count.textContent, "2");
  assert.equal(count.getAttribute("tabindex"), "0");
  assert.equal(
    oneOf(pinned(), "update-likers").textContent,
    "Liked by Sam Lee and Noa Cohen",
  );
  // Five replies: the newest three show.
  const replyIds = () =>
    byClass(pinned(), "update-reply").map((node) => node.dataset.updateId);
  assert.deepEqual(replyIds(), ["33", "34", "35"]);
  const more = oneOf(pinned(), "update-more-replies");
  assert.equal(more.textContent, "Show 2 more replies");
  fire(more, "click");
  assert.deepEqual(calls.at(-1), ["showMoreReplies", LIST[0]]);
  // The action shows the thread whole (`updates.threads`).
  props.updates.threads = new Set(["30"]);
  props.repaint();
  assert.deepEqual(replyIds(), ["31", "32", "33", "34", "35"]);
  // Only the newest loaded: the count, and "Loading replies…" meanwhile.
  props.updates.list = [{ ...LIST[0], repliesCount: 9 }, ...LIST.slice(1)];
  props.updates.threads = new Set();
  props.repaint();
  assert.equal(
    oneOf(pinned(), "update-more-replies").textContent,
    "Show 6 more replies",
  );
  props.updates.loadingThreads = new Set(["30"]);
  props.repaint();
  const busy = oneOf(pinned(), "update-more-replies");
  assert.deepEqual(
    [busy.textContent, busy.disabled],
    ["Loading replies…", true],
  );
  props.updates.list = LIST;
  // Reply opens a composer under the card, focused.
  fire(byKey(pinned(), "update-reply:30"), "click");
  const box = byKey(root(), "composer:reply:30");
  assert.equal(box.getAttribute("placeholder"), "Write a reply…");
  assert.equal(globalThis.document.activeElement, box);
  box.value = "On it";
  fire(box, "input");
  fire(oneOf(pinned(), "update-reply-composer"), "submit");
  const [name, item, parent, draft] = calls.at(-1);
  assert.deepEqual(
    [name, item.id, parent.id, draft.body],
    ["replyToUpdate", "1", "30", "On it"],
  );
});

test("the menu offers what the reader may do", (t) => {
  const { cx } = renderPane(t);
  const labels = (update, parent = null) =>
    updateMenuItems(cx, update, parent)
      .filter(Boolean)
      .map((entry) => entry.label ?? entry.type);
  assert.deepEqual(labels(LIST[2]), [
    "Edit",
    "Pin to top",
    "Copy link",
    "separator",
    "Delete",
  ]);
  assert.deepEqual(labels(LIST[0]), ["Unpin", "Copy link"]);
  // Replies cannot be pinned.
  assert.deepEqual(labels(LIST[0].replies[0], LIST[0]), ["Copy link"]);
  const select = (update, label) =>
    updateMenuItems(cx, update, null)
      .find((entry) => entry?.label === label)
      .onSelect();
  const { calls } = cx;
  select(LIST[0], "Unpin");
  select(LIST[2], "Delete");
  assert.deepEqual(
    calls.slice(-2).map(([name, ...args]) => [name, args.at(-1).id]),
    [
      ["pinUpdate", "30"],
      ["deleteUpdate", "20"],
    ],
  );
});

/** Answers the task picker's requests: one task on board 9, "Done". */
function stubSearch(t) {
  const original = globalThis.fetch;
  const data = {
    TaskPickerSearch: {
      search: [
        {
          kind: "board",
          id: "9",
          title: "Other",
          subtitle: null,
          url: "#/boards/9",
        },
        {
          kind: "item",
          id: "88",
          title: "Order books",
          subtitle: "Other",
          url: "#/boards/9/items/88",
        },
      ],
    },
    TaskPickerBoards: {
      boards: [
        {
          id: "9",
          columns: [
            {
              id: "state",
              title: "State",
              type: "status",
              role: null,
              settings_str: JSON.stringify({
                labels: { 1: "Done" },
                labels_colors: { 1: "#00c875" },
              }),
            },
          ],
        },
      ],
    },
    TaskPickerStatus: {
      items: [
        {
          id: "88",
          column_values: [{ id: "state", text: "Done", value: '{"index":1}' }],
        },
      ],
    },
  };
  globalThis.fetch = async (_url, init) => {
    const name = /query (\w+)/.exec(JSON.parse(init.body).query)[1];
    const text = JSON.stringify({ data: data[name] });
    return { ok: true, status: 200, text: async () => text };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("the picker inserts mentions that post as tokens", async (t) => {
  const { root, calls } = renderPane(t);
  const input = () => byKey(root(), "composer:main");
  const listbox = () => oneOf(root(), "mention-picker");
  input().value = "Hi @sa";
  fire(input(), "input");
  assert.equal(listbox().hidden, false);
  const names = () =>
    byClass(listbox(), "mention-option-name").map((node) => node.textContent);
  assert.deepEqual(names(), ["Sam Lee"]);
  input().value = "Hi @";
  fire(input(), "input");
  // Board people first, then teams, then people without access.
  assert.deepEqual(names(), ["Alex Rivera", "Sam Lee", "Product", "Noa Cohen"]);
  assert.equal(oneOf(listbox(), "mention-no-access").textContent, "No access");
  assert.equal(input().getAttribute("aria-controls"), listbox().id);
  const active = () => input().getAttribute("aria-activedescendant");
  assert.equal(active(), `${listbox().id}-0`);
  fire(input(), "keydown", { key: "ArrowDown" });
  assert.equal(active(), `${listbox().id}-1`);
  const enter = fire(input(), "keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input().value, "Hi @Sam Lee ");
  assert.equal(listbox().hidden, true);
  // Escape closes an open picker without closing the task view.
  input().value = "Hi @Sam Lee and @@";
  fire(input(), "input");
  assert.equal(listbox().hidden, false);
  assert.deepEqual(names(), ["Book room"]);
  const escape = fire(input(), "keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(listbox().hidden, true);
  assert.ok(!calls.some(([name]) => name === "close"));
  // Typed task names search the server (debounced); a click picks.
  stubSearch(t);
  // (Escape keeps that "@@" closed; leaving it lets a new one open.)
  input().value = "Hi @Sam Lee and ";
  fire(input(), "input");
  input().value = "Hi @Sam Lee and @@boo";
  fire(input(), "input");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(names(), ["Order books"]);
  assert.equal(oneOf(listbox(), "mention-option-detail").textContent, "Other");
  const dot = oneOf(listbox(), "mention-status-dot");
  assert.equal(dot.style.backgroundColor, "#00c875");
  assert.equal(dot.getAttribute("title"), "Done");
  fire(oneOf(listbox(), "mention-option"), "click");
  assert.equal(input().value, "Hi @Sam Lee and @Order books ");
  fire(oneOf(root(), "update-main-composer"), "submit");
  const [name, item, draft] = calls.at(-1);
  assert.deepEqual([name, item.id], ["postUpdate", "1"]);
  assert.equal(draft.body, "Hi @[Sam Lee](user:2) and @[Order books](item:88)");
  assert.deepEqual(draft.parts.at(-1), {
    type: "item",
    text: "Order books",
    id: "88",
    boardId: "9",
  });
  assert.equal(input().value, "", "the composer clears at once");
});

test("the edit box loads tokens back as @Name and saves them", (t) => {
  const { root, calls, cx } = renderPane(t);
  updateMenuItems(cx, LIST[2], null)
    .find((entry) => entry?.label === "Edit")
    .onSelect();
  const box = byKey(root(), "composer:edit:20");
  assert.equal(globalThis.document.activeElement, box);
  assert.equal(box.value, "@Sam Lee see @Book room, @Private task @Product");
  // Escape cancels the edit (and only the edit).
  const escape = fire(box, "keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(byKey(root(), "composer:edit:20"), null);
  // Edit again: the mentions survive a change around them.
  updateMenuItems(cx, LIST[2], null)
    .find((entry) => entry?.label === "Edit")
    .onSelect();
  const again = byKey(root(), "composer:edit:20");
  again.value = `${again.value} soon`;
  fire(again, "input");
  fire(oneOf(root(), "update-edit"), "submit");
  const [name, update, draft] = calls.at(-1);
  assert.deepEqual([name, update.id], ["editUpdate", "20"]);
  assert.equal(
    draft.body,
    "@[Sam Lee](user:2) see @[Book room](item:2), @[Private task](item:77) @[Product](team:3) soon",
  );
  assert.equal(cx.ui.editing, null);
});

test("viewers read everything, read-only", (t) => {
  const { root } = renderPane(t, { edit: false });
  const pane = oneOf(root(), "task-updates");
  assert.equal(byClass(pane, "update-composer").length, 0);
  assert.match(oneOf(pane, "task-readonly-note").textContent, /view-only/);
  assert.equal(byClass(pane, "update-like").length, 0);
  assert.equal(byClass(pane, "update-reply-button").length, 0);
  // Likes still show, with their likers.
  assert.equal(oneOf(cardOf(pane, "30"), "update-like-count").textContent, "2");
  assert.equal(byClass(pane, "update-card").length, 3);
});

test("empty, loading and failed feeds", (t) => {
  const empty = renderPane(t, { list: [] });
  assert.equal(
    oneOf(empty.root(), "empty-title").textContent,
    "No updates yet",
  );
  assert.match(
    oneOf(empty.root(), "empty-text").textContent,
    /Type @ to mention/,
  );
  const loading = renderPane(t, { updates: { status: "loading", list: null } });
  assert.equal(byClass(loading.root(), "skeleton-list").length, 1);
  const failed = renderPane(t, { updates: { status: "error", list: null } });
  assert.equal(
    oneOf(failed.root(), "empty-title").textContent,
    "Updates couldn’t be loaded",
  );
  const more = renderPane(t, {
    updates: { status: "ready", list: LIST, hasMore: true, limit: 25 },
  });
  fire(byKey(more.root(), "updates-older"), "click");
  assert.deepEqual(more.calls.at(-1), ["showOlderUpdates"]);
  more.props.updates.loadingOlder = new Set(["cursor"]);
  more.props.repaint();
  const older = byKey(more.root(), "updates-older");
  assert.deepEqual(
    [older.textContent, older.disabled],
    ["Loading older updates…", true],
  );
});

test("a route's update shows lit for a while", (t) => {
  const { root, props, ui } = renderPane(t);
  // Loading shows the thread of an older reply whole (`loadUpdates`).
  props.updates.threads = new Set(["30"]);
  props.target = { id: "31", seq: 1 };
  props.repaint();
  const reply = cardOf(root(), "31");
  assert.ok(reply, "the older reply shows");
  assert.ok(hasClass(reply, "highlight"));
  assert.equal(ui.scrollTo, "31");
  assert.ok(ui.highlight.until > Date.now());
  // The same target is taken once; a lapsed highlight goes.
  ui.highlight.until = Date.now() - 1;
  props.repaint();
  assert.equal(hasClass(cardOf(root(), "31"), "highlight"), false);
  props.target = { id: "404", seq: 2 };
  props.repaint();
  assert.equal(ui.handled, 2);
});
