/**
 * Upgrading older data files (persistence.js): version 2 wrote people's
 * names into notification and activity texts (server/store/legacy-texts.js),
 * so loading one must turn those names into mentions (rendered per viewer,
 * SPEC-2 §6); version 3 files have no subitems, column roles or update
 * authors (SPEC-5 §1.1), and version 4 positions are renumbered per board
 * (SPEC-6 §1.2, store-positions.test.js). Either way the store keeps a
 * private copy of the old file named after its version and saves the
 * result in the current format, which older versions refuse.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventHub } from "../server/events.js";
import { createStore } from "../server/store.js";
import { FORMAT } from "../server/store/persistence.js";
import {
  fakeResponse,
  plainText,
  seedIds,
  startTestServers,
} from "./helpers.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };

/**
 * The PRIV-1 steps: Priya shares "Marketing launch" with Noa, Noa creates
 * an item assigned to Noa and the guest Chris and posts an update, then
 * Priya unshares Noa and takes her off the item. Chris can no longer see
 * Noa. Returns the item.
 */
function staleMember(store) {
  const { users, boards } = seedIds(store);
  const board = boards.marketing;
  store.share({
    resourceKind: "board",
    resourceId: board,
    subjectKind: "user",
    subjectIds: [users.noa],
    role: "editor",
    actorId: users.priya,
  });
  const item = store.createItem({
    boardId: board,
    name: "Noa task",
    values: { person: [users.noa, users.chris] },
    creatorId: users.noa,
  });
  store.createUpdate({ itemId: item.id, body: "hi", creatorId: users.noa });
  store.unshare({
    resourceKind: "board",
    resourceId: board,
    subjectKind: "user",
    subjectId: users.noa,
    actorId: users.priya,
  });
  store.setColumnValue(item.id, "person", [users.chris], {
    actorId: users.priya,
  });
  return item;
}

/**
 * Rewrites a current data file the way version 2 stored it: format /2,
 * texts with every name written out, and the actor's name as the label of
 * user actors.
 */
function asVersion2(doc) {
  const names = new Map(doc.users.map((user) => [user.id, user.name]));
  const flat = (text) =>
    Array.isArray(text)
      ? text.map((part) => part.text ?? names.get(part.user_id)).join("")
      : text;
  return {
    ...doc,
    format: "mini-monday-store/2",
    notifications: doc.notifications.map((n) => ({ ...n, text: flat(n.text) })),
    activity: doc.activity.map((a) => ({
      ...a,
      actor_label: a.actor_id === null ? a.actor_label : names.get(a.actor_id),
      from_text: flat(a.from_text),
      to_text: flat(a.to_text),
    })),
  };
}

async function legacyFile(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const store = await createStore({ file, log: quietLog });
  const item = staleMember(store);
  await store.flush();
  const doc = asVersion2(JSON.parse(await readFile(file, "utf8")));
  return { file, doc, item, ids: seedIds(store) };
}

const save = (file, doc) => writeFile(file, `${JSON.stringify(doc)}\n`);
const assignOf = (store, userId) =>
  store.listNotifications(userId).find((n) => n.kind === "assign");

test("a version-2 file is converted, copied and saved in the current format", async (t) => {
  const { file, doc, ids } = await legacyFile(t);
  const { users } = ids;
  const chrisAssign = doc.notifications.find(
    (n) => n.user_id === users.chris && n.kind === "assign",
  );
  assert.equal(chrisAssign.text, "Noa Cohen assigned you to “Noa task”");
  await save(file, doc);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.format, FORMAT);
  assert.equal(FORMAT, "mini-monday-store/5");
  const copy = `${file}.v2.bak`;
  assert.deepEqual(JSON.parse(await readFile(copy, "utf8")), doc);
  assert.equal((await stat(copy)).mode & 0o777, 0o600, "the copy is private");
  // /2 upgrades through the /3 and /4 paths; only the original version
  // is kept.
  await assert.rejects(access(`${file}.v3.bak`), { code: "ENOENT" });
  await assert.rejects(access(`${file}.v4.bak`), { code: "ENOENT" });
  // Names became mentions; the label of a user actor is not kept.
  assert.deepEqual(assignOf(store, users.chris).text, [
    { user_id: users.noa },
    { text: " assigned you to “Noa task”" },
  ]);
  const entries = store.listActivity(ids.boards.marketing);
  const people = entries.find((e) => e.kind === "column_value_changed");
  assert.deepEqual(people.from_text, [
    { user_id: users.noa },
    { text: ", " },
    { user_id: users.chris },
  ]);
  const removed = entries.find((e) => e.kind === "member_removed");
  assert.deepEqual(removed.from_text, [
    { user_id: users.noa },
    { text: " (editor)" },
  ]);
  assert.ok(
    entries.every((e) => e.actor_id === null || e.actor_label === null),
  );
  // A second load reads the current format and leaves the copy alone.
  await writeFile(copy, "kept");
  const again = await createStore({ file, log: quietLog });
  await again.flush();
  assert.equal(await readFile(copy, "utf8"), "kept");
  assert.deepEqual(
    assignOf(again, users.chris).text,
    assignOf(store, users.chris).text,
  );
});

test("a version-3 file loads and is saved in the current format", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const first = await createStore({ file, log: quietLog });
  const ids = seedIds(first);
  await first.flush();
  const current = JSON.parse(await readFile(file, "utf8"));
  assert.equal(current.format, FORMAT);
  const doc = { ...current, format: "mini-monday-store/3" };
  await save(file, doc);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  const copy = `${file}.v3.bak`;
  assert.deepEqual(JSON.parse(await readFile(copy, "utf8")), doc);
  assert.equal((await stat(copy)).mode & 0o777, 0o600, "the copy is private");
  const saved = JSON.parse(await readFile(file, "utf8"));
  // Loading sorts groups by position; nothing else changes (the seed's
  // positions already follow its display order, which the /4 → /5
  // renumbering keeps).
  const byKey = (a, b) =>
    `${a.board_id}/${a.id}`.localeCompare(`${b.board_id}/${b.id}`);
  const normal = (data) => ({ ...data, groups: data.groups.toSorted(byKey) });
  assert.deepEqual(normal(saved), normal(current));
  assert.ok(saved.items.every((item) => !("parent_id" in item)));
  const board = ids.boards.roadmap;
  assert.deepEqual(
    store.listItems({ boardId: board, limit: 100 }),
    first.listItems({ boardId: board, limit: 100 }),
  );
  // Formats this version does not know (older servers refusing /5 is the
  // same rule) are refused, and the file is left as it was.
  const newer = JSON.stringify({ ...current, format: "mini-monday-store/6" });
  await writeFile(file, newer);
  await assert.rejects(
    createStore({ file, log: quietLog }),
    /unsupported format \(expected mini-monday-store\/5;/,
  );
  assert.equal(await readFile(file, "utf8"), newer);
});

test("after the upgrade a guest reads Someone for people outside their directory", async (t) => {
  const { file, doc, ids } = await legacyFile(t);
  await save(file, doc);
  const store = await createStore({ file, log: quietLog });
  const servers = await startTestServers({ store });
  t.after(() => servers.close());
  const { users, boards } = ids;
  const query = `query ($b: ID!) { boards(ids: [$b]) { activity_logs(limit: 10) {
      kind actor_label from_text to_text } }
    notifications { kind text } }`;
  const read = async (key) => {
    const data = await servers
      .as(users[key])
      .data(query, { b: boards.marketing });
    const log = data.boards[0].activity_logs;
    const texts = (kind) => log.filter((e) => e.kind === kind);
    return { data, texts };
  };
  const chris = await read("chris");
  assert.deepEqual(
    chris
      .texts("column_value_changed")
      .slice(0, 1)
      .map((e) => e.from_text),
    ["Someone, Chris Taylor"],
  );
  assert.equal(chris.texts("member_removed")[0].from_text, "Someone (editor)");
  assert.equal(chris.texts("member_added")[0].to_text, "Someone (editor)");
  const chrisTexts = chris.data.notifications.map((n) => n.text);
  assert.ok(chrisTexts.includes("Someone assigned you to “Noa task”"));
  assert.ok(chrisTexts.includes("Someone posted an update on “Noa task”"));
  assert.ok(chrisTexts.every((text) => !text.includes("Noa Cohen")));
  // People who may see Noa still read her name.
  const priya = await read("priya");
  assert.equal(
    priya.texts("member_removed")[0].from_text,
    "Noa Cohen (editor)",
  );
  assert.equal(priya.texts("member_removed")[0].actor_label, "Priya Nair");

  // The notification stream renders the converted text the same way.
  let emit = null;
  const view = { ...store, on: (listener) => ((emit = listener), () => {}) };
  const hub = createEventHub({ store: view, heartbeatMs: 60_000 });
  t.after(() => hub.close());
  const res = fakeResponse();
  hub.handle({}, res, { stream: "me", userId: users.chris });
  const legacy = assignOf(store, users.chris);
  emit({
    type: "notification_created",
    user_ids: [users.chris],
    resource_kind: "notification",
    resource_id: legacy.id,
  });
  const sent = res.writes.join("");
  assert.match(sent, /"text":"Someone assigned you to “Noa task”"/);
  assert.doesNotMatch(sent, /Noa Cohen/);
});

test("names the upgrade cannot tie to one user fail closed", async (t) => {
  const { file, doc, ids } = await legacyFile(t);
  const { users, teams, boards } = ids;
  const entry = (kind, fields) => ({
    ...doc.activity.find((a) => a.board_id === boards.marketing),
    id: String(doc.next_id++),
    kind,
    actor_id: users.priya,
    column_id: null,
    from_text: null,
    to_text: null,
    ...fields,
  });
  const note = (text, fields = {}) => ({
    ...doc.notifications.find((n) => n.user_id === users.chris),
    id: String(doc.next_id++),
    kind: "update",
    actor_id: users.noa,
    text,
    ...fields,
  });
  doc.activity.push(
    // A name nobody has any more, next to one that is known.
    entry("column_value_changed", {
      column_id: "person",
      from_text: "Old Name, Chris Taylor",
    }),
    entry("member_added", { to_text: "Marketing (viewer)" }),
    entry("member_added", { to_text: "Ghost (owner)" }),
    entry("member_role_changed", { from_text: "garbled" }),
  );
  doc.notifications.push(
    // Noa was renamed since: everything before the known phrase was her name.
    note("Noa C. posted an update on “Noa task”"),
    note("an unknown kind of text"),
    note("Someone shared the doc “Plan” with you (viewer)", {
      kind: "share",
      actor_id: null,
    }),
  );
  assert.ok(teams.marketing, "the seed has a Marketing team");
  await save(file, doc);
  const store = await createStore({ file, log: quietLog });
  const render = (text) => plainText(store, text);
  const log = store.listActivity(boards.marketing);
  const byId = (id) => log.find((a) => a.id === id) ?? null;
  const added = doc.activity.slice(-4).map((a) => byId(a.id));
  assert.equal(render(added[0].from_text), "Someone, Chris Taylor");
  assert.equal(added[1].to_text, "Marketing (viewer)", "team names stay");
  assert.equal(render(added[2].to_text), "Someone (owner)");
  assert.equal(render(added[3].from_text), "Someone");
  const inbox = store.listNotifications(users.chris);
  const texts = doc.notifications
    .slice(-3)
    .map((n) => inbox.find((entry) => entry.id === n.id).text);
  assert.deepEqual(texts[0], [
    { user_id: users.noa },
    { text: " posted an update on “Noa task”" },
  ]);
  assert.equal(render(texts[1]), "Noa Cohen sent you a notification");
  assert.equal(texts[2], "Someone shared the doc “Plan” with you (viewer)");
});
