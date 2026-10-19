/**
 * The update model in the data file (SPEC-6 §2.1): since format
 * `mini-monday-store/6`, replies, edits, pins and the `likes`
 * collection; a `/5` file upgrades additively (no likes yet, plain bodies
 * that would read as mention tokens escaped) with a `.v5.bak` copy; and
 * files that break the update rules are refused and left untouched.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseBody } from "../server/mentions.js";
import { createStore } from "../server/store.js";
import { FORMAT } from "../server/store/persistence.js";
import { seedIds } from "./helpers.js";

const quietLog = { error() {}, warn() {}, info() {}, log() {} };
const readDoc = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, doc) => writeFile(file, `${JSON.stringify(doc)}\n`);

/** A file store with a thread: an edited, pinned update, a reply, likes. */
async function threadFile(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-updates-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const store = await createStore({ file, log: quietLog });
  const { users, boards } = seedIds(store);
  const [item] = store.listItems({ boardId: boards.roadmap }).items;
  const top = store.createUpdate({
    itemId: item.id,
    body: "Draft",
    creatorId: users.sam,
  });
  store.editUpdate(top.id, "Final", { actorId: users.sam });
  store.pinUpdate(top.id);
  const reply = store.createUpdate({
    itemId: item.id,
    body: "Re",
    creatorId: users.noa,
    parentId: top.id,
  });
  store.likeUpdate(top.id, users.noa);
  store.likeUpdate(reply.id, users.sam);
  await store.flush();
  return { file, store, item, top: store.getUpdate(top.id), reply };
}

test("replies, edits, pins and likes persist in the data file", async (t) => {
  const { file, store, item, top, reply } = await threadFile(t);
  assert.equal(FORMAT, "mini-monday-store/7");
  const doc = await readDoc(file);
  assert.equal(doc.format, FORMAT);
  const saved = (id) => doc.updates.find((update) => update.id === id);
  assert.equal(saved(reply.id).parent_update_id, top.id);
  assert.equal(typeof saved(top.id).edited_at, "string");
  assert.equal(typeof saved(top.id).pinned_at, "string");
  assert.equal("parent_update_id" in saved(top.id), false, "absent, not null");
  assert.deepEqual(
    doc.likes.map((like) => Object.keys(like)),
    [
      ["update_id", "user_id", "created_at"],
      ["update_id", "user_id", "created_at"],
    ],
  );
  const reloaded = await createStore({ file, log: quietLog });
  assert.deepEqual(reloaded.listUpdates(item.id), store.listUpdates(item.id));
  assert.deepEqual(reloaded.listReplies(top.id), [reply]);
  assert.deepEqual(reloaded.indexLikes(), store.indexLikes());
});

test("a /5 file upgrades with a .v5.bak copy", async (t) => {
  const { file, item } = await threadFile(t);
  const current = await readDoc(file);
  // What /5 could hold: no likes, replies, edits or pins, plain bodies.
  const plain = "Typed before mentions: @[Sam](user:2) stays text";
  // 10,000 characters that escape to more, yet read as written.
  const long = "@[x](user:1) ".repeat(769) + "zzz";
  const updates = current.updates
    .filter((update) => update.parent_update_id === undefined)
    .map(({ edited_at: _e, pinned_at: _p, ...update }) => update);
  updates[0] = { ...updates[0], body: plain };
  updates[1] = { ...updates[1], body: long };
  const { likes: _likes, ...rest } = current;
  const legacy = { ...rest, format: "mini-monday-store/5", updates };
  await save(file, legacy);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  assert.deepEqual(await readDoc(`${file}.v5.bak`), legacy);
  const doc = await readDoc(file);
  assert.equal(doc.format, FORMAT);
  assert.deepEqual(doc.likes, []);
  const upgraded = store.getUpdate(updates[0].id);
  assert.equal(upgraded.body, plain.replace("@[", "\\@["));
  assert.deepEqual(parseBody(upgraded.body), [{ text: plain }]);
  const escaped = (u) => u.id === updates[0].id || u.id === updates[1].id;
  assert.deepEqual(
    doc.updates.filter((u) => !escaped(u)),
    updates.filter((u) => !escaped(u)),
    "every other body is unchanged",
  );
  // The long one is stored longer than 10,000 characters and saves again.
  const stored = store.getUpdate(updates[1].id).body;
  assert.equal(stored.length, long.length + 769);
  assert.deepEqual(parseBody(stored), [{ text: long }]);
  const edited = store.editUpdate(updates[1].id, stored.replace(/z$/, "y"), {
    actorId: null,
  });
  assert.equal(edited.body, stored.replace(/z$/, "y"));
  const longer = store.editUpdate(updates[1].id, `${stored}y`, {
    actorId: null,
  });
  assert.equal(longer.reason, "invalid", "10,001 characters as it reads");
  assert.ok(store.listUpdates(item.id).length > 0);
  // The saved file is current and loads as it is: no other copy.
  const again = await createStore({ file, log: quietLog });
  await again.flush();
  await assert.rejects(access(`${file}.v6.bak`), { code: "ENOENT" });
});

test("files that break the update rules are refused and left untouched", async (t) => {
  const { file, top, reply } = await threadFile(t);
  const good = await readDoc(file);
  const broken = (mutate) => {
    const copy = structuredClone(good);
    const byId = (id) => copy.updates.find((update) => update.id === id);
    mutate(copy, { top: byId(top.id), reply: byId(reply.id) });
    return copy;
  };
  const cases = [
    broken((doc) => delete doc.likes),
    broken((doc) => (doc.likes = {})),
    broken((doc) => doc.likes.push({ ...doc.likes[0] })),
    broken((doc) => doc.likes.push({ ...doc.likes[0], user_id: "999" })),
    broken((doc) => doc.likes.push({ ...doc.likes[0], update_id: "999" })),
    broken((doc) => (doc.likes[0].created_at = 1)),
    broken((doc, u) => (u.reply.parent_update_id = u.reply.id)),
    broken((doc, u) => (u.reply.parent_update_id = "999")),
    broken((doc, u) => (u.top.parent_update_id = u.reply.id)),
    broken((doc, u) => (u.reply.item_id = doc.items.at(-1).id)),
    broken((doc, u) => (u.reply.pinned_at = u.top.pinned_at)),
    broken((doc, u) => (u.top.edited_at = null)),
    broken((doc, u) => (u.top.pinned_at = true)),
    broken((doc, u) => (u.reply.parent_update_id = 7)),
    broken((doc) => (doc.notifications[0].kind = "liked")),
  ];
  for (const doc of cases) {
    const text = JSON.stringify(doc);
    await writeFile(file, text);
    await assert.rejects(
      createStore({ file, log: quietLog }),
      /Invalid mini-monday data file/,
      text.slice(0, 80),
    );
    assert.equal(await readFile(file, "utf8"), text, "left as it was");
  }
  // New notification kinds load.
  const kinds = broken((doc) => {
    for (const [index, kind] of ["mention", "reply", "like"].entries())
      doc.notifications[index].kind = kind;
  });
  await save(file, kinds);
  const store = await createStore({ file, log: quietLog });
  assert.equal(
    store.getNotification(kinds.notifications[0].id).kind,
    "mention",
  );
});
