/**
 * monday.com fixture account for the importer tests, in the shapes of
 * monday's official client types (`@mondaydotcomorg/api` 14.3.1): IDs are
 * strings, `settings_str` and column `value` are JSON text, and doc block
 * `content` is delta JSON text. `mondayFixture()` returns a fresh copy.
 *
 * Boards: "Roadmap" (public; every column type, subitems, updates, 453
 * items = three item pages; see `monday-items.js`), its subitems board and
 * a doc board (both skipped), "Hiring" (private, closed workspace),
 * "Launch plan" (share, Main workspace, legacy color/person columns, no
 * groups), an archived board, "Broken board", "Orphan board" (a workspace
 * the token cannot list) and 24 small team boards (two board pages).
 * Users: 120 (two user pages); user 900 is referenced but not listed.
 */
import {
  ROADMAP_COLUMNS,
  SUBITEM_COLUMNS,
  column,
  roadmapItems,
  valuesFor,
} from "./monday-items.js";

/** The only token the fake server accepts. */
export const MONDAY_TOKEN = "mm-fake-monday-token-7f3c9a1e";

function board(fields) {
  return {
    description: null,
    board_kind: "public",
    type: "board",
    state: "active",
    workspace: { id: "11" },
    owners: [{ id: "1" }],
    subscribers: [{ id: "1" }],
    columns: [],
    groups: [{ id: "topics", title: "Group Title", color: "#579bfc" }],
    items: [],
    url: `https://acme.monday.com/boards/${fields.id}`,
    ...fields,
  };
}

const TEXT_COLUMNS = [
  ["name", "Name", "name"],
  ["text", "Text", "text"],
];

function smallBoard(id, name, extra = {}) {
  const columns = TEXT_COLUMNS.map(column);
  const row = {
    id: `${id}01`,
    name: `${name} item`,
    created_at: null,
    creator: { id: "1" },
    group: { id: "topics" },
    column_values: valuesFor(columns, { text: ["hello", "hello"] }),
    subitems: [],
    updates: [],
  };
  return board({ id, name, columns, items: [row], ...extra });
}

function roadmap() {
  return board({
    id: "101",
    name: "Roadmap",
    description: "What we ship next",
    subscribers: [{ id: "1" }, { id: "2" }, { id: "900" }],
    columns: ROADMAP_COLUMNS,
    groups: [
      { id: "this_sprint", title: "This sprint", color: "#579bfc" },
      { id: "next_up", title: "Next up", color: "#A25DDC" },
      { id: "later", title: "Later", color: "grass_green" },
      { id: "weird", title: "Weird", color: "not-a-color" },
    ],
    items: roadmapItems(ROADMAP_COLUMNS),
  });
}

const LEGACY_STATUS = {
  labels: { 0: "Draft", 1: "Live" },
  labels_colors: { 0: { color: "pink" }, 1: { color: "#ABC" } },
};

function launchPlan() {
  const columns = [
    ["name", "Name", "name"],
    ["color", "Stage", "color", LEGACY_STATUS],
    ["person", "Lead", "person"],
  ].map(column);
  const press = {
    id: "1401",
    name: "Press kit",
    created_at: "2025-02-02T00:00:00Z",
    creator: { id: "3" },
    group: null,
    column_values: valuesFor(columns, {
      color: ["Live", { index: 1 }],
      person: ["Walter Skinner", { id: 3 }],
    }),
    subitems: [],
    updates: [],
  };
  return board({
    id: "104",
    name: "Launch plan",
    board_kind: "share",
    workspace: null,
    owners: [{ id: "3" }],
    subscribers: [{ id: "3" }, { id: "4" }],
    columns,
    groups: [],
    items: [press],
  });
}

function hiring() {
  const role = {
    id: "1301",
    name: "Senior engineer",
    created_at: "2025-02-01T00:00:00Z",
    creator: { id: "1" },
    group: { id: "topics" },
    column_values: [],
    subitems: [],
    updates: [],
  };
  return board({
    id: "103",
    name: "Hiring",
    board_kind: "private",
    workspace: { id: "12" },
    subscribers: [{ id: "1" }, { id: "2" }, { id: "4" }],
    columns: [column(["name", "Name", "name"])],
    items: [role],
  });
}

function boards() {
  const subitemBoard = { columns: SUBITEM_COLUMNS, type: "sub_items_board" };
  const teams = Array.from({ length: 24 }, (_, n) =>
    smallBoard(String(200 + n), `Team board ${n + 1}`),
  );
  return [
    roadmap(),
    board({ id: "102", name: "Subitems of Roadmap", ...subitemBoard }),
    hiring(),
    launchPlan(),
    board({ id: "105", name: "Product vision", type: "document" }),
    board({ id: "106", name: "Old board", state: "archived" }),
    smallBoard("107", "Broken board"),
    smallBoard("108", "Orphan board", { workspace: { id: "99" } }),
    ...teams,
  ];
}

function users() {
  const named = [
    { id: "1", name: "Dana Scully", email: "dana@acme.test" },
    { id: "2", name: "Fox Mulder", email: "fox@acme.test" },
    { id: "3", name: "Walter Skinner", email: "walter@acme.test" },
    { id: "4", name: "Gina Guest", email: "gina@partner.test" },
    { id: "5", name: "No Email", email: "" },
  ];
  const generated = Array.from({ length: 115 }, (_, n) => ({
    id: String(500 + n),
    name: `Teammate ${n + 1}`,
    email: `teammate-${n + 1}@acme.test`,
  }));
  return [...named, ...generated];
}

const delta = (insert, extra = {}) => ({
  alignment: "left",
  direction: "ltr",
  deltaFormat: [{ insert }],
  ...extra,
});

function blocks(entries) {
  return entries.map(([type, content], index) => ({
    id: `block-${index + 1}`,
    type,
    content: JSON.stringify(content),
  }));
}

function visionBlocks() {
  const mention = { mention: { id: 1, type: "USER" } };
  const bold = { insert: "calm", attributes: { bold: true } };
  return blocks([
    ["large title", delta("Product vision")],
    [
      "normal text",
      { deltaFormat: [{ insert: "We build " }, bold, { insert: " tools.\n" }] },
    ],
    ["medium title", delta("Goals")],
    ["small title", delta("Details")],
    ["bulleted list", delta("Fast")],
    ["numbered list", delta("First")],
    ["check list", delta("Write brief", { checked: true })],
    // The underscore names of create_doc_block's input enum read the same.
    ["check_list", delta("Review brief")],
    ["quote", delta("Less is more")],
    ["code", delta("npm start\nnpm test")],
    ["divider", {}],
    ["notice box", delta("Heads up")],
    ["image", { url: "https://files.acme.test/hero.png", width: 600 }],
    ["table", { rowsCount: 2, columnsCount: 2 }],
    [
      "normal text",
      {
        deltaFormat: [
          { insert: "Ask " },
          { insert: mention },
          { insert: " first" },
        ],
      },
    ],
  ]);
}

function docs() {
  const paragraphs = Array.from({ length: 230 }, (_, n) => [
    "normal text",
    delta(`Paragraph ${n + 1}`),
  ]);
  const vision = { id: "301", name: "Product vision", object_id: "105" };
  const handbook = { id: "302", name: "Big handbook", object_id: "999" };
  return [
    {
      ...vision,
      workspace_id: "11",
      doc_kind: "public",
      blocks: visionBlocks(),
    },
    {
      ...handbook,
      workspace_id: null,
      doc_kind: "private",
      blocks: blocks(paragraphs),
    },
  ];
}

/** A fresh fixture account. */
export function mondayFixture() {
  const account = { id: "77", name: "Acme Corp" };
  return {
    me: { id: "1", name: "Dana Scully", account },
    users: users(),
    workspaces: [
      { id: "11", name: "Product", kind: "open", description: "Product team" },
      { id: "12", name: "Leadership", kind: "closed", description: null },
    ],
    boards: boards(),
    docs: docs(),
  };
}
