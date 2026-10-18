# mini-monday specification, part 2: the full workspace

Part 1 (`SPEC.md`) defines the base: GraphQL engine, data store, boards API,
HTTP servers, bridge protocol, SDK, CLI. Part 2 grows it into a complete,
well-designed work-management product. Everything in part 1 still applies unless
this document changes it. The product's display name is **Worklane** (a
monday.com-style workspace rebuilt from REA findings); do not use monday.com
names, logos or colors as branding.

## 1. Concepts

| Concept        | Summary                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account role   | Every user has one: `admin`, `member`, `viewer`, `guest`.                                                                                                                         |
| User status    | `active` or `deactivated`. Deactivated users cannot sign in; their sessions and API tokens stop working immediately.                                                              |
| Team           | A named group of users with owners and members. Teams can be given access like a user.                                                                                            |
| Workspace      | Container for boards, docs and forms. `open` (every non-guest active user is an implicit member) or `closed` (explicit members only).                                             |
| Board kind     | `public` (shown as "Main": visible to everyone with workspace access), `private` (members only, no guests), `share` (shown as "Shareable": members only, guests allowed).         |
| Doc            | A block document (headings, paragraphs, lists, to-dos, quotes, code, callouts, dividers) in a workspace. Visibility `workspace` or `private`.                                     |
| Note           | A personal note owned by one user. Private unless explicitly shared. Never visible to anyone else, including admins.                                                              |
| Form           | Belongs to a board. Its questions map to board columns; each submission creates an item. Access `public` (anyone with the link), `account` (signed-in non-guest users), `closed`. |
| Share / member | A grant of a role to a subject (`user` or `team`) on a resource (`workspace`, `board`, `doc`, `note`).                                                                            |
| Notification   | Per-user inbox entry: shared with you, assigned to you, update on your item, form response on your board.                                                                         |
| Activity log   | Per-board history of who changed what.                                                                                                                                            |

### 1.1 Roles and capabilities

Access roles on a resource are ordered `viewer < editor < owner`.

| Capability                                                                   |    admin     |    member    |          viewer          |    guest     |
| ---------------------------------------------------------------------------- | :----------: | :----------: | :----------------------: | :----------: |
| Manage users and account roles                                               |      ✓       |              |                          |              |
| See the admin content directory (metadata only)                              |      ✓       |              |                          |              |
| Create workspaces and teams                                                  |      ✓       |      ✓       |                          |              |
| Create boards, docs, forms (where they can edit the workspace)               |      ✓       |      ✓       |                          |              |
| Create personal notes                                                        |      ✓       |      ✓       |            ✓             |      ✓       |
| Implicit access to public boards and workspace docs in accessible workspaces |    editor    |    editor    |          viewer          |      —       |
| Can be added to private boards                                               |      ✓       |      ✓       |            ✓             |              |
| Can be added to shareable boards, docs, notes                                |      ✓       |      ✓       |            ✓             |      ✓       |
| Edit anything                                                                | per resource | per resource | never (capped at viewer) | per resource |

Admins have no implicit access to private/shareable boards, private docs or
anyone's notes. They see private boards and docs in the content directory
(title, kind, owner, workspace) and can add themselves as owner through
`admin_take_ownership` (recorded in the activity log), which makes the override
visible rather than silent.

### 1.2 Effective access (owned by `server/access.js`)

`server/access.js` is the only module that interprets roles and grants. Every
resolver, HTTP route and UI capability flag must use it.

```js
export const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
export function maxRole(a, b)                 // null-safe
export function capRole(role, user)           // viewer accounts cap at "viewer"
export function subjectGrants(store, user, members) // highest role from user grants and team grants
export function workspaceAccess(store, user, workspace) // → "owner" | "editor" | "viewer" | null
export function boardAccess(store, user, board)         // → role | null
export function docAccess(store, user, doc)              // → role | null
export function noteAccess(store, user, note)            // → role | null
export function formAccess(store, user, form)            // management access = boardAccess of its board
export function can(user, capability)  // "manage_users" | "admin_directory" | "create_workspace" | "create_team" | "create_content" | "create_note"
export function canGrant({ resourceKind, resource, subject, role, store }) // → { ok } | { ok: false, reason }
```

Rules (a deactivated user always gets `null`):

- **Workspace**: explicit grant (user or team) → that role; else `open` workspace
  and user is not a guest → `editor` (`viewer` for viewer accounts); else null.
  Admins get `owner` on every workspace for management (members, settings) but
  this does not grant content access to private boards/docs.
- **Board**: explicit grant → that role (guests only on `share` boards; a guest
  grant on a non-share board is ignored); else `public` board and
  `workspaceAccess` non-null and not a guest → `editor` (or `viewer`), and
  admins → `owner` on public boards; else null. Explicit grants work even
  without workspace access (shareable boards for guests).
- **Doc**: explicit grant → role; else `workspace` visibility and workspace
  access and not a guest → `editor`/`viewer`; else null.
- **Note**: owner → `owner`; explicit grant → `viewer`/`editor`; else null.
- `capRole` applies last: viewer accounts never exceed `viewer`.
- Resources the user cannot access are reported as `NOT_FOUND`, never
  `FORBIDDEN`, so their existence does not leak. Actions on accessible
  resources with too low a role → `FORBIDDEN`.
- Required roles: read board/items/updates/activity → viewer; create/edit/move/
  delete items, groups, updates, column values, forms → editor; board settings
  (name, description, kind, columns create/delete, members, delete board) →
  owner. Docs: read → viewer, edit → editor, visibility/members/delete → owner.
  Notes: edit → editor, share/delete → owner. Workspaces: settings/members/
  delete → owner.
- `canGrant`: role must be valid for the resource (notes: `viewer`/`editor`;
  workspaces: `owner`/`editor`); guests may be granted only on `share` boards,
  docs and notes; deactivated users cannot be granted; a resource always keeps
  at least one owner (removing or demoting the last owner fails). Granting a team
  grants its current and future members.
- App principals (iframe apps) and API tokens act as their user, further limited
  by scopes (part 1).

## 2. Data model additions (`server/store.js` and `server/store/*`)

`store.js` stays the entry point (`createStore`) and may delegate to domain
modules under `server/store/` (`people.js`, `workspaces.js`, `boards.js`,
`docs.js`, `notes.js`, `forms.js`, `activity.js`, `seed.js`,
`persistence.js`). Keep each file under 500 lines. Existing part-1 methods keep
their names and behavior. All new mutators emit change events
(`{ type, board_id?, user_ids?, resource_kind?, resource_id? }`).

Records:

```
User        { id, name, email, role, title, status, color, created_at }
Team        { id, name, description, members: [{ user_id, role: "owner"|"member" }], created_at }
Workspace   { id, name, description, kind: "open"|"closed", color, members: [Grant], created_by, created_at }
Grant       { kind: "user"|"team", id, role: "owner"|"editor"|"viewer" }
Board       + { workspace_id, board_kind: "public"|"private"|"share", members: [Grant] }
Doc         { id, workspace_id, title, visibility: "workspace"|"private", members: [Grant],
              blocks: [Block], version, created_by, updated_by, created_at, updated_at }
Block       { id, type: "heading1"|"heading2"|"paragraph"|"bulleted"|"numbered"|"todo"|"quote"|"code"|"divider"|"callout",
              text, checked?: boolean }
Note        { id, owner_id, title, body, color, pinned, shares: [Grant (viewer|editor)], version, created_at, updated_at }
Form        { id, board_id, title, description, accent_color, questions: [Question], target_group_id,
              access: "public"|"account"|"closed", token, submit_message, response_count, created_by, created_at, updated_at }
Question    { id, column_id, label, help, required }
Notification{ id, user_id, kind: "share"|"assign"|"update"|"form_response"|"role", text, url, read, actor_id, created_at }
Activity    { id, board_id, actor_id, actor_label, kind, item_id, item_name, column_id, from_text, to_text, created_at }
```

Limits: names/titles 1–255 characters; descriptions ≤ 2,000; doc blocks ≤
2,000 per doc, block text ≤ 10,000; note body ≤ 20,000; form questions ≤ 50,
labels 1–200, help ≤ 500; emails must contain one `@` and be unique
(case-insensitive). Colors are `#rrggbb`. Form tokens: 16 random bytes,
base64url. Doc and note writes take `expectedVersion`; a mismatch returns
`{ ok: false, reason: "version_conflict", version }` and the API maps it to
`VERSION_CONFLICT`.

Activity is recorded for: item create/rename/move/delete, column value changes
(`from_text`/`to_text` via `formatColumnValue`), group create/rename/delete,
column create, board kind/member changes, form submissions (actor null,
`actor_label: "Form: <title>"`), admin ownership takeovers. Notifications are
created for: being granted access to anything (kind `share`), being added to a
people column (`assign`), an update on an item you are assigned to (`update`),
a form response on a board you own (`form_response`), your account role
changing (`role`). Never notify the actor about their own action.

### 2.1 Seed (extends part 1; deterministic content, random secrets)

Users (part-1 users keep IDs 1–3 and gain roles):

| ID  | Name         | Email               | Role                 | Title             |
| --- | ------------ | ------------------- | -------------------- | ----------------- |
| 1   | Alex Rivera  | alex@example.test   | admin                | Head of Product   |
| 2   | Sam Lee      | sam@example.test    | member               | Product Designer  |
| 3   | Noa Cohen    | noa@example.test    | member               | Engineering Lead  |
| +   | Priya Nair   | priya@example.test  | member               | Marketing Manager |
| +   | Jordan Blake | jordan@example.test | viewer               | Finance Analyst   |
| +   | Chris Taylor | chris@agency.test   | guest                | Agency Partner    |
| +   | Morgan Diaz  | morgan@example.test | member (deactivated) | Former Engineer   |

Teams: "Product" (Alex owner; Sam, Noa members), "Marketing" (Priya owner;
Sam member), "Leadership" (Alex owner).

Workspaces: "Main workspace" (open; Alex owner) holding "Product roadmap"
(public), "Marketing launch" (share; Priya owner, Chris guest editor);
"Leadership" (closed; Leadership team editor, Alex owner) holding "Hiring plan"
(private; Alex owner, Noa editor) and "Budget 2027" (public within the closed
workspace).

Docs: "Product vision" (Main, workspace visibility, Alex owner) with a heading,
paragraphs, a to-do list and a callout; "Launch brief" (Main, private, Priya
owner, shared with Chris viewer and Marketing team editor); "Leadership
offsite" (Leadership workspace, workspace visibility).

Notes: Alex "Ideas for Q1" (pinned, private), Alex "1:1 with Sam" (shared with
Sam viewer), Sam "Design crit notes" (private), Priya "Launch checklist"
(shared with Marketing team editor).

Forms: "Feature request" on Product roadmap (public; questions: name "Request
title" required, notes "Details", status "Priority-ish status", date "Needed
by"), "Campaign intake" on Marketing launch (account access).

A few activity entries and unread notifications for Alex and Sam.

## 3. GraphQL API additions (`server/schema.js` + `server/schema/*.js`)

Split the schema into modules under `server/schema/` (`common.js`,
`boards.js`, `people.js`, `workspaces.js`, `docs.js`, `notes.js`, `forms.js`,
`inbox.js`, `storage.js`) that each export type/field definitions; `schema.js`
merges them into one `buildSchema` call. All authorization goes through
`access.js`. Lists only contain accessible records.

```graphql
enum AccountRole { admin member viewer guest }
enum UserStatus { active deactivated }
enum BoardKind { public private share }
enum AccessRole { owner editor viewer }
enum SubjectKind { user team }
enum ResourceKind { workspace board doc note }
enum WorkspaceKind { open closed }
enum DocVisibility { workspace private }
enum FormAccess { public account closed }
enum NoteScope { mine shared all }

type Account { id: ID! name: String! user_count: Int! role_counts_json: String! }
type User { ... role: AccountRole! title: String status: UserStatus! color: String! created_at: String! teams: [Team!]! }
type Team { id: ID! name: String! description: String members: [TeamMember!]! member_count: Int! my_role: String can_manage: Boolean! }
type TeamMember { user: User! role: String! }       # "owner" | "member"
type Member { kind: SubjectKind! id: ID! name: String! role: AccessRole! user: User team: Team }
type Workspace { id: ID! name: String! description: String kind: WorkspaceKind! color: String!
  members: [Member!]! my_access: AccessRole! boards: [Board!]! docs: [Doc!]! can_manage: Boolean! }
type Board { ... workspace: Workspace! board_kind: BoardKind! members: [Member!]! my_access: AccessRole!
  forms: [Form!]! activity_logs(limit: Int = 50): [ActivityLog!]! }
type Doc { id: ID! title: String! workspace: Workspace! visibility: DocVisibility! members: [Member!]!
  my_access: AccessRole! blocks_json: String! version: Int! created_by: User updated_by: User
  created_at: String! updated_at: String! url: String! }
type Note { id: ID! title: String! body: String! color: String! pinned: Boolean! owner: User!
  shares: [Member!]! my_access: AccessRole! version: Int! created_at: String! updated_at: String! }
type Form { id: ID! board: Board! title: String! description: String accent_color: String!
  questions_json: String! target_group_id: String access: FormAccess! public_url: String!
  submit_message: String response_count: Int! created_at: String! updated_at: String! }
type ActivityLog { id: ID! kind: String! actor: User actor_label: String item_id: ID item_name: String
  column_id: String from_text: String to_text: String created_at: String! }
type Notification { id: ID! kind: String! text: String! url: String! read: Boolean! actor: User created_at: String! }
type SearchResult { kind: String! id: ID! title: String! subtitle: String url: String! }
type ContentEntry { kind: String! id: ID! title: String! privacy: String! owner: User workspace: Workspace }

type Query {
  account: Account!
  workspaces: [Workspace!]!
  teams: [Team!]!
  docs(ids: [ID!], workspace_id: ID): [Doc!]!
  notes(scope: NoteScope = all): [Note!]!
  forms(board_id: ID): [Form!]!
  notifications(unread_only: Boolean = false, limit: Int = 50): [Notification!]!
  unread_notifications_count: Int!
  search(query: String!, limit: Int = 20): [SearchResult!]!
  shared_with_me: [SearchResult!]!
  my_work(limit: Int = 50): [Item!]!
  admin_content_directory: [ContentEntry!]!          # admins only
}

type Mutation {
  invite_user(name: String!, email: String!, role: AccountRole!, title: String): User!     # admin
  update_user(user_id: ID!, name: String, title: String, role: AccountRole): User!         # admin (or self for name/title)
  deactivate_user(user_id: ID!): User!   activate_user(user_id: ID!): User!                 # admin, not self, keep ≥1 active admin
  create_team(name: String!, description: String, member_ids: [ID!]): Team!
  update_team(team_id: ID!, name: String, description: String): Team!
  add_team_members(team_id: ID!, user_ids: [ID!]!, as_owner: Boolean = false): Team!
  remove_team_members(team_id: ID!, user_ids: [ID!]!): Team!   delete_team(team_id: ID!): Team!
  create_workspace(name: String!, kind: WorkspaceKind = open, description: String): Workspace!
  update_workspace(workspace_id: ID!, name: String, description: String, kind: WorkspaceKind, color: String): Workspace!
  delete_workspace(workspace_id: ID!): Workspace!        # must contain no boards or docs
  share(resource_kind: ResourceKind!, resource_id: ID!, subject_kind: SubjectKind!, subject_ids: [ID!]!, role: AccessRole!): [Member!]!
  unshare(resource_kind: ResourceKind!, resource_id: ID!, subject_kind: SubjectKind!, subject_id: ID!): [Member!]!
  admin_take_ownership(resource_kind: ResourceKind!, resource_id: ID!): [Member!]!     # admin; boards and docs only
  # create_board gains: board_kind: BoardKind = public, workspace_id: ID
  set_board_kind(board_id: ID!, board_kind: BoardKind!): Board!   # moving to non-share removes guest grants
  create_doc(title: String!, workspace_id: ID, visibility: DocVisibility = workspace): Doc!
  update_doc(doc_id: ID!, expected_version: Int!, title: String, blocks_json: String): Doc!
  set_doc_visibility(doc_id: ID!, visibility: DocVisibility!): Doc!   delete_doc(doc_id: ID!): Doc!
  create_note(title: String!, body: String, color: String): Note!
  update_note(note_id: ID!, expected_version: Int!, title: String, body: String, color: String, pinned: Boolean): Note!
  delete_note(note_id: ID!): Note!
  create_form(board_id: ID!, title: String!): Form!     # starts with the required name question
  update_form(form_id: ID!, title: String, description: String, accent_color: String, questions_json: String,
              target_group_id: String, access: FormAccess, submit_message: String): Form!
  regenerate_form_link(form_id: ID!): Form!   delete_form(form_id: ID!): Form!
  mark_notifications_read(ids: [ID!], all: Boolean = false): Int!
}
```

- `blocks_json` / `questions_json` / `role_counts_json` are JSON text. Inputs are
  validated against §2 limits; questions must reference existing, non-`people`
  columns of the form's board, the first question is always the `name` column
  (required), question IDs are generated when missing.
- `search` matches case-insensitive substrings of titles/names (boards, items,
  docs, notes, forms, users, teams, workspaces) the user can access; at most
  `limit` (1–50) results ordered by kind then title.
- `shared_with_me`: boards, docs, notes the user can access through an explicit
  user or team grant where the user is not an owner.
- `my_work`: active items whose people columns include the user, on accessible
  boards, ordered by date column (nulls last) then board.
- Doc URL `#/docs/<id>`; note URL `#/notes/<id>`; form public URL
  `<hostOrigin>/f/<token>`; board URL unchanged.
- New error code `VERSION_CONFLICT` (`extensions.version` carries the current
  version).

## 4. HTTP additions (`server/http.js` and `server/routes/*.js`)

Split routes into modules (`server/routes/graphql.js`, `static.js`,
`forms.js`, `auth.js`, `apps.js`) if `http.js` would exceed 500 lines.

| Route                       | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /f/<token>`            | `web/form.html` with the host CSP (form pages may be framed by nobody). Unknown token → 404 page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /f/<token>/definition` | JSON `{ title, description, accent_color, submit_message, questions: [{ id, label, help, required, type, options? }] }` where `type` is the column type and `options` are status labels (non-empty, in index order). `public` → no auth; `account` → session of an active non-guest user, else 401; `closed` → 403 `FORM_CLOSED`.                                                                                                                                                                                                                                                                                       |
| `POST /f/<token>/submit`    | JSON `{ answers: { <questionId>: string }, website: "" }`. Same access rules; `Origin`, when present, must equal the host origin. Non-empty honeypot `website` → 201 without creating anything. Required answers, simple-value parsing via `parseSimpleColumnValue`. Creates an item in `target_group_id` (or the first group), increments `response_count`, records activity and notifies board owners. 201 `{ ok: true, message }`; invalid → 400 `{ errors: [{ message, extensions: { code: "BAD_USER_INPUT", question_id } }] }`. Rate limit 10 submissions per minute per client IP and form → 429 `RATE_LIMITED`. |
| `GET /auth/demo-users`      | Demo mode only (`MM_DEMO_LOGIN` not `0`; tests can pass `demoLogin: false` to `startServers`). Session required. `{ users: [{ id, name, role, title, color, status }] }`. Otherwise 404.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /auth/demo-login`     | Demo mode only. Session cookie + `Origin` check. Body `{ user_id }` of an active user → rotates to a new session for that user (new cookie), 204. Deactivated/unknown → 400.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /auth/logout`         | Ends the session (cookie cleared), 204. The next `GET /` signs in as user 1 again in demo mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /v2/events?stream=me`  | SSE of the current user's notification events (`event: notification`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Session principals resolve the user on every request, so role changes and
deactivation apply immediately.

## 5. Web app (design system, shell, pages)

Keep plain ES modules, no build step, no CDNs, CSP-compatible (no inline
scripts/styles; `element.style` from JS is fine), safe DOM only.

### 5.1 Structure

```
web/
  index.html  form.html  styles/ (tokens.css base.css components.css layout.css pages.css)
  main.js            boot: load me/account/workspaces, mount shell, start router
  router.js          hash router: register(pattern, loader) → page modules
  api.js  dom.js  host-bridge.js
  ui/components/     button.js icon.js (inline SVG icons via createElementNS) avatar.js menu.js
                     dialog.js popover.js tabs.js toast.js empty-state.js share-dialog.js
                     command-palette.js people-picker.js badge.js skeleton.js
  ui/shell/          topbar.js sidebar.js notifications.js user-menu.js workspace-switcher.js
  pages/             home.js my-work.js shared.js board.js docs.js doc-editor.js notes.js
                     forms.js form-builder.js teams.js admin.js workspace-settings.js not-found.js
  form-page.js       public form (loaded by form.html)
```

Existing part-1 UI modules (`web/ui/*.js`) are refactored into this structure;
remove superseded files rather than keeping duplicates.

Page contract: each `pages/*.js` exports
`async function mount(container, ctx, params) → (() => void) | void` (returns a
cleanup). `ctx = { api, me, account, router, toast, dialog, openShare, refreshShell, bus }`
where `openShare({ resourceKind, resourceId })` opens the shared share dialog and
`bus` is an event emitter for SSE-driven updates.

Routes: `#/home`, `#/my-work`, `#/shared`, `#/workspaces/<id>`,
`#/workspaces/<id>/settings`, `#/boards/<id>` (+ part-1 view/item routes, plus
`#/boards/<id>/views/activity` and `#/boards/<id>/views/forms`), `#/docs`,
`#/docs/<id>`, `#/notes`, `#/notes/<id>`, `#/forms/<id>`, `#/teams`,
`#/teams/<id>`, `#/admin` (users), `#/admin/content`. Unknown → not-found page.
Default route `#/home`.

### 5.2 Shell

- **Top bar**: brand ("Worklane" wordmark with a simple SVG mark), global search
  button (opens the command palette; `Ctrl/⌘+K`), notifications bell with unread
  count and a dropdown list (mark one/all read, click navigates), theme toggle
  (system/light/dark, remembered in `localStorage` with try/catch), user avatar
  menu (name, role badge, "Switch user (demo)" listing demo users with role badges,
  "Sign out").
- **Sidebar**: Home, My work, Shared with me, Notes; workspace switcher (lists
  accessible workspaces, kind icon, "+ New workspace" when allowed); the current
  workspace's boards (icon per kind: grid for Main, lock for Private, people for
  Shareable), docs and forms; a "+ Add" menu (Board / Doc / Form, only when the
  user can create); bottom: Teams, Admin (admins only). Collapsible; becomes a
  drawer under 900 px.
- **Command palette**: search across `search(query)` results with kind icons,
  arrow-key navigation, Enter to open, Esc to close; also quick actions (New
  board, New doc, New note).
- **Share dialog** (one component for workspace/board/doc/note): resource
  visibility control (board kind Main/Private/Shareable with explanations; doc
  visibility Workspace/Private; workspace Open/Closed; notes always private
  until shared), current members with role dropdowns and remove buttons (the
  last owner cannot be removed), a people/team picker to add subjects with a
  role, guest-eligibility hints, "Copy link". Uses `share`/`unshare`/
  `set_board_kind`/`set_doc_visibility`/`update_workspace`.
- Capability-aware UI: hide or disable controls the user cannot use (from
  `my_access`, `role`, `can_manage`), with tooltips explaining why. Read-only
  users see a "View only" badge.

### 5.3 Pages

- **Home**: greeting, "My work" preview (next due items), recent boards/docs,
  "Shared with me" preview, unread notifications, quick-create tiles.
- **My work**: assigned items grouped by Overdue / This week / Later / No date,
  with board links and inline status changes.
- **Shared with me**: cards for boards, docs, notes shared with the user, with
  who shared and the role.
- **Workspace**: header with kind badge and members avatars, tabs Boards / Docs /
  Forms, create buttons; settings page (rename, description, color, kind, members
  via the share dialog, delete when empty).
- **Board**: part-1 table/kanban/app views plus: kind badge and members avatars
  in the header, "Share" button, "Activity" view (timeline with actor avatars and
  from → to chips), "Forms" view (list of the board's forms, create, open
  builder, copy public link). View-only users get read-only cells.
- **Docs list** and **Doc editor**: list with filters (All / Mine / Shared with
  me) and visibility badges. The editor is a block editor: each block is a
  `contenteditable` element holding plain text; Enter splits into a new
  paragraph, Backspace on an empty block deletes it, "/" at the start of an empty
  block opens a block-type menu, to-dos have checkboxes, a side handle moves
  blocks up/down. Title is editable. Autosave debounced (800 ms) with
  `expected_version`; on `VERSION_CONFLICT` show a banner offering to reload.
  Saved/saving indicator. Read-only when `my_access` is viewer.
- **Notes**: masonry-style grid of colored note cards with pinned first, filters
  (All / Mine / Shared with me), create, open a note in a side editor with
  autosave and version conflict handling, color picker, pin, share (owner only),
  delete.
- **Form builder** (`#/forms/<id>`): left side question list (add question by
  picking a board column, reorder up/down, label, help, required toggle,
  remove; the name question cannot be removed), right side live preview using the
  same renderer as the public page, settings (title, description, accent color,
  target group, access Public/Account/Closed, submit message), public link with
  copy and "Regenerate link", response count.
- **Public form page** (`form.html` + `form-page.js`): standalone, branded with
  the form accent color, accessible labels, client-side required checks, status
  as radio chips, date picker, number input, success screen with the submit
  message, friendly errors for closed/unknown/rate-limited.
- **Teams**: list with member counts; team page with members, owners, add/remove
  (owners/admins), create team.
- **Admin**: users table (avatar, name, email, title, role dropdown, status, teams,
  actions: deactivate/activate), "Invite user" dialog (name, email, role,
  title), role legend explaining what each role can do, account stats; content
  directory tab listing all boards/docs with privacy, owner and a "Take
  ownership" action with a confirmation dialog.

### 5.4 Visual design

A cohesive, modern design system in `styles/tokens.css`:

- Color tokens for light and dark (`prefers-color-scheme` plus
  `[data-theme="light"|"dark"]` overrides): surfaces (page, panel, raised),
  text (primary, secondary, muted), borders, primary `#5b5bd6` family (Worklane
  indigo), success/warning/danger/info, focus ring; status label colors from the
  data.
- Typography: system font stack, sizes 12/13/14/16/20/24/32, weights 400/500/
  600/700, line heights tuned for dense tables.
- Spacing on a 4 px grid; radii 6/8/12; elevation shadows for menus, dialogs,
  cards; transitions 120–200 ms; `prefers-reduced-motion` respected.
- Components with hover, active, focus-visible and disabled states; skeleton
  loaders while fetching; empty states with an icon, one sentence and an action.
- Accessible: semantic landmarks, labelled controls, focus trapping in dialogs,
  Escape closes overlays, visible focus, 4.5:1 text contrast in both themes.
- Responsive from 360 px: sidebar drawer, horizontally scrollable tables with a
  sticky name column, stacked page headers.
