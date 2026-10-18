# Worklane specification, part 4: import from monday.com and ClickUp

Parts 1–3 describe the product and its private hosting. Part 4 adds an importer
that brings an existing monday.com or ClickUp setup into Worklane: workspaces,
boards/lists, groups, columns/fields, items/tasks, subitems/subtasks, people,
updates/comments and (where the source exposes them) docs. It works from the
source's API with a token, or offline from export files.

## 1. Principles

- **Admins only.** New capability `import_data` (admins). Every import route
  and GraphQL field checks it through `server/access.js`.
- **Tokens are used once.** A source token is accepted only by the scan
  request, kept in memory for that request, never stored, logged, echoed,
  persisted, or put in errors. Redact it from any upstream error text.
- **Fixed upstream hosts.** The server talks only to
  `https://api.monday.com/v2` and `https://api.clickup.com/api/v2` (and
  ClickUp's `https://api.clickup.com/api/v3` for docs). Tests may override the
  base URLs with `MM_IMPORT_MONDAY_URL` / `MM_IMPORT_CLICKUP_URL`; users can
  never supply a URL. No redirects are followed.
- **Bounded work.** Upstream responses are capped (10 MiB each), requests time
  out (30 s), retries honor `Retry-After` / monday complexity errors with capped
  exponential backoff (max 5 attempts), ClickUp is throttled to ≤ 90 requests per
  minute, and a scan stops at configurable limits (default 200 boards/lists,
  50,000 items, 5,000 updates) with a warning rather than failing.
- **Lossless where possible, reported where not.** Anything that cannot be
  represented exactly becomes text and is listed in the report with its source
  path. Nothing is silently dropped.
- **No notification storm.** Import writes do not create notifications or
  per-change SSE fan-out; one `import_finished` notification goes to the
  importing admin. Activity entries are written with actor = importing admin
  and `actor_label: "Import from monday.com"` / `"Import from ClickUp"`.

## 2. Normalized snapshot (`server/import/snapshot.js` owns validation)

Every connector produces this shape; the engine consumes only this shape.
`validateSnapshot(snapshot)` checks it and returns `{ ok, snapshot, errors }`.

```
Snapshot {
  source: "monday" | "clickup" | "csv" | "xlsx",
  source_label: string,                 // e.g. "monday.com account Acme"
  users: [{ source_id, name, email | null }],
  workspaces: [{
    source_id, name, description | null, kind: "open" | "closed",
    boards: [Board], docs: [Doc]
  }],
  warnings: [Warning]
}
Board {
  source_id, name, description | null, kind: "public" | "private" | "share",
  source_url | null,
  members: [{ user_source_id, role: "owner" | "editor" | "viewer" }],
  columns: [{ source_id, title, type: "status" | "text" | "people" | "date" | "numbers",
              original_type, labels?: [{ label, color }] }],   // labels only for status
  groups: [{ source_id, title, color }],
  items: [{ source_id, name, group_source_id, parent_source_id | null,
            values: { [column_source_id]: Value },
            created_at | null, creator_source_id | null,
            updates: [{ body, author_source_id | null, author_name | null, created_at | null }] }]
}
Value: status → label string; text → string; numbers → finite number;
       date → "YYYY-MM-DD"; people → [user_source_id]
Doc { source_id, title, blocks: [{ type, text, checked? }] }   // SPEC-2 block types
Warning { code, message, path }        // path like "workspaces[0].boards[2].columns[5]"
```

Colors are `#rrggbb`; unknown source colors map to the nearest Worklane group or
status color. Long names are truncated to Worklane limits with a warning.

## 3. Connectors (`server/import/connectors/*.js`)

Each exports `scan({ token | file, options, signal, onProgress }) → Snapshot`.
`onProgress({ phase, done, total, message })` drives the UI.

### 3.1 monday.com (`monday.js`)

GraphQL POST to `/v2` with headers `Authorization: <token>`,
`API-Version: 2025-10`, `Content-Type: application/json`. Use the shapes from
monday's official client types (`@mondaydotcomorg/api`; a copy of its
`index.d.ts` from the REA investigation is at
`/tmp/claude-0/-home-user-rea/57a43c1a-3f57-52a5-b573-5dcf113136f3/scratchpad/targets/mondaydotcomorg-api-14.3.1/package/dist/esm/index.d.ts`).

- `me { account { name } }`, `users(limit, page) { id name email }`,
  `workspaces(limit, page) { id name kind description }`.
- `boards(limit: 25, page, state: active) { id name description board_kind
  workspace { id } url owners { id } subscribers { id }
  columns { id title type settings_str } groups { id title color }
  items_page(limit: 200) { cursor items { … } } }`, then
  `next_items_page(cursor, limit)` until done. Items:
  `id name created_at creator { id } group { id }
  column_values { id type text value } subitems { id name column_values { id type text value } }
  updates(limit: 100) { body text_body created_at creator { id name } }`.
  Skip board types `sub_items_board` (subitems come with their parents).
  Boards without a workspace go to a "Main workspace" (monday's default).
- `board_kind`: `public → public`, `private → private`, `share → share`.
  `workspaces.kind`: `open → open`, `closed → closed`.
- Columns: `status`/`color` → status (labels and colors from `settings_str`
  `labels` + `labels_colors[*].color`, empty labels dropped); `people`/`person`
  → people (from `value.personsAndTeams` kind person); `date` → date
  (`value.date`); `numbers` → numbers; `text`, `long_text` → text (long_text
  from `value.text`); `name` is the item name. Every other type (dropdown, tags,
  timeline, link, email, phone, checkbox, rating, mirror, formula, file, …) →
  text from `column_values.text`, with one warning per column naming the
  original type.
- Subitems become items in the same group with `parent_source_id`; their
  columns are merged into the board's columns by title + type when they match,
  otherwise added as "<title> (subitem)".
- Updates: `text_body` (plain text) preferred; HTML is never kept.
- Docs: `docs(limit, page, workspace_ids) { id name blocks { type content } }`
  best effort; block content is monday's delta JSON — extract plain text per
  block; unknown block types → paragraph with a warning.
- Errors: HTTP 401/403 → `INVALID_TOKEN`; GraphQL `ComplexityException` or 429
  → wait (`retry_in_seconds` / `Retry-After`) and retry; other GraphQL errors →
  warning on that board and continue.

### 3.2 ClickUp (`clickup.js`)

REST with header `Authorization: <token>`.

- `GET /team` → workspaces (teams) and members (`user.id/username/email`).
  Each ClickUp **Space** becomes one Worklane workspace named
  "<Team> / <Space>" (private spaces → `closed`, others `open`).
- `GET /team/{id}/space?archived=false`, `/space/{id}/folder?archived=false`,
  `/folder/{id}/list?archived=false`, `/space/{id}/list?archived=false`
  (folderless). Each **List** becomes a board named "<Folder> / <List>" (or
  "<List>" when folderless), `kind` `private` when the list/folder/space is
  private, else `public`.
- `GET /list/{id}` (statuses with colors) and `/list/{id}/field` (custom fields).
- Tasks: `GET /list/{id}/task?page=N&include_closed=true&subtasks=true&archived=false`
  until `last_page` is true (or fewer than 100 tasks). Subtasks keep
  `parent_source_id`.
- Columns: "Status" (status; the list's statuses in order with colors),
  "Assignees" (people), "Due date" (date from ms epoch, UTC), "Start date"
  (date), "Priority" (status: Urgent `#df2f4a`, High `#fdab3d`, Normal
  `#579bfc`, Low `#c4c4c4`), "Time estimate (h)" (numbers), "Tags" (text, comma
  joined), "Description" (text from `text_content`, truncated with a warning
  over 2,000 characters). Custom fields: `drop_down`/`labels` → status (options
  with colors; labels become comma-joined text with a warning), `number`/
  `currency`/`emoji`(rating) → numbers, `date` → date, `text`/`short_text`/
  `email`/`phone`/`url` → text, `users` → people, `checkbox` → text Yes/No,
  others → text with a warning.
- Groups: two groups per board, "Open" (`#579bfc`) and "Closed" (`#00c875`),
  by the status `type` (`closed`/`done` → Closed).
- Comments (option `include_comments`, default on, max 5,000 per scan):
  `GET /task/{id}/comment` → updates using `comment_text`.
- Docs (option `include_docs`, default on): v3 `GET /workspaces/{team}/docs`
  and their pages → Worklane docs (markdown lines → blocks: `#`/`##` headings,
  `- ` bullets, `1. ` numbered, `- [ ]`/`- [x]` todos, `> ` quote, fenced code,
  others paragraph). Failure → warning only.
- Errors: 401 → `INVALID_TOKEN`; 429 → honor `X-RateLimit-Reset`/`Retry-After`.

### 3.3 Files (`files.js`, `csv.js`, `xlsx.js`)

- **CSV** (RFC 4180: quotes, escaped quotes, CRLF/LF, BOM; ≤ 20 MiB; ≤ 50,000
  rows; ≤ 200 columns). One CSV → one board named after the file. The first row
  is the header. Column types are inferred (all values valid dates → date,
  numbers → numbers, ≤ 30 distinct short values → status, values that match
  user emails or `Assignee`/`Owner`/`Person` headers → people, else text) and
  can be overridden in the mapping step. A `Name`/`Task name`/`Item` header (or
  the first column) is the item name; a `Group`/`List`/`Status type` header (if
  present) defines groups, else one group "Imported".
- **monday Excel export** (`.xlsx`, ≤ 20 MiB): a dependency-free reader
  (`xlsx.js`: ZIP central directory + `zlib.inflateRawSync` with
  `maxOutputLength`, total uncompressed ≤ 100 MiB, ≤ 2,000 entries, no path
  traversal, shared strings + inline strings + numbers + dates via the
  workbook's 1900/1904 epoch). monday's board export layout: first rows are the
  board title, then per group a title row followed by a header row and item rows;
  "Subitems" header rows introduce subitems. Parse that layout; other workbook
  layouts fall back to "first sheet as a table" like CSV.
- Spreadsheet formula injection: values starting with `=`, `+`, `-`, `@` are
  imported as plain text (never evaluated) — Worklane never evaluates them, and
  CSV exports elsewhere are out of scope.

## 4. Engine (`server/import/engine.js`)

- `preview(snapshot, { store, importerId, mapping }) → Preview`: counts per
  workspace/board (columns, groups, items, subitems, updates, docs), the user
  mapping proposal, and every warning.
- User mapping: each source user is matched by email (case-insensitive) to an
  active Worklane user; otherwise the proposal is `skip`. The admin may choose,
  per user, `match:<worklane user id>`, `invite:member`, `invite:viewer`,
  `invite:guest`, or `skip`. Invites create users through the store (role,
  name, email; duplicate emails become matches).
- Targets: each source workspace maps to a new Worklane workspace (default) or to
  an existing workspace the admin can manage (`workspace_map`). Selection: the
  admin can include/exclude any board/list and doc.
- `run(snapshot, plan, { store, importerId, onProgress, signal })` creates
  everything through store mutators in a single persisted batch per board (one
  save, no per-item events), applies `members` grants for mapped users with the
  normal guest/role rules (refused grants become warnings), adds the importer as
  owner of every created board/doc, sets `board.import = { source, source_id,
  source_url, imported_at, imported_by }` (shown as a badge), and returns a
  Report `{ created: {workspaces, boards, groups, columns, items, updates, docs,
  users}, skipped: [...], warnings: [...], links: [{ kind, id, url, title }] }`.
- Cancellation: `signal` stops between boards; what was created stays and is
  listed in the report.
- Re-import: if a board with the same `import.source` + `source_id` exists, the
  preview flags it and the default is to create a new copy named "<name>
  (imported again)"; no merging.

## 5. HTTP and GraphQL

REST under `/import` (host server; cookie session with `Origin` check, or API
token with `import_data`; behind the site gate in hosted mode):

| Route                           | Behavior                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /import/scan`             | JSON `{ source: "monday" \| "clickup", token, options }` or raw file body (`Content-Type: application/octet-stream`, `X-Import-Filename`, `X-Import-Kind: csv \| xlsx`, ≤ 20 MiB). Starts a scan job → 202 `{ job_id }`. |
| `GET /import/jobs/<id>`         | `{ id, kind: "scan" \| "import", state: "running" \| "done" \| "failed" \| "cancelled", progress, preview?, report?, error? }`. Only the job's creator can read it.                                                      |
| `POST /import/jobs/<id>/cancel` | Cancels a running job.                                                                                                                                                                                                   |
| `POST /import/run`              | JSON `{ scan_job_id, plan: { users, workspace_map, include } }` → 202 `{ job_id }` for the import job.                                                                                                                   |

- At most one running job per admin and two per server; scan results (snapshots)
  live in memory for 30 minutes, then are discarded. Nothing about the token is
  kept in jobs.
- Progress also streams on `GET /v2/events?stream=me` as `event: import`.
- GraphQL: `Board.import: BoardImport` (`source`, `source_url`,
  `imported_at`, `imported_by: User`) and `me.capabilities` includes
  `import_data` for admins.

## 6. UI (`web/pages/import.js`, `web/ui/import/*`, `web/styles/import.css`)

Route `#/import` (Admin page gets an "Import" tab linking to it; the + Add menu
offers "Import from monday.com / ClickUp" for admins).

1. **Choose source**: cards for monday.com, ClickUp, CSV, monday Excel export,
   each with a one-line explanation and where to find the token/export
   (monday: Avatar → Developers → My access tokens; ClickUp: Settings → Apps →
   API Token). Token input is `type="password"`, `autocomplete="off"`, cleared
   immediately after the scan request, never stored in `localStorage`.
2. **Scanning**: live progress (phase, counts) with Cancel.
3. **Review**: tree of workspaces → boards/lists → docs with checkboxes and
   counts; target workspace per source workspace; a people table (source name,
   email, proposed action dropdown); warnings grouped by code with expandable
   paths; "Import" button with a summary sentence.
4. **Importing**: progress bar and current board, Cancel.
5. **Done**: created counts, links to the new workspaces/boards/docs, the full
   warning list (downloadable as a `.txt` via a Blob URL), "Import more".

Imported boards show an "Imported from monday.com" / "Imported from ClickUp"
badge in the board header with the source link (`rel="noopener noreferrer"`,
http/https only).

## 7. Testing

- Fake upstream servers in `test/fixtures/import/` (node:http) that implement
  the documented monday GraphQL and ClickUp REST shapes, including pagination,
  429 / complexity errors with retry hints, 401, oversized responses and
  timeouts. Fixtures cover every column/field type in §3.
- Unit tests for snapshot validation, mapping of every type, CSV edge cases,
  xlsx reader (valid workbook built in the test, zip bomb, traversal names,
  1904 dates), engine preview/run/cancel/re-import, token never appearing in
  any job, log line or error, permissions (non-admin → 404/403 per §1).
- `scripts/e2e-import.mjs`: in Chromium, an admin imports from the fake monday
  server and the fake ClickUp server (env overrides), maps one user to an
  invite, imports, opens an imported board and sees items, statuses, people and
  updates; also imports a CSV.
- Real monday.com / ClickUp accounts are not reachable from the build
  environment; the README states that the connectors were verified against
  fixtures built from the official API shapes, not against live accounts.
