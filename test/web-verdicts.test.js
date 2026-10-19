/**
 * The UI reads every access verdict from the server (SPEC-2 §6) instead of
 * re-deriving rules: account capabilities from `me.capabilities`, the
 * share dialog's members and candidates, the people picker's
 * `assignable_users`, and the names the server redacts. These tests run
 * the UI's own documents, loaders and normalizers over HTTP against the
 * real servers, signed in as the seeded users.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesOf } from "../server/access.js";
import { request, subscribeMyEvents } from "../web/api.js";
import { activityActor } from "../web/ui/board/activity-model.js";
import { loadActivity, loadBoard, mutate } from "../web/ui/board/board-data.js";
import { createBoardSync } from "../web/ui/board/board-sync.js";
import { personChoices } from "../web/ui/board/cells.js";
import { displayText, personOf } from "../web/ui/board/values.js";
import { SOMEONE } from "../web/ui/components/labels.js";
import { can } from "../web/ui/components/permissions.js";
import { localSource } from "../web/ui/components/people-picker.js";
import {
  CANDIDATE_LIMIT,
  SHARE_CANDIDATES_QUERY,
  SHARE_QUERIES,
  ineligibleReasons,
  inviteRoles,
  normalizeCandidate,
  normalizeResource,
  preferredRole,
} from "../web/ui/components/share-model.js";
import { pausedStreams } from "../web/ui/shell/live-status.js";
import { SHELL_QUERY } from "../web/ui/shell/shell-data.js";
import { startTestServers } from "./helpers.js";

const CAPABILITIES = [
  "manage_users",
  "admin_directory",
  "create_workspace",
  "create_team",
  "create_content",
  "create_note",
];

/**
 * Real servers whose `/v2` the UI's `request()` reaches as the user picked
 * with `as(firstName)` (a browser session cookie per user).
 */
async function browser(t) {
  const started = await startTestServers();
  t.after(() => started.close());
  const original = globalThis.fetch;
  let headers = {};
  globalThis.fetch = (url, init = {}) =>
    original(new URL(url, started.hostOrigin), {
      ...init,
      headers: { ...init.headers, ...headers },
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const { ids } = started;
  return {
    ...started,
    as(name) {
      headers = started.sessionFor(ids.users[name]);
    },
  };
}

const candidatesFor = async (kind, id, query = "") =>
  (
    await request(SHARE_CANDIDATES_QUERY, {
      kind,
      id,
      query,
      limit: CANDIDATE_LIMIT,
    })
  ).share_candidates.map(normalizeCandidate);

test("account capabilities come only from me.capabilities", async (t) => {
  const server = await browser(t);
  for (const name of ["alex", "sam", "jordan", "chris"]) {
    server.as(name);
    const { me } = await request(SHELL_QUERY);
    const user = server.store.getUser(server.ids.users[name]);
    assert.deepEqual(me.capabilities, capabilitiesOf(user), name);
    for (const capability of CAPABILITIES) {
      assert.equal(
        can(me, capability),
        capabilitiesOf(user).includes(capability),
        `${name} ${capability}`,
      );
    }
  }
  // A role alone grants nothing: the client keeps no role table.
  assert.equal(can({ role: "admin", status: "active" }, "manage_users"), false);
  assert.equal(can(null, "create_note"), false);
  assert.equal(can({ capabilities: "create_note" }, "create_note"), false);
});

test("share dialog members carry the server's verdicts", async (t) => {
  const server = await browser(t);
  const hiring = server.ids.boards.hiring;
  const { alex, noa, sam } = server.ids.users;
  const load = async () =>
    normalizeResource(
      "board",
      await request(SHARE_QUERIES.board, { id: hiring }),
      hiring,
    );
  server.as("alex");
  let board = await load();
  const member = (id) => board.members.find((entry) => entry.id === id);
  // Alex is the board's only effective owner: kept, with one role.
  assert.deepEqual(
    [
      member(alex).canRemove,
      member(alex).canChangeRole,
      member(alex).roleOptions,
    ],
    [false, false, ["owner"]],
  );
  assert.match(member(alex).reason, /needs at least one owner/);
  assert.deepEqual(
    [member(noa).canRemove, member(noa).canChangeRole, member(noa).roleOptions],
    [true, true, ["owner", "editor", "viewer"]],
  );
  assert.equal(member(noa).reason, null);

  // A deactivated member can be removed, never given another role.
  await request(
    `mutation { share(resource_kind: board, resource_id: "${hiring}",
      subject_kind: user, subject_ids: ["${sam}"], role: viewer) { id } }`,
  );
  await request(`mutation { deactivate_user(user_id: "${sam}") { id } }`);
  board = await load();
  assert.deepEqual(
    [member(sam).canRemove, member(sam).canChangeRole, member(sam).roleOptions],
    [true, false, []],
  );
  assert.match(member(sam).reason, /only be removed/);

  // An editor sees the members but no verdict lets them change anything.
  server.as("noa");
  board = await load();
  assert.equal(board.canManage, false);
  for (const entry of board.members) {
    assert.deepEqual(
      [entry.canRemove, entry.canChangeRole, entry.roleOptions],
      [false, false, []],
    );
    assert.equal(entry.reason, null);
  }
});

test("share candidates: who could join, why not and with which roles", async (t) => {
  const server = await browser(t);
  const { boards, workspaces, notes, users } = server.ids;
  server.as("alex");
  const onHiring = await candidatesFor("board", boards.hiring);
  const ids = onHiring.map((entry) => entry.id);
  assert.ok(!ids.includes(users.alex) && !ids.includes(users.noa), "members");
  const chris = onHiring.find((entry) => entry.id === users.chris);
  assert.equal(chris.eligible, false);
  assert.match(chris.reason, /Guests can only join shareable boards/);
  assert.deepEqual(chris.roleOptions, []);
  const priya = onHiring.find((entry) => entry.id === users.priya);
  assert.deepEqual(
    [priya.eligible, priya.reason, priya.roleOptions],
    [true, null, ["owner", "editor", "viewer"]],
  );
  assert.ok(ineligibleReasons(onHiring).some((text) => /Guests/.test(text)));
  // The invite select offers what the server accepts.
  const roles = inviteRoles([], onHiring);
  assert.deepEqual(roles, ["owner", "editor", "viewer"]);
  assert.equal(preferredRole("board", roles), "editor");
  assert.deepEqual(inviteRoles([chris], onHiring), []);
  const mixed = [{ roleOptions: ["editor", "viewer"] }, priya];
  assert.deepEqual(inviteRoles(mixed, onHiring), ["editor", "viewer"]);
  assert.equal(preferredRole("board", ["owner"], "viewer"), "owner");
  assert.equal(preferredRole("board", [], "editor"), null);
  // The query narrows the list on the server.
  const found = await candidatesFor("board", boards.hiring, "CHR");
  assert.deepEqual(
    found.map((entry) => entry.name),
    ["Chris Taylor"],
  );

  // Workspaces take owners and editors, notes editors and viewers; a
  // note's owner is never a candidate.
  const onMain = await candidatesFor("workspace", workspaces.main);
  assert.deepEqual(inviteRoles([], onMain), ["owner", "editor"]);
  const onIdeas = await candidatesFor("note", notes.ideas);
  assert.ok(!onIdeas.some((entry) => entry.id === users.alex), "the owner");
  const noteRoles = inviteRoles([], onIdeas);
  assert.deepEqual(noteRoles, ["editor", "viewer"]);
  assert.equal(preferredRole("note", noteRoles), "viewer");

  // Only owners get candidates; the dialog asks only when it can manage.
  server.as("noa");
  const asEditor = normalizeResource(
    "board",
    await request(SHARE_QUERIES.board, { id: boards.hiring }),
    boards.hiring,
  );
  assert.equal(asEditor.canManage, false);
  await assert.rejects(
    candidatesFor("board", boards.hiring),
    (error) => error.code === "FORBIDDEN",
  );
});

test("the people picker offers the board's assignable users", async (t) => {
  const server = await browser(t);
  const { boards, users } = server.ids;
  server.as("alex");
  const hiring = await loadBoard(boards.hiring);
  assert.deepEqual(
    hiring.assignableUsers.map((user) => user.id).sort(),
    [users.alex, users.noa].sort(),
  );
  const roadmap = await loadBoard(boards.roadmap);
  const offered = roadmap.assignableUsers.map((user) => user.id);
  assert.ok(offered.includes(users.jordan), "viewers can be assigned");
  assert.ok(!offered.includes(users.chris), "the guest cannot open it");
  assert.ok(!offered.includes(users.morgan), "deactivated users are not");

  // Someone assigned who can no longer open the board stays listed, only
  // to be removed; everyone else listed is assignable.
  const directory = new Map([
    [users.chris, { id: users.chris, name: "Chris Taylor" }],
  ]);
  const choices = personChoices({
    ids: [users.chris],
    assignable: roadmap.assignableUsers,
    users: directory,
  });
  assert.deepEqual(choices.at(-1), {
    id: users.chris,
    name: "Chris Taylor",
    assignable: false,
  });
  assert.ok(choices.slice(0, -1).every((user) => user.assignable));

  // The server refuses the rest with a message the UI shows as is.
  const people = roadmap.columns.find((column) => column.type === "people");
  const value = JSON.stringify({
    personsAndTeams: [{ id: Number(users.chris), kind: "person" }],
  });
  await assert.rejects(
    mutate("changeValue", {
      boardId: boards.roadmap,
      itemId: roadmap.items[0].id,
      columnId: people.id,
      value,
    }),
    (error) => error.message === "Chris Taylor cannot access this board",
  );

  // A guest picks only from people they may see who can open the board.
  server.as("chris");
  const marketing = await loadBoard(boards.marketing);
  assert.deepEqual(
    marketing.assignableUsers.map((user) => user.id).sort(),
    [users.chris, users.priya].sort(),
  );
});

test("names the server hides read Someone", async (t) => {
  const server = await browser(t);
  const { boards, users } = server.ids;
  const marketing = { resourceKind: "board", resourceId: boards.marketing };
  // Noa renames an item on the Shareable board and leaves it again: Chris,
  // its guest, may no longer see who Noa is.
  server.store.share({
    ...marketing,
    subjectKind: "user",
    subjectIds: [users.noa],
    role: "editor",
    actorId: users.priya,
  });
  server.as("noa");
  const board = await loadBoard(boards.marketing);
  await mutate("renameItem", {
    boardId: boards.marketing,
    itemId: board.items[0].id,
    value: "Renamed by Noa",
  });
  server.store.unshare({
    ...marketing,
    subjectKind: "user",
    subjectId: users.noa,
    actorId: users.priya,
  });
  const renamed = async () =>
    (await loadActivity(boards.marketing, { limit: 5 })).find(
      (entry) => entry.kind === "item_renamed",
    );
  server.as("chris");
  assert.deepEqual(activityActor(await renamed()), {
    kind: "hidden",
    name: SOMEONE,
  });
  // Board members still see who it was.
  server.as("priya");
  const seen = activityActor(await renamed());
  assert.deepEqual(
    [seen.kind, seen.name],
    ["user", server.store.getUser(users.noa).name],
  );

  // People the viewer has no record of read "Someone", never an ID.
  assert.deepEqual(personOf(new Map(), "12"), {
    id: "12",
    name: SOMEONE,
    initials: "?",
  });
  const column = { id: "person", type: "people" };
  assert.equal(displayText(column, ["12"], new Map()), SOMEONE);
});

test("local picker sources skip deactivated and excluded people", () => {
  const source = localSource({
    users: [
      { id: 1, name: "Alex Kim", email: "alex@example.com", status: "active" },
      { id: 2, name: "Sam Lee", email: "sam@example.com", status: "active" },
      { id: 7, name: "Morgan", email: "m@example.com", status: "deactivated" },
    ],
    teams: [{ id: 3, name: "Product" }],
    allowTeams: false,
    excluded: new Set(["user:1"]),
  });
  assert.deepEqual(
    source("").map((subject) => subject.id),
    ["2"],
  );
  assert.deepEqual(
    source("SAM@").map((subject) => subject.name),
    ["Sam Lee"],
  );
  assert.deepEqual(source("morgan"), []);
});

test("an ended board stream pauses live updates only while the board stays", async (t) => {
  const server = await browser(t);
  const { boards } = server.ids;
  server.as("sam");
  const run = async (boardId) => {
    const state = {
      boardId,
      board: null,
      boardStatus: "loading",
      card: null,
      pendingMutations: 0,
      mutationSeq: 0,
      refreshFailed: false,
    };
    const ends = [];
    let paused = 0;
    const sync = createBoardSync({
      state,
      render() {},
      forwardEvent() {},
      watchBoard: (_id, _listener, onEnd) => {
        ends.push(onEnd);
        return () => {};
      },
      refreshShell() {},
      onLivePaused: () => (paused += 1),
    });
    await sync.refresh();
    sync.subscribe(boardId);
    return { state, end: () => ends[0](), paused: () => paused };
  };
  // The stream was refused (too many streams) while the board is open.
  const open = await run(boards.roadmap);
  await open.end();
  assert.equal(open.state.boardStatus, "ready");
  assert.equal(open.paused(), 1);
  // The board went away with the stream: the page says so, no banner.
  const gone = await run(boards.roadmap);
  server.as("alex");
  await mutate("setBoardKind", { id: boards.roadmap, kind: "private" });
  server.as("sam");
  await gone.end();
  assert.equal(gone.state.boardStatus, "missing");
  assert.equal(gone.paused(), 0);
});

test("paused streams: the banner shows while any stream is paused", () => {
  const streams = pausedStreams();
  assert.equal(streams.set("me", true), true);
  assert.equal(streams.set("board:4", true), true);
  assert.equal(streams.set("me", false), true);
  assert.equal(streams.set("board:4", false), false);
  assert.equal(streams.set("board:9", false), false);
  assert.deepEqual(streams.keys(), []);
});

test("the user stream forwards notifications and sidebar changes, and reports its end once, never on a reconnect", (t) => {
  const sources = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.listeners = new Map();
      sources.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    fire(type, readyState) {
      this.readyState = readyState;
      this.listeners.get(type)?.({});
    }
    close() {}
  }
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;
  t.after(() => {
    globalThis.EventSource = original;
  });
  let ended = 0;
  const heard = [];
  subscribeMyEvents(
    {
      notification: (event) => heard.push(["notification", event.type]),
      sidebar: (change) => heard.push(["sidebar", change]),
    },
    () => (ended += 1),
  );
  const [source] = sources;
  assert.equal(source.url, "/v2/events?stream=me");
  const send = (type, data) => source.listeners.get(type)({ data });
  send("sidebar", JSON.stringify({ type: "folder_moved", resource_id: "4" }));
  send("sidebar", "not json");
  send("sidebar", JSON.stringify({ resource_id: "4" }));
  send("notification", JSON.stringify({ type: "notifications_read" }));
  assert.deepEqual(heard, [
    ["sidebar", { type: "folder_moved", resource_id: "4" }],
    ["notification", "notifications_read"],
  ]);
  source.fire("error", FakeEventSource.CONNECTING);
  assert.equal(ended, 0, "a network drop retries on its own");
  source.fire("error", FakeEventSource.CLOSED);
  source.fire("error", FakeEventSource.CLOSED);
  assert.equal(ended, 1);
});
