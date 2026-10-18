/**
 * Server verdicts (SPEC-2 §6) for every seeded role and resource kind:
 * `User.capabilities` on `me`, `Board.assignable_users`, the Member
 * verdicts (`can_remove`, `can_change_role`, `role_options`) and
 * `share_candidates`, all computed by `server/access.js`. People-column
 * writes and team management (capRole) are in verdicts-writes.test.js,
 * guest redaction in api-redaction.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SEED_USERS,
  expectedCode,
  seedKeys,
  seedRole,
  startTestServers,
} from "./helpers.js";

const USERS = SEED_USERS.filter((user) => user !== "morgan");
const ALL = ["owner", "editor", "viewer"];
const NONE = { can_remove: false, can_change_role: false, role_options: [] };
const GUESTS_REFUSED = "Guests can only join shareable boards, docs and notes";
const DEACTIVATED = "Deactivated users cannot be given access";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const clients = Object.fromEntries(
    USERS.map((user) => [user, servers.as(servers.ids.users[user])]),
  );
  const keyOf = (id) =>
    Object.entries(servers.ids.users).find(([, value]) => value === id)[0];
  return { ...servers, clients, keyOf };
}

const CAPABILITIES = {
  admin: [
    "manage_users",
    "admin_directory",
    "create_workspace",
    "create_team",
    "create_content",
    "create_note",
  ],
  member: ["create_workspace", "create_team", "create_content", "create_note"],
  viewer: ["create_note"],
  guest: ["create_note"],
};
const ACCOUNT = {
  alex: "admin",
  sam: "member",
  noa: "member",
  priya: "member",
  jordan: "viewer",
  chris: "guest",
};

test("User.capabilities lists the caller's account capabilities on me only", async (t) => {
  const { clients, ids } = await setup(t);
  for (const user of USERS) {
    const data = await clients[user].data(
      "{ me { id capabilities } users(limit: 100) { id capabilities } }",
    );
    assert.deepEqual(data.me.capabilities, CAPABILITIES[ACCOUNT[user]], user);
    for (const other of data.users) {
      const expected = other.id === ids.users[user] ? data.me.capabilities : [];
      assert.deepEqual(
        other.capabilities,
        expected,
        `${user} sees ${other.id}`,
      );
    }
  }
});

test("Board.assignable_users: active users who can open the board, within the caller's directory", async (t) => {
  const { clients, ids, keyOf } = await setup(t);
  const directory = {
    chris: ["sam", "priya", "chris"],
  };
  for (const user of USERS) {
    const data = await clients[user].data(
      "{ boards(limit: 100) { id assignable_users { id } } }",
    );
    for (const board of data.boards) {
      const key = seedKeys("board").find((k) => ids.boards[k] === board.id);
      const expected = USERS.filter(
        (person) => seedRole("board", key, person) !== null,
      ).filter((person) => directory[user]?.includes(person) ?? true);
      const got = board.assignable_users.map((entry) => keyOf(entry.id));
      assert.deepEqual(got, expected, `${user} on ${key}`);
    }
  }
});

const MEMBERS = `query M($b: [ID!], $d: [ID!]) {
  workspaces { id members { kind id role can_remove can_change_role role_options } }
  boards(ids: $b, limit: 100) { id members { kind id role can_remove can_change_role role_options } }
  docs(ids: $d) { id members { kind id role can_remove can_change_role role_options } }
  notes { id shares { kind id role can_remove can_change_role role_options } } }`;

/** `{ "<kind>:<resourceId>/<subjectKind>:<subjectId>": verdicts }`. */
function verdictMap(data) {
  const map = {};
  const add = (kind, records, field) => {
    for (const record of records) {
      for (const member of record[field]) {
        const { can_remove, can_change_role, role_options } = member;
        const key = `${kind}:${record.id}/${member.kind}:${member.id}`;
        map[key] = { can_remove, can_change_role, role_options };
      }
    }
  };
  add("workspace", data.workspaces, "members");
  add("board", data.boards, "members");
  add("doc", data.docs, "members");
  add("note", data.notes, "shares");
  return map;
}

test("Member verdicts: owners may change grants that keep an effective owner; others may change none", async (t) => {
  const { clients, ids } = await setup(t);
  const { users, teams, workspaces, boards, docs, notes } = ids;
  const last = { can_remove: false, can_change_role: false };
  const free = (roles) => ({
    can_remove: true,
    can_change_role: true,
    role_options: roles,
  });
  // Verdicts the owners of each seeded resource see (SPEC-2 §2.1 grants).
  const owned = {
    [`workspace:${workspaces.main}/user:${users.alex}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`workspace:${workspaces.leadership}/team:${teams.leadership}`]: free([
      "owner",
      "editor",
    ]),
    [`workspace:${workspaces.leadership}/user:${users.alex}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`board:${boards.roadmap}/user:${users.alex}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`board:${boards.marketing}/user:${users.priya}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`board:${boards.marketing}/user:${users.chris}`]: free(ALL),
    [`board:${boards.hiring}/user:${users.alex}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`board:${boards.hiring}/user:${users.noa}`]: free(ALL),
    [`board:${boards.budget}/user:${users.alex}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`doc:${docs.vision}/user:${users.alex}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`doc:${docs.brief}/user:${users.priya}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`doc:${docs.brief}/user:${users.chris}`]: free(ALL),
    [`doc:${docs.brief}/team:${teams.marketing}`]: free(ALL),
    [`doc:${docs.offsite}/user:${users.alex}`]: {
      ...last,
      role_options: ["owner"],
    },
    [`note:${notes.oneOnOne}/user:${users.sam}`]: free(["editor", "viewer"]),
    [`note:${notes.checklist}/team:${teams.marketing}`]: free([
      "editor",
      "viewer",
    ]),
  };
  const resourceKey = (key) => key.split("/")[0];
  const ownerOf = {
    [`workspace:${workspaces.main}`]: "alex",
    [`workspace:${workspaces.leadership}`]: "alex",
    [`board:${boards.roadmap}`]: "alex",
    [`board:${boards.marketing}`]: "priya",
    [`board:${boards.hiring}`]: "alex",
    [`board:${boards.budget}`]: "alex",
    [`doc:${docs.vision}`]: "alex",
    [`doc:${docs.brief}`]: "priya",
    [`doc:${docs.offsite}`]: "alex",
    [`note:${notes.oneOnOne}`]: "alex",
    [`note:${notes.checklist}`]: "priya",
  };
  const variables = { b: Object.values(boards), d: Object.values(docs) };
  for (const user of USERS) {
    const seen = verdictMap(await clients[user].data(MEMBERS, variables));
    assert.ok(Object.keys(seen).length > 0, user);
    for (const [key, verdicts] of Object.entries(seen)) {
      const mine = ownerOf[resourceKey(key)] === user;
      assert.deepEqual(verdicts, mine ? owned[key] : NONE, `${user} ${key}`);
    }
  }
});

test("Member verdicts count effective owners: viewer accounts and deactivated members", async (t) => {
  const { clients, ids, store } = await setup(t);
  const { users, boards } = ids;
  const share = `mutation S($b: ID!, $u: ID!, $r: AccessRole!) { share(resource_kind: board,
    resource_id: $b, subject_kind: user, subject_ids: [$u], role: $r) {
    id role can_remove can_change_role role_options } }`;
  // Jordan (a viewer account) as an owner is capped at viewer: Alex stays
  // the only effective owner, and Jordan manages nothing.
  const after = await clients.alex.data(share, {
    b: boards.roadmap,
    u: users.jordan,
    r: "owner",
  });
  const byId = Object.fromEntries(after.share.map((m) => [m.id, m]));
  assert.deepEqual(byId[users.alex], {
    id: users.alex,
    role: "owner",
    can_remove: false,
    can_change_role: false,
    role_options: ["owner"],
  });
  assert.deepEqual(byId[users.jordan], {
    id: users.jordan,
    role: "owner",
    can_remove: true,
    can_change_role: true,
    role_options: ALL,
  });
  const jordan = await clients.jordan.data(
    `query B($b: [ID!]) { boards(ids: $b) { my_access members { id can_remove role_options } } }`,
    { b: [boards.roadmap] },
  );
  assert.equal(jordan.boards[0].my_access, "viewer");
  assert.ok(
    jordan.boards[0].members.every(
      (m) => m.can_remove === false && m.role_options.length === 0,
    ),
  );
  // A deactivated member can be removed but given no role.
  store.activateUser(users.morgan);
  await clients.alex.data(share, {
    b: boards.hiring,
    u: users.morgan,
    r: "editor",
  });
  store.deactivateUser(users.morgan);
  const hiring = await clients.alex.data(
    `query B($b: [ID!]) { boards(ids: $b) { members { id can_remove can_change_role role_options } } }`,
    { b: [boards.hiring] },
  );
  const morgan = hiring.boards[0].members.find((m) => m.id === users.morgan);
  assert.deepEqual(morgan, {
    id: users.morgan,
    can_remove: true,
    can_change_role: false,
    role_options: [],
  });
});

const CANDIDATES = `query C($k: ResourceKind!, $r: ID!, $q: String, $l: Int) {
  share_candidates(resource_kind: $k, resource_id: $r, query: $q, limit: $l) {
    kind id name subtitle eligible reason role_options } }`;

test("share_candidates needs owner access: NOT_FOUND without access, FORBIDDEN below owner", async (t) => {
  const { clients, ids } = await setup(t);
  const groups = {
    workspace: "workspaces",
    board: "boards",
    doc: "docs",
    note: "notes",
  };
  for (const user of USERS) {
    for (const [kind, group] of Object.entries(groups)) {
      for (const key of seedKeys(kind)) {
        const variables = { k: kind, r: ids[group][key] };
        const code = await clients[user].code(CANDIDATES, variables);
        const want = expectedCode(seedRole(kind, key, user), "owner");
        assert.equal(code, want, `${user} ${kind} ${key}`);
      }
    }
    const missing = { k: "board", r: "999999" };
    assert.equal(await clients[user].code(CANDIDATES, missing), "NOT_FOUND");
  }
});

test("share_candidates lists the directory minus members, with canGrant verdicts", async (t) => {
  const { clients, ids } = await setup(t);
  const { users, teams, boards, workspaces, notes } = ids;
  const list = async (client, variables) =>
    (await client.data(CANDIDATES, variables)).share_candidates;
  const roadmap = await list(clients.alex, { k: "board", r: boards.roadmap });
  assert.deepEqual(
    roadmap.map((c) => `${c.kind}:${c.name}`),
    [
      "user:Jordan Blake",
      "user:Noa Cohen",
      "user:Priya Nair",
      "user:Sam Lee",
      "team:Leadership",
      "team:Marketing",
      "team:Product",
      "user:Chris Taylor",
      "user:Morgan Diaz",
    ],
    "eligible first, users then teams by name; Alex (a member) is left out",
  );
  const byName = Object.fromEntries(roadmap.map((c) => [c.name, c]));
  assert.deepEqual(byName["Chris Taylor"], {
    kind: "user",
    id: users.chris,
    name: "Chris Taylor",
    subtitle: "chris@agency.test",
    eligible: false,
    reason: GUESTS_REFUSED,
    role_options: [],
  });
  assert.equal(byName["Morgan Diaz"].reason, DEACTIVATED);
  assert.deepEqual(byName["Jordan Blake"].role_options, ALL);
  assert.deepEqual(byName.Marketing, {
    kind: "team",
    id: teams.marketing,
    name: "Marketing",
    subtitle: "2 members",
    eligible: true,
    reason: null,
    role_options: ALL,
  });
  // Shareable boards admit guests; current members are never offered.
  const marketing = await list(clients.priya, {
    k: "board",
    r: boards.marketing,
  });
  assert.ok(!marketing.some((c) => [users.priya, users.chris].includes(c.id)));
  // Notes take viewer/editor and leave out their owner; workspaces take
  // owner/editor and no guests.
  const note = await list(clients.alex, { k: "note", r: notes.oneOnOne });
  assert.ok(
    !note.some(
      (c) => c.kind === "user" && [users.alex, users.sam].includes(c.id),
    ),
  );
  const chris = note.find((c) => c.id === users.chris);
  assert.deepEqual(
    [chris.eligible, chris.role_options],
    [true, ["editor", "viewer"]],
  );
  const space = await list(clients.alex, {
    k: "workspace",
    r: workspaces.main,
  });
  const spaceChris = space.find((c) => c.id === users.chris);
  assert.deepEqual(
    [spaceChris.eligible, spaceChris.reason],
    [false, GUESTS_REFUSED],
  );
  const noa = space.find((c) => c.id === users.noa);
  assert.deepEqual(noa.role_options, ["owner", "editor"]);
});

test("share_candidates filters by name or email and bounds limit and query", async (t) => {
  const { clients, ids } = await setup(t);
  const variables = { k: "board", r: ids.boards.roadmap };
  const names = async (query, limit) =>
    (
      await clients.alex.data(CANDIDATES, { ...variables, q: query, l: limit })
    ).share_candidates.map((c) => c.name);
  assert.deepEqual(await names("PRI"), ["Priya Nair"]);
  assert.deepEqual(await names("agency.test"), ["Chris Taylor"]);
  assert.deepEqual(await names("  market "), ["Marketing"]);
  // People who can't be added never take the first places.
  assert.deepEqual(await names("", 2), ["Jordan Blake", "Noa Cohen"]);
  assert.deepEqual(await names("", 9).then((list) => list.slice(-2)), [
    "Chris Taylor",
    "Morgan Diaz",
  ]);
  assert.deepEqual(await names("zzz"), []);
  for (const limit of [0, 51]) {
    const code = await clients.alex.code(CANDIDATES, {
      ...variables,
      l: limit,
    });
    assert.equal(code, "BAD_USER_INPUT", `limit ${limit}`);
  }
  const long = { ...variables, q: "x".repeat(256) };
  assert.equal(await clients.alex.code(CANDIDATES, long), "BAD_USER_INPUT");
});

test("share_candidates only ever offers the caller's directory (guest and viewer owners)", async (t) => {
  const { clients, ids } = await setup(t);
  const create = `mutation { create_note(title: "Mine") { id } }`;
  const chrisNote = (await clients.chris.data(create)).create_note.id;
  const offered = (
    await clients.chris.data(CANDIDATES, { k: "note", r: chrisNote })
  ).share_candidates;
  assert.deepEqual(
    offered.map((c) => [c.kind, c.id, c.eligible]),
    [
      ["user", ids.users.priya, true],
      ["user", ids.users.sam, true],
    ],
    "a guest sees only the people they share with, and no teams",
  );
  const jordanNote = (await clients.jordan.data(create)).create_note.id;
  const all = (
    await clients.jordan.data(CANDIDATES, { k: "note", r: jordanNote })
  ).share_candidates;
  assert.equal(all.length, 9, "six other users and three teams");
  assert.ok(!all.some((c) => c.id === ids.users.jordan && c.kind === "user"));
});
