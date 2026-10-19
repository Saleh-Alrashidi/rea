/**
 * Notifications of the update model (SPEC-6 §2.2, `store/updates.js`):
 * `mention` (users and team members who can open the board, never the
 * actor, deactivated users or anyone without access), `reply` (the
 * parent's author and earlier repliers), `like` (the author, once per
 * update and liker), the assignees' `update` for top-level posts, at
 * most one notification per user and post, and team fan-out into full
 * inboxes in time linear in what is notified.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../server/store.js";
import { MAX_NOTIFICATIONS } from "../server/store/activity.js";
import { plainText, seedIds } from "./helpers.js";

async function seeded() {
  const store = await createStore({ file: null });
  const ids = seedIds(store);
  const events = [];
  store.on((event) => events.push(event));
  const [item] = store.listItems({ boardId: ids.boards.roadmap }).items;
  // Every notification since the last call: [user, kind, text, url].
  const seen = new Set();
  const keys = Object.keys(ids.users);
  const fresh = () => {
    const all = keys.flatMap((key) =>
      store
        .listNotifications(ids.users[key], { limit: 500 })
        .filter((n) => !seen.has(n.id))
        .map((n) => ({ key, n })),
    );
    for (const { n } of all) seen.add(n.id);
    return all
      .sort((a, b) => Number(a.n.id) - Number(b.n.id))
      .map(({ key, n }) => [key, n.kind, plainText(store, n.text), n.url]);
  };
  fresh();
  return { store, ids, events, item, fresh };
}
const token = (kind, id, name = "X") => `@[${name}](${kind}:${id})`;

test("mentions notify people who can open the board, once per post", async () => {
  const { store, ids, events, item, fresh } = await seeded();
  const { users, teams } = ids;
  const body = [
    token("user", users.noa, "Noa"),
    token("user", users.chris, "Chris"),
    token("user", users.morgan, "Morgan"),
    token("user", users.sam, "Sam"),
    token("team", teams.marketing, "Marketing"),
    token("user", users.jordan, "Jordan"),
    token("user", users.noa, "Noa again"),
  ].join(" ");
  events.length = 0;
  const update = store.createUpdate({
    itemId: item.id,
    body,
    creatorId: users.sam,
  });
  const url = `#/boards/${ids.boards.roadmap}/items/${item.id}/updates/${update.id}`;
  const mentioned = (key) => [
    key,
    "mention",
    `Sam Lee mentioned you in “${item.name}”`,
    url,
  ];
  // Chris (a guest without the board), deactivated Morgan and Sam (the
  // actor) hear nothing; Priya through the Marketing team; Alex, the
  // assignee, gets the usual update notification.
  assert.deepEqual(fresh(), [
    mentioned("noa"),
    mentioned("priya"),
    mentioned("jordan"),
    [
      "alex",
      "update",
      `Sam Lee posted an update on “${item.name}”`,
      `#/boards/${ids.boards.roadmap}/items/${item.id}`,
    ],
  ]);
  const told = events
    .filter((e) => e.type === "notification_created")
    .flatMap((e) => e.user_ids);
  assert.deepEqual(told, [users.noa, users.priya, users.jordan, users.alex]);
  // A mentioned assignee gets the mention only.
  store.createUpdate({
    itemId: item.id,
    body: `Ping ${token("user", users.alex, "Alex")}`,
    creatorId: users.noa,
  });
  assert.deepEqual(
    fresh().map(([key, kind]) => [key, kind]),
    [["alex", "mention"]],
  );
  // Edits notify only the people they newly mention.
  const edited = `${body} ${token("user", users.alex, "Alex")}`;
  store.editUpdate(update.id, edited, { actorId: users.sam });
  assert.deepEqual(
    fresh().map(([key, kind, , link]) => [key, kind, link]),
    [["alex", "mention", url]],
  );
  store.editUpdate(update.id, `${edited}!`, { actorId: users.sam });
  assert.deepEqual(fresh(), []);
});

test("replies notify the parent's author and earlier repliers, never the actor", async () => {
  const { store, ids, item, fresh } = await seeded();
  const { users } = ids;
  const post = (creatorId, body, parentId) =>
    store.createUpdate({ itemId: item.id, body, creatorId, parentId });
  const top = post(users.sam, "Thoughts?");
  fresh();
  post(users.noa, "Looks good", top.id);
  assert.deepEqual(
    fresh().map(([key, kind, text]) => [key, kind, text]),
    [["sam", "reply", `Noa Cohen replied to your update on “${item.name}”`]],
    "replies do not notify the assignees",
  );
  post(users.priya, `Agreed ${token("user", users.sam, "Sam")}`, top.id);
  assert.deepEqual(
    fresh().map(([key, kind, text]) => [key, kind, text]),
    [
      ["sam", "mention", `Priya Nair mentioned you in “${item.name}”`],
      ["noa", "reply", `Priya Nair replied to an update on “${item.name}”`],
    ],
  );
  const own = post(users.sam, "Thanks both", top.id);
  assert.deepEqual(
    fresh().map(([key, kind, , url]) => [key, kind, url.endsWith(own.id)]),
    [
      ["noa", "reply", true],
      ["priya", "reply", true],
    ],
  );
});

test("people who lose the board hear about no reply or mention", async () => {
  const { store, ids, fresh } = await seeded();
  const { users, boards } = ids;
  const [role] = store.listItems({ boardId: boards.hiring }).items;
  const grant = { resourceKind: "board", resourceId: boards.hiring };
  const subject = { ...grant, subjectKind: "user" };
  store.share({ ...subject, subjectIds: [users.sam], role: "editor" });
  const top = store.createUpdate({
    itemId: role.id,
    body: "Plan",
    creatorId: users.sam,
  });
  store.unshare({ ...subject, subjectId: users.sam });
  fresh();
  store.createUpdate({
    itemId: role.id,
    body: `Noted ${token("user", users.sam, "Sam")}`,
    creatorId: users.noa,
    parentId: top.id,
  });
  assert.deepEqual(fresh(), [], "Sam is still the author but has no access");
  assert.ok(
    store
      .listNotifications(users.sam, { limit: 500 })
      .every((n) => !plainText(store, n.text).includes(role.name)),
  );
});

test("likes notify the author once per update and liker", async () => {
  const { store, ids, item, fresh } = await seeded();
  const { users } = ids;
  const update = store.createUpdate({
    itemId: item.id,
    body: "Shipped",
    creatorId: users.sam,
  });
  fresh();
  store.likeUpdate(update.id, users.noa);
  assert.deepEqual(
    fresh().map(([key, kind, text]) => [key, kind, text]),
    [["sam", "like", `Noa Cohen liked your update on “${item.name}”`]],
  );
  store.unlikeUpdate(update.id, users.noa);
  store.likeUpdate(update.id, users.noa);
  assert.deepEqual(fresh(), [], "liking again does not notify again");
  store.likeUpdate(update.id, users.sam);
  assert.deepEqual(fresh(), [], "nobody hears about their own like");
  store.likeUpdate(update.id, users.alex);
  assert.deepEqual(
    fresh().map(([key, kind]) => [key, kind]),
    [["sam", "like"]],
    "another liker notifies again",
  );
  const anonymous = store.createUpdate({ itemId: item.id, body: "Bot note" });
  fresh();
  store.likeUpdate(anonymous.id, users.noa);
  assert.deepEqual(fresh(), [], "an update without an author tells nobody");
});

test("team mentions fan out to full inboxes fast, keeping each one's newest", async () => {
  const store = await createStore({ file: null });
  const { users, boards } = seedIds(store);
  const [item] = store.listItems({ boardId: boards.roadmap }).items;
  const members = Array.from({ length: 300 }, (_, n) =>
    store.createUser({ name: `Member ${n}`, email: `m${n}@fanout.test` }),
  ).map((user) => user.id);
  const team = store.createTeam({
    name: "Everyone",
    ownerId: users.alex,
    creatorId: users.alex,
  });
  store.addTeamMembers(team.id, members);
  const actorUnread = store.countUnreadNotifications(users.alex);
  const post = (body) =>
    store.createUpdate({ itemId: item.id, body, creatorId: users.alex });
  // Each post notifies all 300 (the old per-recipient trim took ~16 s
  // for these 200 posts and ~0.5 s for the last one; now ~0.3 s and ~8 ms).
  let started = performance.now();
  const posts = Array.from({ length: MAX_NOTIFICATIONS }, (_, n) =>
    post(`${token("team", team.id)} ${n}`),
  );
  const filling = performance.now() - started;
  assert.ok(filling < 4000, `${MAX_NOTIFICATIONS} posts took ${filling} ms`);
  started = performance.now();
  const many = Array.from({ length: 50 }, () => token("team", team.id));
  const last = post(many.join(" "));
  const took = performance.now() - started;
  assert.ok(took < 200, `one post into full inboxes took ${took} ms`);
  const urlOf = (update) => `/updates/${update.id}`;
  for (const id of [members[0], members.at(-1)]) {
    const inbox = store.listNotifications(id, { limit: 500 });
    assert.equal(inbox.length, MAX_NOTIFICATIONS, "capped");
    assert.ok(inbox[0].url.endsWith(urlOf(last)), "newest first");
    assert.ok(inbox.at(-1).url.endsWith(urlOf(posts[1])), "oldest dropped");
    assert.equal(inbox.filter((n) => n.url.endsWith(urlOf(last))).length, 1);
  }
  assert.equal(
    store.countUnreadNotifications(users.alex),
    actorUnread,
    "never the actor",
  );
});
