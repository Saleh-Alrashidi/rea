/**
 * The Updates pane's data (`web/ui/board/updates-data.js`, the update
 * mutations of `board-data.js` and the inbox's Mentions filter) against
 * the real schema and store, as the seeded users: the server's order is
 * kept, bodies come as the reader's `body_parts` (a task the reader
 * cannot open has no name), and the task picker finds only tasks the
 * author can open. Paging and the field budget are in
 * web-updates-paging.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../server/graphql/parse.js";
import { mutate } from "../web/ui/board/board-data.js";
import { mentionToken } from "../web/ui/board/mention-tokens.js";
import {
  UPDATE_QUERIES,
  loadUpdates,
  searchTasks,
} from "../web/ui/board/updates-data.js";
import { NOTIFICATIONS_QUERY } from "../web/ui/shell/notifications.js";
import { request } from "../web/api.js";
import { realServer } from "./web-updates-server.js";

test("the documents validate against the schema", async (t) => {
  await realServer(t);
  for (const [name, source] of Object.entries(UPDATE_QUERIES)) {
    assert.doesNotThrow(() => parse(source, { maxDepth: 12 }), name);
  }
  assert.doesNotThrow(() => parse(NOTIFICATIONS_QUERY));
});

test("updates keep the server's order: pinned, newest, replies oldest", async (t) => {
  const server = await realServer(t);
  const task = server.item("Product roadmap", "Set up CI pipeline");
  const post = async (body, parentId = null) =>
    (await mutate("createUpdate", { itemId: task.id, body, parentId })).id;
  const first = await post("First");
  const second = await post("Second");
  const third = await post("Third");
  const reply = await post("A reply", first);
  await post("Another reply", first);
  await mutate("pinUpdate", { id: first, itemId: task.id });
  await mutate("editUpdate", { id: third, body: "Third, edited" });
  server.as("sam");
  await mutate("likeUpdate", { id: second });
  await mutate("likeUpdate", { id: reply });

  const asSam = await loadUpdates(task.id);
  assert.deepEqual(
    asSam.list.map((update) => update.id),
    [first, third, second],
  );
  assert.equal(asSam.hasMore, false);
  const [pinned, edited, liked] = asSam.list;
  assert.equal(pinned.pinned, true);
  assert.deepEqual(
    pinned.replies.map((entry) => entry.parts[0].text),
    ["A reply", "Another reply"],
  );
  assert.equal(pinned.replies[0].likedByMe, true);
  assert.ok(edited.editedAt);
  assert.deepEqual(edited.parts, [{ type: "text", text: "Third, edited" }]);
  assert.deepEqual(
    [liked.likesCount, liked.likedByMe, liked.likers.map((u) => u.name)],
    [1, true, ["Sam Lee"]],
  );
  // Alex wrote them: Sam may neither edit nor delete; Alex may both.
  assert.deepEqual([liked.canEdit, liked.canDelete], [false, false]);
  assert.equal(liked.creator.name, "Alex Rivera");
  server.as("alex");
  const asAlex = await loadUpdates(task.id);
  assert.deepEqual(
    [asAlex.list[2].canEdit, asAlex.list[2].canDelete],
    [true, true],
  );
  assert.equal(asAlex.list[2].likedByMe, false);
  // Deleting a top-level update takes its replies along.
  await mutate("deleteUpdate", { id: first });
  const after = await loadUpdates(task.id);
  assert.deepEqual(
    after.list.map((update) => update.id),
    [third, second],
  );
  assert.equal(await loadUpdates("999999"), null);
});

test("bodies come as the reader's parts; a private task has no name", async (t) => {
  const server = await realServer(t);
  const task = server.item("Product roadmap", "Design onboarding flow");
  const ci = server.item("Product roadmap", "Set up CI pipeline");
  const hiring = server.item("Hiring plan", "Senior backend engineer");
  const product = server.store
    .listTeams()
    .find((team) => team.name === "Product");
  const body = [
    mentionToken({
      kind: "user",
      id: server.users.get("sam"),
      name: "Sam Lee",
    }),
    " and ",
    mentionToken({ kind: "team", id: product.id, name: "Product" }),
    ": see ",
    mentionToken({ kind: "item", id: ci.id, name: "Set up CI pipeline" }),
    ", ",
    mentionToken({ kind: "item", id: hiring.id, name: hiring.name }),
    " and https://example.com/x.",
  ].join("");
  await mutate("createUpdate", { itemId: task.id, body, parentId: null });
  server.as("sam");
  const [update] = (await loadUpdates(task.id)).list;
  const roadmap = server.board("Product roadmap").id;
  assert.deepEqual(update.parts, [
    { type: "user", text: "Sam Lee", id: server.users.get("sam") },
    { type: "text", text: " and " },
    { type: "team", text: "Product", id: product.id },
    { type: "text", text: ": see " },
    { type: "item", text: "Set up CI pipeline", id: ci.id, boardId: roadmap },
    { type: "text", text: ", " },
    { type: "item", text: null, id: hiring.id, boardId: null },
    { type: "text", text: " and " },
    {
      type: "link",
      text: "https://example.com/x",
      url: "https://example.com/x",
    },
    { type: "text", text: "." },
  ]);
  // The raw body Sam reads never names the private task either.
  assert.ok(!update.body.includes(hiring.name));
  server.as("alex");
  const [own] = (await loadUpdates(task.id)).list;
  assert.equal(own.parts[6].text, hiring.name);
  assert.equal(own.body, body);

  // Sam was mentioned: the inbox's Mentions filter lists it, linked to it.
  server.as("sam");
  const { notifications } = await request(NOTIFICATIONS_QUERY, {
    kinds: ["mention"],
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, "mention");
  assert.equal(
    notifications[0].url,
    `#/boards/${roadmap}/items/${task.id}/updates/${own.id}`,
  );
  const all = await request(NOTIFICATIONS_QUERY, { kinds: null });
  assert.ok(all.notifications.length > 1);
});

test("the task picker finds tasks the author can open, with status", async (t) => {
  const server = await realServer(t);
  const cache = new Map();
  const found = await searchTasks("onboarding", cache);
  assert.deepEqual(
    found.map((task) => [task.name, task.boardName]),
    [["Design onboarding flow", "Product roadmap"]],
  );
  assert.equal(found[0].statusLabel, "Working on it");
  assert.match(found[0].color, /^#[0-9a-f]{6}$/i);
  assert.ok(cache.has(found[0].boardId));
  const hiring = await searchTasks("engineer", cache);
  assert.ok(hiring.some((task) => task.boardName === "Hiring plan"));
  // Sam cannot open the Hiring plan board.
  server.as("sam");
  const forSam = await searchTasks("engineer", new Map());
  assert.ok(!forSam.some((task) => task.boardName === "Hiring plan"));
  assert.deepEqual(await searchTasks("no such task here", new Map()), []);
});
