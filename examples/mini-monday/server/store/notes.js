/**
 * Personal notes (SPEC-2 §2): owned by one user, private unless shared
 * (viewer or editor shares through `store.share`), never visible to anyone
 * else, admins included. Writes take `expectedVersion`; a mismatch returns
 * `{ ok: false, reason: "version_conflict", version }`.
 */
import { LIMITS } from "../input.js";
import {
  byId,
  commit,
  failure,
  nextId,
  optional,
  push,
  readBoolean,
  readColor,
  readName,
  readText,
  removeWhere,
  replace,
  requireCount,
  withChanges,
} from "../store-state.js";

/** The default note color (a soft yellow card). */
export const NOTE_COLOR = "#fff4c2";

const readBody = (value) => readText(value, "Note body", LIMITS.noteBody) ?? "";

export function insertNote(ctx, fields) {
  const { state } = ctx;
  const at = ctx.now();
  return push(state.notes, {
    id: nextId(state),
    owner_id: fields.ownerId,
    title: fields.title,
    body: fields.body,
    color: fields.color,
    pinned: fields.pinned,
    shares: fields.shares ?? [],
    version: 1,
    created_at: at,
    updated_at: at,
  });
}

const noteEvent = (type, note) => ({
  type,
  resource_kind: "note",
  resource_id: note.id,
});

export function noteApi(ctx) {
  const { state } = ctx;
  return {
    /** All notes, or the notes owned by `ownerId`. */
    listNotes: ({ ownerId } = {}) =>
      ownerId === undefined
        ? [...state.notes]
        : state.notes.filter((n) => n.owner_id === ownerId),
    getNote: (id) => byId(state.notes, id),
    /** Creates a private note; unknown owner → null. */
    createNote({
      ownerId,
      title,
      body = "",
      color = NOTE_COLOR,
      pinned = false,
    } = {}) {
      const fields = {
        title: readName(title, "Note title"),
        body: readBody(body),
        color: readColor(color, "color"),
        pinned: readBoolean(pinned, "pinned"),
      };
      if (!byId(state.users, ownerId)) return null;
      const note = insertNote(ctx, { ...fields, ownerId });
      return commit(ctx, noteEvent("note_created", note), note);
    },
    updateNote(id, { expectedVersion, title, body, color, pinned } = {}) {
      const note = byId(state.notes, id);
      if (!note) return null;
      requireCount(expectedVersion, "expectedVersion", 0);
      const changes = {
        title: optional(title, (v) => readName(v, "Note title")),
        body: optional(body, readBody),
        color: optional(color, (v) => readColor(v, "color")),
        pinned: optional(pinned, (v) => readBoolean(v, "pinned")),
      };
      if (expectedVersion !== note.version) {
        return failure("version_conflict", { version: note.version });
      }
      const stamp = { version: note.version + 1, updated_at: ctx.now() };
      const next = { ...withChanges(note, changes), ...stamp };
      replace(state.notes, note, next);
      return commit(ctx, noteEvent("note_updated", next), next);
    },
    deleteNote(id) {
      const note = byId(state.notes, id);
      if (!note) return null;
      removeWhere(state.notes, (record) => record === note);
      return commit(ctx, noteEvent("note_deleted", note), note);
    },
  };
}
