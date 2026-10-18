/**
 * The GraphQL API end to end over HTTP: every query and mutation, scopes,
 * validation limits, pagination and API versions. App principals and HTTP
 * status paths are covered in http.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../server/store.js";
import { gql, startTestServers, storeWithToken } from "./helpers.js";

const BAD = "BAD_USER_INPUT";
const NOT_FOUND = "NOT_FOUND";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { store, hostUrl, tokens } = servers;
  const roadmap = store.listBoards().find((b) => b.name === "Product roadmap");
  const marketing = store.listBoards().find((b) => b.name !== roadmap.name);
  const first = store.listItems({ boardId: roadmap.id }).items[0];
  const call = (query, variables, options = {}) =>
    gql(hostUrl, { query, variables, token: tokens.readWrite, ...options });
  /** Runs an operation that must succeed and returns `data`. */
  const data = async (query, variables, options) => {
    const { status, body } = await call(query, variables, options);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    return body.data;
  };
  /** Asserts that an operation fails with the error code `expected`. */
  const fails = async (expected, query, variables, options) => {
    const { body } = await call(query, variables, options);
    assert.equal(body.errors?.[0]?.extensions.code, expected, query);
  };
  return { ...servers, roadmap, marketing, first, call, data, fails };
}

test("queries: me, users, version, versions, boards and nested fields", async (t) => {
  const { data, roadmap, marketing, hostOrigin, appsOrigin, store } =
    await setup(t);
  const { me, users, version, versions } = await data(`{
    me { id name email is_admin initials }
    users(ids: [2, "3", "999"]) { id initials }
    version { value kind }
    versions { value kind }
  }`);
  assert.deepEqual(me, {
    id: "1",
    name: "Alex Rivera",
    email: "alex@example.test",
    is_admin: true,
    initials: "AR",
  });
  const initials = users.map((user) => `${user.id}:${user.initials}`);
  assert.deepEqual(initials, ["2:SL", "3:NC"]);
  assert.deepEqual(version, { value: "2026-01", kind: "current" });
  const values = versions.map((entry) => entry.value);
  assert.deepEqual(values, ["2025-10", "2026-01", "2026-04"]);
  const all = await data("{ users(limit: 2) { id } boards { id name } }");
  assert.equal(all.users.length, 2);
  const names = all.boards.map((board) => board.name);
  assert.deepEqual(names, ["Product roadmap", "Marketing launch"]);
  const paged = await data("{ boards(limit: 1, page: 2) { id } }");
  assert.deepEqual(paged.boards, [{ id: marketing.id }]);
  const { boards } = await data(
    `query Board($id: ID!) { boards(ids: [$id]) {
      id name description state url items_count creator { name }
      columns(ids: ["status", "nope"]) { id title type settings_str }
      groups { id title color position }
      views { name type app_install_id app_url }
    } }`,
    { id: roadmap.id },
  );
  const [board] = boards;
  assert.equal(board.url, `${hostOrigin}/#/boards/${roadmap.id}`);
  assert.equal(board.state, "active");
  assert.equal(board.items_count, 8);
  assert.equal(board.creator.name, "Alex Rivera");
  assert.deepEqual(
    board.columns.map((column) => `${column.id}:${column.type}`),
    ["status:status"],
  );
  assert.equal(JSON.parse(board.columns[0].settings_str).labels[1], "Done");
  const groupIds = board.groups.map((group) => group.id);
  assert.deepEqual(groupIds, ["this_sprint", "next_up", "done"]);
  const [install] = store.listInstalls({ boardId: roadmap.id });
  const app = board.views.find((view) => view.type === "app");
  assert.equal(app.app_install_id, install.id);
  const appPath = "/apps/status-summary/index.html";
  assert.equal(app.app_url, `${appsOrigin}${appPath}?install_id=${install.id}`);
  const table = board.views.find((view) => view.type === "table");
  assert.equal(table.app_url, null);
});

test("queries: items with column values, updates and lookups", async (t) => {
  const { data, fails, roadmap, first } = await setup(t);
  const { items } = await data(
    `query Items($ids: [ID!]!) { items(ids: $ids) {
      id name state created_at updated_at
      board { id } group { id title } creator { id }
      column_values { id type text value }
      updates(limit: 1) { body creator { name } }
    } }`,
    { ids: [first.id, "999999", first.id] },
  );
  assert.equal(items.length, 1, "unknown IDs are skipped, duplicates merged");
  const [item] = items;
  assert.equal(item.board.id, roadmap.id);
  assert.deepEqual(item.group, { id: "this_sprint", title: "This sprint" });
  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2}T/);
  const values = Object.fromEntries(
    item.column_values.map(({ id, ...rest }) => [id, Object.values(rest)]),
  );
  const people = '{"personsAndTeams":[{"id":1,"kind":"person"}]}';
  assert.deepEqual(values, {
    name: ["name", "Design onboarding flow", '"Design onboarding flow"'],
    status: ["status", "Working on it", '{"index":0}'],
    person: ["people", "Alex Rivera", people],
    date: ["date", "2026-10-20", '{"date":"2026-10-20"}'],
    estimate: ["numbers", "5", '"5"'],
    notes: ["text", "Wireframes ready", '"Wireframes ready"'],
  });
  const body = "Yes, I will share the link before then.";
  assert.deepEqual(item.updates, [{ body, creator: { name: "Alex Rivera" } }]);
  const filtered = await data(
    `query One($ids: [ID!]!) { items(ids: $ids) {
      column_values(ids: ["status"]) { id text } } }`,
    { ids: [first.id] },
  );
  const status = { id: "status", text: "Working on it" };
  assert.deepEqual(filtered.items[0].column_values, [status]);
  const tooMany = Array.from({ length: 501 }, (_, index) => String(index + 1));
  const ids = "query Many($ids: [ID!]!) { items(ids: $ids) { id } }";
  await fails(BAD, ids, { ids: tooMany });
  await fails(BAD, "{ users(limit: 0) { id } }");
  await fails(BAD, "{ boards(limit: 501) { id } }");
  await fails(BAD, "{ boards(page: 0) { id } }");
});

test("items_page pages with cursors per board and per group", async (t) => {
  const { data, fails, roadmap, marketing, store } = await setup(t);
  const page = `query Page($id: ID!, $limit: Int, $cursor: String) {
    boards(ids: [$id]) { items_page(limit: $limit, cursor: $cursor) {
      cursor items { id } } } }`;
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 5; guard += 1) {
    const variables = { id: roadmap.id, limit: 3, cursor };
    const result = await data(page, variables);
    const itemsPage = result.boards[0].items_page;
    seen.push(...itemsPage.items.map((item) => item.id));
    cursor = itemsPage.cursor;
    if (cursor === null) break;
  }
  const expected = store.listItems({ boardId: roadmap.id, limit: 100 });
  assert.deepEqual(
    seen,
    expected.items.map((item) => item.id),
  );
  const groups = `query Group($id: ID!, $cursor: String) {
    boards(ids: [$id]) { groups(ids: ["done"]) {
      items_page(limit: 1, cursor: $cursor) { cursor items { name } } } } }`;
  const done = await data(groups, { id: roadmap.id });
  const groupPage = done.boards[0].groups[0].items_page;
  assert.deepEqual(groupPage.items, [{ name: "Board sharing" }]);
  const next = await data(groups, { id: roadmap.id, cursor: groupPage.cursor });
  const last = next.boards[0].groups[0].items_page;
  const lastItem = { name: "Item card comments" };
  assert.deepEqual(last, { cursor: null, items: [lastItem] });
  // A group cursor is valid neither for the board nor for another board.
  await fails(BAD, page, { id: roadmap.id, cursor: groupPage.cursor });
  await fails(BAD, page, { id: marketing.id, cursor: groupPage.cursor });
  await fails(BAD, page, { id: roadmap.id, cursor: "not*a*cursor" });
  const forged = { b: roadmap.id, g: null, o: -1 };
  const encoded = Buffer.from(JSON.stringify(forged)).toString("base64url");
  await fails(BAD, page, { id: roadmap.id, cursor: encoded });
  await fails(BAD, page, { id: roadmap.id, limit: 0 });
  await fails(BAD, page, { id: roadmap.id, limit: 501 });
  const full = await data(page, { id: roadmap.id, limit: 500 });
  assert.equal(full.boards[0].items_page.cursor, null);
});

test("API versions gate Board.items and Item.url", async (t) => {
  const { call, data, roadmap, first, hostOrigin } = await setup(t);
  const items = "{ boards(limit: 1) { items(limit: 2) { id } } }";
  const old = await data(items, {}, { apiVersion: "2025-10" });
  assert.equal(old.boards[0].items.length, 2);
  const removed = await call(items);
  assert.equal(removed.status, 400);
  const invalid = removed.body.errors[0].extensions.code;
  assert.equal(invalid, "GRAPHQL_VALIDATION_FAILED");
  const url = `query U($ids: [ID!]!) {
    items(ids: $ids) { url } version { value } }`;
  const ids = { ids: [first.id] };
  const current = await call(url, ids);
  assert.equal(current.status, 400, "Item.url is not in 2026-01");
  const next = await data(url, ids, { apiVersion: "2026-04" });
  const expected = `${hostOrigin}/#/boards/${roadmap.id}/items/${first.id}`;
  assert.equal(next.items[0].url, expected);
  assert.equal(next.version.value, "2026-04");
  const bad = await call("{ me { id } }", {}, { apiVersion: "2099-01" });
  assert.equal(bad.status, 400);
  const unsupported = bad.body.errors[0].extensions.code;
  assert.equal(unsupported, "UNSUPPORTED_API_VERSION");
});

test("board mutations: create, update and delete", async (t) => {
  const { data, fails, store } = await setup(t);
  const created = await data(
    `mutation { create_board(board_name: "  Launch  ", description: "Q4") {
      id name description creator { id } groups { id title color }
      columns { id } views { type } } }`,
  );
  const board = created.create_board;
  assert.equal(board.name, "Launch", "names are trimmed");
  assert.equal(board.creator.id, "1");
  const topics = { id: "topics", title: "Topics", color: "#579bfc" };
  assert.deepEqual(board.groups, [topics]);
  const columns = board.columns.map((column) => column.id);
  assert.deepEqual(columns, ["name", "status", "person", "date"]);
  const views = board.views.map((view) => view.type);
  assert.deepEqual(views, ["table", "kanban"]);
  const id = { b: board.id };
  const update = `mutation U($b: ID!, $a: BoardAttribute!, $v: String!) {
    update_board(board_id: $b, board_attribute: $a, new_value: $v) {
      name description } }`;
  await data(update, { ...id, a: "name", v: "Renamed" });
  const described = await data(update, { ...id, a: "description", v: "" });
  const renamed = { name: "Renamed", description: "" };
  assert.deepEqual(described.update_board, renamed);
  await fails(BAD, update, { ...id, a: "name", v: "x".repeat(256) });
  await fails(BAD, update, { ...id, a: "name", v: "   " });
  const long = "d".repeat(10_001);
  await fails(BAD, update, { ...id, a: "description", v: long });
  await fails(NOT_FOUND, update, { b: "999999", a: "name", v: "x" });
  const empty = 'mutation { create_board(board_name: "") { id } }';
  await fails(BAD, empty);
  const remove = `mutation D($b: ID!) {
    delete_board(board_id: $b) { id state groups { id } } }`;
  const gone = await data(remove, id);
  const deleted = { id: board.id, state: "deleted", groups: [] };
  assert.deepEqual(gone.delete_board, deleted);
  assert.equal(store.getBoard(board.id), null);
  await fails(NOT_FOUND, remove, id);
});

test("group and column mutations", async (t) => {
  const { data, fails, store, marketing } = await setup(t);
  const id = { b: marketing.id };
  const group = `mutation G($b: ID!, $n: String!, $c: String) {
    create_group(board_id: $b, group_name: $n, group_color: $c) {
      id title color position } }`;
  const plain = await data(group, { ...id, n: "Later" });
  const later = { id: "later", title: "Later", color: "#579bfc", position: 1 };
  assert.deepEqual(plain.create_group, later);
  const colored = await data(group, { ...id, n: "Later", c: "#A25DDC" });
  assert.equal(colored.create_group.id, "later_2");
  assert.equal(colored.create_group.color, "#A25DDC");
  await fails(BAD, group, { ...id, n: "X", c: "red" });
  await fails(NOT_FOUND, group, { b: "999999", n: "X" });
  const change = `mutation C($b: ID!, $g: String!, $a: GroupAttribute!,
    $v: String!) { update_group(board_id: $b, group_id: $g,
      group_attribute: $a, new_value: $v) { title color } }`;
  const g = { ...id, g: "later" };
  await data(change, { ...g, a: "title", v: "Someday" });
  const recolored = await data(change, { ...g, a: "color", v: "#00c875" });
  const someday = { title: "Someday", color: "#00c875" };
  assert.deepEqual(recolored.update_group, someday);
  await fails(BAD, change, { ...g, a: "color", v: "#00c87" });
  await fails(NOT_FOUND, change, { ...g, g: "nope", a: "title", v: "x" });
  const remove = `mutation D($b: ID!, $g: String!) {
    delete_group(board_id: $b, group_id: $g) { id } }`;
  const deleted = await data(remove, { ...id, g: "later_2" });
  assert.equal(deleted.delete_group.id, "later_2");
  assert.equal(store.getGroup(marketing.id, "later_2"), null);
  await fails(NOT_FOUND, remove, { ...id, g: "later_2" });
  const column = `mutation K($b: ID!, $t: String!, $type: ColumnType!) {
    create_column(board_id: $b, title: $t, column_type: $type) {
      id title type settings_str } }`;
  const status = await data(column, { ...id, t: "Phase", type: "status" });
  assert.equal(status.create_column.id, "status_2");
  assert.ok(JSON.parse(status.create_column.settings_str).labels);
  const text = await data(column, { ...id, t: "Notes", type: "text" });
  const notes = {
    id: "text",
    title: "Notes",
    type: "text",
    settings_str: "{}",
  };
  assert.deepEqual(text.create_column, notes);
  await fails(BAD, column, { ...id, t: "Title", type: "name" });
  await fails(BAD, column, { ...id, t: " ", type: "text" });
  await fails(NOT_FOUND, column, { b: "999999", t: "N", type: "text" });
});

test("create_item and change_column_value", async (t) => {
  const { data, fails, roadmap } = await setup(t);
  const b = roadmap.id;
  const create = `mutation C($b: ID!, $g: String, $n: String!, $v: String) {
    create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) {
      id name group { id } creator { id }
      column_values(ids: ["status", "person", "estimate"]) { text } } }`;
  const values = JSON.stringify({
    status: "Stuck",
    person: { personsAndTeams: [{ id: 2, kind: "person" }] },
    estimate: 4.5,
  });
  const made = await data(create, { b, g: "next_up", n: " Ship ", v: values });
  const item = made.create_item;
  assert.equal(item.name, "Ship");
  assert.equal(item.group.id, "next_up");
  assert.equal(item.creator.id, "1");
  const texts = item.column_values.map((value) => value.text);
  assert.deepEqual(texts, ["Stuck", "Sam Lee", "4.5"]);
  const plain = await data(create, { b, n: "Default group" });
  assert.equal(plain.create_item.group.id, "this_sprint");
  for (const v of ['{"status":"Nope"}', '{"nope":"x"}', '{"name":"x"}']) {
    await fails(BAD, create, { b, n: "Bad", v });
  }
  for (const v of ["[1]", "{", '"text"']) {
    await fails(BAD, create, { b, n: "Bad", v });
  }
  await fails(BAD, create, { b, n: "n".repeat(256) });
  await fails(NOT_FOUND, create, { b, g: "missing", n: "Bad" });
  await fails(NOT_FOUND, create, { b: "999999", n: "Bad" });
  const ids = { b, i: item.id };
  const change = `mutation V($b: ID!, $i: ID!, $c: String!, $v: String!) {
    change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) {
      column_values(ids: [$c]) { text value } } }`;
  const set = async (c, v) =>
    (await data(change, { ...ids, c, v })).change_column_value.column_values[0];
  const done = { text: "Done", value: '{"index":1}' };
  assert.deepEqual(await set("status", '{"index":1}'), done);
  const date = await set("date", '{"date":"2026-12-31"}');
  assert.equal(date.text, "2026-12-31");
  assert.equal((await set("estimate", '"42"')).value, '"42"');
  assert.equal((await set("notes", '"hello"')).text, "hello");
  assert.deepEqual(await set("notes", "null"), { text: null, value: null });
  const unknownUser = '{"personsAndTeams":[{"id":99,"kind":"person"}]}';
  await fails(BAD, change, { ...ids, c: "person", v: unknownUser });
  await fails(BAD, change, { ...ids, c: "date", v: '{"date":"2026-02-30"}' });
  await fails(BAD, change, { ...ids, c: "estimate", v: '"1e999"' });
  await fails(BAD, change, { ...ids, c: "name", v: '"x"' });
  await fails(NOT_FOUND, change, { ...ids, c: "nope", v: '"x"' });
  await fails(NOT_FOUND, change, { ...ids, b: "999999", c: "notes", v: "1" });
  const elsewhere = { ...ids, b: roadmap.id, i: "999999", c: "notes", v: "1" };
  await fails(NOT_FOUND, change, elsewhere);
});

test("simple and multiple values, moves, updates and deletion", async (t) => {
  const { data, fails, roadmap, first, store } = await setup(t);
  const ids = { b: roadmap.id, i: first.id };
  const simple = `mutation S($b: ID!, $i: ID!, $c: String!, $v: String) {
    change_simple_column_value(board_id: $b, item_id: $i, column_id: $c,
      value: $v) { name column_values(ids: [$c]) { text } } }`;
  const text = async (c, v) => {
    const result = await data(simple, { ...ids, c, v });
    return result.change_simple_column_value;
  };
  assert.equal((await text("name", " Renamed ")).name, "Renamed");
  const label = await text("status", "working on it");
  assert.equal(label.column_values[0].text, "Working on it");
  assert.equal((await text("status", null)).column_values[0].text, null);
  await fails(BAD, simple, { ...ids, c: "name", v: "" });
  await fails(BAD, simple, { ...ids, c: "person", v: "1,abc" });
  const multiple = `mutation M($b: ID!, $i: ID!, $v: String!) {
    change_multiple_column_values(board_id: $b, item_id: $i,
      column_values: $v) { name column_values(ids: ["status", "person"]) {
        text } } }`;
  const both = { name: "Final", status: { label: "Done" }, person: "1,3" };
  const multi = await data(multiple, { ...ids, v: JSON.stringify(both) });
  const owners = { text: "Alex Rivera, Noa Cohen" };
  assert.deepEqual(multi.change_multiple_column_values, {
    name: "Final",
    column_values: [{ text: "Done" }, owners],
  });
  const before = store.getItem(first.id);
  const partial = JSON.stringify({ status: "Stuck", date: "not a date" });
  await fails(BAD, multiple, { ...ids, v: partial });
  assert.deepEqual(store.getItem(first.id), before, "no partial writes");
  const move = `mutation Mv($i: ID!, $g: String!) {
    move_item_to_group(item_id: $i, group_id: $g) { group { id } } }`;
  const moved = await data(move, { i: first.id, g: "done" });
  assert.equal(moved.move_item_to_group.group.id, "done");
  await fails(NOT_FOUND, move, { i: first.id, g: "topics" });
  await fails(NOT_FOUND, move, { i: "999999", g: "done" });
  const update = `mutation Up($i: ID!, $body: String!) {
    create_update(item_id: $i, body: $body) { id body creator { id } } }`;
  const posted = await data(update, { i: first.id, body: "  Looks good  " });
  assert.equal(posted.create_update.body, "Looks good");
  assert.equal(posted.create_update.creator.id, "1");
  await fails(BAD, update, { i: first.id, body: "x".repeat(10_001) });
  await fails(BAD, update, { i: first.id, body: " " });
  await fails(NOT_FOUND, update, { i: "999999", body: "x" });
  const history = await data(
    "query H($i: [ID!]!) { items(ids: $i) { updates { body } } }",
    { i: [first.id] },
  );
  const bodies = history.items[0].updates.map((entry) => entry.body);
  assert.equal(bodies[0], "Looks good", "newest first");
  assert.equal(bodies.length, 3);
  const remove = `mutation Del($i: ID!) {
    delete_item(item_id: $i) { id state } }`;
  const removed = await data(remove, { i: first.id });
  assert.deepEqual(removed.delete_item, { id: first.id, state: "deleted" });
  await fails(NOT_FOUND, remove, { i: first.id });
});

test("read-only tokens cannot mutate; tokens cannot reach app storage", async (t) => {
  const { call, fails, roadmap, store, tokens } = await setup(t);
  const before = store.countItems(roadmap.id);
  const mutation = `mutation C($b: ID!) {
    create_item(board_id: $b, item_name: "Nope") { id } }`;
  const readOnly = { token: tokens.readOnly };
  const refused = await call(mutation, { b: roadmap.id }, readOnly);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.data, null);
  const [error] = refused.body.errors;
  assert.equal(error.extensions.code, "FORBIDDEN");
  assert.equal(error.message, "Missing scope boards:write");
  assert.deepEqual(error.path, ["create_item"]);
  assert.equal(store.countItems(roadmap.id), before);
  const read = await call("{ me { name } }", {}, readOnly);
  assert.equal(read.body.data.me.name, "Alex Rivera");
  const [install] = store.listInstalls();
  const storage = `query S($i: ID!) {
    app_storage(install_id: $i, segment: instance, key: "note") { value } }`;
  await fails("FORBIDDEN", storage, { i: install.id });
  await fails("FORBIDDEN", storage, { i: install.id }, readOnly);
});

test("a token without boards:read reaches only version fields", async (t) => {
  const store = await createStore({ file: null });
  const record = { token: "storage-only", user_id: "1", label: "storage" };
  const scopes = ["storage:read", "storage:write"];
  const view = storeWithToken(store, { ...record, scopes });
  const servers = await startTestServers({ store: view });
  t.after(() => servers.close());
  const ask = async (query) =>
    (await gql(servers.hostUrl, { query, token: record.token })).body;
  const versions = await ask("{ version { value } versions { kind } }");
  assert.equal(versions.errors, undefined);
  for (const field of ["me { id }", "users { id }", "boards { id }"]) {
    const { errors } = await ask(`{ ${field} }`);
    assert.equal(errors[0].message, "Missing scope boards:read", field);
  }
  const items = await ask('{ items(ids: ["1"]) { id } }');
  assert.equal(items.errors[0].extensions.code, "FORBIDDEN");
});
