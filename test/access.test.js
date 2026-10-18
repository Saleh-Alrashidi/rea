import assert from "node:assert/strict";
import test from "node:test";
import {
  ROLE_RANK,
  accessOutcome,
  boardAccess,
  can,
  canManageTeam,
  capRole,
  docAccess,
  formAccess,
  hasRole,
  maxRole,
  noteAccess,
  resourceAccess,
  subjectGrants,
  teamRole,
  workspaceAccess,
} from "../server/access.js";

// server/access.js (SPEC-2 §1.2): exhaustive matrices over a store-like
// fake (so states the store would refuse, such as guest grants on private
// boards, can be checked too), then the same rules on the real seed.

const ROLES = ["admin", "member", "viewer", "guest"];
const STATUSES = ["active", "deactivated"];
const USERS = ROLES.flatMap((role) =>
  STATUSES.map((status) => ({ id: `${role}-${status}`, role, status })),
);
// Team "all" holds every test user; team "none" holds nobody.
const TEAMS = [
  {
    id: "all",
    members: USERS.map((u) => ({ user_id: u.id, role: "member" })),
  },
  { id: "none", members: [] },
];
// Grant variants: [label, (userId) => grants]
const RESOURCE_GRANTS = [
  ["none", () => []],
  ...["viewer", "editor", "owner"].flatMap((role) => [
    [`user ${role}`, (id) => [{ kind: "user", id, role }]],
    [`team ${role}`, () => [{ kind: "team", id: "all", role }]],
  ]),
  ["other team owner", () => [{ kind: "team", id: "none", role: "owner" }]],
];
const WORKSPACE_GRANTS = [
  ["none", () => []],
  ["user owner", (id) => [{ kind: "user", id, role: "owner" }]],
  ["user editor", (id) => [{ kind: "user", id, role: "editor" }]],
  ["team editor", () => [{ kind: "team", id: "all", role: "editor" }]],
];

function fakeStore(records = {}) {
  const find =
    (list = []) =>
    (id) =>
      list.find((record) => record.id === id) ?? null;
  return {
    getUser: find(records.users ?? USERS),
    getTeam: find(records.teams ?? TEAMS),
    getWorkspace: find(records.workspaces),
    getBoard: find(records.boards),
    getDoc: find(records.docs),
    getNote: find(records.notes),
    getForm: find(records.forms),
    getItem: find(records.items),
  };
}

/** The role a grant list gives `user` (team "all" contains everyone). */
const granted = (grants, user) => {
  const roles = grants
    .filter((g) => (g.kind === "user" ? g.id === user.id : g.id === "all"))
    .map((g) => g.role);
  return roles.sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] ?? null;
};
const capped = (role, user) =>
  role !== null && user.role === "viewer" ? "viewer" : role;

// Expected access, written from the spec text (not from access.js).
function expectedWorkspace(user, workspace) {
  if (user.status !== "active" || user.role === "guest") return null;
  if (user.role === "admin") return "owner";
  const explicit = granted(workspace.members, user);
  const implicit = workspace.kind === "open" ? "editor" : null;
  return capped(explicit ?? implicit, user);
}

function expectedBoard(user, board, workspace) {
  if (user.status !== "active") return null;
  const explicit = granted(board.members, user);
  if (user.role === "guest")
    return board.board_kind === "share" ? explicit : null;
  const reachable = expectedWorkspace(user, workspace) !== null;
  if (board.board_kind === "public" && reachable) {
    return user.role === "admin" ? "owner" : capped(explicit ?? "editor", user);
  }
  return capped(explicit, user);
}

function expectedDoc(user, doc, workspace) {
  if (user.status !== "active") return null;
  const explicit = granted(doc.members, user);
  if (explicit !== null) return capped(explicit, user);
  const implicit =
    doc.visibility === "workspace" &&
    user.role !== "guest" &&
    expectedWorkspace(user, workspace) !== null;
  return implicit ? capped("editor", user) : null;
}

function* workspaceCases() {
  for (const user of USERS) {
    for (const kind of ["open", "closed"]) {
      for (const [label, grants] of WORKSPACE_GRANTS) {
        const workspace = { id: "w", kind, members: grants(user.id) };
        yield { user, workspace, label: `${user.id} ${kind} ws (${label})` };
      }
    }
  }
}

test("workspace access: every role, status, kind and grant", () => {
  let count = 0;
  for (const { user, workspace, label } of workspaceCases()) {
    const store = fakeStore({ workspaces: [workspace] });
    const actual = workspaceAccess(store, user, workspace);
    assert.equal(actual, expectedWorkspace(user, workspace), label);
    count += 1;
  }
  assert.equal(count, 8 * 2 * 4);
});

test("board access: role x board kind x workspace kind x grant x team grant", () => {
  let count = 0;
  for (const { user, workspace, label } of workspaceCases()) {
    for (const board_kind of ["public", "private", "share"]) {
      for (const [grantLabel, grants] of RESOURCE_GRANTS) {
        const board = {
          id: "b",
          workspace_id: "w",
          board_kind,
          members: grants(user.id),
        };
        const form = { id: "f", board_id: "b" };
        const store = fakeStore({
          workspaces: [workspace],
          boards: [board],
          forms: [form],
        });
        const want = expectedBoard(user, board, workspace);
        const where = `${label}, ${board_kind} board (${grantLabel})`;
        assert.equal(boardAccess(store, user, board), want, where);
        assert.equal(formAccess(store, user, form), want, `form on ${where}`);
        count += 1;
      }
    }
  }
  assert.equal(count, 64 * 3 * 8);
});

test("doc access: role x visibility x workspace kind x grant x team grant", () => {
  let count = 0;
  for (const { user, workspace, label } of workspaceCases()) {
    for (const visibility of ["workspace", "private"]) {
      for (const [grantLabel, grants] of RESOURCE_GRANTS) {
        const doc = {
          id: "d",
          workspace_id: "w",
          visibility,
          members: grants(user.id),
        };
        const store = fakeStore({ workspaces: [workspace], docs: [doc] });
        const want = expectedDoc(user, doc, workspace);
        const where = `${label}, ${visibility} doc (${grantLabel})`;
        assert.equal(docAccess(store, user, doc), want, where);
        count += 1;
      }
    }
  }
  assert.equal(count, 64 * 2 * 8);
});

test("note access: owners, user and team shares, never anyone else", () => {
  const shares = [
    ["none", () => [], null],
    ["user viewer", (id) => [{ kind: "user", id, role: "viewer" }], "viewer"],
    ["user editor", (id) => [{ kind: "user", id, role: "editor" }], "editor"],
    [
      "team viewer",
      () => [{ kind: "team", id: "all", role: "viewer" }],
      "viewer",
    ],
    [
      "team editor",
      () => [{ kind: "team", id: "all", role: "editor" }],
      "editor",
    ],
    ["other team", () => [{ kind: "team", id: "none", role: "editor" }], null],
    // Note shares are viewer/editor only; an owner share means nothing.
    ["bogus owner share", (id) => [{ kind: "user", id, role: "owner" }], null],
  ];
  for (const user of USERS) {
    const active = user.status === "active";
    const own = { id: "n1", owner_id: user.id, shares: [] };
    assert.equal(noteAccess(fakeStore(), user, own), active ? "owner" : null);
    for (const [label, make, role] of shares) {
      const note = {
        id: "n2",
        owner_id: "someone-else",
        shares: make(user.id),
      };
      const want = active ? capped(role, user) : null;
      assert.equal(
        noteAccess(fakeStore(), user, note),
        want,
        `${user.id} ${label}`,
      );
    }
  }
});

test("team grants cover future members and stop with removal", () => {
  const user = { id: "u", role: "member", status: "active" };
  const team = { id: "t", members: [] };
  const board = {
    id: "b",
    workspace_id: "w",
    board_kind: "private",
    members: [{ kind: "team", id: "t", role: "editor" }],
  };
  const records = {
    users: [user],
    teams: [team],
    workspaces: [{ id: "w", kind: "closed", members: [] }],
    boards: [board],
  };
  assert.equal(boardAccess(fakeStore(records), user, board), null);
  team.members.push({ user_id: "u", role: "member" });
  assert.equal(boardAccess(fakeStore(records), user, board), "editor");
  assert.equal(
    subjectGrants(fakeStore(records), user, board.members),
    "editor",
  );
  team.members.length = 0;
  assert.equal(boardAccess(fakeStore(records), user, board), null);
});

test("missing records and dangling references give no access", () => {
  const user = USERS[2];
  const store = fakeStore({ workspaces: [] });
  assert.equal(workspaceAccess(store, user, null), null);
  assert.equal(boardAccess(store, null, { board_kind: "public" }), null);
  const orphan = {
    id: "b",
    workspace_id: "gone",
    board_kind: "public",
    members: [],
  };
  assert.equal(boardAccess(store, user, orphan), null, "no workspace");
  const ghostTeam = [{ kind: "team", id: "ghost", role: "owner" }];
  assert.equal(subjectGrants(store, user, ghostTeam), null);
  const odd = [
    { kind: "group", id: "all", role: "owner" },
    { kind: "user", id: user.id, role: "admin" },
  ];
  assert.equal(subjectGrants(store, user, odd), null, "unknown kinds/roles");
  assert.equal(formAccess(store, user, null), null);
  assert.equal(formAccess(store, user, { board_id: "gone" }), null);
  assert.throws(() => resourceAccess(store, user, "planet", {}), TypeError);
});

test("role helpers: maxRole, capRole, hasRole, accessOutcome", () => {
  assert.equal(maxRole(null, null), null);
  assert.equal(maxRole("viewer", null), "viewer");
  assert.equal(maxRole(null, "owner"), "owner");
  assert.equal(maxRole("editor", "viewer"), "editor");
  assert.equal(maxRole("bogus", "viewer"), "viewer");
  assert.equal(maxRole("__proto__", null), null);
  const viewer = { role: "viewer" };
  assert.equal(capRole("owner", viewer), "viewer");
  assert.equal(capRole("viewer", viewer), "viewer");
  assert.equal(capRole(null, viewer), null);
  assert.equal(capRole("owner", { role: "member" }), "owner");
  assert.equal(hasRole("editor", "viewer"), true);
  assert.equal(hasRole("viewer", "editor"), false);
  assert.equal(hasRole(null, "viewer"), false);
  assert.throws(() => hasRole("owner", "admin"), TypeError);
  assert.equal(accessOutcome(null, "viewer"), "not_found");
  assert.equal(accessOutcome("viewer", "editor"), "forbidden");
  assert.equal(accessOutcome("owner", "owner"), "ok");
});

test("account capabilities follow the role table", () => {
  const table = {
    manage_users: ["admin"],
    admin_directory: ["admin"],
    create_workspace: ["admin", "member"],
    create_team: ["admin", "member"],
    create_content: ["admin", "member"],
    create_note: ["admin", "member", "viewer", "guest"],
    import_data: ["admin"],
  };
  for (const [capability, allowed] of Object.entries(table)) {
    for (const user of USERS) {
      const want = user.status === "active" && allowed.includes(user.role);
      assert.equal(can(user, capability), want, `${user.id} ${capability}`);
    }
  }
  assert.equal(can(null, "create_note"), false);
  assert.throws(() => can(USERS[0], "launch_rockets"), TypeError);
});

test("team roles and team management", () => {
  const team = {
    id: "t",
    members: [
      { user_id: "o", role: "owner" },
      { user_id: "m", role: "member" },
    ],
  };
  const user = (id, role = "member", status = "active") => ({
    id,
    role,
    status,
  });
  assert.equal(teamRole(team, user("o")), "owner");
  assert.equal(teamRole(team, user("m")), "member");
  assert.equal(teamRole(team, user("x")), null);
  assert.equal(canManageTeam(user("o"), team), true);
  assert.equal(canManageTeam(user("m"), team), false);
  assert.equal(canManageTeam(user("x", "admin"), team), true);
  assert.equal(canManageTeam(user("o", "member", "deactivated"), team), false);
  assert.equal(canManageTeam(user("o"), null), false);
});
