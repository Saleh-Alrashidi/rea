/**
 * Work and size bounds of the importer (SPEC-4 §1 "Bounded work"): people
 * parsing stays linear, file scans and validation run in time slices and
 * stop on cancel, one import holds at most SNAPSHOT_LIMITS.values values,
 * the store refuses a board its data file could not hold, and a state that
 * cannot be saved is a logged failure instead of a crash.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inferType, parseCsv, personOf } from "../server/import/csv.js";
import { itemRoom } from "../server/import/connectors/common.js";
import { scan } from "../server/import/connectors/files.js";
import { drainSliced } from "../server/import/slices.js";
import {
  SNAPSHOT_LIMITS,
  validateSnapshot,
  validateSnapshotSliced,
} from "../server/import/snapshot.js";
import { readXlsx, readXlsxSteps } from "../server/import/xlsx.js";
import { createStore } from "../server/store.js";
import { createPersistence } from "../server/store/persistence.js";
import { sheetWorkbook } from "./fixtures/import/make-xlsx.js";
import { seedIds } from "./helpers.js";

const csvFile = (text, name = "big.csv") => ({
  name,
  kind: "csv",
  bytes: Buffer.from(text),
});

/** A CSV of `rows` rows and `cols` one-letter columns. */
function wideCsv(rows, cols) {
  const lines = [Array.from({ length: cols }, (_, c) => `C${c}`).join(",")];
  for (let r = 0; r < rows; r += 1)
    lines.push(
      Array.from({ length: cols }, (_, c) =>
        String.fromCharCode(97 + ((r + c) % 26)),
      ).join(","),
    );
  return lines.join("\n");
}

/** A snapshot with one board of `items` items and `columns` number columns. */
function numbersSnapshot(items, columns) {
  const ids = Array.from({ length: columns }, (_, c) => `n${c}`);
  return {
    source: "csv",
    source_label: "CSV file big.csv",
    users: [],
    workspaces: [
      {
        source_id: "file",
        name: "Imported from big.csv",
        description: null,
        kind: "closed",
        docs: [],
        boards: [
          {
            source_id: "file:big.csv",
            name: "Big",
            description: null,
            kind: "private",
            source_url: null,
            members: [],
            groups: [{ source_id: "g1", title: "Imported", color: "#579bfc" }],
            columns: ids.map((id) => ({
              source_id: id,
              title: id,
              type: "numbers",
            })),
            items: Array.from({ length: items }, (_, i) => ({
              source_id: `i${i}`,
              name: `Item ${i}`,
              group_source_id: "g1",
              parent_source_id: null,
              values: Object.fromEntries(ids.map((id) => [id, i])),
              created_at: null,
              creator_source_id: null,
              updates: [],
            })),
          },
        ],
      },
    ],
    warnings: [],
  };
}

/** Counts event-loop turns that run while `work` is pending. */
async function turnsDuring(work) {
  let turns = 0;
  let running = true;
  const spin = () => {
    if (!running) return;
    turns += 1;
    setImmediate(spin);
  };
  setImmediate(spin);
  try {
    return { result: await work(), turns };
  } finally {
    running = false;
  }
}

test("people cells are parsed in linear time, with the same results", () => {
  const padded = `a${" ".repeat(100_000)}a`;
  const started = performance.now();
  assert.equal(personOf(padded), null, "too long to be a name");
  assert.equal(inferType([padded], "Notes"), "text");
  assert.ok(performance.now() - started < 50, "no backtracking");
  assert.deepEqual(personOf(`Ann${" ".repeat(5_000)}<ann@acme.test>`), {
    source_id: "email:ann@acme.test",
    name: "Ann",
    email: "ann@acme.test",
  });
  assert.equal(personOf("x <a@b.test> <c@d.test>").name, "x <a@b.test>");
  assert.equal(personOf("<c@d.test>").name, "c@d.test");
  assert.equal(personOf("ann@acme.test").name, "ann@acme.test");
});

test("text after a closing quote is kept, counted and reported", async () => {
  const text = 'Name,Notes\n"Broken,"unclosed\nNext,ok\n"Also"x,y';
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.rows[1], ["Broken,unclosed"]);
  assert.equal(parsed.strayQuotes, 2);
  assert.equal(parsed.strayRecord, 2);
  const snapshot = await scan({ file: csvFile(text, "broken.csv") });
  const warning = snapshot.warnings.find(
    (w) => w.code === "csv_malformed_quote",
  );
  assert.match(warning.message, /^2 quoted values .* line 2/);
  assert.equal(warning.path, "workspaces[0].boards[0]");
  const clean = await scan({ file: csvFile('Name\n"Fine ""quoted"""\n') });
  assert.equal(clean.warnings.length, 0);
});

test("a file scan stops at the value budget with a warning", async () => {
  const limits = { values: 1_000 };
  const snapshot = await scan({
    file: csvFile(wideCsv(50, 21)),
    options: { limits },
  });
  const board = snapshot.workspaces[0].boards[0];
  const values = board.items.reduce(
    (n, i) => n + Object.keys(i.values).length,
    0,
  );
  // 21 cells per row (the header too); a row is kept while 200 more fit.
  assert.equal(board.items.length, 38);
  assert.ok(values <= limits.values);
  const warning = snapshot.warnings.find((w) => w.code === "too_many_values");
  assert.match(
    warning.message,
    /first 38 items .* at most 1,000 values, so 12 more rows/,
  );
  const full = await scan({ file: csvFile(wideCsv(50, 21)) });
  assert.equal(full.workspaces[0].boards[0].items.length, 50, "default budget");
});

test("API scans stop before an item could pass the value budget", () => {
  const report = { list: [], add: (...args) => report.list.push(args) };
  const ctx = {
    limits: { items: 10 },
    counts: { items: 0, values: SNAPSHOT_LIMITS.values - 500 },
    stopped: new Set(),
    flags: {},
    report,
  };
  assert.equal(itemRoom(ctx, "workspaces[0].boards[0]"), true);
  ctx.counts.values += 1;
  assert.equal(itemRoom(ctx, "workspaces[0].boards[0]"), false);
  assert.equal(report.list[0][0], "limit_values");
  assert.match(report.list[0][1], /scan limit of 2,000,000 values/);
  ctx.counts.items = 10;
  assert.equal(itemRoom(ctx, "workspaces[0].boards[1]"), false);
  assert.equal(report.list[1][0], "limit_items");
});

test("a snapshot with more values than one import can store is refused", () => {
  const columns = 500;
  const items = Math.floor(SNAPSHOT_LIMITS.values / columns) + 1;
  const checked = validateSnapshot(numbersSnapshot(items, columns));
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.errors.at(-1), {
    code: "too_large",
    message: "At most 2,000,000 values in all",
    path: "workspaces[0].boards[0].items",
  });
});

test("validation runs in slices, matches the plain check and stops on cancel", async () => {
  const raw = numbersSnapshot(20_000, 10);
  const { result, turns } = await turnsDuring(() =>
    validateSnapshotSliced(raw),
  );
  assert.equal(result.ok, true);
  assert.ok(turns > 0, "the event loop ran during validation");
  assert.deepEqual(result.snapshot, validateSnapshot(raw).snapshot);
  const again = await validateSnapshotSliced(result.snapshot);
  assert.equal(
    again.snapshot,
    result.snapshot,
    "normalized snapshots pass as is",
  );
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await assert.rejects(
    validateSnapshotSliced(numbersSnapshot(20_000, 10), {
      signal: controller.signal,
    }),
    { code: "ABORTED" },
  );
  const done = new AbortController();
  done.abort();
  await assert.rejects(drainSliced([].values(), { signal: done.signal }), {
    code: "ABORTED",
  });
});

test("a file scan yields to the event loop and stops when cancelled", async () => {
  const file = csvFile(wideCsv(20_000, 20));
  const { result, turns } = await turnsDuring(() => scan({ file }));
  assert.equal(result.workspaces[0].boards[0].items.length, 20_000);
  assert.ok(turns > 5, `the event loop ran ${turns} times during the scan`);
  const controller = new AbortController();
  let converting = false;
  const onProgress = ({ phase }) => {
    if (phase !== "converting" || converting) return;
    converting = true;
    // A few turns into the conversion, which used to run in one piece.
    let turn = 0;
    const later = () =>
      (turn += 1) < 3 ? setImmediate(later) : controller.abort();
    setImmediate(later);
  };
  await assert.rejects(scan({ file, signal: controller.signal, onProgress }), {
    code: "ABORTED",
  });
  assert.equal(converting, true);
});

test("a workbook's sheet is read in slices too", async () => {
  const rows = [Array.from({ length: 20 }, (_, c) => `C${c}`)];
  for (let r = 0; r < 8_000; r += 1)
    rows.push(Array.from({ length: 20 }, (_, c) => `v${(r + c) % 40}`));
  const bytes = sheetWorkbook(rows);
  const { result, turns } = await turnsDuring(() =>
    drainSliced(readXlsxSteps(bytes), { sliceMs: 1 }),
  );
  assert.equal(result.rows.length, 8_001);
  assert.deepEqual(result, readXlsx(bytes), "the same as the plain reader");
  assert.ok(turns > 5, `the event loop ran ${turns} times while reading`);
});

test("the store refuses a board its data file could not hold", async () => {
  const store = await createStore({ file: null, maxDataBytes: 64 * 1024 });
  const ids = seedIds(store);
  const workspace = store.listWorkspaces()[0];
  const board = (items) => ({
    workspaceId: workspace.id,
    importerId: ids.users.alex,
    name: "Bulk",
    description: null,
    boardKind: "private",
    meta: { source: "csv", sourceId: "file:bulk.csv", sourceUrl: null },
    label: "Import from CSV",
    members: [],
    groups: [{ key: "g", title: "Imported", color: "#579bfc" }],
    columns: [{ key: "t", title: "Notes", type: "text" }],
    items: Array.from({ length: items }, (_, i) => ({
      groupKey: "g",
      name: `Row ${i}`,
      values: { t: "x".repeat(100) },
      creatorId: null,
      createdAt: null,
      updates: [],
    })),
  });
  const before = store.listBoards().length;
  const first = store.importBoard(board(100));
  assert.equal(first.counts.items, 100, "about 40 KiB fits");
  const second = store.importBoard(board(100));
  assert.equal(second.ok, false);
  assert.match(second.message, /data would grow past 1 MiB/);
  assert.equal(store.listBoards().length, before + 1, "nothing was written");
});

test("a state that cannot be serialized is a logged, retried save failure", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mm-persist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const errors = [];
  const log = { error: (...args) => errors.push(args) };
  const state = { format: "x", columns: [], broken: 1n };
  const persist = createPersistence({ file, state, log });
  persist.schedule();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(errors.length, 1, "the timer's save failed without a crash");
  assert.match(String(errors[0][1]), /BigInt/);
  await assert.rejects(persist.flush(), TypeError);
  delete state.broken;
  persist.schedule();
  await persist.flush();
  const text = await readFile(file, "utf8");
  assert.equal(text, '{"format":"x","columns":[]}\n', "compact JSON");
  assert.equal(persist.size(), text.length);
  persist.grow(100);
  assert.equal(persist.size(), text.length + 100);
});
