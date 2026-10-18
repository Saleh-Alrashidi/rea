import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STATUS_SETTINGS,
  formatColumnValue,
  isValidStoredValue,
  parseColumnValue,
  parseSimpleColumnValue,
} from "../server/column-values.js";

const status = {
  id: "status",
  type: "status",
  settings: DEFAULT_STATUS_SETTINGS,
};
const text = { id: "notes", type: "text", settings: {} };
const numbers = { id: "estimate", type: "numbers", settings: {} };
const date = { id: "date", type: "date", settings: {} };
const people = { id: "person", type: "people", settings: {} };
const name = { id: "name", type: "name", settings: {} };
const users = new Map([
  ["1", { id: "1", name: "Alex Rivera" }],
  ["2", { id: "2", name: "Sam Lee" }],
]);
const getUser = (id) => users.get(id) ?? null;

const okValue = (result) => {
  assert.equal(result.ok, true, result.message);
  return result.value;
};
const failure = (result) => {
  assert.equal(
    result.ok,
    false,
    `expected failure, got ${JSON.stringify(result)}`,
  );
  assert.equal(typeof result.message, "string");
  return result.message;
};

test("status accepts an index, a label and a simple label", () => {
  assert.deepEqual(okValue(parseColumnValue(status, '{"index":1}')), {
    index: 1,
  });
  assert.deepEqual(okValue(parseColumnValue(status, '{"index":"2"}')), {
    index: 2,
  });
  assert.deepEqual(okValue(parseColumnValue(status, '{"index":5}')), {
    index: 5,
  });
  assert.deepEqual(okValue(parseColumnValue(status, '{"label":"Done"}')), {
    index: 1,
  });
  assert.deepEqual(okValue(parseColumnValue(status, '{"label":" stuck "}')), {
    index: 2,
  });
  assert.deepEqual(okValue(parseColumnValue(status, '"Working on it"')), {
    index: 0,
  });
  assert.deepEqual(okValue(parseSimpleColumnValue(status, "Done")), {
    index: 1,
  });
  assert.equal(okValue(parseColumnValue(status, '{"label":""}')), null);
});

test("status rejects unknown labels and indexes", () => {
  assert.match(
    failure(parseColumnValue(status, '{"label":"Blocked"}')),
    /Unknown status label/,
  );
  assert.match(failure(parseSimpleColumnValue(status, "Blocked")), /Blocked/);
  assert.match(
    failure(parseColumnValue(status, '{"index":3}')),
    /Unknown status index/,
  );
  failure(parseColumnValue(status, '{"index":1.5}'));
  failure(parseColumnValue(status, '{"index":-1}'));
  failure(parseColumnValue(status, '{"index":true}'));
  failure(parseColumnValue(status, '{"color":"red"}'));
  failure(parseColumnValue(status, "[1]"));
  failure(parseColumnValue(status, "7"));
});

test("status labels come from the column settings", () => {
  const custom = {
    type: "status",
    settings: { labels: { 0: "Todo", 7: "Shipped" }, labels_colors: {} },
  };
  assert.deepEqual(okValue(parseSimpleColumnValue(custom, "shipped")), {
    index: 7,
  });
  failure(parseSimpleColumnValue(custom, "Done"));
  assert.deepEqual(formatColumnValue(custom, { index: 7 }), {
    text: "Shipped",
    value: '{"index":7}',
  });
});

test("text keeps strings up to 2,000 characters", () => {
  assert.equal(okValue(parseColumnValue(text, '"abc"')), "abc");
  assert.equal(okValue(parseSimpleColumnValue(text, "  padded ")), "  padded ");
  assert.equal(
    okValue(parseSimpleColumnValue(text, "x".repeat(2000))).length,
    2000,
  );
  assert.match(failure(parseSimpleColumnValue(text, "x".repeat(2001))), /2000/);
  failure(parseColumnValue(text, JSON.stringify("x".repeat(2001))));
  failure(parseColumnValue(text, "42"));
  failure(parseColumnValue(text, '{"text":"abc"}'));
});

test("numbers accept finite numbers and numeric strings", () => {
  assert.equal(okValue(parseColumnValue(numbers, '"42"')), 42);
  assert.equal(okValue(parseColumnValue(numbers, "42")), 42);
  assert.equal(okValue(parseColumnValue(numbers, "-3.5")), -3.5);
  assert.equal(okValue(parseSimpleColumnValue(numbers, " 1e3 ")), 1000);
  assert.equal(okValue(parseSimpleColumnValue(numbers, ".5")), 0.5);
  assert.ok(Object.is(okValue(parseSimpleColumnValue(numbers, "-0")), 0));
  for (const bad of [
    '"abc"',
    "1e999",
    '"Infinity"',
    '"NaN"',
    '"0x10"',
    "true",
    '"1,000"',
  ]) {
    failure(parseColumnValue(numbers, bad));
  }
  failure(parseSimpleColumnValue(numbers, "12abc"));
  failure(parseSimpleColumnValue(numbers, "1e400"));
});

test("dates must be real calendar dates", () => {
  assert.equal(
    okValue(parseColumnValue(date, '{"date":"2026-10-18"}')),
    "2026-10-18",
  );
  assert.equal(
    okValue(parseSimpleColumnValue(date, " 2026-10-18 ")),
    "2026-10-18",
  );
  assert.equal(
    okValue(parseSimpleColumnValue(date, "2024-02-29")),
    "2024-02-29",
  );
  assert.equal(
    okValue(parseSimpleColumnValue(date, "2000-02-29")),
    "2000-02-29",
  );
  assert.equal(okValue(parseColumnValue(date, '{"date":null}')), null);
  assert.equal(okValue(parseColumnValue(date, '{"date":""}')), null);
  for (const bad of [
    "2026-02-29",
    "1900-02-29",
    "2026-13-01",
    "2026-04-31",
    "2026-00-10",
    "2026-1-5",
    "0000-01-01",
    "18/10/2026",
  ]) {
    failure(parseSimpleColumnValue(date, bad));
  }
  failure(parseColumnValue(date, '{"day":"2026-10-18"}'));
  failure(parseColumnValue(date, '{"date":20261018}'));
});

test("people accept known user IDs only", () => {
  const json = '{"personsAndTeams":[{"id":1,"kind":"person"},{"id":"2"}]}';
  assert.deepEqual(okValue(parseColumnValue(people, json, { getUser })), [
    "1",
    "2",
  ]);
  assert.deepEqual(
    okValue(parseSimpleColumnValue(people, "2, 1,2", { getUser })),
    ["2", "1"],
  );
  assert.deepEqual(
    okValue(parseSimpleColumnValue(people, "9")),
    ["9"],
    "syntax only without getUser",
  );
  assert.match(
    failure(parseSimpleColumnValue(people, "1,9", { getUser })),
    /Unknown user ID "9"/,
  );
  const team = '{"personsAndTeams":[{"id":1,"kind":"team"}]}';
  assert.match(
    failure(parseColumnValue(people, team, { getUser })),
    /teams are not supported/,
  );
  failure(parseSimpleColumnValue(people, "abc"));
  failure(parseSimpleColumnValue(people, "1.5"));
  failure(parseColumnValue(people, '{"personsAndTeams":[{"id":-1}]}'));
  failure(parseColumnValue(people, '{"personsAndTeams":"1"}'));
  assert.equal(
    okValue(parseColumnValue(people, '{"personsAndTeams":[]}')),
    null,
  );
});

test("null, empty strings and empty objects clear every type", () => {
  for (const column of [status, text, numbers, date, people]) {
    for (const json of ["null", '""', "{}", "", "  ", null]) {
      assert.equal(
        okValue(parseColumnValue(column, json)),
        null,
        `${column.type} ${json}`,
      );
    }
    assert.equal(okValue(parseSimpleColumnValue(column, null)), null);
    assert.equal(okValue(parseSimpleColumnValue(column, "")), null);
    assert.equal(okValue(parseSimpleColumnValue(column, "   ")), null);
  }
});

test("invalid JSON, unknown types and non-string simple values fail", () => {
  assert.match(failure(parseColumnValue(status, "{index:1}")), /valid JSON/);
  assert.match(
    failure(parseColumnValue({ type: "formula" }, '"x"')),
    /Unsupported column type/,
  );
  failure(parseSimpleColumnValue({ type: "__proto__" }, "x"));
  failure(parseSimpleColumnValue(text, 42));
});

test("already decoded values are accepted", () => {
  assert.deepEqual(okValue(parseColumnValue(status, { index: 2 })), {
    index: 2,
  });
  assert.equal(okValue(parseColumnValue(numbers, 7)), 7);
});

test("the name column only takes simple non-empty text", () => {
  assert.match(failure(parseColumnValue(name, '"New name"')), /simple string/);
  assert.equal(
    okValue(parseSimpleColumnValue(name, "  New name ")),
    "New name",
  );
  assert.equal(
    okValue(parseSimpleColumnValue(name, "n".repeat(255))).length,
    255,
  );
  failure(parseSimpleColumnValue(name, "n".repeat(256)));
  failure(parseSimpleColumnValue(name, "   "));
  failure(parseSimpleColumnValue(name, null));
});

test("formatColumnValue follows the output table", () => {
  assert.deepEqual(formatColumnValue(status, { index: 1 }), {
    text: "Done",
    value: '{"index":1}',
  });
  assert.deepEqual(formatColumnValue(status, { index: 5 }), {
    text: "",
    value: '{"index":5}',
  });
  assert.deepEqual(formatColumnValue(text, "abc"), {
    text: "abc",
    value: '"abc"',
  });
  assert.deepEqual(formatColumnValue(numbers, 42), {
    text: "42",
    value: '"42"',
  });
  assert.deepEqual(formatColumnValue(numbers, 2.5), {
    text: "2.5",
    value: '"2.5"',
  });
  assert.deepEqual(formatColumnValue(date, "2026-10-18"), {
    text: "2026-10-18",
    value: '{"date":"2026-10-18"}',
  });
  assert.deepEqual(formatColumnValue(people, ["1", "2"], { getUser }), {
    text: "Alex Rivera, Sam Lee",
    value:
      '{"personsAndTeams":[{"id":1,"kind":"person"},{"id":2,"kind":"person"}]}',
  });
  assert.equal(
    formatColumnValue(people, ["1", "9"], { getUser }).text,
    "Alex Rivera, 9",
  );
  assert.deepEqual(formatColumnValue(name, "Item"), {
    text: "Item",
    value: '"Item"',
  });
  for (const column of [status, text, numbers, date, people]) {
    assert.deepEqual(formatColumnValue(column, null), {
      text: null,
      value: null,
    });
    assert.deepEqual(formatColumnValue(column, undefined), {
      text: null,
      value: null,
    });
  }
});

test("formatted values parse back to the same stored value", () => {
  const cases = [
    [status, { index: 2 }],
    [text, "hello"],
    [numbers, -1.25],
    [date, "2026-12-31"],
    [people, ["2", "1"]],
  ];
  for (const [column, stored] of cases) {
    const { value } = formatColumnValue(column, stored, { getUser });
    assert.deepEqual(
      okValue(parseColumnValue(column, value, { getUser })),
      stored,
    );
    assert.ok(isValidStoredValue(column, stored, { getUser }));
  }
});

test("isValidStoredValue rejects values parsing would never produce", () => {
  assert.ok(isValidStoredValue(status, null));
  assert.ok(!isValidStoredValue(status, { index: 3 }));
  assert.ok(!isValidStoredValue(status, { index: 1, label: "Done" }));
  assert.ok(!isValidStoredValue(text, ""));
  assert.ok(!isValidStoredValue(text, "x".repeat(2001)));
  assert.ok(!isValidStoredValue(numbers, Number.NaN));
  assert.ok(!isValidStoredValue(numbers, "42"));
  assert.ok(!isValidStoredValue(date, "2026-02-30"));
  assert.ok(!isValidStoredValue(people, []));
  assert.ok(!isValidStoredValue(people, ["1", "1"]));
  assert.ok(!isValidStoredValue(people, [1]));
  assert.ok(!isValidStoredValue(people, ["9"], { getUser }));
  assert.ok(!isValidStoredValue(name, "Item"), "name values live on the item");
});

test("DEFAULT_STATUS_SETTINGS matches the spec and is frozen", () => {
  assert.deepEqual(DEFAULT_STATUS_SETTINGS, {
    labels: { 0: "Working on it", 1: "Done", 2: "Stuck", 5: "" },
    labels_colors: { 0: "#fdab3d", 1: "#00c875", 2: "#df2f4a", 5: "#c4c4c4" },
  });
  assert.ok(Object.isFrozen(DEFAULT_STATUS_SETTINGS.labels));
  assert.throws(() => {
    DEFAULT_STATUS_SETTINGS.labels[9] = "x";
  }, TypeError);
});
