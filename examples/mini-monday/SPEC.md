# mini-monday specification

This is the shared contract for every module. Code must match the names,
shapes and behaviors below exactly. When something is unspecified, choose the
simplest behavior consistent with this document and note it in a code comment.

## Goals

A small, dependency-free monday.com-style app:

1. A **boards app**: workspaces of boards, colored groups, items, typed columns
   (status, people, date, numbers, text), a table view, a kanban view and an item
   card with updates (comments).
2. An **app platform** modeled on what REA recovered from monday.com's shipped
   SDKs: a GraphQL API at `/v2` with an `API-Version` header, iframe apps that talk
   to the host page over `postMessage`, a host-proxied ("seamless") API, app
   storage segments, signed session tokens and a small CLI.

The platform deliberately fixes the weaknesses found in the REA report:

| REA finding (monday.com package)                                  | mini-monday rule                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `postMessage(…, "*")`, replies accepted from any sender           | Messages target one exact origin; both sides check `event.origin` **and** `event.source`.                      |
| `Math.random()` 7-character request IDs; replies routed by method | `crypto.randomUUID()` request IDs; responses resolve only their pending request; events dispatch only by type. |
| `mapps` sets `rejectUnauthorized: false`                          | The CLI never disables TLS verification; plain `http:` only for loopback hosts; optional `--ca-file`.          |
| MCP `--read-only` silently false when bare; ignored in one mode   | Bare `--read-only` means true; read-only is enforced server-side by token scopes and client-side by the CLI.   |
| Storage keys concatenated into URLs unencoded                     | Storage keys travel as typed GraphQL arguments and are validated; no key ever forms a URL path.                |

## Runtime and constraints

- Node.js >= 22.19, ESM (`"type": "module"`), **no npm dependencies**. Only
  `node:*` built-ins on the server/CLI and standard Web APIs in the browser.
- Browser code is plain ES modules with no build step, no CDNs, no external fonts.
- Lint/format rules (the repository runs `oxlint` and `oxfmt` over everything):
  at most 500 lines per file, 100 lines per function, cyclomatic complexity 20,
  4 parameters per function, nesting depth 4; `const`/`let` only; ESM imports
  only; 80-column formatting. Run
  `/home/user/rea/node_modules/.bin/oxfmt <files>` and
  `/home/user/rea/node_modules/.bin/oxlint <dir>` on your files.
- Never build HTML from data with `innerHTML`/`insertAdjacentHTML`; use
  `textContent` and DOM APIs.
- Tests use `node:test` and `node:assert/strict` in `test/*.test.js` and run with
  `npm test` (`node --test "test/**/*.test.js"`) from this directory.

## Layout

```
examples/mini-monday/
  package.json  SPEC.md  README.md  .gitignore (.data/, e2e-output/)
  server/
    main.js            entry: env → store → startServers → print URLs/tokens
    http.js            startServers(): host + apps HTTP servers, routing, static
    store.js           createStore(): data model, seed, persistence, change events
    column-values.js   parse/format column values
    schema.js          createSchema(): GraphQL type defs + resolvers
    auth.js            tokens, browser sessions, principals, JWT session tokens
    versions.js        API version table and resolution
    events.js          server-sent events hub
    graphql/
      errors.js        GraphQLError
      parse.js         parse()
      schema.js        buildSchema(), printSchema()
      execute.js       execute()
  web/                 host app (served from the host origin)
    index.html  styles.css  main.js  api.js  dom.js  host-bridge.js
    ui/ sidebar.js board-header.js table-view.js kanban-view.js item-card.js
        app-view.js toast.js popover.js
  sdk/
    mini-monday-sdk.js iframe-app SDK (served from the apps origin)
  apps/
    status-summary/    example board-view app: index.html styles.css app.js
  cli/
    mm.js              CLI
  scripts/
    e2e-smoke.mjs      optional Playwright smoke test (skips if unavailable)
  test/
    helpers.js and *.test.js
```

## Configuration and origins

| Env var          | Default                            | Meaning                                  |
| ---------------- | ---------------------------------- | ---------------------------------------- |
| `MM_HOST_PORT`   | `4100`                             | Host (boards app + API) port             |
| `MM_APPS_PORT`   | `4101`                             | Apps (iframe apps + SDK) port            |
| `MM_BIND`        | `127.0.0.1`                        | Listen address for both servers          |
| `MM_DATA_FILE`   | `<example>/.data/mini-monday.json` | JSON persistence; `:memory:` disables it |
| `MM_HOST_ORIGIN` | `http://localhost:<host port>`     | Public host origin                       |
| `MM_APPS_ORIGIN` | `http://127.0.0.1:<apps port>`     | Public apps origin                       |

The host and apps origins differ in host name (`localhost` vs `127.0.0.1`), so
they are cross-site and cookies of one are not sent to the other.

## Module APIs

### `server/graphql/errors.js`

```js
export class GraphQLError extends Error {
  // code: string, default "INTERNAL_SERVER_ERROR"
  // locations: [{ line, column }] (1-based) | undefined
  // path: (string | number)[] | undefined
  constructor(message, { code, locations, path } = {})
  toJSON() // → { message, locations?, path?, extensions: { code } }
}
```

### `server/graphql/parse.js`

`export function parse(source, { maxLength = 100_000, maxDepth = 12 } = {})`
returns a Document AST or throws `GraphQLError` with code
`GRAPHQL_PARSE_FAILED` and `locations`. Longer sources fail with code
`QUERY_TOO_LARGE`; selection-set nesting deeper than `maxDepth` fails with
`MAX_DEPTH_EXCEEDED`.

Supported: `query`/`mutation` operations (named or anonymous, and the `{ … }`
shorthand), variable definitions with defaults, aliases, arguments, nested
selection sets, named fragments, fragment spreads, inline fragments, directives,
`#` comments, commas as whitespace, all value literals (Int, Float, String with
escapes `\" \\ \/ \b \f \n \r \t \uXXXX`, block strings `"""…"""`, Boolean,
null, Enum, List, Object, Variable). `subscription` is a parse error.

AST node shapes (every Field also has `loc: { line, column }`):

```
Document            { kind: "Document", definitions: [OperationDefinition | FragmentDefinition] }
OperationDefinition { kind, operation: "query"|"mutation", name: string|null,
                      variableDefinitions: [{ name, type: TypeRef, defaultValue?: Value }],
                      directives: [Directive], selectionSet, loc }
FragmentDefinition  { kind, name, typeCondition: string, directives, selectionSet, loc }
SelectionSet        { kind: "SelectionSet", selections: [Field | FragmentSpread | InlineFragment] }
Field               { kind: "Field", alias: string|null, name, arguments: [{ name, value }],
                      directives, selectionSet: SelectionSet|null, loc }
FragmentSpread      { kind: "FragmentSpread", name, directives, loc }
InlineFragment      { kind: "InlineFragment", typeCondition: string|null, directives, selectionSet, loc }
Directive           { name, arguments: [{ name, value }] }
TypeRef             { kind: "NamedType", name } | { kind: "ListType", ofType } | { kind: "NonNullType", ofType }
Value               { kind: "Variable", name } | { kind: "IntValue", value: number }
                    | { kind: "FloatValue", value: number } | { kind: "StringValue", value: string }
                    | { kind: "BooleanValue", value: boolean } | { kind: "NullValue" }
                    | { kind: "EnumValue", value: string } | { kind: "ListValue", values: [Value] }
                    | { kind: "ObjectValue", fields: [{ name, value }] }
```

### `server/graphql/schema.js`

`export function buildSchema(definition)` validates and returns a schema object.
`export function printSchema(schema, { apiVersion })` returns SDL text containing
only fields visible in that version (with `"""description"""` blocks when given
and `@deprecated(reason: …)` when `deprecationReason` is set).

```js
buildSchema({
  enums: { ColumnType: ["name", "text", "status", "people", "date", "numbers"], … },
  types: {
    Query: {
      description: "…",
      fields: {
        boards: {
          type: "[Board!]!",                 // type expression string
          description: "…",
          args: { ids: { type: "[ID!]" }, limit: { type: "Int", defaultValue: 25 } },
          versions: { addedIn: "2026-04", removedIn: "2026-01" }, // both optional
          deprecationReason: "…",            // optional
          resolve(parent, args, ctx, info) { … }, // optional; default parent[name]
        },
      },
    },
  },
  query: "Query",
  mutation: "Mutation",
})
```

Built-in scalars: `ID`, `String`, `Int`, `Float`, `Boolean`. Every named type in a
type expression must be a scalar, an enum or a declared object type (else
`buildSchema` throws). Versions are `"YYYY-MM"` strings compared
lexicographically; a field is visible for `apiVersion` when
`(!addedIn || apiVersion >= addedIn) && (!removedIn || apiVersion < removedIn)`.

### `server/graphql/execute.js`

```js
export async function execute({
  schema, document, variables = {}, operationName = null,
  context = {}, apiVersion, maxDepth = 12, maxFields = 5000,
})
// → { data?: object|null, errors?: GraphQLError[] }
```

1. Select the operation (`operationName` required when several exist; unknown
   name → `GRAPHQL_VALIDATION_FAILED`).
2. Validate the whole operation before running anything: unknown fields (for this
   `apiVersion`), unknown/missing required arguments, leaf fields with selection
   sets, object fields without them, unknown fragments, fragment cycles, type
   conditions naming unknown types, unknown directives (only `@include`/`@skip`),
   depth after fragment expansion > `maxDepth` (`MAX_DEPTH_EXCEEDED`). Any
   failure → `{ errors }` (no `data` key), code `GRAPHQL_VALIDATION_FAILED`
   unless stated, with `locations`.
3. Coerce variables against their definitions (missing required, wrong type →
   `BAD_USER_INPUT`, no `data`). Coerce arguments: `ID` accepts string or
   integer and becomes a string; `Int` is a 32-bit integer; `Float`; `String`;
   `Boolean`; enums accept an EnumValue literal or a string variable from the
   allowed list; a single value is wrapped when a list is expected; `null` for a
   non-null type is an error; defaults apply when the argument is absent.
   Invalid arguments → `BAD_USER_INPUT` with the field's location and path.
4. Execute. Mutation top-level fields run serially in order; query fields may be
   resolved sequentially. `__typename` works on every object. `@include(if:)` and
   `@skip(if:)` apply to fields, spreads and inline fragments. Inline/named
   fragments apply when the type condition is absent or equals the object type.
   Resolvers may return values or promises and receive
   `(parent, args, context, { fieldName, path, apiVersion })`.
5. Errors thrown by resolvers: a `GraphQLError` keeps its message/code; any other
   error becomes `"Internal server error"` with code `INTERNAL_SERVER_ERROR`
   (log the original with `context.log?.error`). Every error gets `path` and
   `locations`. A null in a non-null position propagates to the nearest nullable
   parent (or makes `data` null). Leaf results are serialized by type (ID →
   string, Int/Float → number, Boolean, String, enum string).
6. Counting resolved fields beyond `maxFields` stops execution with one error
   `COMPLEXITY_BUDGET_EXHAUSTED`.

### `server/versions.js`

```js
export const API_VERSIONS = [
  { value: "2025-10", kind: "maintenance" },
  { value: "2026-01", kind: "current" },
  { value: "2026-04", kind: "release_candidate" },
];
export const CURRENT_API_VERSION = "2026-01";
export function resolveApiVersion(headerValue)
// → { ok: true, value, kind } | { ok: false, error: GraphQLError } (code UNSUPPORTED_API_VERSION)
```

Missing or empty header → current version. Values are trimmed and must match
exactly.

### `server/auth.js`

```js
export const ALL_SCOPES = ["boards:read", "boards:write", "storage:read", "storage:write"];
export function signJwt(payload, secret)               // HS256, base64url, header {alg:"HS256",typ:"JWT"}
export function verifyJwt(token, secret, { now = Date.now(), audience } = {})
// → { ok: true, payload } | { ok: false, reason: "malformed"|"algorithm"|"signature"|"expired"|"audience" }
export function createAuth({ store, now = () => Date.now() })
// → {
//   authenticateApiToken(authorizationHeader) → Principal | null  // raw token or "Bearer <token>"
//   createBrowserSession(userId) → sessionId                      // random 32 bytes base64url
//   getBrowserSession(sessionId) → Principal | null
//   appPrincipal(userPrincipal, installId) → Principal | null      // null when install unknown
//   issueSessionToken({ userId, installId, ttlSeconds = 300 }) → { token, expires_at }
// }
```

`Principal = { kind: "token" | "session" | "app", userId: string, scopes: Set<string>, installId?: string, appId?: string }`.
Token principals take the token's scopes; browser sessions get `ALL_SCOPES`; app
principals get the intersection of the user's scopes and the app's scopes.
Signature checks use `crypto.timingSafeEqual`; `verifyJwt` accepts only `HS256`.

Session-token payload:
`{ iss: "mini-monday", aud: <app client_id>, sub: <user id>, iat, exp, dat: { client_id, user_id, account_id: "1", app_id, install_id, board_id, is_admin } }`
signed with the app's `client_secret`.

### `server/store.js`

`export async function createStore({ file = null, now = () => new Date(), seed = true } = {})`
loads `file` when it exists, otherwise seeds; `file: null` keeps everything in
memory. Writes are debounced (≤ 100 ms) and atomic (write a temp file in the same
directory, then rename); parent directories are created. `store.flush()` awaits
pending writes. IDs: users, boards, items, updates, apps, installs and views are
numeric strings from one counter; group IDs are slug strings unique per board
(`"topics"`, `"group_2"`…); column IDs are `"name"` plus `<type>` or
`<type>_<n>` unique per board.

Methods (synchronous unless noted; each mutator emits one change event and
returns the new/updated record; unknown IDs return `null` and emit nothing):

```
on(listener) → unsubscribe        listener({ type, board_id, item_id?, group_id?, column_id? })
listUsers() getUser(id)           findApiToken(token) → { token, user_id, scopes, label } | null
listBoards({ ids, limit, page })  getBoard(id)
createBoard({ name, description, creatorId })   // default columns name/status/person/date,
                                                // group "topics" ("Topics", "#579bfc"),
                                                // views table + kanban
updateBoard(id, { name?, description? })  deleteBoard(id)
listGroups(boardId)  getGroup(boardId, groupId)
createGroup(boardId, { title, color })  updateGroup(boardId, groupId, { title?, color? })
deleteGroup(boardId, groupId)                   // also deletes its items
listColumns(boardId)  getColumn(boardId, columnId)  createColumn(boardId, { title, type })
listItems({ boardId, groupId = null, offset = 0, limit = 25 }) → { items, total }
countItems(boardId)  getItem(id)
createItem({ boardId, groupId, name, values = {}, creatorId })  // groupId defaults to first group
renameItem(id, name)  setColumnValue(id, columnId, storedValue)  // storedValue null clears
moveItem(id, groupId)  deleteItem(id)
listUpdates(itemId, { limit })  createUpdate({ itemId, body, creatorId })
listApps()  getApp(id)  listInstalls({ boardId })  getInstall(id)  listViews(boardId)
getAppStorage(scopeKey, key) → { value, version } | null
setAppStorage(scopeKey, key, value, previousVersion) → { success, version, reason? }
deleteAppStorage(scopeKey, key) → { success, version: null }
flush() → Promise<void>
```

Item records: `{ id, board_id, group_id, name, position, state: "active", creator_id, created_at, updated_at, values: { [columnId]: storedValue } }` with ISO timestamps.
Items are ordered by group position, then item position. App storage scope keys
are `"install:<installId>"` (instance segment) and `"app:<appId>"` (global
segment). `setAppStorage` with a `previousVersion` that differs from the current
version returns `{ success: false, version: <current>, reason: "version_conflict" }`.

Seed (deterministic content, random secrets):

- Users: `1` Alex Rivera (`alex@example.test`, admin), `2` Sam Lee, `3` Noa Cohen.
- Board `Product roadmap`: groups `this_sprint` "This sprint" `#579bfc`,
  `next_up` "Next up" `#a25ddc`, `done` "Done" `#00c875`; columns `name`,
  `status` (Status), `person` (Owner, people), `date` (Due date), `estimate`
  (Estimate, numbers), `notes` (Notes, text); eight items with varied values.
- Board `Marketing launch`: one group, three items.
- App `Status summary`: random `client_id` and `client_secret`, path
  `/apps/status-summary/index.html`, scopes `["boards:read", "storage:read", "storage:write"]`.
- Install of that app on `Product roadmap` with a board view named "Status summary".
- API tokens: one with `ALL_SCOPES` (label "read-write"), one with
  `["boards:read", "storage:read"]` (label "read-only"); 32 random bytes,
  base64url.

### `server/column-values.js`

Stored values: status `{ index: number }`, text `string`, numbers finite
`number`, date `"YYYY-MM-DD"`, people `string[]` of user IDs.

Status settings (per column): `{ labels: { "0": "Working on it", "1": "Done", "2": "Stuck", "5": "" }, labels_colors: { "0": "#fdab3d", "1": "#00c875", "2": "#df2f4a", "5": "#c4c4c4" } }`; index `5` is the blank default.

```js
export const DEFAULT_STATUS_SETTINGS
export function parseColumnValue(column, json)       // change_column_value input (JSON text)
export function parseSimpleColumnValue(column, text) // change_simple_column_value input
// both → { ok: true, value: storedValue | null } | { ok: false, message }
export function formatColumnValue(column, stored, { getUser })
// → { text: string | null, value: string | null }  (value is JSON text)
```

| Type    | `change_column_value` JSON                       | simple text  | output `value`                                   | output `text`      |
| ------- | ------------------------------------------------ | ------------ | ------------------------------------------------ | ------------------ |
| status  | `{"index":1}` or `{"label":"Done"}`              | `Done`       | `{"index":1}`                                    | label              |
| text    | `"abc"`                                          | `abc`        | `"abc"`                                          | the string         |
| numbers | `"42"` or `42`                                   | `42`         | `"42"`                                           | `42`               |
| date    | `{"date":"2026-10-18"}`                          | `2026-10-18` | `{"date":"2026-10-18"}`                          | `2026-10-18`       |
| people  | `{"personsAndTeams":[{"id":1,"kind":"person"}]}` | `1,2`        | `{"personsAndTeams":[{"id":1,"kind":"person"}]}` | comma-joined names |

`null`, `""` or `{}` clears. Unknown labels, invalid dates (must be a real
calendar date), non-finite numbers, unknown user IDs and text over 2,000
characters are errors. The `name` column is changed only through
`change_simple_column_value` / `change_multiple_column_values` with a non-empty
string (≤ 255 characters).

### `server/schema.js`

`export function createSchema()` returns `buildSchema(…)` with this API
(snake_case names, as in monday.com's API):

```graphql
type Query {
  me: User!
  users(ids: [ID!], limit: Int = 50): [User!]!
  boards(ids: [ID!], limit: Int = 25, page: Int = 1): [Board!]!
  items(ids: [ID!]!): [Item!]!
  version: Version!
  versions: [Version!]!
  app_storage(
    install_id: ID!
    segment: StorageSegment!
    key: String!
  ): StorageValue
}
type Version {
  value: String!
  kind: String!
}
type User {
  id: ID!
  name: String!
  email: String!
  is_admin: Boolean!
  initials: String!
}
type Board {
  id: ID!
  name: String!
  description: String
  state: State!
  url: String!
  creator: User
  columns(ids: [String!]): [Column!]!
  groups(ids: [String!]): [Group!]!
  items_page(limit: Int = 25, cursor: String): ItemsPage!
  items(limit: Int = 25): [Item!]! # versions.removedIn "2026-01", deprecated
  items_count: Int!
  views: [BoardView!]!
}
type Group {
  id: String!
  title: String!
  color: String!
  position: Int!
  items_page(limit: Int = 25, cursor: String): ItemsPage!
}
type ItemsPage {
  cursor: String
  items: [Item!]!
}
type Column {
  id: String!
  title: String!
  type: ColumnType!
  settings_str: String!
}
type Item {
  id: ID!
  name: String!
  state: State!
  created_at: String!
  updated_at: String!
  board: Board!
  group: Group!
  creator: User
  column_values(ids: [String!]): [ColumnValue!]!
  updates(limit: Int = 25): [Update!]!
  url: String! # versions.addedIn "2026-04"
}
type ColumnValue {
  id: String!
  type: ColumnType!
  text: String
  value: String
}
type Update {
  id: ID!
  body: String!
  created_at: String!
  creator: User
}
type BoardView {
  id: ID!
  name: String!
  type: String!
  app_install_id: ID
  app_url: String
}
type StorageValue {
  key: String!
  value: String!
  version: Int!
}
type StorageWriteResult {
  success: Boolean!
  version: Int
  reason: String
}
enum ColumnType {
  name
  text
  status
  people
  date
  numbers
}
enum State {
  active
  archived
  deleted
}
enum StorageSegment {
  global
  instance
}
enum BoardAttribute {
  name
  description
}
enum GroupAttribute {
  title
  color
}
type Mutation {
  create_board(board_name: String!, description: String): Board!
  update_board(
    board_id: ID!
    board_attribute: BoardAttribute!
    new_value: String!
  ): Board!
  delete_board(board_id: ID!): Board!
  create_group(board_id: ID!, group_name: String!, group_color: String): Group!
  update_group(
    board_id: ID!
    group_id: String!
    group_attribute: GroupAttribute!
    new_value: String!
  ): Group!
  delete_group(board_id: ID!, group_id: String!): Group!
  create_column(
    board_id: ID!
    title: String!
    column_type: ColumnType!
  ): Column!
  create_item(
    board_id: ID!
    group_id: String
    item_name: String!
    column_values: String
  ): Item!
  change_column_value(
    board_id: ID!
    item_id: ID!
    column_id: String!
    value: String!
  ): Item!
  change_simple_column_value(
    board_id: ID!
    item_id: ID!
    column_id: String!
    value: String
  ): Item!
  change_multiple_column_values(
    board_id: ID!
    item_id: ID!
    column_values: String!
  ): Item!
  move_item_to_group(item_id: ID!, group_id: String!): Item!
  delete_item(item_id: ID!): Item!
  create_update(item_id: ID!, body: String!): Update!
  set_app_storage(
    install_id: ID!
    segment: StorageSegment!
    key: String!
    value: String!
    previous_version: Int
  ): StorageWriteResult!
  delete_app_storage(
    install_id: ID!
    segment: StorageSegment!
    key: String!
  ): StorageWriteResult!
}
```

Resolver context (built by `http.js`):
`{ store, principal, apiVersion, hostOrigin, appsOrigin, log, requireScope(scope) }`.
`requireScope` throws `GraphQLError("Missing scope <scope>", { code: "FORBIDDEN" })`.

- Every Query field except `version`/`versions` requires `boards:read`; every
  board/group/column/item/update mutation requires `boards:write`.
- `app_storage` requires `storage:read`; `set_app_storage`/`delete_app_storage`
  require `storage:write`. All three require `principal.kind === "app"` and
  `install_id === principal.installId` (else `FORBIDDEN`). Segment `instance`
  uses scope key `install:<id>`, `global` uses `app:<appId>`. Keys: 1–256
  characters, no control characters (U+0000–U+001F, U+007F); values ≤ 65,536
  characters; else `BAD_USER_INPUT`.
- Missing records → `GraphQLError(..., { code: "NOT_FOUND" })`; invalid input →
  `BAD_USER_INPUT`. Names are trimmed, 1–255 characters; update bodies 1–10,000.
  Group colors must match `^#[0-9a-fA-F]{6}$` (default `#579bfc`).
  `create_column` rejects type `name`.
- `items_page.limit` 1–500. `cursor` is base64url JSON `{ "b": boardId, "g": groupId|null, "o": offset }`;
  a cursor for another board/group or malformed → `BAD_USER_INPUT`. `cursor` is
  `null` on the last page.
- `Board.url` = `<hostOrigin>/#/boards/<id>`; `Item.url` =
  `<hostOrigin>/#/boards/<board>/items/<id>`; `BoardView.app_url` =
  `<appsOrigin><app path>?install_id=<install id>` for app views, else null.
- `create_item.column_values` and `change_multiple_column_values.column_values`
  are JSON objects keyed by column ID whose values use the
  `change_column_value` formats (a string value is also accepted as the simple
  format); `name` may be included in the latter.

### `server/events.js`

`export function createEventHub({ store, heartbeatMs = 25_000 })` →
`{ handle(req, res, { boardId }), close() }`. `handle` writes SSE headers
(`Content-Type: text/event-stream`, `Cache-Control: no-store`), an initial
`: connected` comment, a heartbeat comment every `heartbeatMs`, and for each
store change on that board:
`event: change\ndata: <JSON of the change event>\n\n`. It cleans up on close.

### `server/http.js`

```js
export async function startServers({
  store, hostPort = 4100, appsPort = 4101, bind = "127.0.0.1",
  hostOrigin, appsOrigin, log = console,
}) // → { hostOrigin, appsOrigin, hostServer, appsServer, auth, close() }
```

Port `0` picks a free port; when an origin is not given it is derived from the
actual port (`http://localhost:<port>` for the host, `http://127.0.0.1:<port>`
for apps). `close()` closes both servers, the event hub and open connections.

Common response headers: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` (host
only). JSON responses use `application/json; charset=utf-8`. Bodies over 1 MiB → 413. Unknown paths → 404, wrong methods → 405 with `Allow`.

**Host server**

| Route                      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                    | `web/index.html`. If the `mm_session` cookie is missing or unknown, creates a browser session for user `1` (demo auto-login) and sets `mm_session=<id>; HttpOnly; SameSite=Strict; Path=/`. CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src <appsOrigin>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`.                                                                                                                                                                                                                                                 |
| `GET /<file>`              | Static files under `web/` (`.html .js .css .svg .json .ico`). Decode the path once, reject `..` segments, NUL, backslashes and dotfiles, and confirm the resolved path stays inside `web/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /v2`                 | GraphQL. Requires `Content-Type: application/json` (else 415). Body `{ query, variables?, operationName? }`. Auth: an `Authorization` header → API token principal (invalid → 401); otherwise the session cookie, accepted only when `Origin` equals the host origin (else 403). With a session cookie and `X-App-Install: <installId>`, the principal becomes the app principal for that install (unknown → 403). No credentials → 401. `API-Version` request header resolved via `versions.js` (unsupported → 400); the response always carries `API-Version: <resolved>`. Parse/validation failures → 400 `{ errors }`; otherwise 200 `{ data, errors? }`. |
| `GET /v2/get_schema`       | Public. `?version=<v>` (default current) `&format=sdl` → `text/plain` SDL from `printSchema`. Unsupported version → 400.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v2/events`           | SSE for `?board_id=<id>`. Auth: API token, or session cookie when `Sec-Fetch-Site` is `same-origin` or `Origin` equals the host origin. Unknown board → 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /apps/session-token` | Session cookie + `Origin` check. Body `{ install_id }` → `{ token, expires_at }` (ISO) for the current user. Unknown install → 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Error bodies for non-GraphQL failures: `{ "errors": [{ "message", "extensions": { "code" } }] }`
with codes `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`METHOD_NOT_ALLOWED` (405), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE`
(415), `BAD_REQUEST` (400), `UNSUPPORTED_API_VERSION` (400).

**Apps server** (no cookies, no API)

| Route                                  | Behavior                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sdk/mini-monday-sdk.js`          | `sdk/mini-monday-sdk.js`                                                                                                                                                                                                                            |
| `GET /apps/config.js`                  | `export const HOST_ORIGIN = "<hostOrigin>";` (`text/javascript`, `Cache-Control: no-store`)                                                                                                                                                         |
| `GET /apps/<app>/<file>`               | Static files under `apps/<app>/` (same path rules). HTML responses carry CSP `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors <hostOrigin>; base-uri 'none'; object-src 'none'`. |
| `POST /apps/status-summary/api/verify` | The example app's backend. Body `{ sessionToken }`; verifies it with the Status summary app's `client_secret` and `audience = client_id` → 200 `{ ok: true, claims: { user_id, board_id, install_id, exp } }` or 401 `{ ok: false, reason }`.       |

### `server/main.js`

Reads the env vars, `createStore({ file })`, `startServers(...)`, then prints:

```
mini-monday is running
  Boards app   http://localhost:4100
  Apps origin  http://127.0.0.1:4101
  GraphQL API  http://localhost:4100/v2
  Token (read-write)  <token>
  Token (read-only)   <token>
```

On `SIGINT`/`SIGTERM` it closes the servers, flushes the store and exits 0.

## Bridge protocol `mini-monday/1`

All messages are plain objects with `protocol: "mini-monday/1"`.

App → host request:
`{ protocol, kind: "request", requestId: <crypto.randomUUID()>, method, args }`

| `method`   | `args`                                                                                                                                                                                                                                                | Response `data`                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get`      | `{ type: "context" \| "settings" \| "sessionToken" \| "location" \| "filter" \| "itemIds" }`                                                                                                                                                          | the value (`sessionToken` → `{ token, expires_at }`)                                                               |
| `set`      | `{ type: "settings", value: object }`                                                                                                                                                                                                                 | new settings                                                                                                       |
| `listen`   | `{ type: "context" \| "settings" \| "events" \| "filter" }`                                                                                                                                                                                           | `{ subscribed: true }`                                                                                             |
| `unlisten` | `{ type }`                                                                                                                                                                                                                                            | `{ subscribed: false }`                                                                                            |
| `execute`  | `{ type, params }`: `notice` `{ message, type?: "success"\|"error"\|"info", timeout? }`; `openItemCard` `{ itemId }`; `confirm` `{ message, confirmButton?, cancelButton? }`; `openLinkInTab` `{ url }` (http/https only); `valueCreatedForUser` `{}` | `{ ok: true }`, or `{ confirm: boolean }` for `confirm`                                                            |
| `storage`  | `{ segment: "global" \| "instance", op: "get" \| "set" \| "delete", key, value?, previousVersion? }`                                                                                                                                                  | `get` → `{ value, version }` or `{ value: null, version: null }`; `set`/`delete` → `{ success, version, reason? }` |
| `api`      | `{ query, variables?, operationName? }`                                                                                                                                                                                                               | the GraphQL response `{ data, errors? }`                                                                           |

Host → app:

- Response: `{ protocol, kind: "response", requestId, ok: true, data }` or
  `{ protocol, kind: "response", requestId, ok: false, error: { message, code } }`.
- Event: `{ protocol, kind: "event", type, data }` — only for types the app is
  listening to. `events` data is the store change event.

Context object: `{ boardId, instanceId: <installId>, instanceType: "board_view", viewId, user: { id, name, isAdmin }, account: { id: "1" }, app: { id, clientId }, theme: "light" | "dark", location: <host URL> }`.

### `sdk/mini-monday-sdk.js` (browser ESM)

```js
export const PROTOCOL = "mini-monday/1";
export function createClient({ hostOrigin, timeoutMs = 30_000, window: win = globalThis.window } = {})
// client.get(type) → Promise<data>
// client.set(type, value) → Promise<data>
// client.listen(type, callback) → unsubscribe()   (sends listen; callback(data) per event;
//                                                   last unsubscribe of a type sends unlisten)
// client.execute(type, params = {}) → Promise<data>
// client.api(query, { variables, operationName } = {}) → Promise<{ data, errors? }>
//        rejects with an Error carrying .errors when the response has errors and no data
// client.storage.getItem(key) / setItem(key, value, { previousVersion } = {}) / deleteItem(key)  (global)
// client.storage.instance.getItem / setItem / deleteItem                                         (instance)
// client.destroy()  removes the listener and rejects pending requests
```

`hostOrigin` is required and must equal `new URL(hostOrigin).origin` with an
`http:`/`https:` scheme (else throw `TypeError`). Requests go to
`win.parent.postMessage(message, hostOrigin)`. Incoming messages are ignored
unless `event.source === win.parent`, `event.origin === hostOrigin`, and the data
is an object with the protocol. Responses resolve/reject only their pending
`requestId`; a request rejects with an `Error` (`code: "TIMEOUT"`) after
`timeoutMs`; an `ok: false` response rejects with `Error(error.message)` and
`.code`. Events go only to `listen` callbacks of that type; a throwing callback
is caught and logged.

### `web/host-bridge.js` (browser ESM)

```js
export function createHostBridge({ iframe, appOrigin, handlers, window: win = globalThis.window })
// → { emit(type, data), destroy() }
```

Accepts a message only when `event.source === iframe.contentWindow`,
`event.origin === appOrigin`, the data has the protocol, `kind === "request"`, a
string `requestId` of 1–100 characters and a known `method`. Replies with
`iframe.contentWindow.postMessage(reply, appOrigin)`. Unknown `get`/`listen`
types, invalid params and handler failures produce `ok: false` responses with
codes `BAD_REQUEST`, `NOT_SUPPORTED` or `INTERNAL`. `emit(type, data)` posts
an event only when the app listens to `type`. `storage` requests are validated
(segment, op, key 1–256 characters without control characters, string value
≤ 65,536 characters) and executed through `handlers.graphql` with the
`app_storage` / `set_app_storage` / `delete_app_storage` operations (passing
`install_id` from `handlers.getContext().instanceId`). `openLinkInTab` accepts
only `http:`/`https:` URLs.

`handlers`:

```
getContext() → object            getSettings() → object      setSettings(value) → Promise<object>
getSessionToken() → Promise<{ token, expires_at }>             getLocation() → object
getFilter() → object             getItemIds() → Promise<string[]>
notice({ message, type, timeout })   openItemCard({ itemId })   confirm(params) → Promise<boolean>
openLinkInTab({ url })           graphql({ query, variables, operationName }) → Promise<response>
```

## Web app (`web/`)

- `api.js`: `graphql(query, variables = {}, { installId, apiVersion } = {})` →
  POST `/v2` (`credentials: "same-origin"`, JSON, `API-Version`, optional
  `X-App-Install`) returning the parsed body; throws an `Error` with `.errors`
  when the HTTP status is not 2xx. `requestSessionToken(installId)` → POST
  `/apps/session-token`. `subscribeBoardEvents(boardId, onEvent)` → `close()`
  using `EventSource`.
- `dom.js`: `h(tag, props, ...children)` safe element builder (`class`,
  `dataset`, `on: { event: fn }`, attributes, text children), plus `clear(el)`.
- Routing with `location.hash`: `#/boards/<id>` (table view),
  `#/boards/<id>/views/kanban`, `#/boards/<id>/views/app-<installId>`,
  `#/boards/<id>/items/<itemId>` (opens the item card over the current view).
- Layout: left sidebar (workspace name, board list, "New board"), board header
  (inline-editable name and description, view tabs "Main table", "Kanban" and one
  tab per installed app view), toolbar ("New item", search filter by item name).
- Table view: one block per group with a colored left border, collapsible header
  (inline rename, color, delete via a menu), column headers (with a "+" to add a
  column: title + type), item rows: name (inline edit, open-card button), status
  (colored pill; click opens a label picker), people (initial avatars; picker),
  date (`<input type="date">`), numbers, text; per-row delete; an "+ Add item" row
  per group; "+ Add group" below the groups.
- Kanban view: one lane per status label with item cards; drag a card to another
  lane to change its status (HTML5 drag and drop); click opens the item card.
- Item card: side panel with the item name, its column values, group, and
  updates (newest first) with a composer.
- App view: an iframe (`sandbox="allow-scripts allow-same-origin allow-forms"`,
  `referrerpolicy="no-referrer"`) at the view's `app_url`, wired with
  `createHostBridge`. Handlers implement: context from the current board/user,
  settings stored in memory per install, `sessionToken` via
  `requestSessionToken`, `notice` → toast, `openItemCard` → navigate,
  `confirm` → an in-app dialog, `openLinkInTab` → `window.open(url, "_blank",
  "noopener,noreferrer")`, `graphql` → `graphql(..., { installId })`, `events`
  forwarded from the board's SSE stream.
- The UI refreshes the current board when an SSE change arrives (debounced).
- Styling: monday-like (primary `#0073ea`, page `#f6f7fb`, text `#323338`,
  borders `#d0d4e4`), system fonts, light and dark themes via
  `prefers-color-scheme`, responsive down to 360 px (the sidebar collapses).

## Example app `apps/status-summary/`

A board view that imports `/apps/config.js` and `/sdk/mini-monday-sdk.js`,
creates a client with `HOST_ORIGIN`, and shows:

- the board name and item total; one bar per status label (label color, count),
  computed from `client.api` (board columns' `settings_str` and the status column
  values of all items, paging `items_page`);
- live refresh via `client.listen("events", …)` (debounced);
- a note saved with `client.storage.instance.setItem("note", …, { previousVersion })`,
  showing the saved version and a conflict message on `version_conflict`;
- "Send notice" → `client.execute("notice", …)`; clicking a bar →
  `client.execute("openItemCard", { itemId })` for the first item with that status;
- "Verify session token" → `client.get("sessionToken")`, then POST to
  `/apps/status-summary/api/verify` and display the verified claims;
- theme from `context.theme`.

## CLI `cli/mm.js`

`mm <command> [args] [options]`

| Command                                       | Action                                                    |
| --------------------------------------------- | --------------------------------------------------------- |
| `me`                                          | current user                                              |
| `boards`                                      | list boards (id, name, items_count)                       |
| `items <boardId>`                             | list items with status and owner text (pages through all) |
| `create-item <boardId> <name> [--group <id>]` | create an item                                            |
| `set-status <boardId> <itemId> <label>`       | `change_simple_column_value` on column `status`           |
| `query <graphql> [--variables <json>]`        | raw GraphQL                                               |
| `schema [--api-version <v>]`                  | print SDL from `/v2/get_schema`                           |

Options: `--endpoint <url>` (default `MM_ENDPOINT` or `http://localhost:4100/v2`),
`--token <t>` (default `MM_TOKEN`; warn on stderr that command-line tokens are
visible to other local processes), `--api-version <v>`, `--read-only` (bare means
true; `--read-only=true|false` also accepted; any other value is an error),
`--ca-file <path>` (extra trusted CA, PEM), `--json` (raw JSON output),
`--timeout <ms>` (default 15,000), `--help`.

Rules: unknown options are errors (exit 2). `https:` endpoints always verify
certificates; the code must never set `rejectUnauthorized: false` or
`NODE_TLS_REJECT_UNAUTHORIZED`. `http:` is allowed only for loopback hosts
(`localhost`, `127.0.0.0/8`, `::1`); otherwise exit 2 with an explanation. In
read-only mode any operation whose type is `mutation` is refused before sending
(exit 3). Responses over 10 MiB are aborted. Exit codes: 0 success, 1 API/HTTP
error, 2 usage error, 3 refused by read-only mode.

Exports for tests: `parseArgs(argv)` → `{ command, positionals, options }` (throws
`UsageError`), `assertSafeEndpoint(url)` (throws `UsageError`),
`operationType(query)` → `"query" | "mutation" | null`, `UsageError`, and
`main(argv, { env, stdout, stderr })` → exit code. The file runs `main` only when
executed directly.
