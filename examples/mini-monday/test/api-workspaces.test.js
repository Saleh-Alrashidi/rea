/**
 * Workspaces and board placement over GraphQL (SPEC-2 §3): the Workspace
 * type, create/update/delete_workspace, create_board with a kind and a
 * workspace, and the redacted Workspace of content reached without
 * workspace access.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startTestServers } from "./helpers.js";

const WORKSPACE = `id name description kind color my_access can_manage
  members { kind id role } boards { name } docs { title }`;

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

test("workspaces show accessible boards and docs and the caller's access", async (t) => {
  const { users, ids } = await setup(t);
  const { workspaces } = await users.sam.data(
    `{ workspaces { ${WORKSPACE} } }`,
  );
  assert.deepEqual(workspaces, [
    {
      id: ids.workspaces.main,
      name: "Main workspace",
      description: "Everyone's shared space",
      kind: "open",
      color: workspaces[0].color,
      my_access: "editor",
      can_manage: false,
      members: [{ kind: "user", id: ids.users.alex, role: "owner" }],
      boards: [{ name: "Product roadmap" }],
      docs: [{ title: "Product vision" }, { title: "Launch brief" }],
    },
  ]);
  const alex = (
    await users.alex.data(`{ workspaces { name can_manage boards { name } } }`)
  ).workspaces;
  assert.deepEqual(alex[1], {
    name: "Leadership",
    can_manage: true,
    boards: [{ name: "Hiring plan" }, { name: "Budget 2027" }],
  });
  // Admins manage every workspace but do not see private content in it.
  assert.deepEqual(alex[0].boards, [{ name: "Product roadmap" }]);
});

test("create_workspace, update_workspace and delete_workspace", async (t) => {
  const { users, ids } = await setup(t);
  const create = `mutation C($n: String!, $k: WorkspaceKind, $d: String) {
    create_workspace(name: $n, kind: $k, description: $d) { ${WORKSPACE} } }`;
  const made = (await users.noa.data(create, { n: " Platform ", d: "Infra" }))
    .create_workspace;
  assert.deepEqual(
    [made.name, made.description, made.kind, made.my_access, made.can_manage],
    ["Platform", "Infra", "open", "owner", true],
  );
  assert.deepEqual(made.members, [
    { kind: "user", id: ids.users.noa, role: "owner" },
  ]);
  assert.match(made.color, /^#[0-9a-f]{6}$/);
  const closed = (await users.noa.data(create, { n: "Secret", k: "closed" }))
    .create_workspace;
  const samSees = (
    await users.sam.data("{ workspaces { id } }")
  ).workspaces.map((w) => w.id);
  assert.ok(samSees.includes(made.id) && !samSees.includes(closed.id));
  for (const n of [" ", "x".repeat(256)]) {
    assert.equal(await users.noa.code(create, { n }), "BAD_USER_INPUT");
  }
  const update = `mutation U($w: ID!, $n: String, $c: String, $k: WorkspaceKind, $d: String) {
    update_workspace(workspace_id: $w, name: $n, color: $c, kind: $k, description: $d) { name color kind description } }`;
  assert.equal(
    await users.sam.code(update, { w: made.id, n: "Mine" }),
    "FORBIDDEN",
  );
  assert.equal(
    await users.sam.code(update, { w: closed.id, n: "Mine" }),
    "NOT_FOUND",
  );
  const changed = await users.noa.data(update, {
    w: made.id,
    c: "#0B8A5F",
    k: "closed",
    d: null,
  });
  assert.deepEqual(changed.update_workspace, {
    name: "Platform",
    color: "#0b8a5f",
    kind: "closed",
    description: null,
  });
  assert.equal(
    await users.noa.code(update, { w: made.id, c: "green" }),
    "BAD_USER_INPUT",
  );
  const board = `mutation B($w: ID) { create_board(board_name: "Infra", workspace_id: $w) { id } }`;
  const { create_board } = await users.noa.data(board, { w: made.id });
  const remove = `mutation D($w: ID!) { delete_workspace(workspace_id: $w) { id } }`;
  const busy = await users.noa.error(remove, { w: made.id });
  assert.equal(busy.extensions.code, "BAD_USER_INPUT");
  assert.match(busy.message, /only an empty workspace/i);
  await users.noa.data(
    `mutation D($b: ID!) { delete_board(board_id: $b) { id } }`,
    { b: create_board.id },
  );
  assert.deepEqual(
    (await users.noa.data(remove, { w: made.id })).delete_workspace,
    { id: made.id },
  );
  assert.equal(await users.noa.code(remove, { w: made.id }), "NOT_FOUND");
});

test("create_board takes a kind and a workspace; the creator owns it", async (t) => {
  const { users, ids } = await setup(t);
  const create = `mutation C($n: String!, $k: BoardKind, $w: ID) {
    create_board(board_name: $n, board_kind: $k, workspace_id: $w) {
      name board_kind my_access workspace { id } members { id role } } }`;
  const plain = (await users.sam.data(create, { n: "Research" })).create_board;
  assert.deepEqual(plain, {
    name: "Research",
    board_kind: "public",
    my_access: "owner",
    workspace: { id: ids.workspaces.main },
    members: [{ id: ids.users.sam, role: "owner" }],
  });
  const privateBoard = (
    await users.sam.data(create, { n: "Private research", k: "private" })
  ).create_board;
  assert.equal(privateBoard.board_kind, "private");
  const visible = async (client) =>
    (await client.data("{ boards(limit: 100) { name } }")).boards.map(
      (b) => b.name,
    );
  assert.ok((await visible(users.noa)).includes("Research"));
  assert.ok(!(await visible(users.noa)).includes("Private research"));
  assert.ok(
    !(await visible(users.alex)).includes("Private research"),
    "not even admins",
  );
  const leadership = await users.alex.data(create, {
    n: "Offsite plan",
    w: ids.workspaces.leadership,
  });
  assert.deepEqual(leadership.create_board.workspace, {
    id: ids.workspaces.leadership,
  });
  assert.equal(
    await users.sam.code(create, { n: "X", w: ids.workspaces.leadership }),
    "NOT_FOUND",
  );
  assert.equal(
    await users.sam.code(create, { n: "X", w: "999999" }),
    "NOT_FOUND",
  );
  const long = `mutation { create_board(board_name: "B", description: "${"d".repeat(2001)}") { id } }`;
  assert.equal(await users.sam.code(long), "BAD_USER_INPUT");
});

test("content reached without workspace access shows a redacted workspace", async (t) => {
  const { users, ids } = await setup(t);
  const query = `query B($b: ID!) { boards(ids: [$b]) { workspace { ${WORKSPACE} } } }`;
  const [board] = (await users.chris.data(query, { b: ids.boards.marketing }))
    .boards;
  assert.deepEqual(board.workspace, {
    id: ids.workspaces.main,
    name: "Main workspace",
    description: null,
    kind: "open",
    color: board.workspace.color,
    my_access: "viewer",
    can_manage: false,
    members: [],
    boards: [{ name: "Marketing launch" }],
    docs: [{ title: "Launch brief" }],
  });
  const noa = (await users.noa.data(query, { b: ids.boards.hiring })).boards[0];
  assert.deepEqual(
    [
      noa.workspace.name,
      noa.workspace.members,
      noa.workspace.boards,
      noa.workspace.docs,
    ],
    ["Leadership", [], [{ name: "Hiring plan" }], []],
  );
});
