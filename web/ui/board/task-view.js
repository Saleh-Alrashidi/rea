/**
 * Task view (SPEC-5 §4, SPEC-6 §1.1, ClickUp style): how the item route
 * shows an item, from every view of every board. A modal
 * `<dialog class="task-view">` (`createModalPanel`: Escape, a backdrop
 * click and the close button close it; focus returns to the opener)
 * holding a top bar (breadcrumb, "Subtask of …", the task ID, close), a
 * left pane that scrolls (title, fields grid, description, custom fields,
 * subtasks: `task-fields.js`, `task-subtasks.js`) and the Activity pane
 * (`task-activity.js`).
 *
 * Every editor reuses the board's actions and carries a focus key, so a
 * live refresh keeps focus and unsaved text. The view keeps its own UI
 * state across renders (the text field being edited, whether empty
 * fields show) and the panes' scroll positions across refreshes; a newly
 * opened task starts at its top with its activity scrolled to the end.
 */

import { h } from "../../dom.js";
import { boardHash, itemHash, workspaceHash } from "../../router.js";
import { accessBadge } from "../components/badge.js";
import { iconButton } from "../components/button.js";
import { emptyState } from "../components/empty-state.js";
import { findByFocusKey } from "../components/focus.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { createModalPanel } from "../components/modal-panel.js";
import { skeletonList } from "../components/skeleton.js";
import { activityPane } from "./task-activity.js";
import {
  customSection,
  descriptionSection,
  fieldsGrid,
} from "./task-fields.js";
import { taskLayout, taskParent } from "./task-model.js";
import { subtasksSection } from "./task-subtasks.js";
import { isDoneStatus } from "./values.js";

/** A missing task and one on another board read the same (no leaks). */
const TASK_MESSAGES = Object.freeze({
  loading: { title: "Loading task…", busy: true },
  missing: {
    title: "This task isn’t available",
    text: "It may have been deleted or moved to a board you can’t open.",
  },
  error: {
    title: "The task couldn’t be loaded",
    text: "Check your connection and try again.",
  },
});
/** Scrolled within this many pixels of the end counts as at the end. */
const END_SLACK = 24;
/** The panes whose scroll position survives a refresh. */
const SCROLLERS = Object.freeze(["task-body", "task-main"]);

function closeButton(onClose) {
  return iconButton({
    icon: "close",
    label: "Close task",
    className: "task-close",
    dataset: { focusKey: "task-close" },
    onClick: onClose,
  });
}

function breadcrumb(board) {
  const { workspace } = board;
  return h(
    "nav",
    { class: "task-breadcrumb", "aria-label": "Breadcrumb" },
    h(
      "ol",
      null,
      workspace
        ? h(
            "li",
            null,
            board.workspaceAccessible
              ? h("a", { href: workspaceHash(workspace.id) }, workspace.name)
              : h("span", null, workspace.name),
          )
        : null,
      h(
        "li",
        null,
        h(
          "a",
          { href: boardHash(board.id), dir: "auto" },
          icon("list", { size: 14 }),
          h("span", null, board.name),
        ),
      ),
    ),
  );
}

function topBar(props) {
  const { board, item, detail } = props;
  const parent = taskParent(board, item, detail);
  return h(
    "header",
    { class: "task-topbar" },
    breadcrumb(board),
    parent
      ? h(
          "a",
          {
            class: "task-parent",
            href: itemHash(board.id, parent.id),
            dataset: { focusKey: "task-parent" },
          },
          icon("subtask", { size: 14 }),
          h("span", null, "Subtask of"),
          h("span", { class: "task-parent-name", dir: "auto" }, parent.name),
        )
      : null,
    h("span", { class: "task-topbar-end" }),
    h("span", { class: "task-id", title: "Task ID" }, `#${item.id}`),
    closeButton(props.onClose),
  );
}

function titleBlock(props) {
  const { item, caps, actions } = props;
  if (!caps.edit) {
    return h(
      "div",
      { class: "task-title-row" },
      h("h2", { class: "task-title-text", dir: "auto" }, item.name),
      caps.viewOnly ? accessBadge("viewer") : null,
    );
  }
  return h(
    "div",
    { class: "task-title-row" },
    h(
      "h2",
      { class: "task-title-heading" },
      inlineInput({
        value: item.name,
        label: "Task name",
        className: "task-title",
        required: true,
        focusKey: "task-name",
        onCommit: (name) => actions.renameItem(item, name),
      }),
    ),
  );
}

function taskContent(props) {
  const layout = taskLayout(props.board.columns);
  const status = layout.roles.status;
  const done =
    Boolean(status) &&
    isDoneStatus(status, props.item.values[status.id] ?? null);
  const view = { ...props, done };
  return h(
    "div",
    { class: "task-inner" },
    topBar(view),
    h(
      "div",
      { class: "task-body", id: "task-body" },
      h(
        "div",
        { class: "task-main", id: "task-main" },
        titleBlock(view),
        fieldsGrid(view, layout),
        descriptionSection(view, layout),
        customSection(view, layout),
        subtasksSection(view, layout),
      ),
      activityPane(view),
    ),
  );
}

function statusContent(props, { title, text, busy = false }) {
  return h(
    "div",
    { class: "task-inner" },
    h(
      "header",
      { class: "task-topbar" },
      h("span", { class: "task-topbar-title" }, busy ? "Task" : title),
      h("span", { class: "task-topbar-end" }),
      closeButton(props.onClose),
    ),
    h(
      "div",
      { class: "task-status-body" },
      busy
        ? skeletonList({ rows: 4, label: title })
        : emptyState({ icon: "item", title, text, compact: true }),
    ),
  );
}

// ------------------------------------------------------------- scroll

const byId = (id) => globalThis.document.getElementById?.(id) ?? null;

/**
 * The scroll positions to keep: each pane's offset, and the stream's
 * unless it sits at its end (then it stays at the end as comments come).
 */
function readScroll() {
  const panes = SCROLLERS.map((id) => byId(id)?.scrollTop ?? 0);
  const stream = byId("task-stream");
  const atEnd =
    !stream ||
    stream.scrollHeight - stream.scrollTop - stream.clientHeight < END_SLACK;
  return { panes, stream: atEnd ? null : stream.scrollTop };
}

function applyScroll(scroll) {
  SCROLLERS.forEach((id, index) => {
    const pane = byId(id);
    if (pane) pane.scrollTop = scroll?.panes[index] ?? 0;
  });
  const stream = byId("task-stream");
  if (stream) stream.scrollTop = scroll?.stream ?? stream.scrollHeight;
}

// -------------------------------------------------------------- view

/**
 * Creates the task view. `render(props)` fills it: `props.status` is "loading", "missing", "error" or "ready" (with
 * `item`, `detail`, `board`, `users`, `actions`, `caps`, `draft`,
 * `onDraft`), plus `itemId` (the route's) and `repaint()`, which redraws
 * the view through the page's regions. `show()` follows each render.
 *
 * @param {{ onClose(): void }} options
 */
export function createTaskView({ onClose }) {
  const panel = createModalPanel({
    className: "task-view",
    label: "Task",
    onClose,
  });
  const dialog = panel.element;
  /** What the view shows of the task in `itemId` beyond the data. */
  const ui = { itemId: null, editing: null, showEmpty: false };
  let props = null;
  let scroll = null;

  function focusIn(key, { caretAtEnd = false } = {}) {
    const target = findByFocusKey(dialog, key);
    if (!target) return;
    target.focus();
    if (!caretAtEnd) return;
    const end = target.value?.length ?? 0;
    target.setSelectionRange?.(end, end);
  }

  const controls = {
    ui,
    focusIn,
    /** Opens the editor of text field `key`, focused at its end. */
    startEdit(key) {
      ui.editing = key;
      props.repaint();
      focusIn(`task-edit:${key}`, { caretAtEnd: true });
    },
    /**
     * Closes the editor of `key` (if it is still the one open) and runs
     * `save`, which redraws; `refocus` returns focus to the field.
     */
    endEdit(key, { save, refocus }) {
      const open = ui.editing === key;
      if (open) ui.editing = null;
      if (save) save();
      else if (open) props.repaint();
      if (refocus) focusIn(`task-edit-btn:${key}`);
    },
    toggleEmpty() {
      ui.showEmpty = !ui.showEmpty;
      props.repaint();
    },
  };

  return {
    element: dialog,
    /** Opens the view (idempotent) and restores its panes' scroll. */
    show() {
      panel.show();
      applyScroll(scroll);
    },
    /** Closes the view; focus returns to its opener. */
    hide() {
      panel.hide();
      ui.itemId = null;
      ui.editing = null;
    },
    render(next) {
      const same = next.itemId === ui.itemId;
      scroll = same && dialog.open ? readScroll() : null;
      if (!same) {
        ui.itemId = next.itemId;
        ui.editing = null;
      }
      props = { ...next, ...controls, onClose };
      const ready = next.status === "ready" && next.item;
      const content = ready
        ? taskContent(props)
        : statusContent(
            props,
            TASK_MESSAGES[next.status] ?? TASK_MESSAGES.loading,
          );
      panel.fill(content, next.item ? `Task ${next.item.name}` : "Task");
    },
  };
}
