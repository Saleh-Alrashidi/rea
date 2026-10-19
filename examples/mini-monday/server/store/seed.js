/**
 * Demo content (SPEC.md seed, extended by SPEC-2 §2.1) from the tables in
 * `store/seed-data.js`: deterministic records with random secrets (app
 * credentials, API tokens, form tokens).
 *
 * The part-1 records come first so they keep their IDs (users 1-3, boards
 * 4 and 17, app 23, install 24); everything SPEC-2 adds follows, and the
 * part-1 boards then get their workspace, kind and members. Seeded boards
 * have the DEFAULT_VIEWS of every new board; their List views are added
 * last (`addListViews`), so the part-1 records keep their IDs. Seeding
 * writes records directly: it emits no events and sends no notifications
 * beyond the seeded inbox.
 */
import { randomBytes } from "node:crypto";
import { ALL_SCOPES } from "../auth.js";
import { byId, nextId, push, randomToken, replace } from "../store-state.js";
import {
  byActor,
  insertNotification,
  recordActivity,
  resourceUrl,
} from "./activity.js";
import {
  DEFAULT_VIEWS,
  addListViews,
  insertBoard,
  insertContent,
  insertView,
} from "./boards.js";
import { insertDoc, readBlocks } from "./docs.js";
import { insertForm } from "./forms.js";
import { insertItem } from "./items.js";
import { insertNote } from "./notes.js";
import { insertTeam, insertUser } from "./people.js";
import { insertUpdate } from "./updates.js";
import {
  ACTIVITY,
  BOARDS,
  DOCS,
  FIRST_USERS,
  FORMS,
  INBOX,
  MORE_USERS,
  NOTES,
  TEAMS,
  UPDATES,
} from "./seed-data.js";
import { insertWorkspace } from "./workspaces.js";

const rows = (table) => table.map((row) => row.split("|"));
/** DEFAULT_VIEWS but the List view, which `addListViews` adds last. */
const FIRST_VIEWS = DEFAULT_VIEWS.filter((view) => view.type !== "list");
const keys = (text) => text.split(",").filter(Boolean);

/** Resolves "kind:key:role" grant specs with the seeded IDs. */
function grantsOf(seed, specs) {
  return specs.map((spec) => {
    const [kind, key, role] = spec.split(":");
    const ids = kind === "user" ? seed.users : seed.teams;
    return { kind, id: ids[key], role };
  });
}

/** The seeded owners of an item row that already exist. */
const ownersOf = (seed, owners) =>
  keys(owners)
    .map((key) => seed.users[key])
    .filter(Boolean);

function seedUsers(ctx, seed, table) {
  for (const [name, email, role, title, status] of rows(table)) {
    const user = insertUser(ctx, { name, email, role, title, status });
    seed.users[name.split(" ")[0].toLowerCase()] = user.id;
  }
}

function itemValues(seed, [status, owners, date, estimate, notes]) {
  const values = {};
  if (status) values.status = { index: Number(status) };
  const person = ownersOf(seed, owners);
  if (person.length > 0) values.person = person;
  if (date) values.date = date;
  if (estimate) values.estimate = Number(estimate);
  if (notes) values.notes = notes;
  return values;
}

/** A board with its groups, columns, views and items (placed later). */
function seedBoard(ctx, seed, key) {
  const table = BOARDS[key];
  const fields = { name: table.name, description: table.description };
  const board = insertBoard(ctx, {
    ...fields,
    creatorId: "1",
    workspaceId: null,
  });
  insertContent(ctx, board.id, { ...table, views: FIRST_VIEWS });
  const items = rows(table.items).map(([groupId, name, ...rest]) => {
    const values = itemValues(seed, rest);
    const item = { boardId: board.id, groupId, name, values, creatorId: "1" };
    return insertItem(ctx, item);
  });
  seed.boards[key] = { id: board.id, items: items.map((item) => item.id) };
}

function seedApp(ctx, boardId) {
  const app = push(ctx.state.apps, {
    id: nextId(ctx.state),
    name: "Status summary",
    client_id: randomBytes(16).toString("hex"),
    client_secret: randomToken(),
    path: "/apps/status-summary/index.html",
    scopes: ["boards:read", "storage:read", "storage:write"],
  });
  const install = { id: nextId(ctx.state), app_id: app.id };
  push(ctx.state.installs, { ...install, board_id: boardId });
  const view = { name: "Status summary", type: "app", installId: install.id };
  insertView(ctx, boardId, view);
}

/** Part 1: users 1-3, the two boards, the app, its install and tokens. */
function seedPartOne(ctx, seed) {
  seedUsers(ctx, seed, FIRST_USERS);
  seedBoard(ctx, seed, "roadmap");
  const [first] = seed.boards.roadmap.items;
  for (const [key, body] of rows(UPDATES)) {
    insertUpdate(ctx, { itemId: first, body, creatorId: seed.users[key] });
  }
  seedBoard(ctx, seed, "marketing");
  seedApp(ctx, seed.boards.roadmap.id);
  const tokens = [
    ["read-write", ALL_SCOPES],
    ["read-only", ["boards:read", "storage:read"]],
  ];
  for (const [label, scopes] of tokens) {
    const token = { token: randomToken(), user_id: "1" };
    push(ctx.state.tokens, { ...token, scopes: [...scopes], label });
  }
}

function seedTeams(ctx, seed) {
  for (const [name, description, owner, members] of rows(TEAMS)) {
    const list = [{ user_id: seed.users[owner], role: "owner" }];
    for (const key of keys(members)) {
      list.push({ user_id: seed.users[key], role: "member" });
    }
    const team = insertTeam(ctx, { name, description, members: list });
    seed.teams[name.toLowerCase()] = team.id;
  }
}

/** Gives a seeded board its workspace, kind, members and creator. */
function placeBoard(ctx, seed, { key, workspace, kind, members }) {
  const current = byId(ctx.state.boards, seed.boards[key].id);
  const grants = grantsOf(seed, members);
  const next = {
    ...current,
    creator_id: grants[0].id,
    workspace_id: seed.workspaces[workspace],
    board_kind: kind,
    members: grants,
  };
  replace(ctx.state.boards, current, next);
}

/** Applies owners to items seeded before those users existed. */
function applyLateOwners(ctx, seed, key) {
  rows(BOARDS[key].items).forEach(([, , , owners], index) => {
    const item = byId(ctx.state.items, seed.boards[key].items[index]);
    const person = ownersOf(seed, owners);
    if (person.length === 0 || item.values.person) return;
    const values = { ...item.values, person };
    replace(ctx.state.items, item, { ...item, values });
  });
}

function seedSpaces(ctx, seed) {
  const space = (key, fields, members) => {
    const grants = grantsOf(seed, members);
    const createdBy = seed.users.alex;
    const workspace = insertWorkspace(ctx, {
      ...fields,
      members: grants,
      createdBy,
    });
    seed.workspaces[key] = workspace.id;
  };
  const main = {
    name: "Main workspace",
    description: "Everyone's shared space",
  };
  space("main", { ...main, kind: "open" }, ["user:alex:owner"]);
  const lead = {
    name: "Leadership",
    description: "Plans for the leadership team",
  };
  const leadMembers = ["team:leadership:editor", "user:alex:owner"];
  space("leadership", { ...lead, kind: "closed" }, leadMembers);
  seedBoard(ctx, seed, "hiring");
  seedBoard(ctx, seed, "budget");
  const placements = [
    ["roadmap", "main", "public", ["user:alex:owner"]],
    ["marketing", "main", "share", ["user:priya:owner", "user:chris:editor"]],
    ["hiring", "leadership", "private", ["user:alex:owner", "user:noa:editor"]],
    ["budget", "leadership", "public", ["user:alex:owner"]],
  ];
  for (const [key, workspace, kind, members] of placements) {
    placeBoard(ctx, seed, { key, workspace, kind, members });
  }
  applyLateOwners(ctx, seed, "marketing");
}

function blocksOf(lines) {
  const blocks = rows(lines).map(([type, text, checked]) =>
    type === "todo" ? { type, text, checked: checked === "x" } : { type, text },
  );
  return readBlocks(blocks);
}

function seedContent(ctx, seed) {
  for (const doc of DOCS) {
    const members = grantsOf(seed, doc.members);
    insertDoc(ctx, {
      workspaceId: seed.workspaces[doc.workspace],
      title: doc.title,
      visibility: doc.visibility,
      members,
      blocks: blocksOf(doc.blocks),
      createdBy: members[0].id,
    });
  }
  for (const [owner, title, body, color, pinned, shares] of rows(NOTES)) {
    const ownerId = seed.users[owner];
    const fields = { ownerId, title, body, color, pinned: pinned === "pinned" };
    const note = insertNote(ctx, {
      ...fields,
      shares: grantsOf(seed, keys(shares)),
    });
    seed.notes[title] = note.id;
  }
  for (const form of FORMS) {
    const questions = rows(form.questions).map(
      ([id, column_id, label, required]) => {
        const fields = { id, column_id, label, help: "" };
        return { ...fields, required: required === "required" };
      },
    );
    const boardId = seed.boards[form.board].id;
    const createdBy = seed.users[form.createdBy];
    insertForm(ctx, { ...form, boardId, questions, createdBy });
  }
}

function seedActivity(ctx, seed) {
  for (const [board, actor, kind, index, columnId, from, to] of rows(
    ACTIVITY,
  )) {
    const { id: boardId, items } = seed.boards[board];
    const item = byId(ctx.state.items, items[Number(index)]);
    recordActivity(ctx, {
      boardId,
      actorId: seed.users[actor],
      kind,
      itemId: item.id,
      itemName: item.name,
      columnId: columnId || null,
      fromText: from || null,
      toText: to || null,
    });
  }
}

const TEXTS = {
  update: (title) => ` posted an update on “${title}”`,
  assign: (title) => ` assigned you to “${title}”`,
  share: (title) => ` shared the note “${title}” with you (viewer)`,
};

function inboxTarget(ctx, seed, target) {
  const [kind, ...rest] = target.split(":");
  const key = rest.join(":");
  if (kind === "note") {
    const note = byId(ctx.state.notes, seed.notes[key]);
    const resource = { kind: "note", id: note.id };
    return { title: note.title, url: resourceUrl("note", note.id), resource };
  }
  const board = seed.boards[kind];
  const item = byId(ctx.state.items, board.items[Number(key)]);
  const url = resourceUrl("board", board.id, item.id);
  return { title: item.name, url, resource: { kind: "board", id: board.id } };
}

function seedInbox(ctx, seed) {
  for (const [user, actor, kind, target] of rows(INBOX)) {
    const actorId = seed.users[actor];
    const { title, url, resource } = inboxTarget(ctx, seed, target);
    const text = byActor(actorId, TEXTS[kind](title));
    const userId = seed.users[user];
    insertNotification(ctx, { userId, actorId, kind, text, url, resource });
  }
}

/** Seeds the demo content (deterministic) with random secrets and tokens. */
export function seedState(ctx) {
  const seed = { users: {}, teams: {}, workspaces: {}, boards: {}, notes: {} };
  seedPartOne(ctx, seed);
  seedUsers(ctx, seed, MORE_USERS);
  seedTeams(ctx, seed);
  seedSpaces(ctx, seed);
  seedContent(ctx, seed);
  seedActivity(ctx, seed);
  seedInbox(ctx, seed);
  addListViews(ctx.state);
}
