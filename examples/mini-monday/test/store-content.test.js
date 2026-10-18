import assert from "node:assert/strict";
import test from "node:test";
import { docAccess } from "../server/access.js";
import { createStore } from "../server/store.js";

// Docs and notes (SPEC-2 §2): block validation and limits, generated block
// IDs, optimistic versions with version conflicts, visibility, deletion.

const START = Date.UTC(2026, 9, 18, 9, 0, 0);
const clock = () => {
  let tick = 0;
  return () => new Date(START + 1000 * tick++);
};

async function seeded() {
  const store = await createStore({ now: clock() });
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const events = [];
  store.on((event) => events.push(event));
  return { store, users, events };
}

test("createDoc stores validated blocks with generated IDs", async () => {
  const { store, users, events } = await seeded();
  const [main] = store.listWorkspaces();
  const doc = store.createDoc({
    title: " Plan ",
    creatorId: users.sam.id,
    blocks: [
      { type: "heading1", text: "Plan" },
      { id: "b1", type: "todo", text: "First" },
      { type: "todo", text: "Second", checked: true },
      { type: "paragraph", text: "Body", checked: true },
      { type: "divider", text: "ignored" },
      { type: "code" },
    ],
  });
  assert.deepEqual(
    [doc.title, doc.workspace_id, doc.visibility, doc.version],
    ["Plan", main.id, "workspace", 1],
  );
  assert.deepEqual(doc.members, [
    { kind: "user", id: users.sam.id, role: "owner" },
  ]);
  assert.deepEqual(
    [doc.created_by, doc.updated_by],
    [users.sam.id, users.sam.id],
  );
  assert.deepEqual(doc.blocks, [
    { id: "b2", type: "heading1", text: "Plan" },
    { id: "b1", type: "todo", text: "First", checked: false },
    { id: "b3", type: "todo", text: "Second", checked: true },
    { id: "b4", type: "paragraph", text: "Body" },
    { id: "b5", type: "divider", text: "" },
    { id: "b6", type: "code", text: "" },
  ]);
  assert.deepEqual(events, [
    { type: "doc_created", resource_kind: "doc", resource_id: doc.id },
  ]);
  assert.equal(docAccess(store, users.sam, doc), "owner");
  assert.equal(
    docAccess(store, users.noa, doc),
    "editor",
    "workspace visibility",
  );
  const secret = store.createDoc({
    title: "Secret",
    visibility: "private",
    creatorId: users.sam.id,
  });
  assert.equal(docAccess(store, users.noa, secret), null);
  assert.equal(
    store.createDoc({ title: "x", workspaceId: "999", creatorId: "1" }),
    null,
  );
  const defaulted = store.createDoc({ title: "D", workspaceId: null });
  assert.deepEqual([defaulted.workspace_id, defaulted.members], [main.id, []]);
  assert.equal(store.createDoc({ title: "x", creatorId: "999" }), null);
  assert.deepEqual(
    store
      .listDocs({ workspaceId: main.id })
      .map((d) => d.title)
      .slice(-3),
    ["Plan", "Secret", "D"],
  );
});

test("doc block and title limits", async () => {
  const { store, users } = await seeded();
  const create = (fields) =>
    store.createDoc({ title: "T", creatorId: users.sam.id, ...fields });
  const bad = [
    { title: "" },
    { title: "x".repeat(256) },
    { visibility: "public" },
    { blocks: "nope" },
    { blocks: [{ type: "table", text: "" }] },
    { blocks: [{ type: "paragraph", text: 5 }] },
    { blocks: [{ type: "paragraph", text: "x".repeat(10_001) }] },
    { blocks: [{ type: "todo", text: "", checked: "yes" }] },
    { blocks: [{ type: "paragraph", text: "", color: "red" }] },
    { blocks: [{ id: "a b", type: "paragraph", text: "" }] },
    {
      blocks: [
        { id: "x", type: "paragraph" },
        { id: "x", type: "quote" },
      ],
    },
    {
      blocks: Array.from({ length: 2001 }, () => ({
        type: "paragraph",
        text: "",
      })),
    },
    { blocks: [null] },
  ];
  for (const fields of bad) {
    const result = create(fields);
    assert.equal(result.reason, "invalid", JSON.stringify(fields).slice(0, 80));
    assert.equal(typeof result.message, "string");
  }
  const big = Array.from({ length: 2000 }, () => ({
    type: "paragraph",
    text: "x".repeat(10),
  }));
  assert.equal(create({ blocks: big }).blocks.length, 2000, "2,000 blocks fit");
  const long = create({
    blocks: [{ type: "quote", text: "q".repeat(10_000) }],
  });
  assert.equal(long.blocks[0].text.length, 10_000);
});

test("updateDoc writes with expectedVersion and reports conflicts", async () => {
  const { store, users, events } = await seeded();
  const doc = store.listDocs()[0];
  const blocks = [...doc.blocks, { type: "paragraph", text: "New" }];
  const next = store.updateDoc(
    doc.id,
    { expectedVersion: 1, title: "Vision 2027", blocks },
    { actorId: users.sam.id },
  );
  assert.deepEqual(
    [next.title, next.version, next.updated_by],
    ["Vision 2027", 2, users.sam.id],
  );
  assert.ok(next.updated_at > doc.updated_at);
  assert.equal(next.created_by, doc.created_by);
  assert.equal(next.blocks.at(-1).id, "b9", "IDs avoid the existing ones");
  assert.deepEqual(next.blocks.slice(0, -1), doc.blocks);
  assert.deepEqual(events, [
    { type: "doc_updated", resource_kind: "doc", resource_id: doc.id },
  ]);
  const stale = store.updateDoc(doc.id, { expectedVersion: 1, title: "Mine" });
  assert.deepEqual(stale, {
    ok: false,
    reason: "version_conflict",
    version: 2,
  });
  assert.equal(store.getDoc(doc.id).title, "Vision 2027", "nothing written");
  assert.equal(events.length, 1);
  const titleOnly = store.updateDoc(doc.id, {
    expectedVersion: 2,
    title: "Vision",
  });
  assert.deepEqual([titleOnly.version, titleOnly.blocks], [3, next.blocks]);
  assert.equal(
    store.updateDoc(doc.id, { expectedVersion: 3, blocks: [{ type: "x" }] })
      .reason,
    "invalid",
  );
  assert.equal(
    store.getDoc(doc.id).version,
    3,
    "invalid input changes nothing",
  );
  assert.throws(
    () => store.updateDoc(doc.id, { expectedVersion: "3" }),
    TypeError,
  );
  assert.equal(store.updateDoc("999999", { expectedVersion: 1 }), null);
});

test("doc visibility and deletion", async () => {
  const { store, users } = await seeded();
  const vision = store.listDocs()[0];
  assert.equal(docAccess(store, users.sam, vision), "editor");
  const hidden = store.setDocVisibility(vision.id, "private");
  assert.deepEqual(
    [hidden.visibility, hidden.version],
    ["private", vision.version],
  );
  assert.equal(docAccess(store, users.sam, hidden), null);
  assert.equal(
    docAccess(store, users.alex, hidden),
    "owner",
    "explicit grants stay",
  );
  assert.equal(store.setDocVisibility(vision.id, "secret").reason, "invalid");
  assert.equal(store.setDocVisibility("999999", "private"), null);
  const deleted = store.deleteDoc(vision.id);
  assert.equal(deleted.id, vision.id);
  assert.equal(store.getDoc(vision.id), null);
  assert.equal(store.deleteDoc(vision.id), null);
});

test("notes: create, versioned updates, limits and deletion", async () => {
  const { store, users, events } = await seeded();
  const note = store.createNote({
    ownerId: users.jordan.id,
    title: "Budget questions",
  });
  assert.deepEqual(
    [
      note.owner_id,
      note.title,
      note.body,
      note.color,
      note.pinned,
      note.shares,
      note.version,
    ],
    [users.jordan.id, "Budget questions", "", "#fff4c2", false, [], 1],
  );
  assert.deepEqual(events, [
    { type: "note_created", resource_kind: "note", resource_id: note.id },
  ]);
  const next = store.updateNote(note.id, {
    expectedVersion: 1,
    body: "Ask about travel",
    color: "#DFF4FF",
    pinned: true,
  });
  assert.deepEqual(
    [next.body, next.color, next.pinned, next.version, next.title],
    ["Ask about travel", "#dff4ff", true, 2, "Budget questions"],
  );
  assert.ok(next.updated_at > note.updated_at);
  assert.deepEqual(
    store.updateNote(note.id, { expectedVersion: 1, pinned: false }),
    {
      ok: false,
      reason: "version_conflict",
      version: 2,
    },
  );
  assert.equal(store.getNote(note.id).pinned, true);
  const bad = [
    { title: "" },
    { title: "x".repeat(256) },
    { body: "b".repeat(20_001) },
    { color: "yellow" },
  ];
  for (const changes of bad) {
    assert.equal(
      store.updateNote(note.id, { expectedVersion: 2, ...changes }).reason,
      "invalid",
    );
    assert.equal(
      store.createNote({ ownerId: users.sam.id, title: "T", ...changes })
        .reason,
      "invalid",
    );
  }
  assert.throws(
    () => store.updateNote(note.id, { expectedVersion: 2, pinned: "yes" }),
    TypeError,
  );
  const full = store.updateNote(note.id, {
    expectedVersion: 2,
    body: "b".repeat(20_000),
  });
  assert.equal(full.body.length, 20_000);
  assert.equal(store.createNote({ ownerId: "999", title: "x" }), null);
  assert.deepEqual(
    store.listNotes({ ownerId: users.jordan.id }).map((n) => n.id),
    [note.id],
  );
  assert.equal(store.deleteNote(note.id).id, note.id);
  assert.equal(store.getNote(note.id), null);
  assert.equal(store.deleteNote(note.id), null);
  assert.equal(store.updateNote(note.id, { expectedVersion: 1 }), null);
});
