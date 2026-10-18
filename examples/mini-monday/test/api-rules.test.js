/**
 * API rules from the review follow-ups: a board kind change never locks
 * out the person making it, a board keeps a group so forms keep working,
 * bad inputs are BAD_USER_INPUT (never masked internal errors), workspaces
 * say whether they can be opened and deleted, and team roles change in
 * one atomic mutation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startTestServers } from "./helpers.js";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const users = Object.fromEntries(
    ["alex", "sam", "noa", "chris"].map((key) => [
      key,
      servers.as(servers.ids.users[key]),
    ]),
  );
  return { ...servers, users };
}

const CREATE = `mutation C($k: BoardKind, $w: ID) { create_board(board_name: "Rules",
  board_kind: $k, workspace_id: $w) { id } }`;
const KIND = `mutation K($b: ID!, $k: BoardKind!) { set_board_kind(board_id: $b,
  board_kind: $k) { id board_kind my_access } }`;
const BOARD = `query B($b: ID!) { boards(ids: [$b]) { board_kind
  activity_logs { kind } } }`;

test("a kind change that would lock out its maker is refused before it commits", async (t) => {
  const { users, ids } = await setup(t);
  const { create_board: board } = await users.sam.data(CREATE, { k: "public" });
  const refused = await users.alex.error(KIND, { b: board.id, k: "private" });
  assert.equal(refused.extensions.code, "BAD_USER_INPUT");
  assert.match(refused.message, /remove your own access/);
  const [seen] = (await users.sam.data(BOARD, { b: board.id })).boards;
  assert.equal(seen.board_kind, "public");
  assert.ok(
    seen.activity_logs.every((entry) => entry.kind !== "board_kind_changed"),
  );
  const share = `mutation S($b: ID!, $u: ID!) { share(resource_kind: board,
    resource_id: $b, subject_kind: user, subject_ids: [$u], role: owner) { id } }`;
  await users.alex.data(share, { b: board.id, u: ids.users.alex });
  const changed = await users.alex.data(KIND, { b: board.id, k: "private" });
  assert.deepEqual(changed.set_board_kind, {
    id: board.id,
    board_kind: "private",
    my_access: "owner",
  });
});

test("the last group cannot be deleted, so forms keep accepting responses", async (t) => {
  const { users, hostUrl } = await setup(t);
  const { create_board: board } = await users.sam.data(CREATE, {});
  const drop = `mutation G($b: ID!) { delete_group(board_id: $b, group_id: "topics") { id } }`;
  const refused = await users.sam.error(drop, { b: board.id });
  assert.deepEqual(
    [refused.extensions.code, refused.message],
    ["BAD_USER_INPUT", "A board keeps at least one group"],
  );
  const form = `mutation F($b: ID!) { create_form(board_id: $b, title: "Ask") {
    questions_json public_url } }`;
  const { create_form: made } = await users.sam.data(form, { b: board.id });
  const [question] = JSON.parse(made.questions_json);
  const response = await fetch(`${made.public_url}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: hostUrl },
    body: JSON.stringify({ answers: { [question.id]: "Hello" }, website: "" }),
  });
  await response.body?.cancel();
  assert.equal(response.status, 201);
});

test("bad inputs are BAD_USER_INPUT, never masked internal errors", async (t) => {
  const { users, ids, log } = await setup(t);
  assert.equal(await users.sam.code(CREATE, { k: null }), "BAD_USER_INPUT");
  const literal = `mutation { create_board(board_name: "x", board_kind: null) { id } }`;
  assert.equal(await users.sam.code(literal), "BAD_USER_INPUT");
  const update = `mutation U($f: ID!, $q: String!) { update_form(form_id: $f,
    questions_json: $q) { id } }`;
  for (const extra of [{ required: "yes" }, { help: 5 }]) {
    const questions = [
      { column_id: "name", label: "Request title" },
      { column_id: "status", label: "S", ...extra },
    ];
    const vars = { f: ids.forms.feature, q: JSON.stringify(questions) };
    const error = await users.alex.error(update, vars);
    assert.equal(
      error.extensions.code,
      "BAD_USER_INPUT",
      JSON.stringify(extra),
    );
  }
  assert.deepEqual(
    log.entries.filter((entry) => entry.level === "error"),
    [],
    "no resolver failures were logged",
  );
});

test("one name, description and color rule for the API, the store and column values", async (t) => {
  const { users, ids, store } = await setup(t);
  const message = async (query, variables) =>
    (await users.alex.error(query, variables))?.message ?? null;
  const longName = "n".repeat(256);
  const board = `mutation B($n: String!, $d: String) { create_board(board_name: $n,
    description: $d) { id } }`;
  assert.equal(
    await message(board, { n: longName }),
    "Board name must be 1-255 characters",
  );
  assert.equal(await message(board, { n: "n".repeat(255) }), null);
  assert.equal(
    store.createTeam({ name: longName }).message,
    "Team name must be 1-255 characters",
  );
  const [item] = store.listItems({ boardId: ids.boards.roadmap }).items;
  const rename = `mutation R($b: ID!, $i: ID!, $v: String) { change_simple_column_value(
    board_id: $b, item_id: $i, column_id: "name", value: $v) { id } }`;
  const vars = { b: ids.boards.roadmap, i: item.id };
  assert.equal(
    await message(rename, { ...vars, v: longName }),
    "Column name: Item name must be 1-255 characters",
  );
  assert.equal(
    await message(board, { n: "Ok", d: "d".repeat(2001) }),
    "Description must be at most 2000 characters",
  );
  assert.equal(
    store.createTeam({ name: "Ok", description: "d".repeat(2001) }).message,
    "Description must be at most 2000 characters",
  );
  const group = `mutation G($b: ID!, $c: String) { create_group(board_id: $b,
    group_name: "Colors", group_color: $c) { color } }`;
  const roadmap = { b: ids.boards.roadmap };
  assert.equal(
    await users.alex.code(group, { ...roadmap, c: "#12345" }),
    "BAD_USER_INPUT",
  );
  const kept = await users.alex.data(group, { ...roadmap, c: "#A25DDC" });
  assert.equal(kept.create_group.color, "#A25DDC", "part 1 keeps the case");
  const plain = await users.alex.data(group, roadmap);
  assert.equal(plain.create_group.color, "#579bfc", "the store's default");
});

test("workspaces tell whether the caller can open and delete them", async (t) => {
  const { users, ids } = await setup(t);
  const fields = "{ id can_open can_delete can_manage }";
  const chris = await users.chris.data(
    `query B($b: ID!) { boards(ids: [$b]) { workspace ${fields} } }`,
    { b: ids.boards.marketing },
  );
  assert.deepEqual(chris.boards[0].workspace, {
    id: ids.workspaces.main,
    can_open: false,
    can_delete: false,
    can_manage: false,
  });
  const create = `mutation { create_workspace(name: "Design") ${fields} }`;
  const { create_workspace: made } = await users.sam.data(create);
  assert.equal(made.can_delete, true, "an empty workspace");
  // Noa (implicit editor of the open workspace) adds a private board.
  await users.noa.data(CREATE, { k: "private", w: made.id });
  const sam = await users.sam.data(`{ workspaces ${fields} }`);
  const design = sam.workspaces.find((workspace) => workspace.id === made.id);
  assert.deepEqual(design, { ...made, can_delete: false });
  const remove = `mutation D($w: ID!) { delete_workspace(workspace_id: $w) { id } }`;
  const refused = await users.sam.error(remove, { w: made.id });
  assert.match(refused.message, /^Only an empty workspace can be deleted/);
  assert.doesNotMatch(refused.message, /[Mm]ove/, "there is no move API");
});

test("set_team_member_role changes a team role in one step", async (t) => {
  const { users, ids, store } = await setup(t);
  const product = ids.teams.product;
  const promote = `mutation P($t: ID!, $u: [ID!]!) { add_team_members(team_id: $t,
    user_ids: $u, as_owner: true) { id } }`;
  await users.alex.data(promote, { t: product, u: [ids.users.sam] });
  const set = `mutation R($t: ID!, $u: ID!, $r: String!) {
    set_team_member_role(team_id: $t, user_id: $u, role: $r) {
      members { user { id } role } } }`;
  const events = [];
  const stop = store.on((event) => events.push(event.type));
  const demoted = await users.alex.data(set, {
    t: product,
    u: ids.users.sam,
    r: "member",
  });
  stop();
  assert.deepEqual(events, ["team_updated"], "one change, no removal");
  const roleOf = (data, id) =>
    data.set_team_member_role.members.find((m) => m.user.id === id).role;
  assert.equal(roleOf(demoted, ids.users.sam), "member");
  const vars = (u, r) => ({ t: product, u, r });
  const last = await users.alex.error(set, vars(ids.users.alex, "member"));
  assert.equal(last.message, "A team keeps at least one owner");
  const outsider = await users.alex.error(set, vars(ids.users.priya, "owner"));
  assert.equal(outsider.message, "That user is not a member of this team");
  const bad = await users.alex.error(set, vars(ids.users.sam, "boss"));
  assert.equal(bad.extensions.code, "BAD_USER_INPUT");
  const forbidden = await users.noa.code(set, vars(ids.users.sam, "owner"));
  assert.equal(forbidden, "FORBIDDEN");
});
