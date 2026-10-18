/**
 * Docs and notes over GraphQL (SPEC-2 §3): creation defaults, block
 * validation, optimistic versions with VERSION_CONFLICT and
 * `extensions.version`, visibility, scopes of the notes list, sharing
 * roles on notes and deletion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startTestServers } from "./helpers.js";

const DOC = `id title visibility version blocks_json url my_access
  workspace { id } created_by { id } updated_by { id } members { id role }`;
const NOTE =
  "id title body color pinned version my_access owner { id } shares { id role }";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids } = servers;
  const users = Object.fromEntries(
    ["alex", "sam", "noa", "priya", "jordan", "chris"].map((key) => [
      key,
      servers.as(ids.users[key]),
    ]),
  );
  return { ...servers, users };
}

test("create_doc defaults to the first workspace and workspace visibility", async (t) => {
  const { users, ids } = await setup(t);
  const create = `mutation C($t: String!, $w: ID, $v: DocVisibility) {
    create_doc(title: $t, workspace_id: $w, visibility: $v) { ${DOC} } }`;
  const doc = (await users.sam.data(create, { t: " Specs " })).create_doc;
  assert.deepEqual(doc, {
    id: doc.id,
    title: "Specs",
    visibility: "workspace",
    version: 1,
    blocks_json: "[]",
    url: `#/docs/${doc.id}`,
    my_access: "owner",
    workspace: { id: ids.workspaces.main },
    created_by: { id: ids.users.sam },
    updated_by: { id: ids.users.sam },
    members: [{ id: ids.users.sam, role: "owner" }],
  });
  const noa = await users.noa.data(
    "query D($d: [ID!]) { docs(ids: $d) { my_access } }",
    { d: [doc.id] },
  );
  assert.deepEqual(noa.docs, [{ my_access: "editor" }]);
  const hidden = await users.sam.data(create, { t: "Draft", v: "private" });
  const none = await users.noa.data(
    "query D($d: [ID!]) { docs(ids: $d) { id } }",
    { d: [hidden.create_doc.id] },
  );
  assert.deepEqual(none.docs, []);
  assert.equal(
    await users.sam.code(create, { t: "x".repeat(256) }),
    "BAD_USER_INPUT",
  );
  const inWorkspace = await users.alex.data(
    "query D($w: ID) { docs(workspace_id: $w) { title } }",
    { w: ids.workspaces.leadership },
  );
  assert.deepEqual(inWorkspace.docs, [{ title: "Leadership offsite" }]);
});

test("update_doc replaces blocks, bumps the version and refuses stale versions", async (t) => {
  const { users, ids, store } = await setup(t);
  const update = `mutation U($d: ID!, $v: Int!, $t: String, $b: String) {
    update_doc(doc_id: $d, expected_version: $v, title: $t, blocks_json: $b) { ${DOC} } }`;
  const doc = ids.docs.vision;
  const blocks = [
    { type: "heading1", text: "Vision" },
    { type: "todo", text: "Ship", checked: true },
    { id: "keep", type: "paragraph", text: "Kept id" },
    { type: "divider", text: "ignored" },
  ];
  const vars = { d: doc, v: 1, b: JSON.stringify(blocks) };
  const saved = (await users.sam.data(update, vars)).update_doc;
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.updated_by, { id: ids.users.sam });
  assert.deepEqual(JSON.parse(saved.blocks_json), [
    { id: "b1", type: "heading1", text: "Vision" },
    { id: "b2", type: "todo", text: "Ship", checked: true },
    { id: "keep", type: "paragraph", text: "Kept id" },
    { id: "b3", type: "divider", text: "" },
  ]);
  const stale = await users.noa.error(update, { d: doc, v: 1, t: "Mine" });
  assert.equal(stale.extensions.code, "VERSION_CONFLICT");
  assert.equal(stale.extensions.version, 2);
  assert.equal(store.getDoc(doc).title, "Product vision", "nothing changed");
  const renamed = await users.noa.data(update, { d: doc, v: 2, t: "Vision 2" });
  assert.equal(renamed.update_doc.version, 3);
  const invalid = [
    "not json",
    '{"type":"paragraph"}',
    '[{"type":"table","text":""}]',
    JSON.stringify([{ type: "paragraph", text: "x".repeat(10_001) }]),
    JSON.stringify([{ type: "paragraph", text: "", extra: 1 }]),
    JSON.stringify([
      { id: "a", type: "quote" },
      { id: "a", type: "code" },
    ]),
  ];
  for (const b of invalid) {
    assert.equal(
      await users.noa.code(update, { d: doc, v: 3, b }),
      "BAD_USER_INPUT",
      b,
    );
  }
  assert.equal(
    await users.noa.code(update, { d: doc, v: -1, t: "x" }),
    "BAD_USER_INPUT",
  );
  assert.equal(store.getDoc(doc).version, 3);
});

test("set_doc_visibility and delete_doc need owner access", async (t) => {
  const { users, ids } = await setup(t);
  const visibility = `mutation V($d: ID!, $v: DocVisibility!) {
    set_doc_visibility(doc_id: $d, visibility: $v) { visibility version } }`;
  const doc = ids.docs.vision;
  assert.equal(
    await users.sam.code(visibility, { d: doc, v: "private" }),
    "FORBIDDEN",
  );
  const done = await users.alex.data(visibility, { d: doc, v: "private" });
  assert.deepEqual(done.set_doc_visibility, {
    visibility: "private",
    version: 1,
  });
  const list = "{ docs { id } }";
  assert.ok(
    (await users.sam.data(list)).docs.every((entry) => entry.id !== doc),
  );
  const remove = "mutation D($d: ID!) { delete_doc(doc_id: $d) { id title } }";
  assert.equal(await users.sam.code(remove, { d: doc }), "NOT_FOUND");
  const gone = await users.alex.data(remove, { d: doc });
  assert.deepEqual(gone.delete_doc, { id: doc, title: "Product vision" });
  assert.equal(await users.alex.code(remove, { d: doc }), "NOT_FOUND");
});

test("notes: private by default, scopes, pinned first, versions", async (t) => {
  const { users, ids } = await setup(t);
  const create = `mutation C($t: String!, $b: String, $c: String) {
    create_note(title: $t, body: $b, color: $c) { ${NOTE} } }`;
  const note = (await users.jordan.data(create, { t: "Budget questions" }))
    .create_note;
  assert.deepEqual(note, {
    id: note.id,
    title: "Budget questions",
    body: "",
    color: "#fff4c2",
    pinned: false,
    version: 1,
    my_access: "owner",
    owner: { id: ids.users.jordan },
    shares: [],
  });
  assert.equal(
    await users.alex.code(create, { t: "x", c: "yellow" }),
    "BAD_USER_INPUT",
  );
  assert.equal(
    await users.alex.code(create, { t: "x", b: "b".repeat(20_001) }),
    "BAD_USER_INPUT",
  );
  const scope = "query N($s: NoteScope) { notes(scope: $s) { title } }";
  const titles = async (client, s) =>
    (await client.data(scope, { s })).notes.map((n) => n.title);
  assert.deepEqual(await titles(users.alex, "mine"), [
    "Ideas for Q1",
    "1:1 with Sam",
  ]);
  assert.deepEqual(await titles(users.alex, "shared"), []);
  assert.deepEqual(await titles(users.sam, "mine"), ["Design crit notes"]);
  assert.deepEqual((await titles(users.sam, "shared")).sort(), [
    "1:1 with Sam",
    "Launch checklist",
  ]);
  assert.equal((await titles(users.sam, "all")).length, 3);
  assert.deepEqual(await titles(users.jordan, "all"), ["Budget questions"]);
  const update = `mutation U($n: ID!, $v: Int!, $t: String, $p: Boolean, $b: String) {
    update_note(note_id: $n, expected_version: $v, title: $t, pinned: $p, body: $b) { version pinned body } }`;
  const pinned = await users.jordan.data(update, {
    n: note.id,
    v: 1,
    p: true,
    b: "Q2?",
  });
  assert.deepEqual(pinned.update_note, {
    version: 2,
    pinned: true,
    body: "Q2?",
  });
  const stale = await users.jordan.error(update, {
    n: note.id,
    v: 1,
    t: "Old",
  });
  assert.equal(stale.extensions.code, "VERSION_CONFLICT");
  assert.equal(stale.extensions.version, 2);
  await users.jordan.data(create, { t: "Later note" });
  assert.deepEqual(await titles(users.jordan, "all"), [
    "Budget questions",
    "Later note",
  ]);
});

test("shared notes: editors edit, only the owner shares and deletes", async (t) => {
  const { users, ids } = await setup(t);
  const checklist = ids.notes.checklist;
  const update = `mutation U($n: ID!, $v: Int!, $b: String) {
    update_note(note_id: $n, expected_version: $v, body: $b) { body version } }`;
  const edited = await users.sam.data(update, {
    n: checklist,
    v: 1,
    b: "Blog post\nNewsletter",
  });
  assert.equal(edited.update_note.version, 2);
  const share = `mutation S($n: ID!, $u: [ID!]!) { share(resource_kind: note, resource_id: $n,
    subject_kind: user, subject_ids: $u, role: viewer) { id role } }`;
  assert.equal(
    await users.sam.code(share, { n: checklist, u: [ids.users.noa] }),
    "FORBIDDEN",
  );
  const remove = "mutation D($n: ID!) { delete_note(note_id: $n) { id } }";
  assert.equal(await users.sam.code(remove, { n: checklist }), "FORBIDDEN");
  // A viewer share is read-only.
  const oneOnOne = ids.notes.oneOnOne;
  assert.equal(
    await users.sam.code(update, { n: oneOnOne, v: 1, b: "x" }),
    "FORBIDDEN",
  );
  const own = await users.priya.data(share, {
    n: checklist,
    u: [ids.users.jordan],
  });
  assert.ok(
    own.share.some((m) => m.id === ids.users.jordan && m.role === "viewer"),
  );
  const jordan = await users.jordan.data(
    "{ notes(scope: shared) { title my_access } }",
  );
  assert.deepEqual(jordan.notes, [
    { title: "Launch checklist", my_access: "viewer" },
  ]);
  // Viewer accounts stay viewers even with an editor share.
  const editor = share.replace("role: viewer", "role: editor");
  await users.priya.data(editor, { n: checklist, u: [ids.users.jordan] });
  const capped = await users.jordan.data(
    "{ notes(scope: shared) { my_access } }",
  );
  assert.deepEqual(capped.notes, [{ my_access: "viewer" }]);
  assert.equal(
    (await users.priya.data(remove, { n: checklist })).delete_note.id,
    checklist,
  );
  assert.deepEqual(
    (await users.sam.data("{ notes(scope: shared) { title } }")).notes,
    [{ title: "1:1 with Sam" }],
  );
});
