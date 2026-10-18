/**
 * Item card: a modal side panel (`<dialog>`) with the item name, group,
 * column values and updates (newest first) with a composer. Escape, the
 * close button and a backdrop click close it.
 */

import { clear, h } from "../dom.js";
import { avatar, cellEditor } from "./cells.js";
import { icon } from "./icons.js";
import { inlineInput } from "./inline-edit.js";
import { closePopover, isPopoverOpen } from "./popover.js";

const MAX_UPDATE = 10_000;

function formatTime(iso) {
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

function groupSelect(props) {
  const { board, item, actions } = props;
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

function metaRow(props) {
  const { detail } = props;
  const created = detail?.createdAt ? formatTime(detail.createdAt) : "";
  return h(
    "div",
    { class: "card-meta" },
    groupSelect(props),
    detail?.creator
      ? h(
          "span",
          { class: "card-created" },
          avatar(detail.creator, { small: true }),
          h("span", null, `Created by ${detail.creator.name}`),
          created ? h("span", null, ` · ${created}`) : null,
        )
      : null,
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
                  itemName: item.name,
                  focusKey: `card-cell:${column.id}`,
                  placeholder: "Set status",
                  onChange: (next) => actions.setValue(item, column, next),
                }),
              ),
            ),
          ),
        ),
  );
}

function composer(props) {
  const { item, actions, draft, onDraft } = props;
  const textarea = h("textarea", {
    class: "input composer-input",
    rows: 3,
    maxlength: MAX_UPDATE,
    placeholder: "Write an update…",
    "aria-label": "Write an update",
    dataset: { focusKey: "card-composer" },
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
      class: "composer",
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
      h("button", { type: "submit", class: "btn btn-primary" }, "Update"),
    ),
  );
  return form;
}

function updateEntry(update) {
  const author = update.creator ?? { id: "0", name: "Unknown", initials: "?" };
  return h(
    "li",
    { class: ["update", update.pending && "pending"] },
    h(
      "div",
      { class: "update-header" },
      avatar(author, { small: true }),
      h("span", { class: "update-author" }, author.name),
      h(
        "time",
        { class: "update-time", datetime: update.created_at },
        formatTime(update.created_at),
      ),
    ),
    h("p", { class: "update-body" }, update.body),
  );
}

function updatesSection(props) {
  const updates = props.detail?.updates ?? [];
  return h(
    "section",
    { class: "card-section", "aria-labelledby": "card-updates-heading" },
    h(
      "h3",
      { class: "card-heading", id: "card-updates-heading" },
      icon("chat"),
      h("span", null, "Updates"),
    ),
    composer(props),
    props.detail
      ? updates.length > 0
        ? h("ol", { class: "update-list" }, updates.map(updateEntry))
        : h("p", { class: "muted" }, "No updates yet. Start the conversation.")
      : h("p", { class: "muted" }, "Loading updates…"),
  );
}

function statusContent(props, message) {
  return h(
    "div",
    { class: "card-inner" },
    h(
      "header",
      { class: "card-header" },
      h("h2", { class: "card-title-text" }, message),
      closeButton(props.onClose),
    ),
  );
}

function cardContent(props) {
  const { item, actions } = props;
  return h(
    "div",
    { class: "card-inner" },
    h(
      "header",
      { class: "card-header" },
      h(
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
      ),
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

/**
 * Creates the item card panel. `render(props)` fills it; `props.status` is
 * "loading", "missing", "error" or "ready" (with `item`, `detail`, `board`,
 * `users`, `actions`, `draft`, `onDraft`).
 *
 * @param {{ onClose(): void }} options
 */
export function createItemCard({ onClose }) {
  const dialog = h("dialog", { class: "item-card", "aria-label": "Item card" });
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
      if (!dialog.isConnected) globalThis.document.body.append(dialog);
      if (!dialog.open) dialog.showModal();
      shown = true;
    },
    /** Closes and detaches the panel. */
    hide() {
      shown = false;
      if (dialog.open) dialog.close();
      dialog.remove();
    },
    render(props) {
      const full = { ...props, onClose };
      let content;
      if (props.status === "ready" && props.item) content = cardContent(full);
      else if (props.status === "missing") {
        content = statusContent(full, "This item no longer exists");
      } else if (props.status === "error") {
        content = statusContent(full, "The item could not be loaded");
      } else content = statusContent(full, "Loading item…");
      dialog.setAttribute(
        "aria-label",
        props.item ? `Item ${props.item.name}` : "Item card",
      );
      clear(dialog).append(content);
    },
  };
}
