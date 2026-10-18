/**
 * Validation rules whose cost or reach the basic execute tests do not
 * cover: field merging across sub-selections and the work a fragment
 * spread under many parents may cause (validation and argument coercion
 * must stay proportional to the document, not to its expansion).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "../server/graphql/execute.js";
import { parse } from "../server/graphql/parse.js";
import { buildSchema } from "../server/graphql/schema.js";

const USERS = [
  { id: "1", name: "Alex" },
  { id: "2", name: "Sam" },
];

function fixture() {
  const calls = [];
  const schema = buildSchema({
    types: {
      Query: {
        fields: {
          me: { type: "User!", resolve: () => USERS[0] },
          user: {
            type: "User",
            args: { id: { type: "ID!" } },
            resolve: (_, { id }) => USERS.find((user) => user.id === id),
          },
        },
      },
      User: {
        fields: {
          id: { type: "ID!" },
          name: { type: "String!" },
          friends: {
            type: "[User!]!",
            resolve: (user) => USERS.filter(({ id }) => id !== user.id),
          },
          tags: {
            type: "[ID!]!",
            args: { ids: { type: "[ID!]" } },
            resolve(_user, args) {
              calls.push(args);
              return args.ids ?? [];
            },
          },
        },
      },
    },
  });
  return { schema, calls };
}

async function run(query, { schema = fixture().schema, ...rest } = {}) {
  const document = parse(query);
  const result = await execute({ schema, document, ...rest });
  return JSON.parse(JSON.stringify(result));
}

const codeOf = (result) => result.errors?.[0]?.extensions.code ?? null;
const aliases = (count, field) =>
  Array.from({ length: count }, (_, index) => `a${index}: ${field}`).join(" ");

test("rejects same-key fields whose merged sub-selections conflict", async () => {
  const conflict = await run("{ me { id } me { id: name } }");
  assert.equal(codeOf(conflict), "GRAPHQL_VALIDATION_FAILED");
  assert.match(conflict.errors[0].message, /"id" and "name" are different/);
  assert.deepEqual(conflict.errors[0].locations, [
    { line: 1, column: 8 },
    { line: 1, column: 18 },
  ]);
  const deep = await run(`{ a: user(id: 1) { friends { tags(ids: [1]) } }
    a: user(id: 1) { friends { tags(ids: [2]) } } }`);
  assert.match(deep.errors[0].message, /differing arguments/);
  const viaFragments = await run(`{ me { ...A ...B } }
    fragment A on User { friends { x: id } }
    fragment B on User { friends { x: name } }`);
  assert.equal(codeOf(viaFragments), "GRAPHQL_VALIDATION_FAILED");
  const merged = await run("{ me { id } me { name friends { id } } }");
  assert.deepEqual(merged.data, {
    me: { id: "1", name: "Alex", friends: [{ id: "2" }] },
  });
});

test("merging fields through self-spreading fragments terminates", async () => {
  const result = await run(`{ me { ...F ...G } }
    fragment F on User { x: friends { ...F } }
    fragment G on User { x: friends { ...G } }`);
  assert.equal(codeOf(result), "GRAPHQL_VALIDATION_FAILED");
  assert.match(result.errors.at(-1).message, /within itself/);
});

test("validates a large literal spread under many parents quickly", async () => {
  // ~84 KB: one 20,000-item literal in a fragment spread 3,000 times.
  // Serializing the literal per spread used to take close to a minute.
  const literal = "0 ".repeat(20_000);
  const query = `{ ${aliases(3000, "me { ...F }")} }
    fragment F on User { id(x: [${literal}]) }`;
  const started = performance.now();
  const result = await run(query);
  const elapsed = performance.now() - started;
  assert.equal(codeOf(result), "GRAPHQL_VALIDATION_FAILED");
  assert.match(result.errors[0].message, /Unknown argument "x"/);
  assert.ok(elapsed < 5000, `validation took ${Math.round(elapsed)} ms`);
});

test("coerces a spread fragment's arguments once, as a frozen value", async () => {
  const { schema, calls } = fixture();
  const query = `{ ${aliases(50, "me { ...F }")} }
    fragment F on User { tags(ids: [1, 2, 3]) }`;
  const result = await run(query, { schema });
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data.a49, { tags: ["1", "2", "3"] });
  assert.equal(calls.length, 50);
  assert.ok(calls.every((args) => args === calls[0]));
  assert.ok(Object.isFrozen(calls[0]) && Object.isFrozen(calls[0].ids));
});
