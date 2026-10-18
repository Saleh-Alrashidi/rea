/**
 * Store rules from the review follow-ups: share notifications name the
 * role the recipient really gets, deleting a team leaves an audit trail on
 * every board it reached, a board keeps a group, malformed form questions
 * are bad input, app storage stays bounded per segment, and temp files of
 * interrupted saves do not pile up.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../server/store.js";
import { MAX_LIVE_KEYS, MAX_TOMBSTONES } from "../server/store/storage.js";

async function seeded() {
  const store = await createStore();
  const users = Object.fromEntries(
    store.listUsers().map((u) => [u.name.split(" ")[0].toLowerCase(), u]),
  );
  const board = (name) =>
    store.listBoards({ limit: 100 }).find((b) => b.name === name);
  return { store, users, board };
}

test("share notifications state the role the recipient really gets", async () => {
  const { store, users, board } = await seeded();
  const marketing = board("Marketing launch");
  store.share({
    resourceKind: "board",
    resourceId: marketing.id,
    subjectKind: "user",
    subjectIds: [users.jordan.id, users.noa.id],
    role: "editor",
    actorId: users.priya.id,
  });
  const [jordan] = store.listNotifications(users.jordan.id);
  assert.match(
    jordan.text,
    /with you \(viewer\)$/,
    "viewer accounts are capped",
  );
  const [noa] = store.listNotifications(users.noa.id);
  assert.match(noa.text, /with you \(editor\)$/);
});

test("deleting a team logs its board removals and announces member changes", async () => {
  const { store, users, board } = await seeded();
  const marketing = board("Marketing launch");
  const product = store.listTeams().find((team) => team.name === "Product");
  store.share({
    resourceKind: "board",
    resourceId: marketing.id,
    subjectKind: "team",
    subjectIds: [product.id],
    role: "editor",
    actorId: users.priya.id,
  });
  const events = [];
  store.on((event) => events.push(event));
  store.deleteTeam(product.id, { actorId: users.alex.id });
  const [entry] = store.listActivity(marketing.id, { limit: 1 });
  assert.deepEqual(
    [entry.kind, entry.actor_id, entry.from_text, entry.to_text],
    ["member_removed", users.alex.id, "Product (editor)", null],
  );
  assert.equal(events[0].type, "team_deleted");
  assert.ok(
    events.some(
      (event) =>
        event.type === "members_changed" && event.board_id === marketing.id,
    ),
  );
});

test("a board keeps at least one group", async () => {
  const { store, users } = await seeded();
  const fresh = store.createBoard({ name: "Lone", creatorId: users.sam.id });
  const [group] = store.listGroups(fresh.id);
  const refused = store.deleteGroup(fresh.id, group.id);
  assert.equal(refused.reason, "last_group");
  assert.equal(store.listGroups(fresh.id).length, 1);
  const other = store.createGroup(fresh.id, { title: "Second" });
  assert.equal(store.deleteGroup(fresh.id, group.id).id, group.id);
  assert.equal(store.deleteGroup(fresh.id, other.id).reason, "last_group");
});

test("malformed form questions are bad input, not internal errors", async () => {
  const { store, board } = await seeded();
  const roadmap = board("Product roadmap");
  const form = store.listForms({ boardId: roadmap.id })[0];
  const questions = (extra) => [
    { column_id: "name", label: "Title" },
    { column_id: "status", label: "S", ...extra },
  ];
  for (const extra of [{ required: "yes" }, { help: 5 }]) {
    const result = store.updateForm(form.id, { questions: questions(extra) });
    assert.equal(result.reason, "invalid", JSON.stringify(extra));
    assert.match(result.message, /^Question 2 (required|help) must be/);
  }
  const ok = store.updateForm(form.id, {
    questions: questions({ help: null }),
  });
  assert.equal(ok.questions[1].help, "");
});

test("app storage keeps at most MAX_LIVE_KEYS keys and folds old tombstones", async () => {
  const { store } = await seeded();
  const scope = "install:999";
  for (let index = 0; index < MAX_LIVE_KEYS; index += 1) {
    store.setAppStorage(scope, `k${index}`, "v");
  }
  const full = store.setAppStorage(scope, "one-more", "v");
  assert.equal(full.reason, "storage_full");
  assert.equal(store.setAppStorage(scope, "k0", "again").success, true);
  // Churn: every key deleted, then many more created and deleted.
  for (let index = 0; index < MAX_LIVE_KEYS; index += 1) {
    store.deleteAppStorage(scope, `k${index}`);
  }
  for (let index = 0; index < 200; index += 1) {
    store.setAppStorage(scope, `x${index}`, "v");
    store.deleteAppStorage(scope, `x${index}`);
  }
  // k0 was at version 2 before its tombstone was folded away; writing it
  // again must not reuse a version a stale client may still hold.
  const again = store.setAppStorage(scope, "k0", "back");
  assert.ok(again.version > 2, `version ${again.version}`);
  assert.equal(
    store.setAppStorage(scope, "k0", "x", 1).reason,
    "version_conflict",
  );
  const fresh = store.setAppStorage(scope, "never-seen", "v");
  assert.equal(fresh.success, true);
  assert.ok(MAX_TOMBSTONES < MAX_LIVE_KEYS + 200, "the churn exceeded the cap");
});

test("temp files of interrupted saves are removed when the store starts", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "mm-temps-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "store.json");
  const stale = [
    ".store.json.43e2b496-2f6b-4c1e-9a5d-0d4f3a1b2c3d.tmp",
    ".store.json.c52fc7b9-1a2b-4c3d-8e9f-a0b1c2d3e4f5.tmp",
  ];
  const kept = [
    "notes.txt",
    ".other.json.43e2b496-2f6b-4c1e-9a5d-0d4f3a1b2c3d.tmp",
  ];
  for (const name of [...stale, ...kept]) {
    await writeFile(path.join(directory, name), "secret copy");
  }
  const store = await createStore({ file });
  await store.flush();
  const names = (await readdir(directory)).sort();
  assert.deepEqual(names, [...kept, "store.json"].sort());
});
