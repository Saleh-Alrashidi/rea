import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GraphQLError } from "../server/graphql/errors.js";
import { execute } from "../server/graphql/execute.js";
import { parse } from "../server/graphql/parse.js";
import { buildSchema } from "../server/graphql/schema.js";

const USERS = [
  { id: "1", name: "Alex" },
  { id: "2", name: "Sam" },
];
/** Builds `{ name: { type } }` definitions from "name:Type" pairs. */
const typed = (spec) =>
  Object.fromEntries(
    spec.split(" ").map((pair) => {
      const [name, type] = pair.split(":");
      return [name, { type }];
    }),
  );
const ECHO_ARGS = typed(
  "text:String n:Int f:Float b:Boolean id:ID ids:[ID!] state:State matrix:[[Int]]",
);

function queryFields(state) {
  const fail = (error) => () => {
    throw error;
  };
  return {
    me: { type: "User!", resolve: () => USERS[0] },
    user: {
      type: "User",
      args: { id: { type: "ID!" } },
      resolve: (_, { id }) => USERS.find((user) => user.id === id) ?? null,
    },
    users: {
      type: "[User!]!",
      args: {
        ids: { type: "[ID!]" },
        limit: { type: "Int", defaultValue: 50 },
      },
      resolve(parent, args, context, info) {
        state.calls.push({ parent, args, context, info });
        return USERS;
      },
    },
    echo: {
      type: "String",
      args: ECHO_ARGS,
      resolve: (_, a) => JSON.stringify(a),
    },
    boom: { type: "String", resolve: fail(new Error("password=hunter2")) },
    forbidden: {
      type: "String",
      resolve: fail(new GraphQLError("Missing scope x", { code: "FORBIDDEN" })),
    },
    returned: { type: "String", resolve: () => new Error("returned") },
    strictUser: { type: "User!", resolve: () => null },
    board: {
      type: "Board",
      resolve: () => ({ id: 7, name: "Roadmap", state: "active", owner: null }),
    },
    numbers: { type: "[Int!]", resolve: () => [1, null, 3] },
    big: { type: "Int", resolve: () => 2 ** 40 },
    later: { type: "String", resolve: async () => "later" },
    newField: { type: "String", versions: { addedIn: "2026-04" } },
    oldField: { type: "String", versions: { removedIn: "2026-01" } },
  };
}

function fixture() {
  const state = { calls: [], order: [], total: 0 };
  const add = async (_, { n, delay }) => {
    await sleep(delay);
    state.order.push(n);
    state.total += n;
    return state.total;
  };
  const schema = buildSchema({
    enums: { State: ["active", "archived"] },
    types: {
      Query: { fields: queryFields(state) },
      User: {
        fields: {
          ...typed("id:ID! name:String!"),
          friends: {
            type: "[User!]!",
            resolve: (user) => USERS.filter(({ id }) => id !== user.id),
          },
        },
      },
      Board: { fields: typed("id:ID! name:String! state:State! owner:User!") },
      Mutation: {
        fields: {
          add: {
            type: "Int!",
            args: {
              n: { type: "Int!" },
              delay: { type: "Int", defaultValue: 0 },
            },
            resolve: add,
          },
          fail: { type: "Int!", resolve: () => Promise.reject(new Error("x")) },
        },
      },
    },
    mutation: "Mutation",
  });
  return { schema, state };
}

const json = (value) => JSON.parse(JSON.stringify(value));
const codeOf = (result) => result.errors[0].extensions.code;
/** Splits a text table into trimmed `|`-separated cells per row. */
const cells = (line) => line.split(" | ").map((cell) => cell.trim());
const rows = (table) => table.trim().split("\n").map(cells);
const location = (text) => {
  const [line, column] = text.split(":").map(Number);
  return { line, column };
};

async function run(query, options = {}) {
  const { schema = fixture().schema, ...rest } = options;
  const document = parse(query);
  const apiVersion = "2026-01";
  return json(await execute({ schema, document, apiVersion, ...rest }));
}

test("executes nested selections with aliases, __typename and defaults", async () => {
  const { schema, state } = fixture();
  const query = `{ __typename who: me { __typename id name friends { name } }
    users { id } later }`;
  const result = await run(query, { schema, context: { requestId: "r1" } });
  assert.deepEqual(result, {
    data: {
      __typename: "Query",
      who: {
        __typename: "User",
        id: "1",
        name: "Alex",
        friends: [{ name: "Sam" }],
      },
      users: [{ id: "1" }, { id: "2" }],
      later: "later",
    },
  });
  const [call] = state.calls;
  assert.equal(call.parent, null);
  assert.deepEqual(call.args, { limit: 50 });
  assert.deepEqual(call.context, { requestId: "r1" });
  const info = { fieldName: "users", path: ["users"], apiVersion: "2026-01" };
  assert.deepEqual(call.info, info);
});

test("merges repeated fields and resolves fragments and spreads", async () => {
  const query = `query { me { id } me { name } ...Root ... on Query { b: board { id } }
    ... { board { ...BoardParts } } }
    fragment Root on Query { me { ...UserParts } }
    fragment UserParts on User { id friends { id } }
    fragment BoardParts on Board { name state ... on User { id } }`;
  const { data } = await run(query);
  assert.deepEqual(data.me, { id: "1", name: "Alex", friends: [{ id: "2" }] });
  assert.deepEqual(data.b, { id: "7" });
  assert.deepEqual(data.board, { name: "Roadmap", state: "active" });
});

test("applies @include and @skip to fields, spreads and inline fragments", async () => {
  const query = `query ($yes: Boolean!, $no: Boolean = false) {
    a: me @include(if: $yes) { id } b: me @include(if: $no) { id }
    c: me @skip(if: $yes) { id } d: me @skip(if: $no) @include(if: true) { id }
    ...F @skip(if: true) ... @include(if: $yes) { e: me { id } } }
    fragment F on Query { f: me { id } }`;
  const { data } = await run(query, { variables: { yes: true } });
  assert.deepEqual(Object.keys(data), ["a", "d", "e"]);
  const bad = await run("query ($v: Boolean) { me @skip(if: $v) { id } }");
  assert.equal(bad.data, undefined);
  assert.equal(codeOf(bad), "BAD_USER_INPUT");
  assert.match(bad.errors[0].message, /Directive "@skip": Argument "if"/);
});

test("selects operations by name", async () => {
  const query = "query A { me { id } } query B { board { id } }";
  const selected = await run(query, { operationName: "B" });
  assert.deepEqual(selected.data, { board: { id: "7" } });
  const cases = [
    [query, null, /Must provide operation name if query contains multiple/],
    [query, "C", /Unknown operation named "C"\./],
    ["fragment F on Query { me { id } }", null, /Must provide an operation\./],
  ];
  for (const [source, operationName, pattern] of cases) {
    const result = await run(source, { operationName });
    assert.equal("data" in result, false);
    assert.equal(codeOf(result), "GRAPHQL_VALIDATION_FAILED");
    assert.match(result.errors[0].message, pattern);
  }
});

// query | expected message fragment | optional line:column
const VALIDATION_CASES = `
{ nope } | Cannot query field "nope" on type "Query". | 1:3
{ me { nope } } | Cannot query field "nope" on type "User". | 1:8
{ newField } | Cannot query field "newField" on type "Query". | 1:3
{ me(x: 1) { id } } | Unknown argument "x" on field "Query.me". | 1:6
{ user(id: 1, id: 2) { id } } | There can be only one argument named "id". | 1:15
{ user { id } } | Argument "id" of type "ID!" is required on field "Query.user", but it was not provided. | 1:3
{ me { id { x } } } | Field "id" must not have a selection since type "ID!" has no subfields. | 1:8
{ __typename { x } } | since type "String!" has no subfields. | 1:3
{ __typename(a: 1) } | Unknown argument "a" on field "Query.__typename". | 1:14
{ me } | Field "me" of type "User!" must have a selection of subfields. | 1:3
{ ...Missing } | Unknown fragment "Missing". | 1:3
{ me { ...A } } fragment A on User { friends { ...A } } | Cannot spread fragment "A" within itself. | 1:48
{ me { ...A } } fragment A on User { ...B } fragment B on User { ...A } | Cannot spread fragment "A" within itself via "B". | 1:66
{ ... on Nope { me { id } } } | Unknown type "Nope". | 1:3
{ ...F } fragment F on Nope { id } | Unknown type "Nope". | 1:10
{ ... on String { me { id } } } | Fragment cannot condition on non composite type "String". | 1:3
{ me @live { id } } | Unknown directive "@live". | 1:6
query @skip(if: true) { me { id } } | Directive "@skip" may not be used on operations. | 1:7
{ ...F } fragment F on Query @include(if: true) { me { id } } | Directive "@include" may not be used on fragments. | 1:30
{ me @skip(if: true) @skip(if: false) { id } } | The directive "@skip" can only be used once at this location. | 1:22
{ me @include { id } } | Argument "if" of type "Boolean!" is required on directive "@include" | 1:6
{ me @skip(when: true) { id } } | Unknown argument "when" on directive "@skip". | 1:12
{ user(id: $id) { id } } | Variable "$id" is not defined. | 1:12
{ users(ids: [$a]) { id } } | Variable "$a" is not defined. | 1:15
query ($a: Int, $a: Int) { me { id } } | There can be only one variable named "$a". | 1:17
query ($a: Nope) { me { id } } | Variable "$a" has unknown type "Nope". | 1:8
query ($a: User) { me { id } } | Variable "$a" cannot be non-input type "User". | 1:8
query ($a: [User!]) { me { id } } | Variable "$a" cannot be non-input type "[User!]". | 1:8
query ($a: Int = "x") { me { id } } | Variable "$a" has an invalid default value: Int cannot represent value "x". | 1:8
{ a: me { id } a: board { id } } | Fields "a" conflict because "me" and "board" are different fields. | 1:3
{ user(id: 1) { id } user(id: 2) { id } } | Fields "user" conflict because they have differing arguments. | 1:3
{ me { id } ...F } fragment F on Query { me: board { id } } | Fields "me" conflict | 1:3
{ ...F } fragment F on Query { me { id } } fragment F on Query { me { id } } | There can be only one fragment named "F". | 1:44
`;

test("rejects invalid operations with located validation errors", async () => {
  for (const [query, expected, at] of rows(VALIDATION_CASES)) {
    const result = await run(query);
    assert.equal("data" in result, false, query);
    assert.equal(codeOf(result), "GRAPHQL_VALIDATION_FAILED", query);
    assert.ok(
      result.errors[0].message.includes(expected),
      result.errors[0].message,
    );
    assert.deepEqual(result.errors[0].locations[0], location(at), query);
  }
});

test("validates the whole operation before running any resolver", async () => {
  const { schema, state } = fixture();
  const result = await run("{ users { id } nope }", { schema });
  assert.equal(codeOf(result), "GRAPHQL_VALIDATION_FAILED");
  assert.equal(state.calls.length, 0);
});

test("reports conflicting fields with both locations", async () => {
  const result = await run("{ a: me { id }\n  a: board { id } }");
  const locations = [location("1:3"), location("2:3")];
  assert.deepEqual(result.errors[0].locations, locations);
  const ok = await run("{ user(id: 1) { id } user(id: 1) { name } }");
  assert.deepEqual(ok.data, { user: { id: "1", name: "Alex" } });
});

test("rejects duplicate operation names and unsupported mutations", async () => {
  const query = "query A { me { id } } query A { me { id } }";
  const duplicate = await run(query, { operationName: "A" });
  assert.match(duplicate.errors[0].message, /only one operation named "A"/);
  const fields = { a: { type: "Int" } };
  const schema = buildSchema({ types: { Query: { fields } } });
  const mutation = await run("mutation { a }", { schema });
  assert.match(mutation.errors[0].message, /Schema does not support mutations/);
});

test("limits depth after fragment expansion", async () => {
  const deep = "{ me { friends { friends { id } } } }";
  assert.ok((await run(deep, { maxDepth: 4 })).data);
  const direct = await run(deep, { maxDepth: 3 });
  assert.equal(codeOf(direct), "MAX_DEPTH_EXCEEDED");
  const message = "Query depth 4 exceeds the maximum depth of 3.";
  assert.equal(direct.errors[0].message, message);
  assert.deepEqual(direct.errors[0].locations, [location("1:28")]);
  const viaFragments = `{ me { ...A } }
    fragment A on User { friends { ...B } }
    fragment B on User { ... on User { friends { id } } }`;
  const expanded = await run(viaFragments, { maxDepth: 3 });
  assert.equal(codeOf(expanded), "MAX_DEPTH_EXCEEDED");
  assert.deepEqual(expanded.errors[0].locations, [location("3:50")]);
  assert.ok((await run(viaFragments, { maxDepth: 4 })).data);
});

test("caps the number of validation errors", async () => {
  const result = await run(`{ ${"x ".repeat(150)}}`);
  assert.equal(result.errors.length, 101);
  assert.match(result.errors.at(-1).message, /Too many validation errors/);
});

// variable type | echo argument | JSON value ("-" = absent) | expected message
const BAD_VARIABLES = `
ID! | id | - | Variable "$v" of required type "ID!" was not provided.
ID! | id | null | Variable "$v" got an invalid value: Expected non-nullable type "ID!" not to be null.
Int | n | 2147483648 | Int cannot represent value 2147483648.
Int | n | -2147483649 | Int cannot represent value -2147483649.
Int | n | 1.5 | Int cannot represent value 1.5.
Int | n | "5" | Int cannot represent value "5".
Float | f | "1.5" | Float cannot represent value "1.5".
ID | id | 1.5 | ID cannot represent value 1.5.
ID | id | 9007199254740992 | ID cannot represent value 9007199254740992.
ID | id | true | ID cannot represent value true.
Boolean | b | "true" | Boolean cannot represent value "true".
String | text | 5 | String cannot represent value 5.
State | state | "deleted" | Value "deleted" does not exist in "State" enum.
[ID!] | ids | ["1",null] | In element #1: Expected non-nullable type "ID!" not to be null.
[[Int]] | matrix | [[1],["x"]] | In element #1: In element #0: Int cannot represent value "x".
`;

// variable type | echo argument | JSON value ("-" = absent) | echo output
const GOOD_VARIABLES = `
ID | id | 5 | {"id":"5"}
ID | id | "abc" | {"id":"abc"}
[ID!] | ids | "1" | {"ids":["1"]}
[ID!] | ids | [1,"2"] | {"ids":["1","2"]}
State | state | "archived" | {"state":"archived"}
Int | n | 2147483647 | {"n":2147483647}
Int | n | -2147483648 | {"n":-2147483648}
Int | n | null | {"n":null}
Int | n | - | {}
Float | f | 2 | {"f":2}
[[Int]] | matrix | 4 | {"matrix":[[4]]}
String | text | "\\u00e9" | {"text":"é"}
`;

function variableRun([type, arg, value]) {
  const variables = value === "-" ? {} : { v: JSON.parse(value) };
  return run(`query Q($v: ${type}) { echo(${arg}: $v) }`, { variables });
}

test("rejects invalid variables with BAD_USER_INPUT and no data", async () => {
  for (const row of rows(BAD_VARIABLES)) {
    const result = await variableRun(row);
    assert.equal("data" in result, false, row[2]);
    assert.equal(codeOf(result), "BAD_USER_INPUT", row[2]);
    assert.ok(
      result.errors[0].message.includes(row[3]),
      result.errors[0].message,
    );
    assert.deepEqual(result.errors[0].locations, [location("1:9")]);
  }
  const notObject = await run("{ me { id } }", { variables: [1] });
  assert.match(notObject.errors[0].message, /Variables must be a JSON object/);
});

test("coerces variables, defaults and list wrapping", async () => {
  for (const row of rows(GOOD_VARIABLES)) {
    assert.deepEqual((await variableRun(row)).data, { echo: row[3] }, row[2]);
  }
  const echo = async (query, variables) =>
    (await run(query, { variables })).data;
  const withDefault = "query ($n: Int = 3) { echo(n: $n) }";
  assert.deepEqual(await echo(withDefault, {}), { echo: '{"n":3}' });
  assert.deepEqual(await echo(withDefault, { n: 4, extra: 1 }), {
    echo: '{"n":4}',
  });
  assert.deepEqual(await echo(withDefault, null), { echo: '{"n":3}' });
});

// echo arguments | echo output, or "!" and the expected error message
const LITERAL_ARGUMENTS = `
id: 42 | {"id":"42"}
id: "a1" | {"id":"a1"}
f: 1, b: false | {"f":1,"b":false}
f: -1.5e2 | {"f":-150}
state: active | {"state":"active"}
ids: "1" | {"ids":["1"]}
ids: [1, "2"] | {"ids":["1","2"]}
matrix: [1, [2, 3], null] | {"matrix":[[1],[2,3],null]}
text: null | {"text":null}
text: """ block """ | {"text":" block "}
n: 2147483648 | !Argument "n" has an invalid value: Int cannot represent value 2147483648.
n: -2147483649 | !Int cannot represent value -2147483649.
n: "1" | !Int cannot represent value "1".
n: 1.0 | !Int cannot represent value 1.
id: 4.5 | !ID cannot represent value 4.5.
id: 9007199254740993 | !ID cannot represent value 9007199254740992.
text: 1 | !String cannot represent value 1.
text: RED | !String cannot represent value RED.
state: "active" | !Enum "State" cannot represent value "active".
state: deleted | !Enum "State" cannot represent value deleted.
ids: [null] | !In element #0: Expected value of non-null type "ID!" not to be null.
text: { a: 1 } | !String cannot represent value an object.
b: [true] | !Boolean cannot represent value a list.
`;

test("coerces literal arguments or reports located field errors", async () => {
  for (const [args, expected] of rows(LITERAL_ARGUMENTS)) {
    const result = await run(`{ echo(${args}) }`);
    if (!expected.startsWith("!")) {
      assert.deepEqual(result, { data: { echo: expected } }, args);
      continue;
    }
    assert.deepEqual(result.data, { echo: null }, args);
    const [error] = result.errors;
    assert.equal(error.extensions.code, "BAD_USER_INPUT", args);
    assert.ok(error.message.includes(expected.slice(1)), error.message);
    assert.deepEqual(error.path, ["echo"], args);
    assert.deepEqual(error.locations, [location("1:3")], args);
  }
});

test("checks non-null arguments at execution time", async () => {
  const nullId = await run("{ user(id: null) { id } }");
  assert.deepEqual(nullId.data, { user: null });
  assert.match(nullId.errors[0].message, /non-null type "ID!" not to be null/);
  const absent = await run("query ($id: ID) { user(id: $id) { id } }");
  const message = /"id" of required type "ID!" was not provided/;
  assert.match(absent.errors[0].message, message);
});

test("applies argument defaults when a variable is absent", async () => {
  const { schema, state } = fixture();
  const query = "query ($l: Int) { users(limit: $l) { id } }";
  await run(query, { schema });
  await run(query, { schema, variables: { l: null } });
  const args = state.calls.map((call) => call.args);
  assert.deepEqual(args, [{ limit: 50 }, { limit: null }]);
});

test("propagates nulls to the nearest nullable parent", async () => {
  const board = await run("{ board { id owner { id } } later }");
  assert.deepEqual(board.data, { board: null, later: "later" });
  assert.deepEqual(board.errors, [
    {
      message: "Cannot return null for non-nullable field Board.owner.",
      locations: [location("1:14")],
      path: ["board", "owner"],
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    },
  ]);
  const root = await run("{ later strictUser { id } }");
  assert.equal(root.data, null);
  assert.deepEqual(root.errors[0].path, ["strictUser"]);
  const list = await run("{ numbers }");
  assert.deepEqual(list.data, { numbers: null });
  assert.deepEqual(list.errors[0].path, ["numbers", 1]);
  const leaf = await run("{ big }");
  assert.deepEqual(leaf.data, { big: null });
  const serialize = /Int cannot represent the value resolved for Query\.big/;
  assert.match(leaf.errors[0].message, serialize);
});

test("masks unexpected resolver errors and keeps GraphQLErrors", async () => {
  const logged = [];
  const log = { error: (...args) => logged.push(args) };
  const query = "{ boom forbidden returned later }";
  const result = await run(query, { context: { log } });
  const data = { boom: null, forbidden: null, returned: null, later: "later" };
  assert.deepEqual(result.data, data);
  const summary = result.errors.map((error) => [
    error.message,
    error.extensions.code,
    error.path,
  ]);
  assert.deepEqual(summary, [
    ["Internal server error", "INTERNAL_SERVER_ERROR", ["boom"]],
    ["Missing scope x", "FORBIDDEN", ["forbidden"]],
    ["Internal server error", "INTERNAL_SERVER_ERROR", ["returned"]],
  ]);
  assert.deepEqual(result.errors[1].locations, [location("1:8")]);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.equal(logged.length, 2);
  assert.equal(logged[0][1].message, "password=hunter2");
  assert.ok(await run(query), "a missing context.log is tolerated");
});

test("runs mutation fields serially in document order", async () => {
  const { schema, state } = fixture();
  const query = `mutation { a: add(n: 1, delay: 30) b: add(n: 2)
    c: add(n: 3, delay: 5) }`;
  const result = await run(query, { schema });
  assert.deepEqual(result.data, { a: 1, b: 3, c: 6 });
  assert.deepEqual(state.order, [1, 2, 3]);
  const failing = "mutation { a: add(n: 1) fail b: add(n: 2) }";
  const failed = await run(failing, { schema });
  assert.equal(failed.data, null);
  assert.deepEqual(failed.errors[0].path, ["fail"]);
  // Fields after a failed non-null mutation field do not run.
  assert.deepEqual(state.order, [1, 2, 3, 1]);
});

test("gates fields by API version", async () => {
  const fresh = await run("{ newField }", { apiVersion: "2026-04" });
  assert.deepEqual(fresh.data, { newField: null });
  const old = await run("{ oldField }", { apiVersion: "2025-10" });
  assert.deepEqual(old.data, { oldField: null });
  const removed = await run("{ oldField }", { apiVersion: "2026-01" });
  assert.match(removed.errors[0].message, /Cannot query field "oldField"/);
  const unversioned = await run("{ newField }", { apiVersion: undefined });
  assert.equal(codeOf(unversioned), "GRAPHQL_VALIDATION_FAILED");
});

test("stops with one error when the field budget is exhausted", async () => {
  // users, then id + name + friends + friends.id for each of the two users.
  const query = "{ users { id name friends { id } } }";
  assert.equal((await run(query, { maxFields: 9 })).errors, undefined);
  const result = await run(query, { maxFields: 6 });
  assert.equal(result.data, null);
  assert.equal(result.errors.length, 1);
  assert.equal(codeOf(result), "COMPLEXITY_BUDGET_EXHAUSTED");
  assert.deepEqual(result.errors[0].path, ["users", 1, "name"]);
});

test("bounds fragment expansion before and during execution", async () => {
  // maxFields 10 allows 100 collected field nodes across both phases.
  const ids = (n) => run(`{ me { ${"id ".repeat(n)}} }`, { maxFields: 10 });
  const early = await ids(120);
  assert.equal("data" in early, false);
  assert.equal(codeOf(early), "COMPLEXITY_BUDGET_EXHAUSTED");
  assert.match(early.errors[0].message, /fragments expand to too many fields/);
  const late = await ids(60);
  assert.equal(late.data, null);
  assert.equal(late.errors.length, 1);
  assert.equal(codeOf(late), "COMPLEXITY_BUDGET_EXHAUSTED");
  assert.deepEqual((await ids(40)).data, { me: { id: "1" } });
});

test("keeps unusual aliases as ordinary keys", async () => {
  const { schema } = fixture();
  const document = parse("{ __proto__: me { id } constructor: later }");
  const { data } = await execute({ schema, document });
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
  assert.deepEqual(Object.keys(data), ["__proto__", "constructor"]);
  const descriptor = Object.getOwnPropertyDescriptor(data, "__proto__");
  assert.deepEqual(descriptor.value, { id: "1" });
});

test("requires a built schema and a parsed document", async () => {
  const { schema } = fixture();
  const document = parse("{ me { id } }");
  await assert.rejects(execute({ schema, document: "{ me }" }), TypeError);
  await assert.rejects(execute({ schema: {}, document }), TypeError);
});
