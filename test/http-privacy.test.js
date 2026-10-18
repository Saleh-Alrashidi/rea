/**
 * Adversarial privacy suite, part 3 (SPEC-2 §1.2, §4): the app platform
 * per seeded user. App principals (`X-App-Install`) and session tokens
 * exist only for installs on boards the user can access, act as that
 * user limited by the app's scopes, and stop as soon as access is lost;
 * public form definitions follow each form's access mode per user.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SEED_USERS,
  apiClient,
  seedRole,
  startTestServers,
} from "./helpers.js";

const USERS = SEED_USERS.filter((user) => user !== "morgan");
const STORAGE = `query S($i: ID!) {
  app_storage(install_id: $i, segment: instance, key: "note") { value } }`;
const SET_STORAGE = `mutation W($i: ID!) { set_app_storage(install_id: $i,
  segment: instance, key: "note", value: "hi") { success } }`;
const WRITES = [
  SET_STORAGE,
  `mutation W($i: ID!) { set_app_storage(install_id: $i, segment: global,
    key: "shared", value: "x") { success } }`,
  `mutation D($i: ID!) { delete_app_storage(install_id: $i, segment: global,
    key: "shared") { success } }`,
  `mutation D($i: ID!) { delete_app_storage(install_id: $i,
    segment: instance, key: "note") { success } }`,
];
const READ_ONLY = ["viewer"];

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { store, ids, hostUrl } = servers;
  const [install] = store.listInstalls({ boardId: ids.boards.roadmap });
  const app = (userId) =>
    apiClient(hostUrl, {
      headers: { ...servers.sessionFor(userId), "X-App-Install": install.id },
    });
  const sessionToken = (userId) =>
    fetch(new URL("/apps/session-token", hostUrl), {
      method: "POST",
      headers: {
        ...servers.sessionFor(userId),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ install_id: install.id }),
    });
  return { ...servers, install, app, sessionToken };
}

test("app principals and session tokens exist only where the user sees the board", async (t) => {
  const { ids, app, sessionToken, install } = await setup(t);
  for (const user of USERS) {
    const canSee = seedRole("board", "roadmap", user) !== null;
    const client = app(ids.users[user]);
    const { status, body } = await client.call("{ me { id } }");
    assert.equal(status, canSee ? 200 : 403, user);
    if (canSee) assert.equal(body.data.me.id, ids.users[user]);
    else assert.equal(body.errors[0].extensions.code, "FORBIDDEN");
    const token = await sessionToken(ids.users[user]);
    await token.body?.cancel();
    assert.equal(token.status, canSee ? 200 : 404, `${user} session token`);
    if (!canSee) continue;
    const role = seedRole("board", "roadmap", user);
    if (READ_ONLY.includes(role)) continue;
    const stored = await client.data(SET_STORAGE, { i: install.id });
    assert.deepEqual(stored, { set_app_storage: { success: true } });
  }
});

test("app storage writes need editor access to the install's board", async (t) => {
  const { ids, app, as, store, install } = await setup(t);
  const scope = `install:${install.id}`;
  await app(ids.users.sam).data(SET_STORAGE, { i: install.id });
  const global = `app:${install.app_id}`;
  store.setAppStorage(global, "shared", "kept");
  const refused = async (userId, label) => {
    const client = app(userId);
    for (const write of WRITES) {
      const error = await client.error(write, { i: install.id });
      assert.deepEqual(
        [error?.extensions.code, error?.message],
        ["FORBIDDEN", "This needs editor access to the board"],
        label,
      );
    }
    const read = await client.data(STORAGE, { i: install.id });
    assert.deepEqual(read.app_storage, { value: "hi" }, `${label} reads`);
  };
  // A viewer account, then a member holding an explicit viewer grant.
  await refused(ids.users.jordan, "jordan");
  const share = `mutation S($b: ID!, $u: ID!) { share(resource_kind: board,
    resource_id: $b, subject_kind: user, subject_ids: [$u], role: viewer) { id } }`;
  await as(ids.users.alex).data(share, {
    b: ids.boards.roadmap,
    u: ids.users.noa,
  });
  await refused(ids.users.noa, "noa (viewer grant)");
  assert.equal(store.getAppStorage(scope, "note").version, 1);
  assert.equal(store.getAppStorage(global, "shared").value, "kept");
  // Editors keep writing.
  const sam = app(ids.users.sam);
  for (const write of WRITES) {
    const data = await sam.data(write, { i: install.id });
    assert.equal(Object.values(data)[0].success, true);
  }
});

test("an app acts as its user, limited by the app's scopes", async (t) => {
  const { ids, app, store, install } = await setup(t);
  const asAlex = app(ids.users.alex);
  const { boards } = await asAlex.data("{ boards(limit: 100) { name } }");
  assert.deepEqual(
    boards.map((board) => board.name),
    ["Product roadmap", "Hiring plan", "Budget 2027"],
    "the user's boards, nothing more",
  );
  const before = store.countItems(ids.boards.roadmap);
  const write = `mutation W($b: ID!) { create_item(board_id: $b, item_name: "x") { id } }`;
  const error = await asAlex.error(write, { b: ids.boards.roadmap });
  assert.deepEqual(
    [error.extensions.code, error.message],
    ["FORBIDDEN", "Missing scope boards:write"],
  );
  assert.equal(store.countItems(ids.boards.roadmap), before);
  // Storage is the install's own; the same user's session cannot reach it.
  const session = apiClient(asAlex.headers.Origin, {
    headers: { Cookie: asAlex.headers.Cookie, Origin: asAlex.headers.Origin },
  });
  assert.equal(await session.code(STORAGE, { i: install.id }), "FORBIDDEN");
  const notes = await asAlex.data("{ notes { title } }");
  assert.deepEqual(notes.notes.map((note) => note.title).sort(), [
    "1:1 with Sam",
    "Ideas for Q1",
  ]);
});

test("losing board access revokes the app principal and its session tokens", async (t) => {
  const { ids, app, sessionToken, as, install } = await setup(t);
  const jordan = app(ids.users.jordan);
  assert.equal((await jordan.call("{ me { id } }")).status, 200);
  const kind = `mutation K($b: ID!) { set_board_kind(board_id: $b, board_kind: private) { id } }`;
  await as(ids.users.alex).data(kind, { b: ids.boards.roadmap });
  assert.equal((await jordan.call("{ me { id } }")).status, 403);
  assert.equal(await jordan.code(STORAGE, { i: install.id }), "FORBIDDEN");
  const token = await sessionToken(ids.users.jordan);
  await token.body?.cancel();
  assert.equal(token.status, 404, "same as an unknown install");
  // The owner keeps the app.
  assert.equal((await app(ids.users.alex).call("{ me { id } }")).status, 200);
});

test("form definitions follow the access mode for every user", async (t) => {
  const { ids, store, sessionFor, hostUrl } = await setup(t);
  const definition = async (key, headers = {}) => {
    const { token } = store.getForm(ids.forms[key]);
    const response = await fetch(new URL(`/f/${token}/definition`, hostUrl), {
      headers,
    });
    await response.body?.cancel();
    return response.status;
  };
  for (const user of USERS) {
    const session = sessionFor(ids.users[user]);
    assert.equal(await definition("feature", session), 200, `${user} public`);
    const account = user === "chris" ? 401 : 200;
    assert.equal(await definition("campaign", session), account, user);
  }
  assert.equal(await definition("feature"), 200);
  assert.equal(await definition("campaign"), 401);
});
