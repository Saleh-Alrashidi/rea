/**
 * Sharing flows over HTTP (SPEC-2 §1.2, §3): share/unshare on every
 * resource kind with notifications and shared_with_me, team grants for
 * current and future members, grant rules (roles per kind, guests,
 * deactivated users, hidden subjects), last-owner protection,
 * set_board_kind removing guest grants, and admin_take_ownership.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startTestServers } from "./helpers.js";

const MEMBERS = "{ kind id name role user { id } team { id } }";
const SHARE = `mutation S($k: ResourceKind!, $r: ID!, $sk: SubjectKind!, $s: [ID!]!, $role: AccessRole!) {
  share(resource_kind: $k, resource_id: $r, subject_kind: $sk, subject_ids: $s, role: $role) ${MEMBERS} }`;
const UNSHARE = `mutation U($k: ResourceKind!, $r: ID!, $sk: SubjectKind!, $s: ID!) {
  unshare(resource_kind: $k, resource_id: $r, subject_kind: $sk, subject_id: $s) ${MEMBERS} }`;
const BOARD = `query B($b: ID!) { boards(ids: [$b]) { id my_access board_kind
  members { kind id role } activity_logs(limit: 10) { kind actor { id } from_text to_text } } }`;
const INBOX = "{ notifications { kind text url } unread_notifications_count }";

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
  /** Variables of SHARE for user subjects (spread `sk: "team"` for teams). */
  const shareVars = (k, r, s, role) => ({ k, r, sk: "user", s, role });
  return { ...servers, users, shareVars };
}

test("sharing a board grants access, notifies and lists it in shared_with_me", async (t) => {
  const { users, ids, shareVars } = await setup(t);
  const board = ids.boards.marketing;
  assert.deepEqual((await users.sam.data(BOARD, { b: board })).boards, []);
  const vars = shareVars("board", board, [ids.users.sam], "editor");
  const members = (await users.priya.data(SHARE, vars)).share;
  const sam = members.find((m) => m.kind === "user" && m.id === ids.users.sam);
  assert.deepEqual(sam.role, "editor");
  const [seen] = (await users.sam.data(BOARD, { b: board })).boards;
  assert.equal(seen.my_access, "editor");
  assert.equal(seen.activity_logs[0].kind, "member_added");
  assert.equal(seen.activity_logs[0].to_text, "Sam Lee (editor)");
  const inbox = await users.sam.data(INBOX);
  assert.equal(inbox.notifications[0].kind, "share");
  assert.equal(inbox.notifications[0].url, `#/boards/${board}`);
  assert.match(inbox.notifications[0].text, /Priya Nair shared the board/);
  const shared = await users.sam.data(
    "{ shared_with_me { kind id subtitle } }",
  );
  assert.ok(
    shared.shared_with_me.some(
      (e) => e.id === board && e.subtitle === "Can edit",
    ),
  );
  // Changing the role notifies again; removing it hides the board and its
  // notifications.
  await users.priya.data(SHARE, { ...vars, role: "viewer" });
  assert.equal((await users.sam.data(INBOX)).unread_notifications_count, 4);
  const unshare = { k: "board", r: board, sk: "user", s: ids.users.sam };
  await users.priya.data(UNSHARE, unshare);
  assert.deepEqual((await users.sam.data(BOARD, { b: board })).boards, []);
  const after = await users.sam.data(INBOX);
  assert.ok(after.notifications.every((n) => n.url !== `#/boards/${board}`));
  assert.equal(after.unread_notifications_count, 2, "only the seeded ones");
});

test("team grants cover current and future members, and stop on removal", async (t) => {
  const { users, ids, shareVars } = await setup(t);
  const hiring = ids.boards.hiring;
  const vars = {
    ...shareVars("board", hiring, [ids.teams.product], "viewer"),
    sk: "team",
  };
  const members = (await users.alex.data(SHARE, vars)).share;
  const team = members.find((m) => m.kind === "team");
  assert.deepEqual(team.team, { id: ids.teams.product });
  assert.equal(
    (await users.sam.data(BOARD, { b: hiring })).boards[0].my_access,
    "viewer",
  );
  const write = `mutation W($b: ID!) { create_item(board_id: $b, item_name: "x") { id } }`;
  assert.equal(await users.sam.code(write, { b: hiring }), "FORBIDDEN");
  assert.deepEqual((await users.priya.data(BOARD, { b: hiring })).boards, []);
  const add = `mutation A($t: ID!, $u: [ID!]!) { add_team_members(team_id: $t, user_ids: $u) {
    members { user { id } role } } }`;
  await users.alex.data(add, { t: ids.teams.product, u: [ids.users.priya] });
  assert.equal(
    (await users.priya.data(BOARD, { b: hiring })).boards[0].my_access,
    "viewer",
  );
  // Noa keeps the higher of their user (editor) and team (viewer) grants.
  assert.equal(
    (await users.noa.data(BOARD, { b: hiring })).boards[0].my_access,
    "editor",
  );
  const remove = `mutation R($t: ID!, $u: [ID!]!) { remove_team_members(team_id: $t, user_ids: $u) { id } }`;
  await users.alex.data(remove, { t: ids.teams.product, u: [ids.users.priya] });
  assert.deepEqual((await users.priya.data(BOARD, { b: hiring })).boards, []);
  // Team managers only: Sam is a plain member of Product.
  assert.equal(
    await users.sam.code(add, { t: ids.teams.product, u: [ids.users.jordan] }),
    "FORBIDDEN",
  );
  assert.equal(
    await users.chris.code(add, { t: ids.teams.product, u: [ids.users.chris] }),
    "NOT_FOUND",
  );
  const drop = "mutation D($t: ID!) { delete_team(team_id: $t) { id } }";
  await users.alex.data(drop, { t: ids.teams.product });
  assert.deepEqual((await users.sam.data(BOARD, { b: hiring })).boards, []);
});

test("grant rules: roles per kind, guests, deactivated and hidden subjects", async (t) => {
  const { users, ids, shareVars, store } = await setup(t);
  const bad = async (client, vars, pattern) => {
    const error = await client.error(SHARE, vars);
    assert.equal(
      error?.extensions.code,
      "BAD_USER_INPUT",
      JSON.stringify(vars),
    );
    if (pattern) assert.match(error.message, pattern);
  };
  const { chris, morgan, sam, noa } = ids.users;
  await bad(
    users.alex,
    shareVars("note", ids.notes.ideas, [sam], "owner"),
    /role/,
  );
  await bad(
    users.alex,
    shareVars("workspace", ids.workspaces.main, [sam], "viewer"),
    /role/,
  );
  await bad(
    users.alex,
    shareVars("board", ids.boards.hiring, [chris], "viewer"),
    /Guests/,
  );
  await bad(
    users.alex,
    shareVars("workspace", ids.workspaces.main, [chris], "editor"),
    /Guests/,
  );
  await bad(
    users.alex,
    shareVars("board", ids.boards.roadmap, [morgan], "viewer"),
    /Deactivated/,
  );
  await bad(
    users.alex,
    shareVars("note", ids.notes.ideas, ["999999"], "viewer"),
    /Unknown user/,
  );
  await bad(
    users.alex,
    shareVars("note", ids.notes.ideas, [ids.teams.product], "viewer"),
    /Unknown user/,
  );
  // All or nothing: one bad subject means no grant at all.
  await bad(
    users.alex,
    shareVars("board", ids.boards.hiring, [sam, chris], "viewer"),
  );
  assert.equal(store.getBoard(ids.boards.hiring).members.length, 2);
  // Guests may own shareable content and share notes, but only with people
  // they can see; hidden users look exactly like unknown ones.
  const note = await users.chris.data(
    'mutation { create_note(title: "Agency ideas") { id } }',
  );
  const id = note.create_note.id;
  const hidden = await users.chris.error(
    SHARE,
    shareVars("note", id, [noa], "viewer"),
  );
  const unknown = await users.chris.error(
    SHARE,
    shareVars("note", id, ["999999"], "viewer"),
  );
  assert.equal(
    hidden.message.replace(noa, "?"),
    unknown.message.replace("999999", "?"),
  );
  const ok = await users.chris.data(
    SHARE,
    shareVars("note", id, [ids.users.priya], "editor"),
  );
  assert.deepEqual(
    ok.share.map((m) => [m.id, m.role]),
    [[ids.users.priya, "editor"]],
  );
  // Shareable boards accept guests.
  const brief = shareVars("board", ids.boards.marketing, [chris], "viewer");
  assert.equal(
    (await users.priya.data(SHARE, brief)).share.find((m) => m.id === chris)
      .role,
    "viewer",
  );
});

test("last-owner protection on boards, docs, workspaces and teams", async (t) => {
  const { users, ids, shareVars } = await setup(t);
  const { priya, sam } = ids.users;
  const board = ids.boards.marketing;
  const leave = { k: "board", r: board, sk: "user", s: priya };
  const demote = shareVars("board", board, [priya], "editor");
  for (const [query, vars] of [
    [UNSHARE, leave],
    [SHARE, demote],
  ]) {
    const error = await users.priya.error(query, vars);
    assert.equal(error.extensions.code, "BAD_USER_INPUT");
    assert.match(error.message, /at least one owner/);
  }
  await users.priya.data(SHARE, shareVars("board", board, [sam], "owner"));
  const left = (await users.priya.data(UNSHARE, leave)).unshare;
  assert.deepEqual(left.map((m) => m.id).sort(), [ids.users.chris, sam].sort());
  assert.deepEqual((await users.priya.data(BOARD, { b: board })).boards, []);
  const doc = { k: "doc", r: ids.docs.vision, sk: "user", s: ids.users.alex };
  assert.equal(await users.alex.code(UNSHARE, doc), "BAD_USER_INPUT");
  const space = {
    k: "workspace",
    r: ids.workspaces.main,
    sk: "user",
    s: ids.users.alex,
  };
  assert.equal(await users.alex.code(UNSHARE, space), "BAD_USER_INPUT");
  const team = `mutation R($t: ID!, $u: [ID!]!) { remove_team_members(team_id: $t, user_ids: $u) { id } }`;
  const error = await users.priya.error(team, {
    t: ids.teams.marketing,
    u: [priya],
  });
  assert.equal(error.extensions.code, "BAD_USER_INPUT");
});

test("set_board_kind: owners only; leaving shareable removes guest grants", async (t) => {
  const { users, ids, store } = await setup(t);
  const board = ids.boards.marketing;
  const kind = `mutation K($b: ID!, $k: BoardKind!) { set_board_kind(board_id: $b, board_kind: $k) {
    board_kind members { id } } }`;
  assert.equal(
    await users.chris.code(kind, { b: board, k: "private" }),
    "FORBIDDEN",
  );
  assert.equal(
    await users.sam.code(kind, { b: board, k: "private" }),
    "NOT_FOUND",
  );
  const done = (await users.priya.data(kind, { b: board, k: "private" }))
    .set_board_kind;
  assert.equal(done.board_kind, "private");
  assert.deepEqual(done.members, [{ id: ids.users.priya }]);
  assert.deepEqual((await users.chris.data(BOARD, { b: board })).boards, []);
  const [seen] = (await users.priya.data(BOARD, { b: board })).boards;
  const kinds = seen.activity_logs.map((entry) => entry.kind);
  assert.deepEqual(kinds.slice(0, 2), ["member_removed", "board_kind_changed"]);
  assert.equal(seen.activity_logs[1].to_text, "Private");
  // Back to shareable: the guest grant is not restored.
  await users.priya.data(kind, { b: board, k: "share" });
  assert.deepEqual((await users.chris.data(BOARD, { b: board })).boards, []);
  // Main (public) boards open to the workspace: Sam gets implicit editor.
  await users.priya.data(kind, { b: board, k: "public" });
  assert.equal(
    (await users.sam.data(BOARD, { b: board })).boards[0].my_access,
    "editor",
  );
  assert.equal(
    (await users.jordan.data(BOARD, { b: board })).boards[0].my_access,
    "viewer",
  );
  // A guest who is the only owner blocks leaving shareable.
  const lone = store.createBoard({
    name: "Agency",
    creatorId: ids.users.priya,
    boardKind: "share",
  });
  store.share({
    resourceKind: "board",
    resourceId: lone.id,
    subjectKind: "user",
    subjectIds: [ids.users.chris],
    role: "owner",
  });
  store.unshare({
    resourceKind: "board",
    resourceId: lone.id,
    subjectKind: "user",
    subjectId: ids.users.priya,
  });
  const blocked = await users.chris.error(kind, { b: lone.id, k: "private" });
  assert.equal(blocked.extensions.code, "BAD_USER_INPUT");
});

test("admin_take_ownership: admins only, boards and docs only, logged", async (t) => {
  const { users, ids } = await setup(t);
  const take = `mutation T($k: ResourceKind!, $r: ID!) { admin_take_ownership(resource_kind: $k, resource_id: $r) {
    id role } }`;
  const board = ids.boards.marketing;
  for (const key of ["sam", "priya", "jordan", "chris"]) {
    assert.equal(
      await users[key].code(take, { k: "board", r: board }),
      "FORBIDDEN",
      key,
    );
  }
  for (const [k, r] of [
    ["note", ids.notes.crit],
    ["note", "999999"],
    ["workspace", ids.workspaces.main],
  ]) {
    const error = await users.alex.error(take, { k, r });
    assert.equal(error.extensions.code, "BAD_USER_INPUT");
    assert.equal(error.message, "Only boards and docs can be taken over");
  }
  assert.equal(
    await users.alex.code(take, { k: "board", r: "999999" }),
    "NOT_FOUND",
  );
  assert.deepEqual((await users.alex.data(BOARD, { b: board })).boards, []);
  const members = (await users.alex.data(take, { k: "board", r: board }))
    .admin_take_ownership;
  assert.ok(members.some((m) => m.id === ids.users.alex && m.role === "owner"));
  const [seen] = (await users.alex.data(BOARD, { b: board })).boards;
  assert.equal(seen.my_access, "owner");
  assert.equal(seen.activity_logs[0].kind, "ownership_taken");
  assert.equal(seen.activity_logs[0].actor.id, ids.users.alex);
  // Priya sees the override in the log.
  const [hers] = (await users.priya.data(BOARD, { b: board })).boards;
  assert.equal(hers.activity_logs[0].kind, "ownership_taken");
  const docs = `query D($d: [ID!]) { docs(ids: $d) { my_access members { id role } } }`;
  assert.deepEqual(
    (await users.alex.data(docs, { d: [ids.docs.brief] })).docs,
    [],
  );
  await users.alex.data(take, { k: "doc", r: ids.docs.brief });
  const [doc] = (await users.alex.data(docs, { d: [ids.docs.brief] })).docs;
  assert.equal(doc.my_access, "owner");
});

test("a doc takeover reaches its owners and outlives the admin leaving", async (t) => {
  const { users, ids } = await setup(t);
  const doc = ids.docs.brief;
  const take = `mutation T($r: ID!) { admin_take_ownership(resource_kind: doc,
    resource_id: $r) { id } }`;
  const before = Object.fromEntries(
    await Promise.all(
      ["priya", "sam", "chris"].map(async (key) => [
        key,
        (await users[key].data(INBOX)).unread_notifications_count,
      ]),
    ),
  );
  await users.alex.data(take, { r: doc });
  const vars = { k: "doc", r: doc, sk: "user", s: ids.users.alex };
  await users.alex.data(UNSHARE, vars);
  const inbox = await users.priya.data(INBOX);
  assert.equal(inbox.unread_notifications_count, before.priya + 1);
  assert.deepEqual(inbox.notifications[0], {
    kind: "share",
    text: "Alex Rivera (admin) took ownership of the doc “Launch brief”",
    url: `#/docs/${doc}`,
  });
  // Editors and viewers (the Marketing team, Chris) are not owners.
  for (const key of ["sam", "chris"]) {
    const count = (await users[key].data(INBOX)).unread_notifications_count;
    assert.equal(count, before[key], key);
  }
});

test("workspace members: owners manage them; closed workspaces open to members", async (t) => {
  const { users, ids, shareVars } = await setup(t);
  const space = ids.workspaces.leadership;
  const list = "{ workspaces { id my_access members { id role } } }";
  const has = async (client) =>
    (await client.data(list)).workspaces.find((w) => w.id === space) ?? null;
  assert.equal(await has(users.priya), null);
  const vars = shareVars("workspace", space, [ids.users.priya], "editor");
  assert.equal(await users.priya.code(SHARE, vars), "NOT_FOUND");
  await users.alex.data(SHARE, vars);
  assert.equal((await has(users.priya)).my_access, "editor");
  // Workspace access opens public boards and workspace docs, not private ones.
  const boards = "{ boards(limit: 100) { id my_access } docs { id } }";
  const seen = await users.priya.data(boards);
  assert.ok(
    seen.boards.some(
      (b) => b.id === ids.boards.budget && b.my_access === "editor",
    ),
  );
  assert.ok(seen.boards.every((b) => b.id !== ids.boards.hiring));
  assert.ok(seen.docs.some((d) => d.id === ids.docs.offsite));
  assert.equal(
    await users.priya.code(SHARE, { ...vars, s: [ids.users.sam] }),
    "FORBIDDEN",
  );
  const update = `mutation U($w: ID!) { update_workspace(workspace_id: $w, kind: open) { kind } }`;
  assert.equal(await users.priya.code(update, { w: space }), "FORBIDDEN");
  assert.equal(
    (await users.alex.data(update, { w: space })).update_workspace.kind,
    "open",
  );
  assert.equal((await has(users.jordan)).my_access, "viewer");
  assert.equal(
    await has(users.chris),
    null,
    "guests never get workspace access",
  );
});
