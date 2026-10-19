/**
 * The task view's right pane, monday-style (SPEC-6 §2.3): an "Updates"
 * tab with the item's update count over one scrolling feed (`#task-stream`):
 *
 * - "Write an update…" on top (editors; viewers get a note instead), a
 *   composer with mentions (`update-composer.js`);
 * - the update cards in the server's order, pinned first, then newest
 *   first (`update-card.js`); "Show older updates" when there are more,
 *   which appends the next page;
 * - "No updates yet" with an @mention hint when there are none;
 * - who created the task, at the end.
 *
 * The Activity tab (the item's field changes) is not shown: the API's
 * activity logs cannot be filtered by item (`Board.activity_logs` lists
 * a board's newest entries), and SPEC-6 §2.3 hides the tab then.
 *
 * `ui` (`createUpdatesUi`, kept by the task view per task) holds what the
 * pane shows besides the data: composer drafts, open reply boxes, the
 * edit box and the update a route points at
 * (`#/boards/<id>/items/<itemId>/updates/<updateId>`): that one is
 * scrolled into view and highlighted for HIGHLIGHT_MS (`revealTarget`).
 * Loading finds it first, however old (`updates-data.js loadUpdates`:
 * pages back to it and shows an older reply's thread whole).
 */

import { h } from "../../dom.js";
import { emptyState } from "../components/empty-state.js";
import { formatTime, timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { skeletonList } from "../components/skeleton.js";
import { showToast } from "../components/toast.js";
import { peopleOptions } from "./mention-picker-model.js";
import { updateCard, updateElementId } from "./update-card.js";
import { updateComposer } from "./update-composer.js";
import { boardTasks, searchTasks } from "./updates-data.js";
import { findUpdate } from "./updates-model.js";

/** How long the update a link points at stays highlighted. */
export const HIGHLIGHT_MS = 2000;

/** The pane's UI state of one task (see the module comment). */
export function createUpdatesUi() {
  return {
    composers: new Map(),
    replying: new Set(),
    editing: null,
    highlight: null,
    /** The `seq` of the last route target handled, and one to scroll to. */
    handled: null,
    scrollTo: null,
  };
}

/** Where the composers' mention pickers find people and tasks. */
function mentionSources(props) {
  const { board, item, people } = props;
  return {
    people: (query) =>
      peopleOptions({
        assignable: board.assignableUsers ?? [],
        users: people?.users ?? [],
        teams: people?.teams ?? [],
        query,
      }),
    boardTasks: () => boardTasks(board, item.id),
    tasks: (query, cache) => searchTasks(query, cache),
  };
}

function tabsHeader(props) {
  const count = props.detail?.updatesCount;
  return h(
    "div",
    { class: "updates-tabs", role: "tablist", "aria-label": "Task feed" },
    h(
      "button",
      {
        type: "button",
        role: "tab",
        id: "task-updates-tab",
        class: "updates-tab active",
        "aria-selected": "true",
        "aria-controls": "task-stream",
        tabindex: "0",
      },
      icon("chat", { size: 14 }),
      h("span", null, "Updates"),
      Number.isSafeInteger(count) && count > 0
        ? h("span", { class: "updates-tab-count" }, String(count))
        : null,
    ),
  );
}

function mainComposer(cx) {
  const { props } = cx;
  if (!props.caps.edit) {
    return h(
      "p",
      { class: "task-readonly-note" },
      icon("eye", { size: 14 }),
      "You have view-only access, so you can read updates but not post them.",
    );
  }
  return updateComposer({
    key: "main",
    store: cx.ui.composers,
    placeholder: "Write an update…",
    label: "Write an update",
    submitLabel: "Update",
    hint: "Type @ to mention · Ctrl + Enter to post",
    className: "update-main-composer",
    sources: cx.sources,
    onSubmit: (draft) => props.actions.postUpdate(props.item, draft),
    onRestore: () => props.repaint(),
  });
}

function emptyFeed(props) {
  return emptyState({
    icon: "chat",
    title: "No updates yet",
    text: props.caps.edit
      ? "Share progress or ask a question. Type @ to mention a teammate, or @@ to link a task."
      : "Updates posted on this task appear here.",
    compact: true,
  });
}

function feed(cx) {
  const { updates, actions } = cx.props;
  if (!updates?.list) {
    if (updates?.status === "error") {
      return emptyState({
        icon: "alert",
        title: "Updates couldn’t be loaded",
        compact: true,
        action: { label: "Try again", onClick: () => actions.reloadUpdates() },
      });
    }
    return skeletonList({ rows: 3, label: "Loading updates" });
  }
  if (updates.list.length === 0) return emptyFeed(cx.props);
  return h(
    "ol",
    { class: "update-list", "aria-label": "Updates" },
    updates.list.map((update) => updateCard(cx, update)),
  );
}

function olderButton(props) {
  const { updates } = props;
  if (!updates?.hasMore || !updates.list) return null;
  const loading = (updates.loadingOlder?.size ?? 0) > 0;
  return h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm updates-older",
      disabled: loading,
      "aria-busy": loading ? "true" : null,
      dataset: { focusKey: "updates-older" },
      on: { click: () => props.actions.showOlderUpdates() },
    },
    icon("chevronDown", { size: 14 }),
    h("span", null, loading ? "Loading older updates…" : "Show older updates"),
  );
}

function createdLine({ detail }) {
  if (!detail) return null;
  const { creator, createdAt } = detail;
  return h(
    "p",
    { class: "updates-created" },
    icon("plus", { size: 12 }),
    h(
      "span",
      null,
      creator
        ? [h("strong", { dir: "auto" }, creator.name), " created this task"]
        : "This task was created",
      createdAt
        ? [
            " · ",
            h(
              "time",
              { datetime: createdAt, title: formatTime(createdAt) || null },
              timeAgo(createdAt),
            ),
          ]
        : null,
    ),
  );
}

/**
 * Takes a new route target (`props.target`, `{ id, seq }`) once the
 * updates are loaded (with it, when it exists): highlights the update
 * and marks it to be scrolled to; an update that is not there any more
 * says so once.
 */
function takeTarget(ui, props) {
  const target = props.target;
  const list = props.updates?.list;
  if (!target || ui.handled === target.seq || !list) return;
  ui.handled = target.seq;
  if (!findUpdate(list, target.id)) {
    showToast({ message: "This update isn’t available anymore", type: "info" });
    return;
  }
  ui.highlight = { id: target.id, until: Date.now() + HIGHLIGHT_MS };
  ui.scrollTo = target.id;
}

/**
 * Scrolls the targeted update into view and focuses it, once, after the
 * view is shown; its highlight fades after HIGHLIGHT_MS.
 */
export function revealTarget(ui) {
  const id = ui.scrollTo;
  if (!id) return;
  const element = globalThis.document.getElementById?.(updateElementId(id));
  if (!element) return;
  ui.scrollTo = null;
  element.scrollIntoView?.({ block: "center" });
  // After the region's render, which puts focus back where it was.
  globalThis.setTimeout(() => {
    const shown = globalThis.document.getElementById?.(updateElementId(id));
    shown?.focus?.({ preventScroll: true });
  }, 0);
  const left = Math.max(0, (ui.highlight?.until ?? 0) - Date.now());
  globalThis.setTimeout(() => {
    if (ui.highlight?.id !== id) return;
    ui.highlight = null;
    globalThis.document
      .getElementById?.(updateElementId(id))
      ?.classList?.remove("highlight");
  }, left);
}

/**
 * The Updates pane of the task in `props` (task view props, with
 * `updates` `{ status, list, hasMore, threads?, loadingOlder?,
 * loadingThreads? }`, `target`, `people`, `me` and `ui.updates`).
 */
export function updatesPane(props) {
  const ui = props.ui.updates;
  takeTarget(ui, props);
  const cx = { props, ui, sources: mentionSources(props) };
  return h(
    "aside",
    { class: "task-updates", "aria-label": "Updates" },
    tabsHeader(props),
    h(
      "div",
      {
        class: "updates-scroll",
        id: "task-stream",
        role: "tabpanel",
        tabindex: "0",
        "aria-labelledby": "task-updates-tab",
      },
      mainComposer(cx),
      feed(cx),
      olderButton(props),
      createdLine(props),
    ),
  );
}
