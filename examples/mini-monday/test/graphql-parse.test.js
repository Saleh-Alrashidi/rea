// Covers parse() and GraphQLError, plus buildSchema()/printSchema() (the
// schema half of the GraphQL engine; execution lives in
// graphql-execute.test.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComplexityError,
  GraphQLError,
  locatedError,
} from "../server/graphql/errors.js";
import { parse } from "../server/graphql/parse.js";
import { buildSchema, printSchema } from "../server/graphql/schema.js";

/** Splits a text table into trimmed `|`-separated cells per row. */
const cells = (line) => line.split(" | ").map((cell) => cell.trim());
const rows = (table) => table.trim().split("\n").map(cells);
const at = (text) => {
  const [line, column] = text.split(":").map(Number);
  return { line, column };
};
const selections = (source) =>
  parse(source).definitions[0].selectionSet.selections;
const argValue = (literal) =>
  selections(`{ f(a: ${literal}) }`)[0].arguments[0].value;

function parseError(source, options) {
  try {
    parse(source, options);
  } catch (error) {
    assert.ok(error instanceof GraphQLError, String(error));
    return error;
  }
  assert.fail(`expected ${JSON.stringify(source)} to fail`);
}

test("parses operations, variables, aliases, arguments and selections", () => {
  const source = `query Board($id: ID! = 1, $limit: [Int]) @trace {
  board: boards(ids: [$id]) { id }
}`;
  const field = (name, loc, rest) => ({
    kind: "Field",
    alias: null,
    name,
    arguments: [],
    directives: [],
    selectionSet: null,
    ...rest,
    loc: at(loc),
  });
  const named = (name) => ({ kind: "NamedType", name });
  const ids = {
    name: "ids",
    value: {
      kind: "ListValue",
      values: [{ kind: "Variable", name: "id", loc: at("2:23") }],
    },
    loc: at("2:17"),
  };
  const id = field("id", "2:31");
  const board = field("boards", "2:3", {
    alias: "board",
    arguments: [ids],
    selectionSet: { kind: "SelectionSet", selections: [id] },
  });
  const variableDefinitions = [
    {
      name: "id",
      type: { kind: "NonNullType", ofType: named("ID") },
      defaultValue: { kind: "IntValue", value: 1 },
      loc: at("1:13"),
    },
    {
      name: "limit",
      type: { kind: "ListType", ofType: named("Int") },
      loc: at("1:27"),
    },
  ];
  assert.deepEqual(parse(source), {
    kind: "Document",
    definitions: [
      {
        kind: "OperationDefinition",
        operation: "query",
        name: "Board",
        variableDefinitions,
        directives: [{ name: "trace", arguments: [], loc: at("1:42") }],
        selectionSet: { kind: "SelectionSet", selections: [board] },
        loc: at("1:1"),
      },
    ],
  });
});

test("parses shorthand, anonymous and mutation operations", () => {
  const [shorthand, anonymous, mutation, named] = parse(
    "{ a } query { b } mutation { c } mutation Save { d }",
  ).definitions;
  assert.deepEqual(
    [shorthand, anonymous, mutation, named].map((op) => [
      op.operation,
      op.name,
    ]),
    [
      ["query", null],
      ["query", null],
      ["mutation", null],
      ["mutation", "Save"],
    ],
  );
  assert.deepEqual(mutation.loc, at("1:19"));
  assert.deepEqual(shorthand.variableDefinitions, []);
});

test("parses fragments, spreads, inline fragments and directives", () => {
  const source = `fragment F on Board @x { ...G @skip(if: $s)
  ... on Item { name } ... @include(if: true) { id } ... { id } }`;
  const [fragment] = parse(source).definitions;
  assert.equal(fragment.kind, "FragmentDefinition");
  assert.equal(fragment.name, "F");
  assert.equal(fragment.typeCondition, "Board");
  assert.deepEqual(fragment.loc, at("1:1"));
  assert.deepEqual(fragment.directives, [
    { name: "x", arguments: [], loc: at("1:21") },
  ]);
  const [spread, typed, conditional, bare] = fragment.selectionSet.selections;
  const skip = {
    name: "skip",
    arguments: [
      {
        name: "if",
        value: { kind: "Variable", name: "s", loc: at("1:41") },
        loc: at("1:37"),
      },
    ],
    loc: at("1:31"),
  };
  const spreadNode = { kind: "FragmentSpread", name: "G", directives: [skip] };
  assert.deepEqual(spread, { ...spreadNode, loc: at("1:26") });
  assert.equal(typed.kind, "InlineFragment");
  assert.equal(typed.typeCondition, "Item");
  assert.deepEqual(typed.loc, at("2:3"));
  assert.equal(conditional.typeCondition, null);
  assert.equal(conditional.directives[0].name, "include");
  assert.deepEqual(bare.directives, []);
  assert.equal(bare.selectionSet.selections[0].name, "id");
});

// GraphQL literal | JSON of the expected value node
const LITERALS = String.raw`
123 | {"kind":"IntValue","value":123}
-7 | {"kind":"IntValue","value":-7}
0 | {"kind":"IntValue","value":0}
1.5 | {"kind":"FloatValue","value":1.5}
-1.5e3 | {"kind":"FloatValue","value":-1500}
2E-2 | {"kind":"FloatValue","value":0.02}
1e+2 | {"kind":"FloatValue","value":100}
0.0 | {"kind":"FloatValue","value":0}
"abc" | {"kind":"StringValue","value":"abc"}
"" | {"kind":"StringValue","value":""}
"\" \\ \/ \b \f \n \r \t" | {"kind":"StringValue","value":"\" \\ / \b \f \n \r \t"}
"é€" | {"kind":"StringValue","value":"é€"}
"😀" | {"kind":"StringValue","value":"😀"}
"# not a comment" | {"kind":"StringValue","value":"# not a comment"}
"""  block  """ | {"kind":"StringValue","value":"  block  "}
"""\n stays raw""" | {"kind":"StringValue","value":"\\n stays raw"}
true | {"kind":"BooleanValue","value":true}
false | {"kind":"BooleanValue","value":false}
null | {"kind":"NullValue"}
ACTIVE | {"kind":"EnumValue","value":"ACTIVE"}
nullable | {"kind":"EnumValue","value":"nullable"}
[] | {"kind":"ListValue","values":[]}
[1, "a" [true]] | {"kind":"ListValue","values":[{"kind":"IntValue","value":1},{"kind":"StringValue","value":"a"},{"kind":"ListValue","values":[{"kind":"BooleanValue","value":true}]}]}
{} | {"kind":"ObjectValue","fields":[]}
{a: 1, b: {c: null}} | {"kind":"ObjectValue","fields":[{"name":"a","value":{"kind":"IntValue","value":1}},{"name":"b","value":{"kind":"ObjectValue","fields":[{"name":"c","value":{"kind":"NullValue"}}]}}]}
$var | {"kind":"Variable","name":"var","loc":{"line":1,"column":8}}
`;

test("parses every value literal kind", () => {
  for (const [literal, expected] of rows(LITERALS)) {
    const actual = JSON.stringify(argValue(literal));
    assert.equal(actual, JSON.stringify(JSON.parse(expected)), literal);
  }
});

test("dedents block strings", () => {
  const block = (body) => argValue(`"""${body}"""`).value;
  const letter = "\n    Hello,\n      World!\n\n    Yours\n  ";
  assert.equal(block(letter), "Hello,\n  World!\n\nYours");
  assert.equal(block('a \\""" b'), 'a """ b');
  assert.equal(block("first\r\n  second\r  third"), "first\nsecond\nthird");
  assert.equal(block("\n\n  \t \n"), "");
  assert.equal(block('say "hi" '), 'say "hi" ');
  const [, after] = selections('{ a(x: """\none\ntwo\n""") b }');
  assert.deepEqual(after.loc, at("4:6"));
});

test("treats comments, commas, BOM and CR/CRLF as ignored tokens", () => {
  const source = "﻿# heading\r\n{ a, b # trailing } ,\r  c,,, }";
  const [a, b, c] = selections(source);
  assert.deepEqual([a.loc, b.loc, c.loc], [at("2:3"), at("2:6"), at("3:3")]);
  assert.equal(selections("{a,b}").length, 2);
});

// source | expected message | line:column
const SYNTAX_ERRORS = String.raw`
# only a comment | Syntax Error: Unexpected <EOF>. | 1:17
{ | Syntax Error: Expected Name, found <EOF>. | 1:2
{} | Syntax Error: Expected Name, found "}". | 1:2
{ a( ) } | Syntax Error: Expected Name, found ")". | 1:6
{ a(x: ) } | Syntax Error: Unexpected ")". | 1:8
{ a } } | Syntax Error: Unexpected "}". | 1:7
query ($a) { a } | Syntax Error: Expected ":", found ")". | 1:10
query () { a } | Syntax Error: Expected "$", found ")". | 1:8
{ a(x: 0123) } | Syntax Error: Invalid number, unexpected digit after 0: "1". | 1:9
{ a(x: 1.) } | Syntax Error: Invalid number, expected digit but got: ")". | 1:10
{ a(x: 1e) } | Syntax Error: Invalid number, expected digit but got: ")". | 1:10
{ a(x: 1.5.2) } | Syntax Error: Invalid number, expected digit but got: ".". | 1:11
{ a(x: 12abc) } | Syntax Error: Invalid number, expected digit but got: "a". | 1:10
{ a(x: -) } | Syntax Error: Invalid number, expected digit but got: ")". | 1:9
{ a(x: "abc) } | Syntax Error: Unterminated string. | 1:15
{ a(x: "a\qb") } | Syntax Error: Invalid character escape sequence: "\\q". | 1:10
{ a(x: "\u12G4") } | Syntax Error: Invalid Unicode escape sequence: "\\u12G4". | 1:9
{ a(x: "\uDE00") } | Syntax Error: Invalid Unicode escape sequence: "\\uDE00". | 1:9
{ a(x: "\uD83Dx") } | Syntax Error: Invalid Unicode escape sequence: "\\uD83D". | 1:9
{ a ? } | Syntax Error: Unexpected character: "?". | 1:5
{ ..a } | Syntax Error: Unexpected character: ".". | 1:3
subscription { a } | Syntax Error: Subscription operations are not supported. | 1:1
type Query { a: Int } | Syntax Error: Unexpected Name "type". | 1:1
query ($a: Int = $b) { a } | Syntax Error: Unexpected variable in constant value. | 1:18
fragment on on X { a } | Syntax Error: Expected fragment name, found Name "on". | 1:10
fragment F Board { a } | Syntax Error: Expected "on", found Name "Board". | 1:12
{ a(x: [1, 2) } | Syntax Error: Unexpected ")". | 1:13
{ a(x: {b 1}) } | Syntax Error: Expected ":", found Int "1". | 1:11
{ ... } | Syntax Error: Expected "{", found "}". | 1:7
{ a @ } | Syntax Error: Expected Name, found "}". | 1:7
{ a(x: "s" "t") } | Syntax Error: Expected Name, found String "t". | 1:12
"""unterminated | Syntax Error: Unterminated string. | 1:16
`;

test("reports syntax errors with GRAPHQL_PARSE_FAILED and locations", () => {
  for (const [source, message, location] of rows(SYNTAX_ERRORS)) {
    const error = parseError(source);
    assert.equal(error.code, "GRAPHQL_PARSE_FAILED", source);
    assert.equal(error.message, message, source);
    assert.deepEqual(error.locations, [at(location)], source);
  }
});

test("locates errors on later lines and rejects raw control characters", () => {
  const cases = [
    ["{\n  a(x: 01)\n}", "2:9", /unexpected digit after 0/],
    ['{ a(x: "line\nbreak") }', "1:13", /Unterminated string/],
    ['{ a(x: "\u0007") }', "1:9", /Invalid character within String: U\+0007/],
    ['{ a(x: """\n ok \u0000""") }', "2:5", /within String: U\+0000/],
    ["{ a \u0007 }", "1:5", /Unexpected character: U\+0007/],
    ["{ a(x: 1)\r\n  b(y: @) }", "2:8", /Unexpected "@"/],
  ];
  for (const [source, location, pattern] of cases) {
    const error = parseError(source);
    assert.match(error.message, pattern, source);
    assert.deepEqual(error.locations, [at(location)], source);
  }
  const empty = parseError("");
  assert.equal(empty.message, "Syntax Error: Unexpected <EOF>.");
  assert.deepEqual(empty.locations, [at("1:1")]);
  const notText = parseError(42);
  assert.equal(notText.code, "GRAPHQL_PARSE_FAILED");
});

test("enforces the source size limit", () => {
  assert.ok(parse("{ a }", { maxLength: 5 }));
  const error = parseError("{ a }", { maxLength: 4 });
  assert.equal(error.code, "QUERY_TOO_LARGE");
  const padded = `{ a }${" ".repeat(100_000)}`;
  assert.equal(parseError(padded).code, "QUERY_TOO_LARGE");
});

test("enforces the selection-set depth limit", () => {
  const nested = (depth) => `${"{ a ".repeat(depth)}${"}".repeat(depth)}`;
  assert.ok(parse(nested(12)));
  const error = parseError(nested(13));
  assert.equal(error.code, "MAX_DEPTH_EXCEEDED");
  assert.deepEqual(error.locations, [at("1:49")]);
  assert.ok(parse("{ a { b { c } } }", { maxDepth: 3 }));
  const limited = parseError("{ a { b { c } } }", { maxDepth: 2 });
  assert.deepEqual(limited.locations, [at("1:9")]);
  assert.equal(
    parseError("{ ... { a } }", { maxDepth: 1 }).code,
    "MAX_DEPTH_EXCEEDED",
  );
  assert.ok(parse("{ a } fragment F on Q { b { c } }", { maxDepth: 2 }));
  const huge = parseError("{a".repeat(40_000));
  assert.equal(huge.code, "MAX_DEPTH_EXCEEDED");
});

test("bounds value and type nesting", () => {
  const list = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  assert.equal(argValue(list(64)).kind, "ListValue");
  assert.equal(parseError(`{ f(a: ${list(65)}) }`).code, "MAX_DEPTH_EXCEEDED");
  const object = `${"{a: ".repeat(65)}1${"}".repeat(65)}`;
  assert.equal(parseError(`{ f(a: ${object}) }`).code, "MAX_DEPTH_EXCEEDED");
  const type = `${"[".repeat(65)}Int${"]".repeat(65)}`;
  const query = `query ($a: ${type}) { a }`;
  assert.equal(parseError(query).code, "MAX_DEPTH_EXCEEDED");
});

test("GraphQLError serializes the response error shape", () => {
  const plain = new GraphQLError("boom");
  assert.ok(plain instanceof Error);
  assert.equal(plain.name, "GraphQLError");
  assert.equal(
    JSON.stringify(plain),
    '{"message":"boom","extensions":{"code":"INTERNAL_SERVER_ERROR"}}',
  );
  const locations = [{ line: 2, column: 3, extra: true }];
  const located = new GraphQLError("bad", {
    code: "BAD_USER_INPUT",
    locations,
    path: ["items", 0, "name"],
  });
  assert.equal(
    JSON.stringify(located),
    '{"message":"bad","locations":[{"line":2,"column":3}],' +
      '"path":["items",0,"name"],"extensions":{"code":"BAD_USER_INPUT"}}',
  );
  located.toJSON().path.push("mutated");
  assert.deepEqual(located.path, ["items", 0, "name"]);
  const empty = new GraphQLError("x", { code: "C", locations: [] });
  assert.deepEqual(empty.toJSON(), { message: "x", extensions: { code: "C" } });
});

test("ComplexityError and locatedError build located response errors", () => {
  const locations = [{ line: 1, column: 2 }];
  const budget = new ComplexityError("too big", { locations, path: ["a"] });
  assert.ok(budget instanceof GraphQLError);
  const expected = { message: "too big", locations, path: ["a"] };
  const code = "COMPLEXITY_BUDGET_EXHAUSTED";
  assert.deepEqual(budget.toJSON(), { ...expected, extensions: { code } });
  const logged = [];
  const log = { error: (...args) => logged.push(args) };
  const masked = locatedError(new TypeError("secret"), { path: ["x", 0], log });
  const summary = (error) => [error.message, error.code, error.path];
  assert.deepEqual(summary(masked), [
    "Internal server error",
    "INTERNAL_SERVER_ERROR",
    ["x", 0],
  ]);
  assert.equal(logged[0][1].message, "secret");
  const original = new GraphQLError("nope", { code: "FORBIDDEN", path: ["a"] });
  const kept = locatedError(original, { locations, path: ["b"] });
  assert.deepEqual(summary(kept), ["nope", "FORBIDDEN", ["b"]]);
  assert.deepEqual(original.path, ["a"]);
  assert.equal(locatedError("thrown string").message, "Internal server error");
});

const withQuery = (fields, extra = {}) => ({
  types: { Query: { fields } },
  ...extra,
});
const withField = (field) => withQuery({ a: { type: "Int", ...field } });
const withArg = (arg) => withField({ args: { x: arg } });
const withExtra = (extra) => withQuery({ a: { type: "Int" } }, extra);
const nestedList = `${"[".repeat(10)}Int${"]".repeat(10)}`;
const BAD_SCHEMAS = [
  [{}, /types must be a plain object/],
  [withExtra({ extra: 1 }), /unknown key "extra"/],
  [withField({ type: "Nope" }), /references unknown type "Nope"/],
  [withField({ type: "[Int" }), /invalid type "\[Int"/],
  [withField({ type: "Int!!" }), /invalid type "Int!!"/],
  [withField({ type: " Int" }), /invalid type " Int"/],
  [withField({ type: nestedList }), /invalid type/],
  [withField({ type: 5 }), /type must be a string/],
  [withArg({ type: "Query" }), /uses object type "Query" as an input/],
  [
    withArg({ type: "Int", defaultValue: "1" }),
    /default is invalid: Int cannot/,
  ],
  [withArg({ type: "Int", default: 1 }), /unknown key "default"/],
  [withField({ resolver() {} }), /unknown key "resolver"/],
  [withField({ resolve: 1 }), /resolve must be a function/],
  [withField({ versions: { addedIn: "2026-4" } }), /"YYYY-MM"/],
  [withField({ versions: { since: "2026-04" } }), /unknown key "since"/],
  [withField({ description: 5 }), /description must be a string/],
  [withQuery({ __a: { type: "Int" } }), /invalid name "__a"/],
  [withQuery({ "a-b": { type: "Int" } }), /invalid name "a-b"/],
  [withQuery({}), /must define at least one field/],
  [withExtra({ mutation: "Mutation" }), /root type "Mutation"/],
  [
    { types: { Other: { fields: { a: { type: "Int" } } } } },
    /root type "Query"/,
  ],
  [withExtra({ enums: { E: [] } }), /non-empty array/],
  [withExtra({ enums: { E: ["a", "a"] } }), /duplicate value "a"/],
  [withExtra({ enums: { E: ["true"] } }), /value "true"/],
  [withExtra({ enums: { String: ["a"] } }), /built-in scalar/],
  [withExtra({ enums: { Query: ["a"] } }), /"Query" is defined twice/],
];

test("buildSchema rejects invalid definitions", () => {
  for (const [definition, pattern] of BAD_SCHEMAS) {
    assert.throws(() => buildSchema(definition), pattern, pattern.source);
  }
});

function printableSchema() {
  return buildSchema({
    enums: { Color: ["red", "green"] },
    types: {
      Root: {
        description: "Entry point",
        fields: {
          items: {
            type: "[Item!]!",
            description: "All items.\nPaged.",
            args: {
              first: { type: "Int", defaultValue: 25 },
              color: { type: "Color", defaultValue: "red" },
              ids: { type: "[ID!]", defaultValue: 5 },
              label: { type: "String", defaultValue: 'a "b"' },
            },
          },
          search: {
            type: "[Item!]!",
            args: {
              text: { type: "String!", description: 'Say "hi"' },
              after: { type: "String", defaultValue: null },
            },
          },
          legacy: {
            type: "Int",
            deprecationReason: 'Use "items"',
            versions: { removedIn: "2026-04" },
          },
          future: { type: "Int", versions: { addedIn: "2026-04" } },
        },
      },
      Item: {
        fields: {
          id: { type: "ID!", description: 'Has """ inside' },
          label: { type: "String", description: "Ends with a quote:'\"" },
        },
      },
      Hidden: {
        fields: { a: { type: "Int", versions: { addedIn: "2030-01" } } },
      },
      Change: { fields: { ok: { type: "Boolean!" } } },
    },
    query: "Root",
    mutation: "Change",
  });
}

test("printSchema prints version-filtered SDL", () => {
  const expected = `schema {
  query: Root
  mutation: Change
}

"""Entry point"""
type Root {
  """
  All items.
  Paged.
  """
  items(first: Int = 25, color: Color = red, ids: [ID!] = ["5"], label: String = "a \\"b\\""): [Item!]!
  search(
    """
    Say "hi"
    """
    text: String!
    after: String = null
  ): [Item!]!
  legacy: Int @deprecated(reason: "Use \\"items\\"")
}

type Item {
  """Has \\""" inside"""
  id: ID!
  """
  Ends with a quote:'"
  """
  label: String
}

type Hidden

type Change {
  ok: Boolean!
}

enum Color {
  red
  green
}
`;
  const schema = printableSchema();
  assert.equal(printSchema(schema, { apiVersion: "2026-01" }), expected);
  const next = printSchema(schema, { apiVersion: "2026-04" });
  assert.equal(next.includes("legacy"), false);
  assert.ok(next.includes("  future: Int\n"));
  const simple = buildSchema(withQuery({ a: { type: "Int" } }));
  assert.equal(printSchema(simple), "type Query {\n  a: Int\n}\n");
});

test("buildSchema returns an immutable schema with coerced defaults", () => {
  const schema = printableSchema();
  assert.equal(Object.isFrozen(schema), true);
  const items = schema.types.get("Root").fields.get("items");
  assert.equal(Object.isFrozen(items), true);
  const ids = items.args.get("ids");
  assert.deepEqual(ids.defaultValue, ["5"]);
  assert.equal(Object.isFrozen(ids.defaultValue), true);
});
