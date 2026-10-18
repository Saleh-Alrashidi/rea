/**
 * What the rest of Worklane sees of imports (SPEC-4 §5): progress as
 * `event: import` on the importer's `stream=me` only, the one
 * `import_finished` notification, `Board.import` and the import's activity
 * label in GraphQL, and the import routes behind the hosted site gate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { apiClient, openStream, startTestServers } from "./helpers.js";
import { codeOf, startHosted } from "./hosted-helpers.js";
import { sampleSnapshot } from "./import-engine-fixtures.js";

const TOKEN = "clickup-token-0123456789abcdef";
/** A connector returning the sample snapshot as `source` data. */
const stub = (source) => ({
  scan: async () => ({ ...sampleSnapshot(), source }),
});
const CONNECTORS = {
  monday: stub("monday"),
  clickup: stub("clickup"),
  files: stub("csv"),
};
const JSON_TYPE = { "Content-Type": "application/json" };

async function setup(t) {
  const servers = await startTestServers({ importConnectors: CONNECTORS });
  t.after(() => servers.close());
  const admin = servers.sessionFor(servers.ids.users.alex);
  const post = (path, body) =>
    fetch(new URL(path, servers.hostUrl), {
      method: "POST",
      headers: { ...admin, ...JSON_TYPE },
      body: JSON.stringify(body),
    }).then((response) => response.json());
  const stream = async (headers) => {
    const url = new URL("/v2/events?stream=me", servers.hostUrl);
    const opened = await openStream(url, headers);
    t.after(() => opened.close());
    await opened.next(/: connected\n\n/);
    return opened;
  };
  return { ...servers, admin, post, stream };
}

/** Scans and imports the sample snapshot; resolves with both job IDs. */
async function importSample(s) {
  const scan = await s.post("/import/scan", {
    source: "clickup",
    token: TOKEN,
  });
  for (let n = 0; n < 50; n += 1) {
    const response = await fetch(
      new URL(`/import/jobs/${scan.job_id}`, s.hostUrl),
      {
        headers: s.admin,
      },
    );
    if ((await response.json()).state === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const run = await s.post("/import/run", {
    scan_job_id: scan.job_id,
    plan: {},
  });
  return { scanId: scan.job_id, runId: run.job_id };
}

test("progress streams as event: import to the importer only", async (t) => {
  const s = await setup(t);
  s.store.updateUser(s.ids.users.sam, { role: "admin" });
  const mine = await s.stream(s.admin);
  const other = await s.stream(s.sessionFor(s.ids.users.sam));
  const boardUrl = new URL(
    `/v2/events?board_id=${s.ids.boards.roadmap}`,
    s.hostUrl,
  );
  const board = await openStream(boardUrl, s.admin);
  t.after(() => board.close());
  await board.next(/: connected\n\n/);
  const { scanId, runId } = await importSample(s);
  const read = async (id, state) => {
    for (;;) {
      const [, data] = await mine.next(/event: import\ndata: (.*)\n\n/);
      const payload = JSON.parse(data);
      if (payload.job_id === id && payload.state === state) return payload;
    }
  };
  const scanned = await read(scanId, "done");
  assert.deepEqual(Object.keys(scanned).toSorted(), [
    "job_id",
    "kind",
    "progress",
    "state",
  ]);
  assert.equal(scanned.kind, "scan");
  // The notification is committed just before the import job ends.
  const [, note] = await mine.next(/event: notification\ndata: (.*)\n\n/);
  assert.equal(JSON.parse(note).kind, "import_finished");
  assert.match(
    JSON.parse(note).text,
    /^Import from ClickUp finished: 3 boards/,
  );
  const finished = await read(runId, "done");
  assert.equal(finished.kind, "import");
  assert.equal(finished.progress.phase, "done");
  await assert.rejects(other.next(/event: import/, 300), /timed out/);
  await assert.rejects(
    board.next(/event: import/, 100),
    /timed out/,
    "board streams carry board changes only",
  );
});

test("GraphQL shows Board.import, the import's activity label and import_data", async (t) => {
  const s = await setup(t);
  const { runId } = await importSample(s);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const job = await (
    await fetch(new URL(`/import/jobs/${runId}`, s.hostUrl), {
      headers: s.admin,
    })
  ).json();
  const boardId = job.report.links.find((l) => l.title === "Roadmap").id;
  const api = apiClient(s.hostUrl, { headers: s.admin });
  const data = await api.data(
    `query ($ids: [ID!]) {
      me { capabilities }
      imported: boards(ids: $ids) {
        import { source source_id source_url imported_at imported_by { id name } }
        activity_logs(limit: 10) { kind actor { id } actor_label }
      }
      seeded: boards(ids: ["${s.ids.boards.roadmap}"]) { import { source } }
    }`,
    { ids: [boardId] },
  );
  assert.ok(data.me.capabilities.includes("import_data"));
  const [board] = data.imported;
  assert.deepEqual(board.import, {
    source: "clickup",
    source_id: "b-roadmap",
    source_url: "https://acme.monday.com/boards/101",
    imported_at: board.import.imported_at,
    imported_by: { id: s.ids.users.alex, name: "Alex Rivera" },
  });
  assert.equal(data.seeded[0].import, null);
  const imported = board.activity_logs.find((e) => e.kind === "board_imported");
  assert.deepEqual(imported, {
    kind: "board_imported",
    actor: { id: s.ids.users.alex },
    actor_label: "Import from ClickUp",
  });
  const sam = apiClient(s.hostUrl, { headers: s.sessionFor(s.ids.users.sam) });
  const mine = await sam.data("{ me { capabilities } }");
  assert.equal(mine.me.capabilities.includes("import_data"), false);
});

test("in hosted mode the import routes are behind the site gate", async (t) => {
  const hosted = await startHosted(t, { importConnectors: CONNECTORS });
  const body = { source: "monday", token: TOKEN };
  const headers = { ...JSON_TYPE, Origin: "https://worklane.example" };
  const locked = await hosted.request("/import/scan", {
    method: "POST",
    headers,
    body,
  });
  assert.equal(locked.status, 401);
  assert.equal(codeOf(locked), "SITE_LOCKED");
  const tokenOnly = await hosted.request("/import/scan", {
    method: "POST",
    headers: { ...JSON_TYPE, Authorization: hosted.tokens.readWrite },
    body,
  });
  assert.equal(
    codeOf(tokenOnly),
    "SITE_LOCKED",
    "API tokens do not open /import",
  );
  assert.doesNotMatch(locked.body + tokenOnly.body, /clickup-token/);
  const cookie = await hosted.session();
  const opened = await hosted.request("/import/scan", {
    method: "POST",
    headers: { ...JSON_TYPE, ...hosted.as(cookie) },
    body,
  });
  assert.equal(opened.status, 202);
});
