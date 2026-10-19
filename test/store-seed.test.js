import assert from "node:assert/strict";
import test from "node:test";
import {
  boardAccess,
  docAccess,
  noteAccess,
  notificationVisible,
} from "../server/access.js";
import { ALL_SCOPES } from "../server/auth.js";
import { createStore } from "../server/store.js";
import { DEFAULT_VIEWS } from "../server/store/boards.js";
import { plainEntry } from "./helpers.js";

// The seed (server/store/seed.js and seed-data.js): part-1 content with its
// IDs, and the SPEC-2 §2.1 people, teams, workspaces, boards, docs, notes,
// forms, activity and inbox.
const START = Date.UTC(2026, 9, 18, 9, 0, 0);
const clock = () => {
  let tick = 0;
  return () => new Date(START + 1000 * tick++);
};
const memoryStore = (options = {}) => createStore({ now: clock(), ...options });
const roadmapOf = (store) =>
  store.listBoards().find((b) => b.name === "Product roadmap");
const byName = (list, name) =>
  list.find((record) => (record.name ?? record.title) === name);

test("seed data matches the spec", async () => {
  const store = await memoryStore();
  const users = store.listUsers();
  // SPEC-2 §2.1: part-1 users keep IDs 1-3 and gain roles and titles;
  // `is_admin` is now derived from the role (server/access.js).
  assert.deepEqual(
    users.slice(0, 3).map((u) => [u.id, u.name, u.email, u.role]),
    [
      ["1", "Alex Rivera", "alex@example.test", "admin"],
      ["2", "Sam Lee", "sam@example.test", "member"],
      ["3", "Noa Cohen", "noa@example.test", "member"],
    ],
  );
  const [roadmap, marketing] = store.listBoards();
  assert.deepEqual([roadmap.id, marketing.id], ["4", "17"]);
  assert.equal(roadmap.name, "Product roadmap");
  assert.equal(marketing.name, "Marketing launch");
  assert.deepEqual(
    store
      .listGroups(roadmap.id)
      .map((g) => [g.id, g.title, g.color, g.position]),
    [
      ["this_sprint", "This sprint", "#579bfc", 0],
      ["next_up", "Next up", "#a25ddc", 1],
      ["done", "Done", "#00c875", 2],
    ],
  );
  assert.deepEqual(
    store.listColumns(roadmap.id).map((c) => [c.id, c.title, c.type]),
    [
      ["name", "Name", "name"],
      ["status", "Status", "status"],
      ["person", "Owner", "people"],
      ["date", "Due date", "date"],
      ["estimate", "Estimate", "numbers"],
      ["notes", "Notes", "text"],
    ],
  );
  const status = store.getColumn(roadmap.id, "status");
  assert.equal(status.settings.labels[1], "Done");
  assert.equal(status.settings_str, JSON.stringify(status.settings));
  assert.equal(store.getColumn(roadmap.id, "notes").settings_str, "{}");
  assert.equal(store.countItems(roadmap.id), 8);
  assert.equal(store.countItems(marketing.id), 3);
  assert.deepEqual(
    store.listGroups(marketing.id).map((g) => g.id),
    ["topics"],
  );
  const values = store
    .listItems({ boardId: roadmap.id, limit: 8 })
    .items.map((i) => i.values);
  for (const column of ["status", "person", "date", "estimate", "notes"]) {
    assert.ok(
      values.some((v) => column in v),
      `some item has ${column}`,
    );
    assert.ok(
      values.some((v) => !(column in v)),
      `some item lacks ${column}`,
    );
  }
  assert.ok(values.some((v) => v.person?.length === 2));
  assert.ok(new Set(values.map((v) => v.status?.index)).size >= 3);
});

test("seed includes the Status summary app, its install, view and tokens", async () => {
  const store = await memoryStore();
  const roadmap = roadmapOf(store);
  const [app] = store.listApps();
  assert.deepEqual(
    [app.id, store.listInstalls()[0].id],
    ["23", "24"],
    "part-1 IDs are kept",
  );
  assert.equal(app.name, "Status summary");
  assert.equal(app.path, "/apps/status-summary/index.html");
  assert.deepEqual(app.scopes, [
    "boards:read",
    "storage:read",
    "storage:write",
  ]);
  assert.match(app.client_id, /^[0-9a-f]{32}$/);
  assert.match(app.client_secret, /^[\w-]{43}$/);
  const [install] = store.listInstalls({ boardId: roadmap.id });
  assert.deepEqual(store.getInstall(install.id), install);
  assert.equal(install.app_id, app.id);
  // Every seeded board has the default views (SPEC-6 §1.1), in tab order.
  const views = store.listViews(roadmap.id);
  assert.deepEqual(
    views.map((v) => [v.name, v.type, v.app_install_id]),
    [
      ["List", "list", null],
      ["Main table", "table", null],
      ["Kanban", "kanban", null],
      ["Status summary", "app", install.id],
    ],
  );
  for (const board of store.listBoards({ limit: 100 })) {
    const types = store.listViews(board.id).map((v) => v.type);
    assert.deepEqual(
      types.filter((type) => type !== "app"),
      DEFAULT_VIEWS.map((view) => view.type),
      board.name,
    );
  }
  const tokens = store.listApiTokens();
  assert.deepEqual(
    tokens.map((t) => [t.label, t.user_id, t.scopes]),
    [
      ["read-write", "1", [...ALL_SCOPES]],
      ["read-only", "1", ["boards:read", "storage:read"]],
    ],
  );
  for (const { token } of tokens) assert.match(token, /^[\w-]{43}$/);
  const other = await memoryStore();
  assert.notEqual(other.listApiTokens()[0].token, tokens[0].token);
  assert.notEqual(other.listApps()[0].client_secret, app.client_secret);
  assert.deepEqual(
    other.listBoards(),
    store.listBoards(),
    "content is deterministic",
  );
});

test("SPEC-2 seed: users, teams and workspaces", async () => {
  const store = await memoryStore();
  assert.deepEqual(
    store.listUsers().map((u) => [u.name, u.email, u.role, u.title, u.status]),
    [
      [
        "Alex Rivera",
        "alex@example.test",
        "admin",
        "Head of Product",
        "active",
      ],
      ["Sam Lee", "sam@example.test", "member", "Product Designer", "active"],
      ["Noa Cohen", "noa@example.test", "member", "Engineering Lead", "active"],
      [
        "Priya Nair",
        "priya@example.test",
        "member",
        "Marketing Manager",
        "active",
      ],
      [
        "Jordan Blake",
        "jordan@example.test",
        "viewer",
        "Finance Analyst",
        "active",
      ],
      [
        "Chris Taylor",
        "chris@agency.test",
        "guest",
        "Agency Partner",
        "active",
      ],
      [
        "Morgan Diaz",
        "morgan@example.test",
        "member",
        "Former Engineer",
        "deactivated",
      ],
    ],
  );
  for (const user of store.listUsers()) {
    assert.match(user.color, /^#[0-9a-f]{6}$/);
    assert.equal(typeof user.created_at, "string");
  }
  const id = (name) => byName(store.listUsers(), name).id;
  const members = (team) =>
    byName(store.listTeams(), team).members.map((m) => [m.user_id, m.role]);
  assert.deepEqual(members("Product"), [
    [id("Alex Rivera"), "owner"],
    [id("Sam Lee"), "member"],
    [id("Noa Cohen"), "member"],
  ]);
  assert.deepEqual(members("Marketing"), [
    [id("Priya Nair"), "owner"],
    [id("Sam Lee"), "member"],
  ]);
  assert.deepEqual(members("Leadership"), [[id("Alex Rivera"), "owner"]]);
  const leadershipTeam = byName(store.listTeams(), "Leadership").id;
  assert.deepEqual(
    store.listWorkspaces().map((w) => [w.name, w.kind, w.members]),
    [
      ["Main workspace", "open", [{ kind: "user", id: "1", role: "owner" }]],
      [
        "Leadership",
        "closed",
        [
          { kind: "team", id: leadershipTeam, role: "editor" },
          { kind: "user", id: "1", role: "owner" },
        ],
      ],
    ],
  );
  assert.equal(store.getDefaultWorkspace().name, "Main workspace");
});

test("SPEC-2 seed: boards and docs", async () => {
  const store = await memoryStore();
  const [main, leadership] = store.listWorkspaces();
  const id = (name) => byName(store.listUsers(), name).id;
  const user = (name, role) => ({ kind: "user", id: id(name), role });
  const team = (name, role) => ({
    kind: "team",
    id: byName(store.listTeams(), name).id,
    role,
  });
  assert.deepEqual(
    store
      .listBoards()
      .map((b) => [b.name, b.workspace_id, b.board_kind, b.members]),
    [
      ["Product roadmap", main.id, "public", [user("Alex Rivera", "owner")]],
      [
        "Marketing launch",
        main.id,
        "share",
        [user("Priya Nair", "owner"), user("Chris Taylor", "editor")],
      ],
      [
        "Hiring plan",
        leadership.id,
        "private",
        [user("Alex Rivera", "owner"), user("Noa Cohen", "editor")],
      ],
      ["Budget 2027", leadership.id, "public", [user("Alex Rivera", "owner")]],
    ],
  );
  const docs = store.listDocs();
  assert.deepEqual(
    docs.map((d) => [d.title, d.workspace_id, d.visibility, d.members]),
    [
      ["Product vision", main.id, "workspace", [user("Alex Rivera", "owner")]],
      [
        "Launch brief",
        main.id,
        "private",
        [
          user("Priya Nair", "owner"),
          user("Chris Taylor", "viewer"),
          team("Marketing", "editor"),
        ],
      ],
      [
        "Leadership offsite",
        leadership.id,
        "workspace",
        [user("Alex Rivera", "owner")],
      ],
    ],
  );
  const types = docs[0].blocks.map((b) => b.type);
  for (const type of ["heading1", "paragraph", "todo", "callout"]) {
    assert.ok(types.includes(type), `Product vision has a ${type}`);
  }
  assert.ok(docs[0].blocks.filter((b) => b.type === "todo").length >= 2);
  assert.ok(docs.every((d) => d.version === 1 && d.blocks.every((b) => b.id)));
});

test("SPEC-2 seed: notes and forms", async () => {
  const store = await memoryStore();
  const id = (name) => byName(store.listUsers(), name).id;
  const user = (name, role) => ({ kind: "user", id: id(name), role });
  const team = (name, role) => ({
    kind: "team",
    id: byName(store.listTeams(), name).id,
    role,
  });
  assert.deepEqual(
    store
      .listNotes()
      .map((n) => [n.owner_id, n.title, n.pinned, n.shares, n.version]),
    [
      [id("Alex Rivera"), "Ideas for Q1", true, [], 1],
      [
        id("Alex Rivera"),
        "1:1 with Sam",
        false,
        [user("Sam Lee", "viewer")],
        1,
      ],
      [id("Sam Lee"), "Design crit notes", false, [], 1],
      [
        id("Priya Nair"),
        "Launch checklist",
        false,
        [team("Marketing", "editor")],
        1,
      ],
    ],
  );
  const [feature, intake] = store.listForms();
  assert.deepEqual(
    [feature.title, feature.board_id, feature.access, feature.response_count],
    ["Feature request", roadmapOf(store).id, "public", 0],
  );
  assert.deepEqual(
    feature.questions.map((q) => [q.column_id, q.label, q.required]),
    [
      ["name", "Request title", true],
      ["notes", "Details", false],
      ["status", "Priority-ish status", false],
      ["date", "Needed by", false],
    ],
  );
  assert.deepEqual(
    [intake.title, intake.board_id, intake.access],
    ["Campaign intake", "17", "account"],
  );
  assert.equal(intake.questions[0].column_id, "name");
  for (const form of [feature, intake]) {
    assert.match(form.token, /^[\w-]{22}$/, "16 random bytes, base64url");
  }
  const other = await memoryStore();
  assert.notEqual(other.listForms()[0].token, feature.token, "random tokens");
  const withoutToken = ({ token: _token, ...rest }) => rest;
  assert.deepEqual(
    other.listForms().map(withoutToken),
    store.listForms().map(withoutToken),
  );
  assert.deepEqual(
    other.listDocs(),
    store.listDocs(),
    "content is deterministic",
  );
});

test("SPEC-2 seed: activity, inbox and coherent access", async () => {
  const store = await memoryStore();
  const users = store.listUsers();
  const unread = (user) => store.countUnreadNotifications(user.id);
  assert.ok(unread(users[0]) >= 1 && unread(users[1]) >= 1);
  assert.deepEqual(
    users.slice(2).map(unread),
    [0, 0, 0, 0, 0],
    "only Alex and Sam have unread notifications",
  );
  const roadmap = roadmapOf(store);
  assert.ok(store.listActivity(roadmap.id).length >= 3);
  for (const user of users) {
    for (const note of store.listNotifications(user.id)) {
      assert.ok(notificationVisible(store, user, note), note.text);
      assert.notEqual(note.actor_id, user.id, "never notified about oneself");
    }
  }
  for (const board of store.listBoards()) {
    for (const entry of store.listActivity(board.id)) {
      const actor = store.getUser(entry.actor_id);
      assert.ok(boardAccess(store, actor, board), "actors can see the board");
      assert.equal(entry.actor_label, null, "user actors are kept by ID");
      assert.equal(plainEntry(store, entry).actor_label, actor.name);
    }
    const { items } = store.listItems({ boardId: board.id, limit: 100 });
    for (const item of items) {
      for (const userId of item.values.person ?? []) {
        const assignee = store.getUser(userId);
        assert.ok(
          boardAccess(store, assignee, board),
          `${board.name} assignee`,
        );
      }
    }
  }
  const owner = (doc) => store.getUser(doc.created_by);
  for (const doc of store.listDocs()) {
    assert.equal(docAccess(store, owner(doc), doc), "owner");
  }
  for (const note of store.listNotes()) {
    assert.equal(
      noteAccess(store, store.getUser(note.owner_id), note),
      "owner",
    );
  }
});
