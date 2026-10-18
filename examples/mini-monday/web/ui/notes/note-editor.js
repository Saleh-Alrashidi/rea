/**
 * The note side editor: title and body with debounced autosave and
 * `expected_version` (`docs/autosave.js`), the color palette and pin
 * (saved at once), Share and Delete for the owner, and the save status. A
 * version conflict, lost access or a failed save stops editing and shows a
 * banner (reload, copy my version, try again). Viewers read only.
 *
 * ```js
 * const editor = createNoteEditor({ ctx, note, onSaved, onClose,
 *   onDeleted, onShared, onReload });
 * aside.replaceChildren(editor.element);
 * ```
 */

import { h } from "../../dom.js";
import { avatarStack } from "../components/avatar.js";
import { accessBadge } from "../components/badge.js";
import { iconButton } from "../components/button.js";
import { timeAgo } from "../components/format.js";
import { menuButton } from "../components/menu.js";
import { REASONS } from "../components/permissions.js";
import { createAutosave } from "../docs/autosave.js";
import { copyText, createSaveStatus, saveBanner } from "../docs/save-status.js";
import { openColorPicker } from "./color-picker.js";
import { paintNote } from "./note-card.js";
import {
  DELETE_NOTE_MUTATION,
  NOTE_LIMITS,
  colorName,
  noteCapabilities,
  noteText,
  saveNote,
} from "./note-model.js";

function fit(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

// --------------------------------------------------------------- meta

function renderMeta(ed) {
  const { note, caps } = ed;
  const parts = [];
  if (!caps.mine && note.owner) parts.push(`Owned by ${note.owner.name}`);
  parts.push(`Edited ${timeAgo(note.updated_at)}`);
  const shared = note.shares.length > 0;
  ed.dom.meta.replaceChildren(
    h("span", null, parts.join(" · ")),
    shared
      ? h(
          "span",
          { class: "note-panel-shares" },
          avatarStack(note.shares, { max: 4, size: "xs" }),
          h("span", null, caps.mine ? "Shared" : "Shared with you"),
        )
      : h("span", { class: "note-panel-shares" }, "Only you"),
  );
}

function renderPin(ed) {
  const button = ed.dom.pin;
  if (!button) return;
  button.setAttribute("aria-pressed", String(ed.pinned));
  const label = ed.pinned ? "Unpin note" : "Pin note";
  button.setAttribute("aria-label", label);
  button.title = label;
}

// ------------------------------------------------------------ actions

async function copyVersion(ed) {
  const text = noteText({
    title: ed.dom.title.value,
    body: ed.dom.body.value,
  });
  if (await copyText(text))
    ed.ctx.toast.success("Your version is on the clipboard");
  else ed.ctx.toast.show({ message: text, type: "info", timeout: 30_000 });
}

function lock(ed) {
  if (ed.locked) return;
  ed.locked = true;
  ed.dom.title.readOnly = true;
  ed.dom.body.readOnly = true;
  for (const button of [ed.dom.color, ed.dom.pin]) {
    button?.setAttribute("aria-disabled", "true");
  }
}

function onState(ed, snapshot) {
  ed.status.update(snapshot);
  const banner = saveBanner(snapshot, {
    what: "note",
    onReload: () => ed.callbacks.onReload(),
    onCopy: () => copyVersion(ed),
    onRetry: () => ed.autosave.retry(),
  });
  ed.dom.banners.replaceChildren(...(banner ? [banner] : []));
  const code = snapshot.error?.code;
  if (
    snapshot.status === "conflict" ||
    (snapshot.status === "failed" &&
      (code === "NOT_FOUND" || code === "FORBIDDEN"))
  ) {
    lock(ed);
  }
}

function setColor(ed, color) {
  ed.color = color;
  paintNote(ed.element, color);
  ed.dom.color.setAttribute("aria-label", `Color: ${colorName(color)}`);
  ed.dom.color.title = `Color: ${colorName(color)}`;
  ed.autosave.change({ color }, { immediate: true });
}

function togglePin(ed) {
  if (ed.locked || !ed.caps.edit) return;
  ed.pinned = !ed.pinned;
  renderPin(ed);
  ed.autosave.change({ pinned: ed.pinned }, { immediate: true });
}

async function share(ed) {
  const result = await ed.ctx.openShare({
    resourceKind: "note",
    resourceId: ed.note.id,
  });
  if (result.changed && !result.lostAccess) ed.callbacks.onShared();
}

async function remove(ed) {
  const confirmed = await ed.ctx.dialog.confirm({
    title: "Delete this note?",
    message: `“${ed.note.title}” will be deleted, also for anyone it is shared with. This can’t be undone.`,
    confirmButton: "Delete note",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await ed.ctx.api.request(DELETE_NOTE_MUTATION, { id: ed.note.id });
  } catch (error) {
    ed.ctx.toast.error(error, "Couldn’t delete the note");
    return;
  }
  ed.autosave.dispose();
  ed.ctx.toast.success("Note deleted");
  ed.callbacks.onDeleted(ed.note.id);
}

// -------------------------------------------------------------- fields

function titleInput(ed) {
  const textarea = h("textarea", {
    class: "note-title-input",
    rows: 1,
    maxlength: NOTE_LIMITS.title,
    "aria-label": "Title",
    placeholder: "Title",
    readonly: !ed.caps.edit,
    value: ed.note.title,
    on: {
      input() {
        const clean = textarea.value.replace(/[\r\n]+/g, " ");
        if (clean !== textarea.value) textarea.value = clean;
        fit(textarea);
        const title = clean.trim();
        if (title) ed.autosave.change({ title });
      },
      keydown(event) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        ed.dom.body.focus();
      },
      blur() {
        if (textarea.value.trim() !== "") return;
        textarea.value = ed.note.title;
        fit(textarea);
      },
    },
  });
  return textarea;
}

function bodyInput(ed) {
  const textarea = h("textarea", {
    class: "note-body-input",
    maxlength: NOTE_LIMITS.body,
    "aria-label": "Note",
    placeholder: ed.caps.edit ? "Write a note…" : "This note is empty.",
    readonly: !ed.caps.edit,
    value: ed.note.body,
    on: {
      input() {
        fit(textarea);
        ed.autosave.change({ body: textarea.value });
      },
    },
  });
  return textarea;
}

// ---------------------------------------------------------------- bar

function editControls(ed) {
  if (!ed.caps.edit) return [accessBadge("viewer")];
  ed.dom.color = h(
    "button",
    {
      type: "button",
      class: "icon-btn note-color-button",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-label": `Color: ${colorName(ed.color)}`,
      title: `Color: ${colorName(ed.color)}`,
      on: {
        click() {
          if (ed.locked) return;
          openColorPicker({
            anchor: ed.dom.color,
            value: ed.color,
            onSelect: (color) => setColor(ed, color),
          });
        },
      },
    },
    h("span", { class: "note-color-dot", "aria-hidden": "true" }),
  );
  ed.dom.pin = iconButton({
    icon: "pin",
    label: "Pin note",
    pressed: ed.pinned,
    className: "note-pin-button",
    onClick: () => togglePin(ed),
  });
  renderPin(ed);
  return [ed.status.element, ed.dom.color, ed.dom.pin];
}

function bar(ed) {
  const { caps } = ed;
  return h(
    "header",
    { class: "note-panel-bar" },
    editControls(ed),
    h("span", { class: "note-panel-spacer" }),
    iconButton({
      icon: "userPlus",
      label: caps.manage ? "Share note" : "Share (owner only)",
      disabledReason: caps.manage ? null : REASONS.notOwner,
      onClick: () => share(ed),
    }),
    menuButton({
      icon: "more",
      label: "Note actions",
      items: () => [
        { label: "Copy text", icon: "copy", onSelect: () => copyVersion(ed) },
        { type: "separator" },
        {
          label: "Delete note",
          icon: "trash",
          danger: true,
          disabledReason: caps.manage ? null : REASONS.notOwner,
          onSelect: () => remove(ed),
        },
      ],
    }),
    iconButton({
      icon: "close",
      label: "Close note",
      onClick: () => ed.callbacks.onClose(),
    }),
  );
}

function build(ed) {
  ed.dom.banners = h("div", { class: "note-panel-banners" });
  ed.dom.title = titleInput(ed);
  ed.dom.body = bodyInput(ed);
  ed.dom.meta = h("footer", { class: "note-panel-meta" });
  const element = h(
    "aside",
    {
      class: ["note-panel", !ed.caps.edit && "read-only"],
      "aria-label": "Note editor",
      tabindex: "-1",
      on: {
        keydown(event) {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            ed.callbacks.onClose();
          }
        },
      },
    },
    bar(ed),
    ed.dom.banners,
    h("div", { class: "note-panel-body" }, ed.dom.title, ed.dom.body),
    ed.dom.meta,
  );
  paintNote(element, ed.color);
  renderMeta(ed);
  return element;
}

/**
 * @param {{ ctx: object, note: object,
 *   onSaved(note: object, changes: object): void, onClose(): void,
 *   onDeleted(id: string): void, onShared(): void, onReload(): void }} options
 */
export function createNoteEditor({ ctx, note, ...callbacks }) {
  const ed = {
    ctx,
    note,
    caps: noteCapabilities(note, ctx.me),
    color: note.color,
    pinned: note.pinned,
    locked: false,
    dom: {},
    callbacks,
    status: createSaveStatus(),
  };
  ed.autosave = createAutosave({
    version: note.version,
    save: (changes, expectedVersion) =>
      saveNote(ctx.api, { id: note.id, changes, expectedVersion }),
    onState: (snapshot) => onState(ed, snapshot),
    onSaved(result, changes) {
      ed.note = result;
      renderMeta(ed);
      callbacks.onSaved(result, changes);
    },
  });
  ed.element = build(ed);
  return {
    id: note.id,
    element: ed.element,
    /** Moves focus in; `select` selects the title (a new note). */
    focus({ select = false } = {}) {
      fit(ed.dom.title);
      fit(ed.dom.body);
      if (!ed.caps.edit) ed.element.focus();
      else if (select) ed.dom.title.select();
      else ed.dom.body.focus();
    },
    togglePin: () => togglePin(ed),
    /** Shows newer metadata (shares) from a list reload. */
    refreshMeta(fresh) {
      ed.note = { ...ed.note, shares: fresh.shares, owner: fresh.owner };
      renderMeta(ed);
    },
    unsaved: () => ed.autosave.snapshot().unsaved,
    flush: () => ed.autosave.flush(),
    /** Saves what is pending, then stops. */
    close() {
      ed.autosave.flush().finally(() => ed.autosave.dispose());
    },
  };
}
