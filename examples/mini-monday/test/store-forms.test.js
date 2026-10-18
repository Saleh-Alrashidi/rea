import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../server/store.js";

// Forms (SPEC-2 §2): creation with the name question, question validation,
// settings, tokens, submissions with activity and owner notifications.

async function seeded() {
  const store = await createStore();
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const roadmap = store.listBoards()[0];
  const events = [];
  store.on((event) => events.push(event));
  return { store, users, roadmap, events };
}

test("createForm starts with the required name question", async () => {
  const { store, users, roadmap, events } = await seeded();
  const form = store.createForm({
    boardId: roadmap.id,
    title: " Bugs ",
    creatorId: users.sam.id,
  });
  assert.deepEqual(
    [
      form.title,
      form.board_id,
      form.access,
      form.response_count,
      form.target_group_id,
    ],
    ["Bugs", roadmap.id, "public", 0, null],
  );
  assert.deepEqual(form.questions, [
    { id: "q1", column_id: "name", label: "Name", help: "", required: true },
  ]);
  assert.match(form.token, /^[\w-]{22}$/);
  assert.equal(form.accent_color, "#5b5bd6");
  assert.equal(typeof form.submit_message, "string");
  assert.deepEqual(events, [
    {
      type: "form_created",
      board_id: roadmap.id,
      resource_kind: "form",
      resource_id: form.id,
    },
  ]);
  assert.deepEqual(
    store.listForms({ boardId: roadmap.id }).map((f) => f.title),
    ["Feature request", "Bugs"],
  );
  assert.equal(store.findFormByToken(form.token), form);
  for (const bad of [form.token.slice(1), "", null, 42]) {
    assert.equal(store.findFormByToken(bad), null);
  }
  assert.equal(store.createForm({ boardId: "999999", title: "x" }), null);
  assert.equal(
    store.createForm({ boardId: roadmap.id, title: "x", creatorId: "999" }),
    null,
  );
  assert.equal(
    store.createForm({ boardId: roadmap.id, title: "" }).reason,
    "invalid",
  );
});

test("updateForm validates questions against the board", async () => {
  const { store, roadmap } = await seeded();
  const form = store.createForm({ boardId: roadmap.id, title: "Intake" });
  const name = { column_id: "name", label: "Title" };
  const update = (questions) => store.updateForm(form.id, { questions });
  const next = update([
    name,
    {
      column_id: "status",
      label: " Priority ",
      help: "Pick one",
      required: true,
    },
    { id: "when", column_id: "date", label: "Due" },
  ]);
  assert.deepEqual(next.questions, [
    { id: "q1", column_id: "name", label: "Title", help: "", required: true },
    {
      id: "q2",
      column_id: "status",
      label: "Priority",
      help: "Pick one",
      required: true,
    },
    { id: "when", column_id: "date", label: "Due", help: "", required: false },
  ]);
  const notName = { column_id: "notes", label: "Notes" };
  const bad = [
    "nope",
    [],
    [notName],
    [notName, name],
    [name, { column_id: "person", label: "Owner" }],
    [name, { column_id: "missing", label: "Gone" }],
    [name, { column_id: "notes", label: "" }],
    [name, { column_id: "notes", label: "x".repeat(201) }],
    [name, { column_id: "notes", label: "N", help: "h".repeat(501) }],
    [name, notName, notName],
    [
      { ...name, id: "a" },
      { ...notName, id: "a" },
    ],
    [name, { ...notName, id: "bad id" }],
    [name, { ...notName, extra: true }],
    [name, ...Array.from({ length: 50 }, () => notName)],
  ];
  for (const questions of bad) {
    assert.equal(
      update(questions).reason,
      "invalid",
      JSON.stringify(questions).slice(0, 60),
    );
  }
  assert.deepEqual(
    store.getForm(form.id).questions,
    next.questions,
    "failures change nothing",
  );
  const forced = update([
    { column_id: "name", label: "Title", required: false },
  ]);
  assert.equal(
    forced.questions[0].required,
    true,
    "the name question is always required",
  );
});

test("updateForm settings, link regeneration and deletion", async () => {
  const { store, roadmap, events } = await seeded();
  const form = store.createForm({ boardId: roadmap.id, title: "Intake" });
  const next = store.updateForm(form.id, {
    title: "Requests",
    description: "Tell us",
    accentColor: "#D6336C",
    targetGroupId: "done",
    access: "account",
    submitMessage: "Got it",
  });
  assert.deepEqual(
    [
      next.title,
      next.description,
      next.accent_color,
      next.target_group_id,
      next.access,
      next.submit_message,
    ],
    ["Requests", "Tell us", "#d6336c", "done", "account", "Got it"],
  );
  assert.equal(
    store.updateForm(form.id, { targetGroupId: null }).target_group_id,
    null,
  );
  for (const changes of [
    { targetGroupId: "missing" },
    { access: "everyone" },
    { accentColor: "pink" },
    { title: "" },
    { description: "d".repeat(2001) },
  ]) {
    assert.equal(
      store.updateForm(form.id, changes).reason,
      "invalid",
      JSON.stringify(changes),
    );
  }
  const fresh = store.regenerateFormToken(form.id);
  assert.notEqual(fresh.token, form.token);
  assert.equal(
    store.findFormByToken(form.token),
    null,
    "the old link stops working",
  );
  assert.equal(store.findFormByToken(fresh.token).id, form.id);
  assert.ok(
    events.every((e) => e.board_id === roadmap.id && e.resource_id === form.id),
  );
  assert.equal(store.deleteForm(form.id).id, form.id);
  assert.equal(store.getForm(form.id), null);
  assert.equal(store.deleteForm(form.id), null);
  assert.equal(store.updateForm(form.id, { title: "x" }), null);
  assert.equal(store.regenerateFormToken(form.id), null);
});

test("submitForm creates the item, counts it, logs it and tells the owners", async () => {
  const { store, users, roadmap, events } = await seeded();
  const [feature] = store.listForms();
  const unread = store.countUnreadNotifications(users.alex.id);
  const item = store.submitForm(feature.id, {
    name: " Dark mode for forms ",
    values: { notes: "Please", status: { index: 1 }, date: "2026-12-24" },
  });
  assert.deepEqual(
    [item.name, item.group_id, item.creator_id, item.values],
    [
      "Dark mode for forms",
      "next_up",
      null,
      { notes: "Please", status: { index: 1 }, date: "2026-12-24" },
    ],
  );
  assert.equal(store.getForm(feature.id).response_count, 1);
  const [entry] = store.listActivity(roadmap.id, { limit: 1 });
  assert.deepEqual(
    [
      entry.kind,
      entry.actor_id,
      entry.actor_label,
      entry.item_id,
      entry.item_name,
      entry.to_text,
    ],
    [
      "form_submitted",
      null,
      "Form: Feature request",
      item.id,
      item.name,
      "Next up",
    ],
  );
  assert.equal(store.countUnreadNotifications(users.alex.id), unread + 1);
  const [note] = store.listNotifications(users.alex.id);
  assert.deepEqual(
    [note.kind, note.actor_id, note.url],
    ["form_response", null, `#/boards/${roadmap.id}/items/${item.id}`],
  );
  assert.equal(
    note.text,
    "New response to “Feature request”: “Dark mode for forms”",
  );
  assert.deepEqual(events[0], {
    type: "form_submitted",
    board_id: roadmap.id,
    resource_kind: "form",
    resource_id: feature.id,
    item_id: item.id,
    group_id: "next_up",
  });
  assert.deepEqual(
    events.slice(1).map((e) => [e.type, e.user_ids]),
    [["notification_created", [users.alex.id]]],
  );
});

test("submitForm falls back to the first group and refuses closed forms", async () => {
  const { store, users, roadmap } = await seeded();
  const [feature, intake] = store.listForms();
  store.deleteGroup(roadmap.id, "next_up");
  const item = store.submitForm(feature.id, { name: "Fallback" });
  assert.equal(item.group_id, "this_sprint");
  const marketingOwnerUnread = store.countUnreadNotifications(users.priya.id);
  store.submitForm(intake.id, { name: "Autumn campaign" });
  assert.equal(
    store.countUnreadNotifications(users.priya.id),
    marketingOwnerUnread + 1,
  );
  assert.equal(
    store.countUnreadNotifications(users.chris.id),
    0,
    "editors are not owners",
  );
  store.updateForm(feature.id, { access: "closed" });
  const before = store.getForm(feature.id).response_count;
  assert.equal(
    store.submitForm(feature.id, { name: "Late" }).reason,
    "form_closed",
  );
  assert.equal(store.getForm(feature.id).response_count, before);
  assert.equal(store.submitForm(intake.id, { name: "" }).reason, "invalid");
  assert.throws(
    () => store.submitForm(intake.id, { name: "x", values: { date: "soon" } }),
    TypeError,
  );
  assert.equal(
    store.getForm(intake.id).response_count,
    1,
    "invalid answers count nothing",
  );
  assert.equal(store.submitForm("999999", { name: "x" }), null);
});
