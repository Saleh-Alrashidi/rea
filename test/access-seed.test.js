import assert from "node:assert/strict";
import test from "node:test";
import {
  boardAccess,
  can,
  docAccess,
  noteAccess,
  requireBoard,
  requireCapability,
  requireDoc,
  requireForm,
  requireItem,
  requireNote,
  requireResource,
  requireWorkspace,
  workspaceAccess,
} from "../server/access.js";
import { createStore } from "../server/store.js";

// server/access.js on the real seed (SPEC-2 §2.1): every seeded person's
// access to every seeded workspace, board, doc and note, and the
// NOT_FOUND / FORBIDDEN helpers. Exhaustive matrices are in access.test.js.

async function seeded() {
  const store = await createStore();
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const pick = (list) => (name) =>
    list.find((r) => (r.name ?? r.title) === name);
  return {
    store,
    users,
    workspace: pick(store.listWorkspaces()),
    board: pick(store.listBoards()),
    doc: pick(store.listDocs()),
    note: pick(store.listNotes()),
  };
}

test("seeded workspaces and boards give each person the spec's access", async () => {
  const { store, users, workspace, board } = await seeded();
  const columns = [
    workspace("Main workspace"),
    workspace("Leadership"),
    board("Product roadmap"),
    board("Marketing launch"),
    board("Hiring plan"),
    board("Budget 2027"),
  ];
  const expected = {
    alex: ["owner", "owner", "owner", null, "owner", "owner"],
    sam: ["editor", null, "editor", null, null, null],
    noa: ["editor", null, "editor", null, "editor", null],
    priya: ["editor", null, "editor", "owner", null, null],
    jordan: ["viewer", null, "viewer", null, null, null],
    chris: [null, null, null, "editor", null, null],
    morgan: [null, null, null, null, null, null],
  };
  for (const [name, roles] of Object.entries(expected)) {
    const actual = columns.map((record, index) =>
      index < 2
        ? workspaceAccess(store, users[name], record)
        : boardAccess(store, users[name], record),
    );
    assert.deepEqual(actual, roles, name);
  }
});

test("seeded docs and notes give each person the spec's access", async () => {
  const { store, users, doc, note } = await seeded();
  const docs = ["Product vision", "Launch brief", "Leadership offsite"].map(
    doc,
  );
  const notes = [
    "Ideas for Q1",
    "1:1 with Sam",
    "Design crit notes",
    "Launch checklist",
  ].map(note);
  const expected = {
    alex: [
      ["owner", null, "owner"],
      ["owner", "owner", null, null],
    ],
    sam: [
      ["editor", "editor", null],
      [null, "viewer", "owner", "editor"],
    ],
    noa: [
      ["editor", null, null],
      [null, null, null, null],
    ],
    priya: [
      ["editor", "owner", null],
      [null, null, null, "owner"],
    ],
    jordan: [
      ["viewer", null, null],
      [null, null, null, null],
    ],
    chris: [
      [null, "viewer", null],
      [null, null, null, null],
    ],
    morgan: [
      [null, null, null],
      [null, null, null, null],
    ],
  };
  for (const [name, [docRoles, noteRoles]] of Object.entries(expected)) {
    const user = users[name];
    assert.deepEqual(
      docs.map((d) => docAccess(store, user, d)),
      docRoles,
      `${name} docs`,
    );
    assert.deepEqual(
      notes.map((n) => noteAccess(store, user, n)),
      noteRoles,
      `${name} notes`,
    );
  }
});

test("a viewer account keeps owning its own notes", async () => {
  const { store, users } = await seeded();
  const note = store.createNote({ ownerId: users.jordan.id, title: "Mine" });
  assert.equal(noteAccess(store, users.jordan, note), "owner");
  assert.ok(can(users.jordan, "create_note"));
  assert.equal(can(users.jordan, "create_content"), false);
});

// ------------------------------------------------- NOT_FOUND vs FORBIDDEN

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return [error.extensions?.code ?? error.code, error.message];
  }
  return ["ok", null];
};

test("require helpers: NOT_FOUND hides existence, FORBIDDEN needs access", async () => {
  const { store, users, board, doc, note, workspace } = await seeded();
  const as = (user) => ({ store, principal: { userId: user.id } });
  const hiring = board("Hiring plan");
  assert.deepEqual(
    codeOf(() => requireBoard(as(users.sam), hiring.id)),
    ["NOT_FOUND", `Board "${hiring.id}" was not found`],
  );
  assert.deepEqual(
    codeOf(() => requireBoard(as(users.sam), "999999")),
    ["NOT_FOUND", 'Board "999999" was not found'],
    "the same answer for a board that does not exist",
  );
  assert.equal(requireBoard(as(users.noa), hiring.id, "editor"), hiring);
  assert.equal(
    codeOf(() => requireBoard(as(users.noa), hiring.id, "owner"))[0],
    "FORBIDDEN",
  );
  const roadmap = board("Product roadmap");
  assert.equal(
    codeOf(() => requireBoard(as(users.jordan), roadmap.id, "editor"))[0],
    "FORBIDDEN",
  );
  assert.equal(
    requireBoard({ store, user: users.jordan }, roadmap.id),
    roadmap,
  );
  assert.equal(
    codeOf(() => requireBoard(as(users.morgan), roadmap.id))[0],
    "NOT_FOUND",
  );
  const item = store.listItems({ boardId: hiring.id }).items[0];
  assert.deepEqual(
    codeOf(() => requireItem(as(users.sam), item.id)),
    ["NOT_FOUND", `Item "${item.id}" was not found`],
  );
  assert.equal(requireItem(as(users.noa), item.id, "editor"), item);
  assert.equal(
    codeOf(() => requireItem(as(users.noa), "999999"))[0],
    "NOT_FOUND",
  );
  const brief = doc("Launch brief");
  assert.equal(
    codeOf(() => requireDoc(as(users.alex), brief.id))[0],
    "NOT_FOUND",
  );
  assert.equal(
    codeOf(() => requireDoc(as(users.chris), brief.id, "editor"))[0],
    "FORBIDDEN",
  );
  const crit = note("Design crit notes");
  assert.equal(
    codeOf(() => requireNote(as(users.alex), crit.id))[0],
    "NOT_FOUND",
  );
  assert.equal(requireNote(as(users.sam), crit.id, "owner"), crit);
  const leadership = workspace("Leadership");
  assert.equal(
    codeOf(() => requireWorkspace(as(users.sam), leadership.id))[0],
    "NOT_FOUND",
  );
  assert.equal(
    requireWorkspace(as(users.alex), leadership.id, "owner"),
    leadership,
  );
  const intake = store.listForms()[1];
  assert.equal(
    codeOf(() => requireForm(as(users.alex), intake.id))[0],
    "NOT_FOUND",
  );
  assert.equal(requireForm(as(users.priya), intake.id, "owner"), intake);
  const viaKind = { resourceKind: "doc", id: brief.id, minRole: "owner" };
  assert.equal(requireResource(as(users.priya), viaKind), brief);
  assert.throws(
    () => requireResource(as(users.priya), { ...viaKind, resourceKind: "x" }),
    TypeError,
  );
});

test("requireCapability checks the acting user's account role", async () => {
  const { store, users } = await seeded();
  const as = (user) => ({ store, principal: { userId: user.id } });
  assert.equal(requireCapability(as(users.alex), "manage_users"), users.alex);
  assert.equal(
    codeOf(() => requireCapability(as(users.sam), "manage_users"))[0],
    "FORBIDDEN",
  );
  assert.equal(
    codeOf(() => requireCapability(as(users.chris), "create_content"))[0],
    "FORBIDDEN",
  );
  assert.equal(
    codeOf(() => requireCapability(as(users.morgan), "create_note"))[0],
    "FORBIDDEN",
  );
  assert.equal(requireCapability(as(users.chris), "create_note"), users.chris);
});
