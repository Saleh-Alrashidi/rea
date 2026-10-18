/**
 * Personal notes: visible only to their owner and the users and teams they
 * are shared with (never to admins as such). Editing needs editor access,
 * deleting owner (`server/access.js`). `update_note` takes
 * `expected_version`; a stale version fails with VERSION_CONFLICT and
 * `extensions.version`.
 */
import { noteAccess, requireCapability, requireNote } from "../access.js";
import {
  badInput,
  memberRecords,
  notFound,
  read,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

const missing = (id) => () => notFound("Note", id);
/** Pinned notes first, then the most recently updated. */
const noteOrder = (a, b) =>
  Number(b.pinned) - Number(a.pinned) ||
  b.updated_at.localeCompare(a.updated_at) ||
  Number(b.id) - Number(a.id);

const Query = wrapAll(read, {
  notes(_p, { scope }, ctx) {
    const viewer = viewerOf(ctx);
    const wanted = (note) => {
      if (noteAccess(ctx.store, viewer, note) === null) return false;
      const mine = note.owner_id === viewer.id;
      return scope === "all" || (scope === "mine") === mine;
    };
    return ctx.store.listNotes().filter(wanted).sort(noteOrder);
  },
});

/** null arguments mean "unchanged" (or the default on create). */
const given = (value) => value ?? undefined;

const Mutation = wrapAll(write, {
  create_note(_p, args, ctx) {
    const owner = requireCapability(ctx, "create_note");
    const result = ctx.store.createNote({
      ownerId: owner.id,
      title: readName(args.title, "Note title"),
      body: args.body ?? "",
      color: given(args.color),
    });
    return storeResult(result, missing(owner.id));
  },
  update_note(_p, args, ctx) {
    const note = requireNote(ctx, args.note_id, "editor");
    if (args.expected_version < 0) {
      badInput("expected_version must not be negative");
    }
    const result = ctx.store.updateNote(note.id, {
      expectedVersion: args.expected_version,
      title: args.title == null ? undefined : readName(args.title, "Title"),
      body: given(args.body),
      color: given(args.color),
      pinned: given(args.pinned),
    });
    return storeResult(result, missing(note.id));
  },
  delete_note(_p, args, ctx) {
    const note = requireNote(ctx, args.note_id, "owner");
    return storeResult(ctx.store.deleteNote(note.id), missing(note.id));
  },
});

const Note = {
  owner: (note, _a, { store }) => store.getUser(note.owner_id),
  shares: (note, _a, { store }) => memberRecords(store, "note", note),
  my_access: (note, _a, ctx) => noteAccess(ctx.store, viewerOf(ctx), note),
};

export const definition = {
  types: {
    Query: 'notes(scope:NoteScope="all"):[Note!]!',
    Note: `id:ID! title:String! body:String! color:String! pinned:Boolean!
      owner:User! shares:[Member!]! my_access:AccessRole! version:Int!
      created_at:String! updated_at:String!`,
    Mutation: `create_note(title:String!,body:String,color:String):Note!
      update_note(note_id:ID!,expected_version:Int!,title:String,body:String,color:String,pinned:Boolean):Note!
      delete_note(note_id:ID!):Note!`,
  },
  resolvers: { Query, Mutation, Note },
  extras: {
    "Query.notes": { description: "Your notes and notes shared with you." },
  },
};
