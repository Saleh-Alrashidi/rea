/**
 * A ClickUp scan end to end below HTTP (SPEC-4 §4, §5): the job registry
 * runs the real connector against the fake ClickUp API, validates and
 * previews its snapshot, and an import job writes it to the store. The
 * token stays out of everything the jobs keep and log.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { scan } from "../server/import/connectors/clickup.js";
import { createImportJobs } from "../server/import/jobs.js";
import { startClickUpServer } from "./fixtures/import/clickup-server.js";
import { fakeClock } from "./fixtures/import/clickup-scan.js";
import { recordingLog } from "./helpers.js";
import { seededStore } from "./import-engine-fixtures.js";

const settled = (jobs, id, userId) =>
  new Promise((resolve) => {
    const poll = () => {
      const job = jobs.get(id, userId);
      if (job.state !== "running") resolve(job);
      else setTimeout(poll, 5);
    };
    poll();
  });

async function harness(t) {
  const clock = fakeClock();
  const server = await startClickUpServer({ now: clock.now });
  t.after(() => server.close());
  const transport = { env: { MM_IMPORT_CLICKUP_URL: server.endpoint }, clock };
  // The connector the routes load, with its test seam set to the fake.
  const clickup = { scan: (input) => scan({ ...input, transport }) };
  const { store, ids } = await seededStore();
  const log = recordingLog();
  const published = [];
  const jobs = createImportJobs({
    store,
    publish: (userId, payload) => published.push(payload),
    connectors: { clickup },
    log,
  });
  t.after(() => jobs.close());
  return { server, store, jobs, log, published, admin: ids.users.alex };
}

/**
 * ClickUp folders became folders of the board's Space (SPEC-6 §3.1),
 * each board keeping its source folder with ClickUp's private flag: one
 * per source folder that holds a Main board, in the Space's color, with
 * its private lists too ("Backlog"); the lists of the private folder
 * "Secret projects" stay at the Space's root, so its name is nowhere in
 * the Space. Lists keep their own names and folderless lists sit at the
 * Space's root.
 */
function checkFolders(store, { board, report, admin }) {
  assert.deepEqual(
    [board.import.folder, board.import.source_name],
    [
      { source_id: "90011001", name: "Engineering", private: false },
      "Sprint 12",
    ],
  );
  const { color } = store.getWorkspace(board.workspace_id);
  const folders = store.listFolders({ workspaceId: board.workspace_id });
  assert.deepEqual(
    folders.map((f) => [f.name, f.color, f.position, f.created_by]),
    [["Engineering", color, 1024, admin]],
  );
  const placed = (title) => {
    const id = report.links.find((link) => link.title === title).id;
    const record = store.getBoard(id);
    const folder = store.getFolder(record.folder_id ?? null);
    return [folder?.name ?? null, record.position];
  };
  assert.deepEqual(["Sprint 12", "Backlog", "Plans", "Inbox"].map(placed), [
    ["Engineering", 1024],
    ["Engineering", 2048],
    [null, 1024],
    [null, 2048],
  ]);
}

test("a ClickUp scan is previewed and imported through the jobs", async (t) => {
  const { server, store, jobs, log, published, admin } = await harness(t);
  const options = { include_comments: true };
  const started = jobs.startScan({
    userId: admin,
    source: "clickup",
    token: server.token,
    options,
  });
  const scanned = await settled(jobs, started.job.id, admin);
  assert.equal(scanned.state, "done", JSON.stringify(scanned.error));
  const { preview } = scanned;
  assert.equal(
    preview.source_label,
    "ClickUp workspaces Acme Corp, Side Project",
  );
  const { boards, items: top, subitems, docs } = preview.totals;
  assert.deepEqual([boards, top, subitems, docs], [6, 235, 2, 55]);
  const alex = preview.users.find((user) => user.source_id === "105");
  assert.equal(alex.proposal, "skip", "no Worklane user has this email");
  const plan = { users: { 105: "invite:member" } };
  const run = jobs.startImport({ userId: admin, scanJobId: scanned.id, plan });
  const done = await settled(jobs, run.job.id, admin);
  assert.equal(done.state, "done", JSON.stringify(done.error));
  const link = done.report.links.find((l) => l.title === "Sprint 12");
  const board = store.getBoard(link.id);
  assert.deepEqual(
    [board.import.source, board.import.source_id, board.import.source_url],
    ["clickup", "901101", "https://app.clickup.com/9001/v/li/901101"],
  );
  const inboxLink = done.report.links.find((l) => l.title === "Inbox");
  const inbox = store.getBoard(inboxLink.id).import;
  assert.equal(inbox.source_name, "Inbox");
  assert.equal(Object.hasOwn(inbox, "folder"), false, "folderless: no key");
  checkFolders(store, { board, report: done.report, admin });
  const { items, total } = store.listItems({ boardId: board.id, limit: 500 });
  assert.equal(total, 230);
  const plan1 = items.find((item) => item.name === "Plan the sprint");
  // 30 comments, one of them with 2 real replies (SPEC-6 §2.1).
  const posted = store.listUpdates(plan1.id, { limit: 100 });
  assert.equal(posted.length, 30);
  assert.equal(store.countUpdatesByItem().get(plan1.id), 32);
  const thread = posted.find((update) => update.body === "Comment 10");
  const replies = store.listReplies(thread.id);
  assert.deepEqual(
    replies.map((reply) => [reply.body, reply.parent_update_id]),
    [
      ["First reply", thread.id],
      ["Second reply", thread.id],
    ],
  );
  const ship = items.find((item) => item.name === "Ship it");
  const columns = store.listColumns(board.id);
  const assignees = columns.find((c) => c.role === "assignees");
  const invited = store.findUserByEmail("alex@former.test");
  assert.deepEqual(ship.values[assignees.id], [invited.id]);
  const groups = store.listGroups(board.id).map((group) => group.title);
  assert.deepEqual(groups, ["Open", "Closed"]);
  const status = columns.find((c) => c.role === "status");
  assert.deepEqual(Object.values(status.settings.labels_types), [
    "open",
    "custom",
    "custom",
    "done",
    "closed",
    "custom",
  ]);
  assert.deepEqual(
    store.listViews(board.id).map((view) => view.type),
    ["list", "table", "kanban"],
  );
  const named = (name) => items.find((item) => item.name === name);
  const [tests, unit, fixtures] = ["Write tests", "Unit tests", "Fixtures"].map(
    named,
  );
  assert.deepEqual(
    [unit.parent_id, fixtures.parent_id, tests.parent_id],
    [tests.id, unit.id, undefined],
    "subtasks are real subitems, two levels deep",
  );
  assert.notEqual(unit.group_id, tests.group_id, "each in its own group");
  // A scan is imported once; the second run names the first.
  const second = jobs.startImport({
    userId: admin,
    scanJobId: scanned.id,
    plan,
  });
  assert.deepEqual(second, {
    ok: false,
    reason: "already_imported",
    importJobId: run.job.id,
  });
  const leaks = (value) => JSON.stringify(value).includes(server.token);
  assert.ok(!leaks(jobs.get(started.job.id, admin)) && !leaks(done));
  assert.ok(!leaks(log.entries) && !leaks(published));
});
