/**
 * The real API for the Updates pane's data tests: `fetch` served by the
 * real schema over a seeded store, signed in as a seeded user. It logs
 * each request (`requests`: `{ operation, variables }`) and can answer
 * one with the field-budget error instead (`overBudget(request)`), as
 * the server does for a request it cannot fit.
 */
import { ALL_SCOPES } from "../server/auth.js";
import { execute } from "../server/graphql/execute.js";
import { parse } from "../server/graphql/parse.js";
import { createSchema } from "../server/schema.js";
import { createStore } from "../server/store.js";

export function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

const BUDGET = {
  data: null,
  errors: [
    {
      message: "Query exceeded the budget of 5000 resolved fields.",
      extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED" },
    },
  ],
};

/**
 * Serves the UI's requests from the real schema over a seeded store;
 * `as(name)` switches the signed-in user (a first name).
 */
export async function realServer(t) {
  const store = await createStore({ file: null });
  const schema = createSchema();
  const users = new Map(
    store
      .listUsers()
      .map((user) => [user.name.split(" ")[0].toLowerCase(), user.id]),
  );
  let userId = users.get("alex");
  const server = { requests: [], overBudget: () => false };
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1];
    const logged = { operation, variables: body.variables ?? {} };
    server.requests.push(logged);
    if (server.overBudget(logged)) return jsonResponse(200, BUDGET);
    const result = await execute({
      schema,
      document: parse(body.query),
      variables: body.variables ?? {},
      apiVersion: "2026-01",
      context: {
        store,
        principal: { kind: "session", userId, scopes: new Set(ALL_SCOPES) },
        hostOrigin: "http://localhost:4100",
        apiVersion: "2026-01",
        log: { error() {} },
        requireScope() {},
      },
    });
    return jsonResponse("data" in result ? 200 : 400, result);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const boards = store.listBoards({ limit: 500 });
  const board = (name) => boards.find((entry) => entry.name === name);
  const item = (boardName, name) =>
    store
      .listItems({ boardId: board(boardName).id, limit: 500 })
      .items.find((entry) => entry.name === name);
  return Object.assign(server, {
    store,
    users,
    board,
    item,
    as(name) {
      userId = users.get(name);
    },
  });
}
