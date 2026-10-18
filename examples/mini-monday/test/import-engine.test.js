/**
 * Import previews and plans (SPEC-4 §4, `server/import/engine.js`,
 * `server/import/plan.js`): counts per workspace and board, the user
 * mapping proposal, re-import flags, import targets and plan checking.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ImportError, preview, run } from "../server/import/engine.js";
import { checkPlan } from "../server/import/plan.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import { sampleSnapshot, seededStore } from "./import-engine-fixtures.js";

const normalized = () => validateSnapshot(sampleSnapshot()).snapshot;

test("preview counts every workspace and board and lists every warning", async () => {
  const { store, ids } = await seededStore();
  const result = preview(sampleSnapshot(), {
    store,
    importerId: ids.users.alex,
  });
  assert.equal(result.source, "monday");
  assert.equal(result.source_name, "monday.com");
  assert.equal(result.source_label, "monday.com account Acme");
  const [main, archive] = result.workspaces;
  assert.deepEqual(
    main.boards.map((b) => [b.source_id, b.counts, b.included, b.path]),
    [
      [
        "b-roadmap",
        { columns: 5, groups: 2, items: 2, subitems: 1, updates: 2 },
        true,
        "workspaces[0].boards[0]",
      ],
      [
        "b-hiring",
        { columns: 1, groups: 1, items: 1, subitems: 0, updates: 0 },
        true,
        "workspaces[0].boards[1]",
      ],
    ],
  );
  assert.deepEqual(main.docs, [
    {
      source_id: "d-1",
      title: "Handbook",
      visibility: "private",
      path: "workspaces[0].docs[0]",
      included: true,
      blocks: 2,
    },
  ]);
  assert.equal(main.target, "new");
  assert.equal(archive.boards[0].counts.items, 0);
  assert.deepEqual(result.totals, {
    workspaces: 2,
    boards: 3,
    docs: 1,
    users: 6,
    columns: 7,
    groups: 4,
    items: 3,
    subitems: 1,
    updates: 2,
  });
  assert.deepEqual(result.selected, {
    boards: 3,
    docs: 1,
    items: 3,
    subitems: 1,
    updates: 2,
  });
  assert.deepEqual(result.warnings, sampleSnapshot().warnings);
});

test("users are proposed by email (case-insensitive, active users only)", async () => {
  const { store, ids } = await seededStore();
  const { users } = preview(sampleSnapshot(), {
    store,
    importerId: ids.users.alex,
  });
  assert.deepEqual(
    users.map((u) => [u.source_id, u.proposal, u.action, u.match?.id ?? null]),
    [
      [
        "u-sam",
        `match:${ids.users.sam}`,
        `match:${ids.users.sam}`,
        ids.users.sam,
      ],
      [
        "u-chris",
        `match:${ids.users.chris}`,
        `match:${ids.users.chris}`,
        ids.users.chris,
      ],
      [
        "u-jordan",
        `match:${ids.users.jordan}`,
        `match:${ids.users.jordan}`,
        ids.users.jordan,
      ],
      ["u-morgan", "skip", "skip", null],
      ["u-new", "skip", "skip", null],
      ["u-anon", "skip", "skip", null],
    ],
  );
  assert.deepEqual(users[0].match, {
    id: ids.users.sam,
    name: "Sam Lee",
    email: "sam@example.test",
    role: "member",
  });
  assert.match(users[3].note, /deactivated/);
  assert.equal(users[4].note, null);
  assert.equal(users[5].note, "No email to match");
});

test("preview reflects a mapping: choices, targets and selection", async () => {
  const { store, ids } = await seededStore();
  const mapping = {
    users: { "u-new": "invite:guest", "u-sam": "skip" },
    workspace_map: { "w-main": ids.workspaces.leadership },
    include: { boards: ["b-hiring"], docs: [] },
  };
  const result = preview(sampleSnapshot(), {
    store,
    importerId: ids.users.alex,
    mapping,
  });
  const [main, archive] = result.workspaces;
  assert.equal(main.target, ids.workspaces.leadership);
  assert.equal(archive.target, "new");
  assert.deepEqual(
    main.boards.map((b) => b.included),
    [false, true],
  );
  assert.equal(main.docs[0].included, false);
  assert.equal(archive.boards[0].included, false);
  assert.deepEqual(result.selected, {
    boards: 1,
    docs: 0,
    items: 1,
    subitems: 0,
    updates: 0,
  });
  const actions = Object.fromEntries(result.users.map((u) => [u.source_id, u]));
  assert.equal(actions["u-new"].action, "invite:guest");
  assert.equal(actions["u-new"].proposal, "skip");
  assert.equal(actions["u-sam"].action, "skip");
  assert.deepEqual(
    result.targets.map((t) => t.id).toSorted(),
    store
      .listWorkspaces()
      .map((w) => w.id)
      .toSorted(),
    "admins can import into every workspace",
  );
});

test("plans are checked against the snapshot with exact paths", async () => {
  const { store, ids } = await seededStore();
  const snapshot = normalized();
  const options = { store, importerId: ids.users.alex };
  const plan = {
    users: {
      "u-sam": "match:999",
      "u-chris": `match:${ids.users.morgan}`,
      "u-anon": "invite:member",
      "u-new": "invite:admin",
      "u-ghost": "skip",
    },
    workspace_map: { "w-main": "999", "w-archive": "new", "w-x": "new" },
    include: { boards: ["b-roadmap", "b-nope", 7], docs: "all", extra: [] },
    users_too: true,
  };
  const result = checkPlan(snapshot, plan, options);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((e) => e.path),
    [
      "plan.users_too",
      'plan.users["u-ghost"]',
      'plan.users["u-sam"]',
      'plan.users["u-chris"]',
      'plan.users["u-new"]',
      'plan.users["u-anon"]',
      'plan.workspace_map["w-x"]',
      'plan.workspace_map["w-main"]',
      "plan.include.extra",
      "plan.include.boards[1]",
      "plan.include.boards[2]",
      "plan.include.docs",
    ],
  );
  assert.match(result.errors[5].message, /no email/);
  assert.deepEqual(checkPlan(snapshot, "x", options).errors, [
    { path: "plan", message: "Expected an object" },
  ]);
  const fine = checkPlan(snapshot, {}, options);
  assert.equal(fine.ok, true);
  assert.equal(fine.plan.users.get("u-sam").userId, ids.users.sam);
  assert.equal(fine.plan.targets.get("w-main"), null);
  assert.equal(fine.plan.boards.size, 3);
  assert.throws(
    () => preview(sampleSnapshot(), { ...options, mapping: plan }),
    (error) => error instanceof ImportError && error.code === "INVALID_PLAN",
  );
});

test("only importers (admins) can preview or run", async () => {
  const { store, ids } = await seededStore();
  for (const user of ["sam", "jordan", "chris"]) {
    const options = { store, importerId: ids.users[user] };
    assert.throws(
      () => preview(sampleSnapshot(), options),
      (error) => error.code === "FORBIDDEN",
      user,
    );
    await assert.rejects(run(sampleSnapshot(), {}, options), {
      code: "FORBIDDEN",
    });
  }
  store.updateUser(ids.users.alex, { role: "member" });
  assert.equal(store.getUser(ids.users.alex).role, "admin", "last admin stays");
  store.updateUser(ids.users.sam, { role: "admin" });
  store.deactivateUser(ids.users.sam);
  assert.throws(
    () => preview(sampleSnapshot(), { store, importerId: ids.users.sam }),
    { code: "FORBIDDEN" },
    "deactivated admins cannot import",
  );
});

test("an invalid snapshot is refused with its errors", async () => {
  const { store, ids } = await seededStore();
  const snapshot = sampleSnapshot();
  snapshot.workspaces[0].boards[0].kind = "secret";
  assert.throws(
    () => preview(snapshot, { store, importerId: ids.users.alex }),
    (error) =>
      error.code === "INVALID_SNAPSHOT" &&
      error.details.errors[0].path === "workspaces[0].boards[0].kind",
  );
});

test("existing workspace targets must be ones the importer may import into", async () => {
  const { store, ids } = await seededStore();
  const snapshot = normalized();
  const workspace = store.createWorkspace({
    name: "Ops",
    creatorId: ids.users.sam,
  });
  const plan = { workspace_map: { "w-main": workspace.id } };
  const admin = checkPlan(snapshot, plan, {
    store,
    importerId: ids.users.alex,
  });
  assert.equal(admin.ok, true, "admins manage every workspace");
  assert.equal(admin.plan.targets.get("w-main").id, workspace.id);
  store.updateUser(ids.users.priya, { role: "admin" });
  store.deactivateUser(ids.users.priya);
  const gone = checkPlan(snapshot, plan, {
    store,
    importerId: ids.users.priya,
  });
  assert.equal(gone.ok, false, "a deactivated importer manages nothing");
});
