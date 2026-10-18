/**
 * SSE fan-out (server/events.js): streams are indexed by board, user and
 * session, so each change reaches exactly the streams it concerns and
 * costs nothing for the others. Board changes reach that board's streams
 * (one access check per user), notifications only the named user's inbox,
 * user changes that user's streams, workspace changes the streams of its
 * boards, team changes every board stream; doc and note changes reach
 * none. Lost access, deactivation, ended and expired sessions close the
 * right streams only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEventHub } from "../server/events.js";
import { createStore } from "../server/store.js";
import { fakeResponse, plainText, seedIds } from "./helpers.js";

const LOOKUPS = ["getUser", "getBoard", "getWorkspace", "getTeam"];

/**
 * A store view recording the lookups the hub makes: `total()` counts
 * them, `checked()` lists the users whose access was looked up.
 */
function countingStore(store) {
  const calls = [];
  const counted = Object.fromEntries(
    LOOKUPS.map((name) => [
      name,
      (...args) => {
        calls.push([name, args[0]]);
        return store[name](...args);
      },
    ]),
  );
  const total = () => calls.length;
  const checked = () =>
    [
      ...new Set(calls.filter(([n]) => n === "getUser").map(([, id]) => id)),
    ].sort();
  const reset = () => void (calls.length = 0);
  return {
    view: Object.freeze({ ...store, ...counted }),
    total,
    checked,
    reset,
  };
}

async function setup(t, options = {}) {
  const store = await createStore({ file: null });
  const ids = seedIds(store);
  const counting = countingStore(store);
  const hub = createEventHub({ store: counting.view, ...options });
  t.after(() => hub.close());
  const open = (settings) => {
    const res = fakeResponse();
    assert.equal(hub.handle({}, res, settings), true);
    return res;
  };
  const changes = (res) =>
    res.writes
      .filter((text) => text.startsWith("event: change"))
      .map((text) => JSON.parse(text.split("data: ")[1]));
  const notifications = (res) =>
    res.writes
      .filter((text) => text.startsWith("event: notification"))
      .map((text) => JSON.parse(text.split("data: ")[1]));
  return { store, ids, hub, open, changes, notifications, ...counting };
}

test("a board change reaches only its board's streams and checks each user once", async (t) => {
  const { store, ids, open, changes, total, checked, reset } = await setup(t);
  const { users, boards } = ids;
  const roadmap = [users.sam, users.sam, users.noa].map((userId) =>
    open({ boardId: boards.roadmap, userId }),
  );
  const others = [
    open({ boardId: boards.budget, userId: users.alex }),
    open({ boardId: boards.hiring, userId: users.noa }),
    open({ boardId: boards.marketing, userId: users.chris }),
  ];
  const inbox = open({ stream: "me", userId: users.sam });
  const [item] = store.listItems({ boardId: boards.roadmap }).items;
  reset();
  store.renameItem(item.id, "Renamed", { actorId: users.alex });
  for (const res of roadmap) {
    assert.deepEqual(
      changes(res).map((event) => event.type),
      ["item_renamed"],
    );
  }
  for (const res of [...others, inbox]) assert.deepEqual(changes(res), []);
  // The board's audience: Sam and Noa, each looked up once (user, board,
  // workspace), however many streams they hold; nobody else.
  assert.deepEqual(checked(), [users.sam, users.noa].sort());
  assert.equal(total(), 6);
  // Doc and note changes concern no stream at all.
  reset();
  const doc = store.getDoc(ids.docs.vision);
  store.updateDoc(doc.id, { expectedVersion: doc.version, title: "Vision" });
  store.createNote({ ownerId: users.sam, title: "Private" });
  assert.equal(total(), 0);
  for (const res of roadmap) assert.equal(changes(res).length, 1);
});

test("notifications reach only the named user's inbox, rendered for them", async (t) => {
  const { store, ids, open, notifications, changes, checked, reset } =
    await setup(t);
  const { users, boards } = ids;
  const samInbox = [
    open({ stream: "me", userId: users.sam }),
    open({ stream: "me", userId: users.sam }),
  ];
  const noaInbox = open({ stream: "me", userId: users.noa });
  const samBoard = open({ boardId: boards.budget, userId: users.alex });
  reset();
  store.share({
    resourceKind: "board",
    resourceId: boards.hiring,
    subjectKind: "user",
    subjectIds: [users.sam],
    role: "viewer",
    actorId: users.alex,
  });
  for (const res of samInbox) {
    const [event] = notifications(res);
    const record = store.getNotification(event.resource_id);
    assert.equal(event.text, plainText(store, record.text));
    assert.match(event.text, /^Alex Rivera shared the board “Hiring plan”/);
  }
  assert.deepEqual(notifications(noaInbox), []);
  assert.deepEqual(changes(samBoard), [], "the hiring change is not budget's");
  assert.deepEqual(
    checked(),
    [users.alex, users.sam].sort(),
    "the recipient (once for both streams) and the actor its text names",
  );
});

test("access changes re-check and close exactly the streams they concern", async (t) => {
  const { store, ids, open, checked, reset } = await setup(t);
  const { users, boards, workspaces, teams } = ids;
  const hiringNoa = open({ boardId: boards.hiring, userId: users.noa });
  const roadmapNoa = open({ boardId: boards.roadmap, userId: users.noa });
  const roadmapSam = open({ boardId: boards.roadmap, userId: users.sam });
  const budgetAlex = open({ boardId: boards.budget, userId: users.alex });
  const noaInbox = open({ stream: "me", userId: users.noa });
  // A workspace change re-checks only the streams of its boards.
  reset();
  store.updateWorkspace(workspaces.leadership, { description: "Plans" });
  assert.deepEqual(checked(), [users.alex, users.noa].sort(), "hiring, budget");
  reset();
  store.updateWorkspace(workspaces.main, { description: "Everyone" });
  assert.deepEqual(checked(), [users.noa, users.sam].sort(), "roadmap");
  // Unsharing Noa from the hiring board ends her hiring stream only.
  store.unshare({
    resourceKind: "board",
    resourceId: boards.hiring,
    subjectKind: "user",
    subjectId: users.noa,
  });
  assert.equal(hiringNoa.writableEnded, true);
  assert.equal(roadmapNoa.writableEnded, false);
  // A team change re-checks every board stream; nobody loses access here.
  reset();
  store.updateTeam(teams.product, { description: "Builds" });
  assert.deepEqual(checked(), [users.alex, users.noa, users.sam].sort());
  assert.ok(
    [roadmapNoa, roadmapSam, budgetAlex].every((res) => !res.writableEnded),
  );
  // A user change re-checks that user's streams only.
  reset();
  store.updateUser(users.sam, { title: "Designer" });
  assert.deepEqual(checked(), [users.sam]);
  // Deactivating Noa ends all of Noa's streams and nobody else's.
  store.deactivateUser(users.noa);
  assert.equal(roadmapNoa.writableEnded, true);
  assert.equal(noaInbox.writableEnded, true);
  assert.equal(roadmapSam.writableEnded, false);
  assert.equal(budgetAlex.writableEnded, false);
});

test("sessions end their own streams; expired ones end at the next heartbeat", async (t) => {
  const live = new Set(["one", "two"]);
  const { ids, hub, open } = await setup(t, {
    heartbeatMs: 10,
    sessionActive: (id) => live.has(id),
  });
  const { users, boards } = ids;
  const one = open({
    boardId: boards.roadmap,
    userId: users.sam,
    sessionId: "one",
  });
  const inboxOne = open({ stream: "me", userId: users.sam, sessionId: "one" });
  const two = open({
    boardId: boards.roadmap,
    userId: users.sam,
    sessionId: "two",
  });
  const token = open({ boardId: boards.roadmap, userId: users.sam });
  hub.endSession("one");
  assert.equal(one.writableEnded, true);
  assert.equal(inboxOne.writableEnded, true);
  assert.equal(two.writableEnded, false);
  live.delete("two");
  await delay(40);
  assert.equal(two.writableEnded, true, "an expired session ends its stream");
  assert.equal(token.writableEnded, false, "token streams have no session");
  assert.equal(hub.size, 1);
});

test("per-user capacity counts that user's streams only", async (t) => {
  const { ids, hub } = await setup(t);
  const opened = [];
  for (let n = 0; n < 32; n += 1) {
    const res = fakeResponse();
    assert.equal(
      hub.handle({}, res, { stream: "me", userId: ids.users.sam }),
      true,
    );
    opened.push(res);
  }
  const refused = fakeResponse();
  assert.equal(
    hub.handle({}, refused, { stream: "me", userId: ids.users.sam }),
    false,
  );
  assert.equal(refused.status, 429);
  const other = fakeResponse();
  assert.equal(
    hub.handle({}, other, { stream: "me", userId: ids.users.noa }),
    true,
  );
  opened[0].emit("close");
  const again = fakeResponse();
  assert.equal(
    hub.handle({}, again, { stream: "me", userId: ids.users.sam }),
    true,
  );
});
