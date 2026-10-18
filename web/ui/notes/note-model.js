/**
 * Notes data (no DOM): the GraphQL documents, normalization, the fixed
 * color palette, the list filters and what the user may do with a note.
 * Access comes only from the server's `my_access` (through
 * `components/permissions.js`): editors write, only the owner shares and
 * deletes. The list order is the server's (pinned first, newest edit).
 */

import { hasRole } from "../components/permissions.js";
import { textColorOn } from "../board/values.js";

const PERSON = "id name initials color";
const NOTE_FIELDS = `id title body color pinned my_access version created_at updated_at
    owner { ${PERSON} }
    shares { kind id name role user { ${PERSON} } }`;

export const NOTES_QUERY = `query NotesPage {
  notes(scope: all) {
    ${NOTE_FIELDS}
  }
}`;

export const UPDATE_NOTE_MUTATION = `mutation UpdateNote($id: ID!, $expectedVersion: Int!, $title: String, $body: String, $color: String, $pinned: Boolean) {
  update_note(note_id: $id, expected_version: $expectedVersion, title: $title, body: $body, color: $color, pinned: $pinned) {
    ${NOTE_FIELDS}
  }
}`;

export const DELETE_NOTE_MUTATION = `mutation DeleteNote($id: ID!) {
  delete_note(note_id: $id) { id }
}`;

/** SPEC-2 §2 limits (the server checks them again). */
export const NOTE_LIMITS = Object.freeze({ title: 255, body: 20_000 });

/** The note palette: soft card colors that keep text readable. */
export const NOTE_COLORS = Object.freeze([
  { value: "#fff4c2", label: "Lemon" },
  { value: "#ffe4cc", label: "Peach" },
  { value: "#fde7ef", label: "Blossom" },
  { value: "#efe5fd", label: "Lavender" },
  { value: "#dff4ff", label: "Sky" },
  { value: "#d8f3ee", label: "Mint" },
  { value: "#e8f5e9", label: "Sage" },
  { value: "#eceef3", label: "Cloud" },
]);

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = NOTE_COLORS[0].value;
const LIGHT_TEXT = textColorOn("#000000");

/** The note's color when valid, else the default card color. */
export const safeNoteColor = (color) =>
  COLOR_PATTERN.test(color ?? "") ? color : DEFAULT_COLOR;

/** The palette name of `color`, or "Custom" for other colors. */
export function colorName(color) {
  const value = String(color ?? "").toLowerCase();
  return NOTE_COLORS.find((entry) => entry.value === value)?.label ?? "Custom";
}

/**
 * "dark" when light text reads better on `color` (colors set through the
 * API can be anything), else "light".
 */
export function noteTone(color) {
  return textColorOn(safeNoteColor(color)) === LIGHT_TEXT ? "dark" : "light";
}

const person = (record) =>
  record ? { ...record, id: String(record.id) } : null;

/** Normalizes an API Note (string IDs, shares shaped for avatars). */
export function normalizeNote(note) {
  return {
    ...note,
    id: String(note.id),
    owner: person(note.owner),
    shares: (note.shares ?? []).map((share) => ({
      kind: share.kind,
      id: String(share.id),
      name: share.name,
      role: share.role,
      color: share.user?.color ?? null,
      initials: share.user?.initials ?? null,
    })),
  };
}

/** Loads every note the user can open (own and shared), server order. */
export async function loadNotes(api) {
  const data = await api.request(NOTES_QUERY);
  return data.notes.map(normalizeNote);
}

/**
 * Saves `changes` (`{ title?, body?, color?, pinned? }`) with
 * `expectedVersion`; resolves with the updated note.
 */
export async function saveNote(api, { id, changes, expectedVersion }) {
  const data = await api.request(UPDATE_NOTE_MUTATION, {
    id,
    expectedVersion,
    title: changes.title ?? null,
    body: changes.body ?? null,
    color: changes.color ?? null,
    pinned: changes.pinned ?? null,
  });
  return normalizeNote(data.update_note);
}

/** What `me` may do with `note`. */
export function noteCapabilities(note, me) {
  return {
    edit: hasRole(note?.my_access, "editor"),
    manage: hasRole(note?.my_access, "owner"),
    viewOnly: note?.my_access === "viewer",
    mine: note?.owner?.id === String(me?.id),
  };
}

export const NOTE_FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "shared", label: "Shared with me" },
]);

function matches(note, term) {
  if (!term) return true;
  return (
    note.title.toLowerCase().includes(term) ||
    note.body.toLowerCase().includes(term)
  );
}

/**
 * The notes grid for a filter and search: pinned and other notes in the
 * server's order, with per-filter counts for the search.
 *
 * @param {object[]} notes normalized notes
 * @param {{ filter?: "all" | "mine" | "shared", query?: string, meId: string }} options
 * @returns {{ pinned: object[], others: object[],
 *   counts: { all: number, mine: number, shared: number } }}
 */
export function notesView(notes, { filter = "all", query = "", meId }) {
  const term = query.trim().toLowerCase();
  const found = notes.filter((note) => matches(note, term));
  const mine = (note) => note.owner?.id === String(meId);
  const tests = { all: () => true, mine, shared: (note) => !mine(note) };
  const shown = found.filter(tests[filter] ?? tests.all);
  return {
    pinned: shown.filter((note) => note.pinned),
    others: shown.filter((note) => !note.pinned),
    counts: {
      all: found.length,
      mine: found.filter(tests.mine).length,
      shared: found.filter(tests.shared).length,
    },
  };
}

/** Plain text of a note for "Copy my version". */
export const noteText = ({ title, body }) =>
  body ? `${title}\n\n${body}` : title;
