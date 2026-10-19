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
  const link = done.report.links.find(
    (l) => l.title === "Engineering / Sprint 12",
  );
  const board = store.getBoard(link.id);
  assert.deepEqual(
    [board.import.source, board.import.source_id, board.import.source_url],
    ["clickup", "901101", "https://app.clickup.com/9001/v/li/901101"],
  );
  assert.deepEqual(
    [board.import.folder, board.import.source_name],
    [{ source_id: "90011001", name: "Engineering" }, "Sprint 12"],
  );
  const inboxLink = done.report.links.find((l) => l.title === "Inbox");
  const inbox = store.getBoard(inboxLink.id).import;
  assert.equal(inbox.source_name, "Inbox");
  assert.equal(Object.hasOwn(inbox, "folder"), false, "folderless: no key");
  const { items, total } = store.listItems({ boardId: board.id, limit: 500 });
  assert.equal(total, 230);
  const plan1 = items.find((item) => item.name === "Plan the sprint");
  assert.equal(store.listUpdates(plan1.id, { limit: 100 }).length, 32);
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
