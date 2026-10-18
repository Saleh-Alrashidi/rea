/**
 * A note card in the notes grid: the note's color, title, a body preview,
 * who it is from (notes shared with you) or who it is shared with (your
 * notes), "View only", and a pin toggle for people who can edit. The
 * whole card opens the note in the side editor.
 */

import { h } from "../../dom.js";
import { noteHash } from "../../router.js";
import { avatar, avatarStack } from "../components/avatar.js";
import { accessBadge } from "../components/badge.js";
import { iconButton } from "../components/button.js";
import { icon } from "../components/icon.js";
import { timeAgo } from "../components/format.js";
import { noteCapabilities, noteTone, safeNoteColor } from "./note-model.js";

/** Longer bodies are clipped before rendering (the card shows ~10 lines). */
const PREVIEW_CHARS = 600;

/** Applies a note's color to a card or the editor panel. */
export function paintNote(element, color) {
  element.style.setProperty("--note-color", safeNoteColor(color));
  element.dataset.tone = noteTone(color);
}

function footer(note, caps) {
  if (!caps.mine && note.owner) {
    return h(
      "div",
      { class: "note-card-footer" },
      avatar(note.owner, { size: "xs", title: null }),
      h("span", { class: "note-card-by" }, `From ${note.owner.name}`),
      caps.viewOnly ? accessBadge("viewer") : null,
    );
  }
  if (note.shares.length === 0) {
    return h(
      "div",
      { class: "note-card-footer" },
      icon("lock", { size: 12 }),
      h("span", { class: "note-card-by" }, timeAgo(note.updated_at)),
    );
  }
  const names = note.shares.map((share) => share.name).join(", ");
  return h(
    "div",
    { class: "note-card-footer" },
    avatarStack(note.shares, { max: 3, size: "xs" }),
    h("span", { class: "note-card-by" }, `Shared with ${names}`),
  );
}

/**
 * @param {object} note a normalized note
 * @param {{ me: object, selected: boolean, onPin(note: object): void }} options
 * @returns {HTMLElement}
 */
export function noteCard(note, { me, selected, onPin }) {
  const caps = noteCapabilities(note, me);
  const preview =
    note.body.length > PREVIEW_CHARS
      ? `${note.body.slice(0, PREVIEW_CHARS)}…`
      : note.body;
  const card = h(
    "article",
    {
      class: ["note-card", note.pinned && "pinned", selected && "selected"],
      dataset: { noteId: note.id },
    },
    h(
      "h3",
      { class: "note-card-title" },
      h(
        "a",
        {
          class: "note-card-link",
          href: noteHash(note.id),
          "aria-current": selected ? "true" : null,
        },
        note.title,
      ),
    ),
    preview ? h("p", { class: "note-card-body" }, preview) : null,
    footer(note, caps),
    caps.edit
      ? iconButton({
          icon: "pin",
          size: "sm",
          label: note.pinned ? "Unpin note" : "Pin note",
          pressed: note.pinned,
          className: "note-card-pin",
          onClick: () => onPin(note),
        })
      : null,
  );
  paintNote(card, note.color);
  return card;
}
