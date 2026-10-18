/**
 * Form management over GraphQL (SPEC-2 §3): create_form with its name
 * question, Board.forms and `forms`, update_form validation (questions,
 * target group, access, texts), link regeneration and deletion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startTestServers } from "./helpers.js";

const FORM = `id title description accent_color questions_json target_group_id
  access public_url submit_message response_count board { id }`;
const UPDATE = `mutation U($f: ID!, $q: String, $g: String, $a: FormAccess,
  $t: String, $d: String, $c: String, $m: String) {
  update_form(form_id: $f, questions_json: $q, target_group_id: $g, access: $a,
    title: $t, description: $d, accent_color: $c, submit_message: $m) { ${FORM} } }`;

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const sam = servers.as(servers.ids.users.sam);
  const create = `mutation C($b: ID!, $t: String!) { create_form(board_id: $b, title: $t) { ${FORM} } }`;
  const form = (
    await sam.data(create, { b: servers.ids.boards.roadmap, t: " Bugs " })
  ).create_form;
  return { ...servers, sam, create, form };
}

test("create_form starts public with the required name question", async (t) => {
  const { form, ids, hostOrigin, store, sam } = await setup(t);
  const { token } = store.getForm(form.id);
  assert.deepEqual(form, {
    id: form.id,
    title: "Bugs",
    description: null,
    accent_color: "#5b5bd6",
    questions_json: JSON.stringify([
      { id: "q1", column_id: "name", label: "Name", help: "", required: true },
    ]),
    target_group_id: null,
    access: "public",
    public_url: `${hostOrigin}/f/${token}`,
    submit_message: "Thanks! Your response was recorded.",
    response_count: 0,
    board: { id: ids.boards.roadmap },
  });
  assert.match(token, /^[\w-]{22}$/, "16 random bytes, base64url");
  const lists = await sam.data(
    `query F($b: ID!) {
    forms(board_id: $b) { title } boards(ids: [$b]) { forms { title } } }`,
    { b: ids.boards.roadmap },
  );
  assert.deepEqual(
    lists.forms.map((f) => f.title),
    ["Feature request", "Bugs"],
  );
  assert.deepEqual(lists.boards[0].forms, lists.forms);
});

test("update_form validates questions against the board's columns", async (t) => {
  const { form, sam } = await setup(t);
  const questions = [
    { column_id: "name", label: "Bug title", required: false },
    {
      column_id: "notes",
      label: " Steps ",
      help: "What did you do?",
      required: true,
    },
    { id: "prio", column_id: "status", label: "Severity" },
  ];
  const saved = (
    await sam.data(UPDATE, { f: form.id, q: JSON.stringify(questions) })
  ).update_form;
  assert.deepEqual(JSON.parse(saved.questions_json), [
    {
      id: "q1",
      column_id: "name",
      label: "Bug title",
      help: "",
      required: true,
    },
    {
      id: "q2",
      column_id: "notes",
      label: "Steps",
      help: "What did you do?",
      required: true,
    },
    {
      id: "prio",
      column_id: "status",
      label: "Severity",
      help: "",
      required: false,
    },
  ]);
  const name = { column_id: "name", label: "Title" };
  const invalid = [
    "not json",
    JSON.stringify({ column_id: "name", label: "x" }),
    JSON.stringify([]),
    JSON.stringify([{ column_id: "notes", label: "First" }]),
    JSON.stringify([name, { column_id: "person", label: "Who" }]),
    JSON.stringify([name, { column_id: "missing", label: "?" }]),
    JSON.stringify([name, { column_id: "notes", label: "" }]),
    JSON.stringify([name, { column_id: "notes", label: "x".repeat(201) }]),
    JSON.stringify([
      name,
      { column_id: "notes", label: "x", help: "h".repeat(501) },
    ]),
    JSON.stringify([name, { column_id: "name", label: "Again" }]),
    JSON.stringify([name, { column_id: "notes", label: "x", extra: true }]),
    JSON.stringify(Array.from({ length: 51 }, () => name)),
  ];
  for (const q of invalid) {
    assert.equal(
      await sam.code(UPDATE, { f: form.id, q }),
      "BAD_USER_INPUT",
      q.slice(0, 60),
    );
  }
  const unchanged = await sam.data(
    `query F($b: ID!) { forms(board_id: $b) { questions_json } }`,
    {
      b: saved.board.id,
    },
  );
  assert.equal(unchanged.forms[1].questions_json, saved.questions_json);
});

test("update_form settings: target group, access, texts and colors", async (t) => {
  const { form, sam } = await setup(t);
  const vars = {
    f: form.id,
    g: "done",
    a: "account",
    t: "Bug reports",
    d: "Tell us",
    c: "#D6336C",
    m: "Got it!",
  };
  const saved = (await sam.data(UPDATE, vars)).update_form;
  assert.deepEqual(
    [
      saved.target_group_id,
      saved.access,
      saved.title,
      saved.description,
      saved.accent_color,
      saved.submit_message,
    ],
    ["done", "account", "Bug reports", "Tell us", "#d6336c", "Got it!"],
  );
  const cleared = (await sam.data(UPDATE, { f: form.id, g: null, d: null }))
    .update_form;
  assert.deepEqual(
    [cleared.target_group_id, cleared.description],
    [null, null],
  );
  assert.equal(cleared.title, "Bug reports", "absent arguments change nothing");
  for (const bad of [
    { g: "topics" },
    { c: "pink" },
    { t: " " },
    { d: "d".repeat(2001) },
  ]) {
    assert.equal(
      await sam.code(UPDATE, { f: form.id, ...bad }),
      "BAD_USER_INPUT",
      JSON.stringify(bad),
    );
  }
  assert.equal(await sam.code(UPDATE, { f: "999999", t: "x" }), "NOT_FOUND");
});

test("regenerate_form_link and delete_form", async (t) => {
  const { form, sam, store } = await setup(t);
  const old = store.getForm(form.id).token;
  const regenerate = `mutation R($f: ID!) { regenerate_form_link(form_id: $f) { public_url } }`;
  const fresh = (await sam.data(regenerate, { f: form.id }))
    .regenerate_form_link;
  assert.notEqual(fresh.public_url, form.public_url);
  assert.equal(store.findFormByToken(old), null);
  const remove = `mutation D($f: ID!) { delete_form(form_id: $f) { id title } }`;
  assert.deepEqual((await sam.data(remove, { f: form.id })).delete_form, {
    id: form.id,
    title: "Bugs",
  });
  assert.equal(await sam.code(remove, { f: form.id }), "NOT_FOUND");
  assert.equal(store.getForm(form.id), null);
});

test("deleting a form's target group sends answers to the first group", async (t) => {
  const { form, sam, store, ids, hostUrl } = await setup(t);
  await sam.data(UPDATE, { f: form.id, g: "done" });
  const drop = `mutation G($b: ID!) { delete_group(board_id: $b, group_id: "done") { id } }`;
  await sam.data(drop, { b: ids.boards.roadmap });
  assert.equal(store.getForm(form.id).target_group_id, null);
  const { token } = store.getForm(form.id);
  const response = await fetch(new URL(`/f/${token}/submit`, hostUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Crash on save" } }),
  });
  assert.equal(response.status, 201);
  const { items } = store.listItems({
    boardId: ids.boards.roadmap,
    groupId: "this_sprint",
    limit: 100,
  });
  assert.equal(items.at(-1).name, "Crash on save");
});
