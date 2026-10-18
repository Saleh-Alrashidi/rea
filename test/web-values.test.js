import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STATUS_SETTINGS,
  formatColumnValue,
  parseColumnValue,
} from "../server/column-values.js";
import { itemHash, parseRoute, viewHash } from "../web/ui/router.js";
import {
  CLEAR_VALUE,
  decodeItem,
  decodeValue,
  displayText,
  encodeValue,
  parseStatusSettings,
  prepareColumns,
} from "../web/ui/values.js";

const USERS = new Map([
  ["1", { id: "1", name: "Alex Rivera" }],
  ["2", { id: "2", name: "Sam Lee" }],
]);
const getUser = (id) => USERS.get(id) ?? null;

/** Server-side column records and their API (`settings_str`) form. */
const SERVER_COLUMNS = [
  { id: "status", type: "status", settings: DEFAULT_STATUS_SETTINGS },
  { id: "person", type: "people", settings: {} },
  { id: "date", type: "date", settings: {} },
  { id: "estimate", type: "numbers", settings: {} },
  { id: "notes", type: "text", settings: {} },
];
const CLIENT_COLUMNS = prepareColumns(
  SERVER_COLUMNS.map(({ settings, ...column }) => ({
    ...column,
    title: column.id,
    settings_str: JSON.stringify(settings),
  })),
);
const client = (id) => CLIENT_COLUMNS.find((column) => column.id === id);
const server = (id) => SERVER_COLUMNS.find((column) => column.id === id);

/** UI value → change_column_value JSON → stored → ColumnValue → UI value. */
function roundTrip(columnId, uiValue) {
  const json = encodeValue(client(columnId), uiValue);
  const parsed = parseColumnValue(server(columnId), json, { getUser });
  assert.equal(parsed.ok, true, parsed.message);
  const output = formatColumnValue(server(columnId), parsed.value, { getUser });
  return {
    stored: parsed.value,
    output,
    decoded: decodeValue(client(columnId), output.value),
  };
}

test("status settings parse into ordered options and a blank label", () => {
  const status = client("status").status;
  assert.deepEqual(status.options, [
    { index: 0, label: "Working on it", color: "#fdab3d" },
    { index: 1, label: "Done", color: "#00c875" },
    { index: 2, label: "Stuck", color: "#df2f4a" },
  ]);
  assert.deepEqual(status.blank, { index: 5, color: "#c4c4c4" });
});

test("malformed status settings degrade to safe defaults", () => {
  assert.deepEqual(parseStatusSettings("{not json"), {
    options: [],
    blank: null,
  });
  const hostile = JSON.stringify({
    labels: { 0: "A", x: "B", 1: 7 },
    labels_colors: { 0: "red; background: url(x)" },
  });
  assert.deepEqual(parseStatusSettings(hostile).options, [
    { index: 0, label: "A", color: "#c4c4c4" },
  ]);
});

test("client encodings are accepted by the server and decode back", () => {
  const cases = [
    ["status", 1, { index: 1 }, "Done"],
    ["person", ["2", "1"], ["2", "1"], "Sam Lee, Alex Rivera"],
    ["date", "2026-10-18", "2026-10-18", "2026-10-18"],
    ["estimate", "42.5", 42.5, "42.5"],
    ["notes", 'Ship it <b>"now"</b>', 'Ship it <b>"now"</b>', null],
  ];
  for (const [columnId, uiValue, stored, text] of cases) {
    const result = roundTrip(columnId, uiValue);
    assert.deepEqual(result.stored, stored, columnId);
    assert.deepEqual(result.decoded, uiValue, columnId);
    if (text !== null) assert.equal(result.output.text, text, columnId);
    assert.equal(
      displayText(client(columnId), uiValue, USERS),
      result.output.text,
      columnId,
    );
  }
});

test("empty UI values encode as a clear for every column type", () => {
  for (const column of SERVER_COLUMNS) {
    for (const empty of [null, "", []]) {
      const json = encodeValue(client(column.id), empty);
      assert.equal(json, CLEAR_VALUE);
      assert.deepEqual(parseColumnValue(column, json), {
        ok: true,
        value: null,
      });
    }
  }
});

test("the server stays the validator of numbers and text", () => {
  const json = encodeValue(client("estimate"), "12abc");
  assert.equal(parseColumnValue(server("estimate"), json).ok, false);
});

test("decodeItem keeps the name out of values and tolerates bad JSON", () => {
  const item = decodeItem(
    {
      id: 11,
      name: "Launch",
      group: { id: "this_sprint" },
      column_values: [
        { id: "name", text: "Launch", value: '"Launch"' },
        { id: "status", text: "Stuck", value: '{"index":2}' },
        { id: "person", text: "", value: "{broken" },
        { id: "unknown", text: "x", value: '"x"' },
      ],
    },
    CLIENT_COLUMNS,
  );
  assert.equal(item.id, "11");
  assert.equal(item.groupId, "this_sprint");
  assert.deepEqual(item.values, { status: 2, person: [] });
  assert.deepEqual(item.texts, { status: "Stuck", person: "" });
});

test("routes parse and round-trip", () => {
  assert.deepEqual(parseRoute("#/boards/12"), {
    boardId: "12",
    view: "table",
    installId: null,
    itemId: null,
  });
  assert.equal(parseRoute("#/boards/12/views/kanban").view, "kanban");
  assert.deepEqual(parseRoute("#/boards/12/views/app-7"), {
    boardId: "12",
    view: "app",
    installId: "7",
    itemId: null,
  });
  assert.deepEqual(parseRoute("#/boards/12/items/40"), {
    boardId: "12",
    view: null,
    installId: null,
    itemId: "40",
  });
  for (const hash of [
    "",
    "#/",
    "#/boards/x",
    "#/boards/1/views/app-",
    "#/boards/1/items/1/x",
  ]) {
    assert.equal(parseRoute(hash).boardId, null, hash);
  }
  assert.equal(viewHash("3", { view: "kanban" }), "#/boards/3/views/kanban");
  assert.equal(
    viewHash("3", { view: "app", installId: "9" }),
    "#/boards/3/views/app-9",
  );
  assert.equal(viewHash("3", { view: "table" }), "#/boards/3");
  assert.equal(itemHash("3", "4"), "#/boards/3/items/4");
});
