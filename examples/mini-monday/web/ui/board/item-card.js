/**
 * Item card: a modal side panel (`<dialog>`) with the item name, group,
 * column values and updates (newest first) with a composer. Escape, the
 * close button and a backdrop click close it. View-only users see the same
 * card read-only, without the composer (posting updates needs editor).
 *
 * The task view (`task-view.js`, SPEC-5 §4) shares its dialog shell
 * (`createModalPanel`) and composer.
 */

import { clear, h } from "../../dom.js";
import { avatar } from "../components/avatar.js";
import { accessBadge, badge } from "../components/badge.js";
import { emptyState } from "../components/empty-state.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { findByFocusKey } from "../components/focus.js";
import { closePopover, isPopoverOpen } from "../components/popover.js";
import { skeletonList } from "../components/skeleton.js";
import { cellEditor } from "./cells.js";
import { updateAuthor } from "./task-model.js";
import { safeColor } from "./values.js";

const MAX_UPDATE = 10_000;
/** A missing item and one on another board read the same (no leaks). */
const CARD_MESSAGES = Object.freeze({
  loading: { title: "Loading item…", busy: true },
  missing: {
    title: "This item isn’t available",
    text: "It may have been deleted or moved to a board you can’t open.",
  },
  error: {
    title: "The item couldn’t be loaded",
    text: "Check your connection and try again.",
  },
});

/** A timestamp in full: "Oct 18, 2026, 10:00 AM" (local), or "". */
export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function closeButton(onClose) {
  return h(
    "button",
    {
      type: "button",
      class: "icon-btn card-close",
      "aria-label": "Close item card",
      dataset: { focusKey: "card-close" },
      on: { click: onClose },
    },
    icon("close"),
  );
}

function groupChip(board, item) {
  const group = board.groups.find((entry) => entry.id === item.groupId);
  const chip = h(
    "span",
    { class: "card-group-chip" },
    h("span", { class: "card-group-dot", "aria-hidden": "true" }),
    group?.title ?? "No group",
  );
  chip.style.setProperty("--group-color", safeColor(group?.color));
  return h(
    "span",
    { class: "card-group" },
    h("span", { class: "card-meta-label" }, "Group"),
    chip,
  );
}

function groupSelect(props) {
  const { board, item, actions } = props;
  if (!props.caps.edit) return groupChip(board, item);
  return h(
    "label",
    { class: "card-group" },
    h("span", { class: "card-meta-label" }, "Group"),
    h(
      "select",
      {
        class: "input input-small",
        dataset: { focusKey: "card-group" },
        value: item.groupId ?? "",
        on: {
          change: (event) => actions.moveItem(item, event.currentTarget.value),
        },
      },
      board.groups.map((group) =>
        h("option", { value: group.id }, group.title),
      ),
    ),
  );
}

/** The directory record of a user (it carries the avatar color). */
function person(users, user) {
  return users?.get(String(user?.id)) ?? user;
}

/**
 * "Created by Sam · time". Without a creator the API either hides who it
 * was (people outside a guest's directory) or nobody was (form responses),
 * so only the time is shown.
 */
function createdLine(users, creator, created) {
  if (!creator) {
    return created
      ? h("span", { class: "card-created" }, `Created ${created}`)
      : null;
  }
  return h(
    "span",
    { class: "card-created" },
    avatar(person(users, creator), { size: "sm" }),
    h("span", null, `Created by ${creator.name}`),
    created ? h("span", null, ` · ${created}`) : null,
  );
}

function metaRow(props) {
  const { detail } = props;
  const created = detail?.createdAt ? formatTime(detail.createdAt) : "";
  return h(
    "div",
    { class: "card-meta" },
    groupSelect(props),
    createdLine(props.users, detail?.creator, created),
  );
}

function fieldsSection(props) {
  const { board, item, users, actions } = props;
  const columns = board.columns.filter((column) => column.type !== "name");
  return h(
    "section",
    { class: "card-section", "aria-labelledby": "card-fields-heading" },
    h("h3", { class: "card-heading", id: "card-fields-heading" }, "Columns"),
    columns.length === 0
      ? h("p", { class: "muted" }, "This board has no columns yet.")
      : h(
          "dl",
          { class: "card-fields" },
          columns.map((column) =>
            h(
              "div",
              { class: ["card-field", `card-field-${column.type}`] },
              h("dt", null, column.title),
              h(
                "dd",
                null,
                cellEditor({
                  column,
                  value: item.values[column.id] ?? null,
                  users,
                  assignable: board.assignableUsers,
                  itemName: item.name,
                  focusKey: `card-cell:${column.id}`,
                  placeholder: "Set status",
                  readOnly: !props.caps.edit,
                  onChange: (next) => actions.setValue(item, column, next),
                }),
              ),
            ),
          ),
        ),
  );
}

/** The card's composer words (`composer` options). */
const CARD_COMPOSER = Object.freeze({
  placeholder: "Write an update…",
  label: "Write an update",
  submit: "Update",
  focusKey: "card-composer",
});

/**
 * The update composer: a textarea (Ctrl/⌘+Enter posts) whose text is
 * kept in the page's draft (`props.onDraft`), posted with
 * `actions.addUpdate`. `words` names it (`CARD_COMPOSER`).
 * @param {{ item: object, actions: object, draft: string,
 *   onDraft(text: string): void }} props
 * @param {{ placeholder: string, label: string, submit: string,
 *   focusKey: string, className?: string }} words
 */
export function composer(props, words) {
  const { item, actions, draft, onDraft } = props;
  const textarea = h("textarea", {
    class: "input composer-input",
    rows: 3,
    maxlength: MAX_UPDATE,
    placeholder: words.placeholder,
    "aria-label": words.label,
    dir: "auto",
    dataset: { focusKey: words.focusKey },
    value: draft,
    on: {
      input: (event) => onDraft(event.currentTarget.value),
      keydown(event) {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          form.requestSubmit();
        }
      },
    },
  });
  const form = h(
    "form",
    {
      class: ["composer", words.className],
      on: {
        submit(event) {
          event.preventDefault();
          const body = textarea.value.trim();
          if (!body) return;
          textarea.value = "";
          onDraft("");
          actions.addUpdate(item, body);
        },
      },
    },
    textarea,
    h(
      "div",
      { class: "composer-actions" },
      h("span", { class: "muted composer-hint" }, "Ctrl + Enter to post"),
      h("button", { type: "submit", class: "btn btn-primary" }, words.submit),
    ),
  );
  return form;
}

/** Initials on a neutral gray (white text at 4.8:1) for source authors. */
const SOURCE_AUTHOR_COLOR = "#6b7280";

/**
 * The avatar of an update's author (`updateAuthor`): the user's, or the
 * initials of an imported update's source author on a neutral color.
 * @param {{ user: object | null, name: string }} author
 * @param {Map} users directory users (they carry the avatar colors)
 */
export function authorAvatar(author, users, { size = "sm" } = {}) {
  if (author.user) return avatar(person(users, author.user), { size });
  return avatar({ name: author.name, color: SOURCE_AUTHOR_COLOR }, { size });
}

function updateEntry(update, { users, source }) {
  // The API hides authors outside a guest's directory; an imported
  // update names its source author instead (SPEC-5 §1.4).
  const author = updateAuthor(update, source);
  return h(
    "li",
    { class: ["update", update.pending && "pending"] },
    h(
      "div",
      { class: "update-header" },
      authorAvatar(author, users),
      h("span", { class: "update-author" }, author.name),
      author.tag ? badge(author.tag, { className: "update-source" }) : null,
      h(
        "time",
        { class: "update-time", datetime: update.created_at },
        formatTime(update.created_at),
      ),
    ),
    h("p", { class: "update-body" }, update.body),
  );
}

function updateList(props) {
  const updates = props.detail?.updates ?? [];
  if (!props.detail) return skeletonList({ rows: 2, label: "Loading updates" });
  if (updates.length > 0) {
    return h(
      "ol",
      { class: "update-list" },
      updates.map((update) =>
        updateEntry(update, {
          users: props.users,
          source: props.board.import?.source,
        }),
      ),
    );
  }
  return emptyState({
    icon: "chat",
    title: "No updates yet",
    text: props.caps.edit
      ? "Share progress, questions or decisions about this item."
      : "Updates about this item will appear here.",
    compact: true,
  });
}

function updatesSection(props) {
  return h(
    "section",
    { class: "card-section", "aria-labelledby": "card-updates-heading" },
    h(
      "h3",
      { class: "card-heading", id: "card-updates-heading" },
      icon("chat"),
      h("span", null, "Updates"),
    ),
    props.caps.edit
      ? composer(props, CARD_COMPOSER)
      : h(
          "p",
          { class: "card-readonly-note" },
          icon("eye", { size: 14 }),
          "You have view-only access, so you can read updates but not post them.",
        ),
    updateList(props),
  );
}

function statusContent(props, { title, text, busy = false }) {
  return h(
    "div",
    { class: "card-inner" },
    h(
      "header",
      { class: "card-header" },
      h("h2", { class: "card-title-text" }, busy ? "Item" : title),
      closeButton(props.onClose),
    ),
    h(
      "div",
      { class: "card-body" },
      busy
        ? skeletonList({ rows: 4, label: title })
        : emptyState({ icon: "item", title, text, compact: true }),
    ),
  );
}

function cardTitle(props) {
  const { item, actions } = props;
  if (!props.caps.edit) {
    return h("h2", { class: "card-title-text" }, item.name);
  }
  return h(
    "h2",
    { class: "card-title-heading" },
    inlineInput({
      value: item.name,
      label: "Item name",
      className: "card-title",
      required: true,
      focusKey: "card-name",
      onCommit: (name) => actions.renameItem(item, name),
    }),
  );
}

function cardContent(props) {
  return h(
    "div",
    { class: "card-inner" },
    h(
      "header",
      { class: "card-header" },
      cardTitle(props),
      props.caps.viewOnly ? accessBadge("viewer") : null,
      closeButton(props.onClose),
    ),
    metaRow(props),
    h(
      "div",
      { class: "card-body" },
      fieldsSection(props),
      updatesSection(props),
    ),
  );
}

/** The focus key of the focused element outside `dialog`, or null. */
function openerKey(dialog) {
  const active = globalThis.document.activeElement;
  if (!active || dialog.contains(active)) return null;
  return active.dataset?.focusKey ?? null;
}

/**
 * Focuses the element with `key` once the render that closed the card has
 * rebuilt the view, unless focus has already moved somewhere else.
 */
function returnFocus(key) {
  if (!key) return;
  globalThis.setTimeout(() => {
    const doc = globalThis.document;
    const active = doc.activeElement;
    if (active && active !== doc.body) return;
    findByFocusKey(doc, key)?.focus({ preventScroll: false });
  }, 0);
}

/**
 * A modal panel: `<dialog class={className}>` that Escape (closing an open
 * popover first), a click on its backdrop and the browser's own close
 * dismiss through `onClose`. Focus returns to the control that opened it,
 * found again by focus key since closing re-renders the board view. The
 * panel's content fills the dialog (it has no padding), so only the
 * backdrop targets the dialog itself.
 *
 * @param {{ className: string, label: string, onClose(): void }} options
 * @returns {{ element: HTMLDialogElement, show(): void, hide(): void,
 *   fill(content: Node, label: string): void }}
 */
export function createModalPanel({ className, label, onClose }) {
  const dialog = h("dialog", { class: className, "aria-label": label });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (isPopoverOpen()) closePopover();
    else onClose();
  });
  dialog.addEventListener("click", (event) => {
    // Only the backdrop area targets the dialog itself (it has no padding).
    if (event.target === dialog) onClose();
  });
  let shown = false;
  // The control that opened the panel ("Open", a kanban title), by focus
  // key: closing re-renders the board view, so the element may be gone.
  let returnKey = null;
  dialog.addEventListener("close", () => {
    // The browser may close a modal itself (for example on a repeated
    // Escape); keep the route in step with what is shown. The event is
    // asynchronous, so `hide()` clears `shown` before closing.
    if (!shown) return;
    shown = false;
    onClose();
  });

  return {
    element: dialog,
    /** Opens the panel (idempotent). */
    show() {
      if (!dialog.open) returnKey = openerKey(dialog);
      if (!dialog.isConnected) globalThis.document.body.append(dialog);
      if (!dialog.open) dialog.showModal();
      shown = true;
    },
    /** Closes and detaches the panel; focus returns to its opener. */
    hide() {
      const wasOpen = dialog.open;
      shown = false;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (wasOpen) returnFocus(returnKey);
      returnKey = null;
    },
    /** Replaces the panel's content and accessible name. */
    fill(content, name) {
      dialog.setAttribute("aria-label", name);
      clear(dialog).append(content);
    },
  };
}

/**
 * Creates the item card panel. `render(props)` fills it; `props.status` is
 * "loading", "missing", "error" or "ready" (with `item`, `detail`, `board`,
 * `users`, `actions`, `caps`, `draft`, `onDraft`).
 *
 * @param {{ onClose(): void }} options
 */
export function createItemCard({ onClose }) {
  const panel = createModalPanel({
    className: "item-card",
    label: "Item card",
    onClose,
  });
  return {
    element: panel.element,
    show: panel.show,
    hide: panel.hide,
    render(props) {
      const full = { ...props, onClose };
      let content;
      if (props.status === "ready" && props.item) content = cardContent(full);
      else
        content = statusContent(
          full,
          CARD_MESSAGES[props.status] ?? CARD_MESSAGES.loading,
        );
      panel.fill(content, props.item ? `Item ${props.item.name}` : "Item card");
    },
  };
}
