/**
 * Folders and sidebar positions in the data file (SPEC-6 §3.1): the
 * /6 → /7 upgrade (one folder per Space and source folder for imported
 * boards, only where a Main board of that source folder already shows
 * it to the Space; the importer's composed names undone only when /6
 * composed them exactly; first positions in the current order, a
 * `.v6.bak` copy, an idempotent reload; /5 files go through it too), the
 * load checks of every new shape and rule, and what deleting a folder or
 * a Space does.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateSnapshot } from "../server/import/snapshot.js";
import { createStore } from "../server/store.js";
import { FORMAT } from "../server/store/persistence.js";
import { POSITION_SPACING } from "../server/store/positions.js";
import { sampleSnapshot } from "./import-engine-fixtures.js";
import { seedIds, startTestServers } from "./helpers.js";

const S = POSITION_SPACING;
const quietLog = { error() {}, warn() {}, info() {}, log() {} };
const readDoc = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, doc) => writeFile(file, `${JSON.stringify(doc)}\n`);

/** A minimal `importBoard` spec of a ClickUp list. */
const listSpec = (key, { name, folder, sourceName, ...rest }) => ({
  workspaceId: rest.workspaceId,
  importerId: rest.importerId,
  name,
  description: null,
  boardKind: rest.kind ?? "public",
  meta: {
    source: "clickup",
    sourceId: `list-${key}`,
    sourceUrl: null,
    ...(folder ? { folder } : {}),
    sourceName,
  },
  label: "Import from ClickUp",
  summary: "Imported from ClickUp",
  members: [],
  groups: [{ key: "open", title: "Open", color: "#579bfc" }],
  columns: [],
  items: [],
});

/** What a /6 file held: no folders, folder links or positions. */
function asVersion6(doc) {
  const strip = ({ folder_id: _f, position: _p, ...record }) => record;
  const { folders: _folders, ...rest } = doc;
  return {
    ...rest,
    format: "mini-monday-store/6",
    workspaces: doc.workspaces.map(strip),
    boards: doc.boards.map(strip),
    docs: doc.docs.map(strip),
  };
}

const ENGINEERING = { sourceId: "f-eng", name: "Engineering" };
const DESIGN = { sourceId: "f-design", name: "Design" };
const LAYOFFS = { sourceId: "f9", name: "Layoffs 2027" };

/**
 * Imported ClickUp lists sitting in source folders, by key: `sprint`
 * (the importer's composed name), `renamed` (renamed since), `near` (a
 * near miss), `again` (a re-import), `hidden` (a private list in a
 * folder with Main boards), `ideas` (another folder), `ops` (the same
 * source folder in another Space), `layoffs` (a private list alone in its
 * folder) and `inbox` (folderless). Values: name, folder, own name,
 * Space key (default `main`), board kind (default public).
 */
const LISTS = {
  sprint: ["Engineering / Sprint 12", ENGINEERING, "Sprint 12"],
  renamed: ["Our backlog", ENGINEERING, "Backlog"],
  near: ["Engineering / Plans 2", ENGINEERING, "Plans"],
  again: ["Engineering / Sprint 12 (imported again)", ENGINEERING, "Sprint 12"],
  hidden: ["Engineering / Hidden", ENGINEERING, "Hidden", "main", "private"],
  ideas: ["Design / Ideas", DESIGN, "Ideas"],
  ops: ["Engineering / Ops", ENGINEERING, "Ops", "leadership"],
  layoffs: [
    "Layoffs 2027 / Candidates",
    LAYOFFS,
    "Candidates",
    "main",
    "private",
  ],
  inbox: ["Inbox", null, "Inbox"],
};

/**
 * A data file holding `lists` (by key: `{ name, folder, sourceName,
 * space, kind }`), saved as format /6.
 */
async function legacyFile(t, lists) {
  const dir = await mkdtemp(path.join(tmpdir(), "mini-monday-folders-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  const store = await createStore({ file, log: quietLog });
  const ids = seedIds(store);
  const boards = {};
  for (const [key, { space = "main", ...list }] of Object.entries(lists)) {
    const workspaceId = ids.workspaces[space];
    const where = { workspaceId, importerId: ids.users.alex };
    boards[key] = store.importBoard(
      listSpec(key, { ...list, ...where }),
    ).board.id;
  }
  await store.flush();
  const legacy = asVersion6(await readDoc(file));
  await save(file, legacy);
  return { file, legacy, ids, boards };
}

const listsFile = (t) =>
  legacyFile(
    t,
    Object.fromEntries(
      Object.entries(LISTS).map(([key, [name, folder, sourceName, ...r]]) => [
        key,
        { name, folder, sourceName, space: r[0], kind: r[1] },
      ]),
    ),
  );

test("a /6 file gets folders, names, positions and a .v6.bak", async (t) => {
  const { file, legacy, ids, boards } = await listsFile(t);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  const { main, leadership } = ids.workspaces;
  const board = (key) => store.getBoard(boards[key]);
  const folder = (key) => store.getFolder(board(key).folder_id);
  // One folder per (Space, source folder) with a Main board, named and
  // colored after them; the private-only "Layoffs 2027" gets none.
  const [engineering, design] = store.listFolders({ workspaceId: main });
  const [ops] = store.listFolders({ workspaceId: leadership });
  assert.equal(store.listFolders().length, 3);
  const imported = legacy.boards.find((b) => b.id === boards.sprint).import;
  assert.deepEqual(engineering, {
    id: engineering.id,
    workspace_id: main,
    name: "Engineering",
    color: store.getWorkspace(main).color,
    position: S,
    created_by: ids.users.alex,
    created_at: imported.imported_at,
  });
  assert.deepEqual([design.name, design.position], ["Design", 2 * S]);
  assert.deepEqual([ops.name, ops.position], ["Engineering", S]);
  for (const key of ["sprint", "renamed", "near", "again", "hidden"]) {
    assert.equal(folder(key), engineering, key);
  }
  assert.equal(folder("ideas"), design);
  assert.equal(folder("ops"), ops, "the same source folder in another Space");
  for (const key of ["layoffs", "inbox"]) {
    assert.equal(board(key).folder_id, undefined, key);
  }
  // Only the importer's own composition is undone, and only in a folder.
  const names = Object.fromEntries(
    Object.keys(boards).map((key) => [key, board(key).name]),
  );
  assert.deepEqual(names, {
    sprint: "Sprint 12",
    renamed: "Our backlog",
    near: "Engineering / Plans 2",
    again: "Engineering / Sprint 12 (imported again)",
    hidden: "Hidden",
    ideas: "Ideas",
    ops: "Ops",
    layoffs: "Layoffs 2027 / Candidates",
    inbox: "Inbox",
  });
  // Positions in the current order, per container.
  const positions = (records) =>
    records.map((record) => [record.name ?? record.title, record.position]);
  assert.deepEqual(positions(store.listWorkspaces()), [
    ["Main space", S],
    ["Leadership", 2 * S],
  ]);
  const inside = (id, list) =>
    list.filter((record) => (record.folder_id ?? null) === id);
  const mainBoards = store
    .listBoards({ limit: 100 })
    .filter((b) => b.workspace_id === main);
  assert.deepEqual(positions(inside(null, mainBoards)), [
    ["Product roadmap", S],
    ["Marketing launch", 2 * S],
    ["Layoffs 2027 / Candidates", 3 * S],
    ["Inbox", 4 * S],
  ]);
  assert.deepEqual(positions(inside(engineering.id, mainBoards)), [
    ["Sprint 12", S],
    ["Our backlog", 2 * S],
    ["Engineering / Plans 2", 3 * S],
    ["Engineering / Sprint 12 (imported again)", 4 * S],
    ["Hidden", 5 * S],
  ]);
  assert.deepEqual(positions(store.listDocs({ workspaceId: main })), [
    ["Product vision", S],
    ["Launch brief", 2 * S],
  ]);
  // The old file is kept, private; the new one is /7.
  const copy = `${file}.v6.bak`;
  assert.deepEqual(await readDoc(copy), legacy);
  assert.equal((await stat(copy)).mode & 0o777, 0o600, "the copy is private");
  const saved = await readDoc(file);
  assert.equal(saved.format, FORMAT);
  assert.equal(FORMAT, "mini-monday-store/7");
  // A second load reads a current file and changes nothing.
  const text = await readFile(file, "utf8");
  const again = await createStore({ file, log: quietLog });
  await again.flush();
  assert.equal(await readFile(file, "utf8"), text);
  assert.equal(again.listFolders().length, 3);
  await assert.rejects(access(`${file}.v7.bak`), { code: "ENOENT" });
});

test("a private source folder's name stays out of its Space after the upgrade", async (t) => {
  const { file, ids, boards } = await listsFile(t);
  const store = await createStore({ file, log: quietLog });
  const servers = await startTestServers({ store });
  t.after(() => servers.close());
  const QUERY = `{ workspaces { folders { name } boards { id name folder { id } } } }`;
  for (const user of ["priya", "alex"]) {
    const { workspaces } = await servers.as(ids.users[user]).data(QUERY);
    const folders = workspaces.flatMap((w) => w.folders.map((f) => f.name));
    assert.ok(!folders.includes("Layoffs 2027"), user);
    const layoffs = workspaces
      .flatMap((w) => w.boards)
      .find((b) => b.id === boards.layoffs);
    assert.equal(layoffs === undefined, user === "priya", "private");
    if (layoffs) {
      assert.deepEqual(layoffs, {
        id: boards.layoffs,
        name: "Layoffs 2027 / Candidates",
        folder: null,
      });
    }
  }
});

/**
 * What /6 named a list in a folder, exactly as it did: its ClickUp
 * connector composed `${folder} / ${list}` from the raw names and the
 * snapshot normalized that like any board name, beside the folder's and
 * the list's own normalized names.
 */
function composedAt6(rawFolder, rawList) {
  const snapshot = sampleSnapshot();
  const [board] = snapshot.workspaces[0].boards;
  Object.assign(board, {
    name: `${rawFolder} / ${rawList}`,
    folder: { source_id: "f-1", name: rawFolder },
    source_name: rawList,
  });
  const checked = validateSnapshot(snapshot);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  const { name, folder, source_name } =
    checked.snapshot.workspaces[0].boards[0];
  return { name, folderName: folder.name, sourceName: source_name };
}

const PAIR = "\u{1F600}";
/** Raw ClickUp names (folder, list) of every way /6 composed a name. */
const COMPOSED = {
  plain: ["Product", "Roadmap"],
  untrimmed: [" Product\t", "\u00a0 Roadmap "],
  blank: ["  ", "Notes"],
  untitled: ["Untitled folder", "Ideas"],
  longList: ["Long", "x".repeat(300)],
  longFolder: ["F".repeat(300), "List"],
  pairInList: ["Emoji", `${"a".repeat(246)}${PAIR}${"b".repeat(20)}`],
  pairInFolder: [`${"F".repeat(254)}${PAIR}G`, "List"],
};

test("the upgrade undoes every name /6 composed, and only those", async (t) => {
  const lists = {};
  const add = (key, { name, folderName, sourceName }) => {
    const folder = { sourceId: `f-${key}`, name: folderName };
    lists[key] = { name, folder, sourceName };
  };
  const composed = {};
  for (const [key, [rawFolder, rawList]] of Object.entries(COMPOSED)) {
    composed[key] = composedAt6(rawFolder, rawList);
    add(key, composed[key]);
  }
  assert.deepEqual(
    ["untrimmed", "blank", "longList", "pairInList", "pairInFolder"].map(
      (key) => [composed[key].name, composed[key].name.length],
    ),
    [
      ["Product\t / \u00a0 Roadmap", 20],
      ["/ Notes", 7],
      [`Long / ${"x".repeat(248)}`, 255],
      [`Emoji / ${"a".repeat(246)}`, 254],
      ["F".repeat(254), 254],
    ],
    "as /6 composed them",
  );
  assert.equal(composed.blank.folderName, "Untitled folder");
  // Names /6 could not have composed for these lists (renamed since).
  const { plain, longList } = composed;
  const misses = {
    suffixed: { ...plain, name: "Product / Roadmap 2" },
    tight: { ...plain, name: "Product /Roadmap" },
    folderless: { ...plain, name: "/ Roadmap" },
    tab: { ...plain, name: "Product\t/ Roadmap" },
    short: { ...longList, name: longList.name.slice(0, 254) },
  };
  for (const [key, list] of Object.entries(misses)) add(key, list);
  const { file, boards } = await legacyFile(t, lists);
  const store = await createStore({ file, log: quietLog });
  const named = (key) => {
    const board = store.getBoard(boards[key]);
    return [board.name, store.getFolder(board.folder_id).name];
  };
  for (const [key, { folderName, sourceName }] of Object.entries(composed)) {
    assert.deepEqual(named(key), [sourceName, folderName], key);
  }
  for (const [key, { name, folderName }] of Object.entries(misses)) {
    assert.deepEqual(named(key), [name, folderName], key);
  }
});

test("a /5 file goes through the folder upgrade and keeps only .v5.bak", async (t) => {
  const { file, legacy, boards } = await listsFile(t);
  const { likes: _likes, ...rest } = legacy;
  const older = { ...rest, format: "mini-monday-store/5" };
  await save(file, older);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  assert.equal(store.getBoard(boards.sprint).name, "Sprint 12");
  assert.equal(store.listFolders().length, 3);
  assert.deepEqual(await readDoc(`${file}.v5.bak`), older);
  await assert.rejects(access(`${file}.v6.bak`), { code: "ENOENT" });
  assert.equal((await readDoc(file)).format, FORMAT);
});

test("files that break the folder rules are refused and left untouched", async (t) => {
  const { file, ids, boards } = await listsFile(t);
  const store = await createStore({ file, log: quietLog });
  await store.flush();
  const good = await readDoc(file);
  const { main, leadership } = ids.workspaces;
  const [mainFolder] = good.folders.filter((f) => f.workspace_id === main);
  const [otherFolder] = good.folders.filter(
    (f) => f.workspace_id === leadership,
  );
  const broken = (mutate) => {
    const copy = structuredClone(good);
    const find = (name, id) => copy[name].find((record) => record.id === id);
    mutate(copy, find);
    return copy;
  };
  const cases = [
    broken((doc) => delete doc.folders),
    broken((doc) => (doc.folders = {})),
    broken((doc) => delete doc.folders[0].color),
    broken((doc) => (doc.folders[0].position = "1")),
    broken((doc) => (doc.folders[0].name = 7)),
    broken((doc) => (doc.folders[0].workspace_id = "99999")),
    broken((doc) => (doc.folders[1].id = doc.folders[0].id)),
    broken((doc, find) => (find("boards", boards.inbox).folder_id = "99999")),
    broken((doc, find) => {
      find("boards", boards.inbox).folder_id = otherFolder.id;
    }),
    broken((doc, find) => {
      find("docs", ids.docs.vision).folder_id = otherFolder.id;
    }),
    broken((doc, find) => (find("boards", boards.inbox).folder_id = null)),
    broken((doc, find) => (find("boards", boards.inbox).position = null)),
    broken((doc, find) => (find("docs", ids.docs.vision).position = "1")),
    broken((doc) => (doc.workspaces[0].position = Number.NaN)),
  ];
  for (const doc of cases) {
    const text = JSON.stringify(doc);
    await writeFile(file, text);
    await assert.rejects(
      createStore({ file, log: quietLog }),
      /Invalid mini-monday data file/,
      text.slice(0, 80),
    );
    assert.equal(await readFile(file, "utf8"), text, "left as it was");
  }
  // Records in a folder of their own Space load; positions are optional.
  const fine = broken((doc, find) => {
    find("docs", ids.docs.vision).folder_id = mainFolder.id;
    delete find("boards", boards.inbox).position;
  });
  await save(file, fine);
  const loaded = await createStore({ file, log: quietLog });
  assert.equal(loaded.getDoc(ids.docs.vision).folder_id, mainFolder.id);
  assert.equal(loaded.getBoard(boards.inbox).position, undefined);
});

test("deleting a folder empties it into the Space root; a Space takes its folders", async (t) => {
  const { file, ids, boards } = await listsFile(t);
  const first = await createStore({ file, log: quietLog });
  await first.flush();
  const doc = await readDoc(file);
  const engineering = doc.folders.find(
    (f) => f.workspace_id === ids.workspaces.main && f.name === "Engineering",
  );
  doc.docs.find((d) => d.id === ids.docs.brief).folder_id = engineering.id;
  await save(file, doc);
  const store = await createStore({ file, log: quietLog });
  const events = [];
  store.on((event) => events.push(event));
  const before = store.listBoards({ limit: 100 }).length;
  const deleted = store.deleteFolder(engineering.id);
  assert.equal(deleted.id, engineering.id);
  assert.equal(store.getFolder(engineering.id), null);
  assert.equal(store.listBoards({ limit: 100 }).length, before, "no content");
  const root = store
    .listBoards({ limit: 100 })
    .filter((b) => b.workspace_id === ids.workspaces.main)
    .map((b) => [b.name, b.folder_id ?? null, b.position]);
  assert.deepEqual(root.slice(0, 3), [
    ["Product roadmap", null, S],
    ["Marketing launch", null, 2 * S],
    ["Sprint 12", null, 5 * S],
  ]);
  assert.equal(store.getBoard(boards.inbox).position, 4 * S);
  assert.equal(store.getBoard(boards.hidden).position, 9 * S, "in order");
  assert.deepEqual(
    [
      store.getDoc(ids.docs.brief).folder_id,
      store.getDoc(ids.docs.brief).position,
    ],
    [undefined, 2 * S],
    "after the root's own docs",
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["folder_deleted", ...Array(5).fill("board_moved"), "doc_moved"],
  );
  // A Space can only be deleted empty; its folders go with it.
  const space = store.createWorkspace({
    name: "Temp",
    creatorId: ids.users.alex,
  });
  const kept = store.createFolder({ workspaceId: space.id, name: "Kept" });
  assert.equal(kept.color, space.color, "the Space's color by default");
  store.deleteWorkspace(space.id);
  assert.equal(store.getFolder(kept.id), null);
  await store.flush();
  await createStore({ file, log: quietLog });
});
