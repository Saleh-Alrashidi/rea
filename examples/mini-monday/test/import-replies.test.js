/**
 * Imported replies (SPEC-6 §2.1): a snapshot update carries its `replies`
 * (one level; deeper ones join the thread, the replies of an empty update
 * become updates), the board spec and the store keep them as real replies
 * (`parent_update_id`) with their bodies as written, plain source text
 * never reads as a mention token, and previews and reports count them.
 * Connector output is in import-clickup.test.js and import-monday.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { preview, run } from "../server/import/engine.js";
import { validateSnapshot } from "../server/import/snapshot.js";
import { parseBody } from "../server/mentions.js";
import { sampleSnapshot, seededStore } from "./import-engine-fixtures.js";

const BOARD = "workspaces[0].boards[0]";
const roadmapOf = (snapshot) => snapshot.workspaces[0].boards[0];
const update = (body, extra = {}) => ({
  body,
  author_source_id: "u-sam",
  author_name: "Sam L.",
  created_at: "2025-03-05T00:00:00.000Z",
  ...extra,
});

/** The sample snapshot with threads on its first item. */
function threaded() {
  const snapshot = sampleSnapshot();
  const [first] = roadmapOf(snapshot).items;
  first.updates = [
    update("Plan @[Sam](user:2) as text", {
      replies: [
        update("Agreed", { author_source_id: null, author_name: "Old Admin" }),
        update(" "),
        update("Nested parent", { replies: [update("Too deep")] }),
      ],
    }),
    update("", { replies: [update("Orphan reply")] }),
    update("Alone"),
  ];
  return snapshot;
}

test("snapshot updates keep one level of replies", () => {
  const result = validateSnapshot(threaded());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const [first] = roadmapOf(result.snapshot).items;
  assert.deepEqual(
    first.updates.map((u) => [u.body, u.replies?.map((r) => r.body)]),
    [
      ["Plan @[Sam](user:2) as text", ["Agreed", "Nested parent", "Too deep"]],
      ["Orphan reply", undefined],
      ["Alone", undefined],
    ],
  );
  const codes = result.snapshot.warnings.map((w) => [w.code, w.path]);
  const at = `${BOARD}.items[0].updates`;
  for (const expected of [
    ["empty_update", `${at}[0].replies[1]`],
    ["replies_flattened", `${at}[0].replies[2].replies`],
    ["empty_update", `${at}[1]`],
    ["replies_promoted", `${at}[1]`],
  ]) {
    assert.ok(
      codes.some(
        ([code, path]) => code === expected[0] && path === expected[1],
      ),
      expected.join(" "),
    );
  }
});

test("bodies are cut so that their stored form fits", () => {
  const snapshot = sampleSnapshot();
  const [first] = roadmapOf(snapshot).items;
  const token = "@[x](user:1)";
  first.updates = [update(`${"a".repeat(10_000 - token.length)}${token}`)];
  const result = validateSnapshot(snapshot);
  const [kept] = roadmapOf(result.snapshot).items[0].updates;
  // The token needs one escape, so its last character is cut.
  assert.equal(kept.body.length, 9_999);
  assert.ok(result.snapshot.warnings.some((w) => w.code === "truncated"));
});

test("imported replies are real replies, counted in previews and reports", async () => {
  const { store, ids, events } = await seededStore();
  const snapshot = threaded();
  const shown = preview(snapshot, { store, importerId: ids.users.alex });
  const board = shown.workspaces[0].boards[0];
  assert.equal(board.counts.updates, 6, "3 updates and their 3 replies");
  events.length = 0;
  const report = await run(snapshot, {}, { store, importerId: ids.users.alex });
  assert.equal(report.created.updates, 6);
  const link = report.links.find(
    (l) => l.kind === "board" && l.title === "Roadmap",
  );
  const [item] = store.listItems({ boardId: link.id }).items;
  const top = store.listUpdates(item.id);
  assert.deepEqual(
    top.map((u) => u.body),
    ["Alone", "Orphan reply", "Plan \\@[Sam](user:2) as text"],
  );
  const plan = top[2];
  assert.deepEqual(
    parseBody(plan.body),
    [{ text: "Plan @[Sam](user:2) as text" }],
    "source text never becomes a mention",
  );
  const replies = store.listReplies(plan.id);
  assert.deepEqual(
    replies.map((r) => [r.body, r.parent_update_id, r.author_name]),
    [
      ["Agreed", plan.id, "Old Admin"],
      ["Nested parent", plan.id, undefined],
      ["Too deep", plan.id, undefined],
    ],
  );
  assert.equal(store.countUpdatesByItem().get(item.id), 6);
  // Only the importer hears about the import.
  const told = events
    .filter((e) => e.type === "notification_created")
    .flatMap((e) => e.user_ids);
  assert.deepEqual(told, [ids.users.alex]);
});

test("the store refuses replies to imported replies", async () => {
  const { store, ids } = await seededStore();
  const spec = {
    workspaceId: ids.workspaces.main,
    importerId: ids.users.alex,
    name: "Imported",
    description: null,
    boardKind: "private",
    meta: { source: "monday", sourceId: "b-9", sourceUrl: null },
    label: "Import from monday.com",
    summary: null,
    members: [],
    groups: [{ key: "g", title: "Group", color: "#579bfc" }],
    columns: [],
    items: [
      {
        groupKey: "g",
        name: "Task",
        values: {},
        creatorId: null,
        createdAt: null,
        updates: [
          {
            body: "Top",
            creatorId: null,
            createdAt: null,
            replies: [
              {
                body: "Reply",
                creatorId: null,
                createdAt: null,
                replies: [{ body: "Deeper", creatorId: null, createdAt: null }],
              },
            ],
          },
        ],
      },
    ],
  };
  const before = store.listBoards({ limit: 1000 }).length;
  const refused = store.importBoard(spec);
  assert.equal(refused.reason, "invalid");
  assert.match(refused.message, /Replies can't have replies/);
  assert.equal(store.listBoards({ limit: 1000 }).length, before);
  delete spec.items[0].updates[0].replies[0].replies;
  assert.equal(store.importBoard(spec).counts.updates, 2);
});
