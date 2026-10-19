/**
 * Sidebar changes on the user streams (server/events.js, SPEC-6 §3.3):
 * folder changes reach who can see the folder's Space, Space moves who
 * can see that Space, board and doc moves who can open the board or doc
 * (or could, in the Space it left), as `event: sidebar` with IDs only.
 * Users who cannot see the Space, board or doc get nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createEventHub } from "../server/events.js";
import { createStore } from "../server/store.js";
import {
  fakeResponse,
  openStream,
  seedIds,
  startTestServers,
} from "./helpers.js";

const NAMES = ["alex", "sam", "noa", "priya", "jordan", "chris"];

async function setup(t) {
  const store = await createStore({ file: null });
  const ids = seedIds(store);
  const hub = createEventHub({ store });
  t.after(() => hub.close());
  const inboxes = Object.fromEntries(
    NAMES.map((name) => {
      const res = fakeResponse();
      const userId = ids.users[name];
      assert.equal(hub.handle({}, res, { stream: "me", userId }), true);
      return [name, res];
    }),
  );
  const board = fakeResponse();
  hub.handle({}, board, { boardId: ids.boards.roadmap, userId: ids.users.sam });
  /** Who got sidebar messages since the last call: `{ name: [payload] }`. */
  const heard = () => {
    const seen = {};
    for (const [name, res] of Object.entries(inboxes)) {
      const messages = res.writes
        .filter((text) => text.startsWith("event: sidebar\n"))
        .map((text) => JSON.parse(text.split("data: ")[1]));
      res.writes.length = 0;
      if (messages.length > 0) seen[name] = messages;
    }
    return seen;
  };
  return { store, ids, inboxes, board, heard };
}

const everyone = (names, payloads) =>
  Object.fromEntries(names.map((name) => [name, payloads]));
const MAIN_AUDIENCE = ["alex", "sam", "noa", "priya", "jordan"];

test("folder changes reach who can see the folder's Space, with IDs only", async (t) => {
  const { store, ids, heard, board } = await setup(t);
  const { main, leadership } = ids.workspaces;
  const { alex } = ids.users;
  const folder = store.createFolder({ workspaceId: main, name: "Plans" });
  const payload = (type) => ({
    type,
    resource_kind: "folder",
    resource_id: folder.id,
    workspace_id: main,
  });
  // The guest Chris has no role on Main.
  assert.deepEqual(
    heard(),
    everyone(MAIN_AUDIENCE, [payload("folder_created")]),
  );
  store.updateFolder(folder.id, { name: "Plans 2027" });
  const second = store.createFolder({ workspaceId: main, name: "Later" });
  store.moveFolder(second.id, { beforeId: folder.id });
  store.deleteFolder(folder.id);
  const changes = heard();
  assert.deepEqual(
    changes.sam.map((change) => change.type),
    ["folder_updated", "folder_created", "folder_moved", "folder_deleted"],
  );
  assert.deepEqual(Object.keys(changes).sort(), [...MAIN_AUDIENCE].sort());
  // Closed Leadership: only its member Alex; Noa, who edits a private
  // board in it, cannot see the Space.
  const secret = store.createFolder({
    workspaceId: leadership,
    name: "Board pack",
    creatorId: alex,
  });
  assert.deepEqual(heard(), {
    alex: [
      {
        type: "folder_created",
        resource_kind: "folder",
        resource_id: secret.id,
        workspace_id: leadership,
      },
    ],
  });
  assert.equal(
    board.writes.some((text) => text.includes("folder_")),
    false,
    "board streams get no folder changes",
  );
});

test("Space moves reach who can see that Space", async (t) => {
  const { store, ids, heard } = await setup(t);
  const { main, leadership } = ids.workspaces;
  store.moveWorkspace(leadership, { beforeId: main });
  const leadershipMoved = {
    type: "workspace_moved",
    resource_kind: "workspace",
    resource_id: leadership,
  };
  assert.deepEqual(heard(), { alex: [leadershipMoved] });
  store.moveWorkspace(main, { beforeId: leadership });
  assert.deepEqual(
    heard(),
    everyone(MAIN_AUDIENCE, [{ ...leadershipMoved, resource_id: main }]),
  );
});

test("board moves reach who can open the board, also in the Space it left", async (t) => {
  const { store, ids, heard } = await setup(t);
  const { main, leadership } = ids.workspaces;
  const { hiring, roadmap, marketing } = ids.boards;
  // The private Hiring plan: its members Alex and Noa, not Sam.
  const folder = store.createFolder({ workspaceId: leadership, name: "HR" });
  heard();
  store.moveBoard(hiring, { folderId: folder.id });
  const moved = (boardId) => [{ type: "board_moved", board_id: boardId }];
  assert.deepEqual(heard(), everyone(["alex", "noa"], moved(hiring)));
  // The shareable Marketing launch: its members Priya and the guest Chris.
  store.moveBoard(marketing, { beforeId: roadmap });
  assert.deepEqual(heard(), everyone(["priya", "chris"], moved(marketing)));
  // The public roadmap goes to closed Leadership: Main's members lose it,
  // so they hear of it too, without learning where it went.
  store.moveBoard(roadmap, { workspaceId: leadership });
  assert.deepEqual(heard(), everyone(MAIN_AUDIENCE, moved(roadmap)));
  // Back in Main, the Leadership audience (Alex) is a Main member anyway.
  store.moveBoard(roadmap, { workspaceId: main });
  assert.deepEqual(heard(), everyone(MAIN_AUDIENCE, moved(roadmap)));
});

test("doc moves reach who can open the doc", async (t) => {
  const { store, ids, heard } = await setup(t);
  const { main, leadership } = ids.workspaces;
  const { brief, vision, offsite } = ids.docs;
  const moved = (docId) => [
    { type: "doc_moved", resource_kind: "doc", resource_id: docId },
  ];
  // The private Launch brief: Priya, the guest Chris and the Marketing
  // team (Sam, Priya); not Noa or Jordan, and the admin only by a grant.
  const folder = store.createFolder({ workspaceId: main, name: "Launch" });
  heard();
  store.moveDoc(brief, { folderId: folder.id });
  assert.deepEqual(heard(), everyone(["sam", "priya", "chris"], moved(brief)));
  store.moveDoc(offsite, { beforeId: null, workspaceId: leadership });
  assert.deepEqual(heard(), {}, "a move that changes nothing says nothing");
  store.moveDoc(vision, { workspaceId: leadership });
  assert.deepEqual(heard(), everyone(MAIN_AUDIENCE, moved(vision)));
});

test("the user stream carries sidebar changes over HTTP", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { ids, hostUrl, sessionFor, as, store } = servers;
  const { sam, chris, alex } = ids.users;
  const url = new URL("/v2/events?stream=me", hostUrl);
  const watch = async (userId) => {
    const stream = await openStream(url, sessionFor(userId));
    t.after(() => stream.close());
    await stream.next(/^: connected\n\n/);
    return stream;
  };
  const [samStream, chrisStream] = [await watch(sam), await watch(chris)];
  const created = await as(sam).data(
    `mutation { create_folder(workspace_id: "${ids.workspaces.main}", name: "Q4") { id } }`,
  );
  const [, data] = await samStream.next(/event: sidebar\ndata: (.*)\n\n/);
  assert.deepEqual(JSON.parse(data), {
    type: "folder_created",
    resource_kind: "folder",
    resource_id: created.create_folder.id,
    workspace_id: ids.workspaces.main,
  });
  // Chris's next message is his own notification: the folder never came.
  store.share({
    resourceKind: "doc",
    resourceId: ids.docs.vision,
    subjectKind: "user",
    subjectIds: [chris],
    role: "viewer",
    actorId: alex,
  });
  const [before] = await chrisStream.next(/^[\s\S]*?event: notification\n/);
  assert.doesNotMatch(before, /event: sidebar/);
});
