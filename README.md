# Worklane (mini-monday)

Worklane is a small, dependency-free work-management workspace in the style
of monday.com, rebuilt from what REA (this repository's reverse-engineering
tool) recovered from monday.com's shipped SDKs, CLI and apps framework. It
is an example, not a product: everything runs locally from Node.js
built-ins and plain browser ES modules, with no npm dependencies, build
step, CDN or external font.

It has two halves:

- **A workspace app**: account roles, teams, open and closed workspaces,
  boards (table, kanban, activity, forms and app views), block docs,
  personal notes, public forms, an inbox of notifications, search, and an
  admin area. Sharing and privacy rules are enforced in one server module.
- **An app platform** modeled on monday.com's: a GraphQL API at `/v2` with
  an `API-Version` header, iframe apps that talk to the host page over
  `postMessage`, a host-proxied API, app storage, signed session tokens and
  a small CLI.

The contracts are [`SPEC.md`](SPEC.md) (part 1: engine, API, platform) and
[`SPEC-2.md`](SPEC-2.md) (part 2: the full workspace). This README
summarizes them; the specs win where they differ.

## How it maps to the REA findings

REA's report on monday.com's packages found weaknesses in the shipped client
code. The platform half of Worklane deliberately does the opposite:

| REA finding (monday.com package)                                  | Worklane rule                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `postMessage(…, "*")`, replies accepted from any sender           | Messages target one exact origin; both sides check `event.origin` **and** `event.source`.                      |
| `Math.random()` 7-character request IDs; replies routed by method | `crypto.randomUUID()` request IDs; responses resolve only their pending request; events dispatch only by type. |
| `mapps` sets `rejectUnauthorized: false`                          | The CLI never disables TLS verification; plain `http:` only for loopback hosts; optional `--ca-file`.          |
| MCP `--read-only` silently false when bare; ignored in one mode   | Bare `--read-only` means true; read-only is enforced server-side by token scopes and client-side by the CLI.   |
| Storage keys concatenated into URLs unencoded                     | Storage keys travel as typed GraphQL arguments and are validated; no key ever forms a URL path.                |

The display name is Worklane; no monday.com names, logos or colors are
used as branding.

## Quick start

Requires Node.js 22.19 or newer. From this directory:

```sh
npm start            # node server/main.js
```

The server seeds a demo account and prints its URLs and two API tokens:

```
mini-monday is running
  Boards app   http://localhost:4100
  Apps origin  http://127.0.0.1:4101
  GraphQL API  http://localhost:4100/v2
  Token (read-write)  <random token>
  Token (read-only)   <random token>
```

Open <http://localhost:4100>. In demo mode the first visit signs you in as
Alex Rivera (admin). The avatar menu at the top right has **Switch user
(demo)**, which lists every seeded user with their role, so you can see the
same workspace as a member, a viewer or a guest. **Sign out** ends the
session; the next visit signs in as Alex again.

| Seeded user  | Role                 | Good for trying                                        |
| ------------ | -------------------- | ------------------------------------------------------ |
| Alex Rivera  | admin                | Admin area, content directory, ownership takeover      |
| Sam Lee      | member               | Editing, creating boards and docs, notes shared to him |
| Noa Cohen    | member               | A private board in a closed workspace via a grant      |
| Priya Nair   | member               | Owner of the Shareable "Marketing launch" board        |
| Jordan Blake | viewer               | Read-only boards and docs; can still write notes       |
| Chris Taylor | guest                | Sees only what is shared with him                      |
| Morgan Diaz  | member (deactivated) | Cannot sign in                                         |

Configuration (environment variables):

| Variable         | Default                        | Meaning                                          |
| ---------------- | ------------------------------ | ------------------------------------------------ |
| `MM_HOST_PORT`   | `4100`                         | Host (workspace app + API) port; `0` = free      |
| `MM_APPS_PORT`   | `4101`                         | Apps (iframe apps + SDK) port                    |
| `MM_BIND`        | `127.0.0.1`                    | Listen address for both servers                  |
| `MM_DATA_FILE`   | `.data/mini-monday.json`       | JSON persistence; `:memory:` disables it         |
| `MM_HOST_ORIGIN` | `http://localhost:<host port>` | Public host origin                               |
| `MM_APPS_ORIGIN` | `http://127.0.0.1:<apps port>` | Public apps origin (a different site on purpose) |
| `MM_DEMO_LOGIN`  | on                             | `0` turns off auto sign-in and the user switcher |

The data file format is `mini-monday-store/2`. A part-1 file is refused
with a message; move it away and the server reseeds.

## Feature tour

### Roles and capabilities

Every user has one account role, and every grant gives a resource role
ordered `viewer < editor < owner`.

| Capability                                              | admin        | member       | viewer         | guest        |
| ------------------------------------------------------- | ------------ | ------------ | -------------- | ------------ |
| Manage users and account roles; admin content directory | ✓            |              |                |              |
| Create workspaces and teams                             | ✓            | ✓            |                |              |
| Create boards, docs, forms (where they can edit)        | ✓            | ✓            |                |              |
| Create personal notes                                   | ✓            | ✓            | ✓              | ✓            |
| Implicit access to Main boards and workspace docs       | editor       | editor       | viewer         | —            |
| Can be added to Private boards                          | ✓            | ✓            | ✓              |              |
| Can be added to Shareable boards, docs and notes        | ✓            | ✓            | ✓              | ✓            |
| Edit                                                    | per resource | per resource | never (viewer) | per resource |

Admins have no silent access to private content: the content directory
shows titles and owners only, and **Take ownership** adds the admin as an
owner in plain sight (boards also log it in the activity).

### Sharing

One share dialog serves workspaces, boards, docs and notes. It shows the
visibility setting (board kind Main / Private / Shareable; doc Workspace /
Private; workspace Open / Closed; notes stay private until shared), the
current members with role menus, and a people-and-teams picker that
explains why someone is not eligible (guests only on Shareable boards,
docs and notes; deactivated users never). The last owner cannot be removed
or demoted. Turning a Shareable board into Main or Private asks first,
then removes its guests. Granting a team covers its current and future
members.

### Workspaces, boards and the inbox

- **Shell**: a top bar (search, notifications bell with live unread count,
  theme toggle, account menu) and a sidebar (Home, My work, Shared with me,
  Notes, the current workspace's boards, docs and forms, Teams, Admin).
  Ctrl/⌘+K opens the command palette over `search` plus quick actions.
- **Home**: greeting, quick-create tiles, next due items, unread
  notifications, recent boards and docs, and what was shared with you.
- **My work**: items assigned to you, grouped by Overdue / This week /
  Later / No date, with inline status changes.
- **Boards**: the part-1 table, kanban and app views, plus a kind badge,
  member avatars, Share, an **Activity** timeline (who changed what, with
  from → to chips) and a **Forms** view. Viewers get read-only cells and a
  "View only" badge; controls you cannot use are disabled with a reason.
- **Notifications** for shares, assignments, updates on your items, form
  responses on your boards and role changes arrive live over SSE.

### Docs and notes

- **Docs**: block documents (headings, paragraphs, lists, to-dos, quotes,
  code, callouts, dividers). Each block is a `contenteditable` element
  holding plain text; Enter splits, Backspace merges, "/" opens the block
  menu, Markdown-style shortcuts work. Changes autosave after 800 ms with
  the doc's version; if someone else saved first, a banner offers to
  reload instead of overwriting.
- **Notes**: personal colored notes in a grid, pinned first, with an
  autosaving side editor. They are private to their owner (admins
  included) until shared as viewer or editor.

### Forms

A form belongs to a board; each question maps to a board column and each
response creates an item. The builder (`#/forms/<id>`) edits questions,
help text, accent color, target group, access (Public / Signed-in members /
Closed) and the thank-you message, with a live preview that uses the same
renderer as the public page. The public page `/f/<token>` is standalone,
has client-side checks, status chips, date and number inputs, a honeypot
field and a rate limit of 10 submissions per minute per client and form.
"Regenerate link" invalidates the old link at once.

### Apps

Board views can be iframe apps served from the separate apps origin. The
example app, **Status summary** (`apps/status-summary/`), uses the SDK
(`sdk/mini-monday-sdk.js`) to read the board through the host-proxied API,
listen to live board events, keep a note in app storage with optimistic
versioning, show host notices and open item cards, and verify a signed
session token with its own backend.

### CLI

`cli/mm.js` talks to the API with a token:

```sh
MM_TOKEN=<read-write token> node cli/mm.js boards
MM_TOKEN=<read-only token> node cli/mm.js items 4 --read-only
node cli/mm.js schema --api-version 2026-04
node cli/mm.js --help
```

Commands: `me`, `boards`, `items`, `create-item`, `set-status`, `query`,
`schema`. Prefer `MM_TOKEN` over `--token` (other local processes can read
command lines). `https:` endpoints always verify certificates; `http:` is
allowed only for loopback hosts; `--read-only` refuses mutations before
sending them.

## Architecture

```
server/
  main.js          env → store → startServers → banner with tokens
  http.js          host and apps servers, routing table, security headers
  routes/          graphql.js static.js forms.js auth.js apps.js common.js
  access.js        the only interpreter of roles, grants and teams
  store.js         createStore(): records, change events, persistence
  store/           people workspaces boards items docs notes forms grants
                   activity storage seed seed-data persistence
  schema.js        merges server/schema/*.js into one buildSchema() call
  schema/          common people workspaces boards items sharing docs notes
                   forms inbox search storage
  graphql/         parse.js schema.js execute.js errors.js (the engine)
  auth.js          API tokens, browser sessions, app principals, JWTs
  events.js        server-sent events hub
  column-values.js parse and format column values
  versions.js      API version table
web/               the host app (plain ES modules, no build)
  main.js router.js api.js dom.js host-bridge.js form-page.js
  pages/           one module per route (mount(container, ctx, params))
  ui/              components/ shell/ board/ docs/ notes/ forms/ admin/
                   teams/ workspaces/
  styles/          design tokens, base, components and feature sheets
apps/status-summary/  example iframe app
sdk/               the iframe-app SDK (served from the apps origin)
cli/               the mm CLI
scripts/           browser tests (e2e-smoke, e2e-roles) and their harness
test/              node:test suites
```

**One owner for access.** `server/access.js` is the single module that
interprets account roles, user status, grants and team membership
(`workspaceAccess`, `boardAccess`, `docAccess`, `noteAccess`,
`formAccess`, `can`, `canGrant`, `notificationVisible`). The store records
facts and never decides authority; resolvers, HTTP routes, the SSE hub and
the app/session-token code all ask `access.js`. The web client reads only
the server's verdicts (`my_access`, `can_manage`, `role`) to decide which
controls to show.

**GraphQL subset.** `server/graphql/` is a small, dependency-free engine:
queries and mutations (no subscriptions), variables with defaults,
aliases, fragments (named and inline), `@include`/`@skip`, full validation
before execution, input coercion, null propagation, and limits on query
length (100,000 characters), depth (12) and resolved fields (5,000). Fields carry
`addedIn`/`removedIn` versions, so `/v2/get_schema?version=…&format=sdl`
prints each API version's SDL. Expected failures use error codes
(`NOT_FOUND`, `FORBIDDEN`, `BAD_USER_INPUT`, `VERSION_CONFLICT` with
`extensions.version`, …).

**Bridge protocol `mini-monday/1`.** Apps send
`{ protocol, kind: "request", requestId, method, args }` with
`crypto.randomUUID()` IDs to the exact host origin; the host
(`web/host-bridge.js`) accepts only messages from its iframe's window and
the app origin, answers each request once, and pushes events only for
types the app listens to. Methods: `get`, `set`, `listen`, `unlisten`,
`execute`, `storage`, `api`.

**Server-sent events.** `GET /v2/events?board_id=<id>` streams a board's
change events (`event: change`) after an access check, re-checks access on
every change and ends the stream when access is lost. `GET
/v2/events?stream=me` streams the signed-in user's notification events
(`event: notification`) and ends when the user is deactivated. The web
app refreshes boards, the activity view, form response counts and the
notification bell from these streams.

## Security model

- **Not found, not forbidden.** A resource you cannot access answers
  `NOT_FOUND` with the same message as a missing one, and never appears in
  lists, search, counts, notifications, activity, SSE, form definitions or
  share pickers. `FORBIDDEN` is only for accessible resources where your
  role is too low.
- **Sessions resolve the user on every request**: role changes apply at
  once, and deactivation ends sessions, API tokens and streams
  immediately.
- **Browser sessions** are `HttpOnly; SameSite=Strict` cookies. GraphQL
  with a cookie requires the exact host `Origin`, and so do the other
  cookie-authenticated POST routes (`/auth/demo-login`, `/auth/logout`,
  `/apps/session-token`); public form submissions reject a foreign
  `Origin`.
- **Two origins.** Apps run on a different site (`127.0.0.1` vs
  `localhost`) in a sandboxed iframe and never receive the host cookie.
  App principals get the intersection of the user's and the app's scopes;
  API tokens carry their own scopes (the read-only token cannot write).
- **Content Security Policy** without inline scripts or styles on the host
  (`script-src 'self'; style-src 'self'; frame-ancestors 'none'`), on apps
  (`frame-ancestors <host>`) and on public forms. The UI never builds HTML
  from data (`textContent` and DOM APIs only) and only navigates to
  in-app links from server data.
- **Public forms**: unguessable 16-byte tokens, a timing-safe token
  lookup, an `Origin` check, a honeypot and a per-client rate limit.
- **Secrets**: tokens, app secrets and session IDs are random per run;
  signatures are compared with `crypto.timingSafeEqual`; JWTs accept only
  HS256.

## Testing

From this directory:

```sh
npm test                       # node --test "test/**/*.test.js"
node --test test/permissions.test.js   # one suite
npm run e2e                    # node scripts/e2e-smoke.mjs
node scripts/e2e-roles.mjs     # roles, sharing and privacy in Chromium
```

- The unit and integration suites cover the GraphQL engine, the store and
  its persistence, `access.js` (a role matrix per seeded user), the API and
  HTTP routes (including adversarial privacy suites per user), SSE, the
  CLI, the SDK and host bridge, and the web modules (every GraphQL document
  the UI sends is validated against the real schema).
- `e2e-smoke.mjs` drives the board UI and the Status summary app.
  `e2e-roles.mjs` signs in each demo user in its own browser and covers
  the shell and command palette, notifications arriving live, the share
  dialog with a guest, a private board hidden until shared, a viewer's
  read-only board, a guest's limited view, doc autosave with a forced
  version conflict, notes privacy, the form builder with a public
  submission, admin invites, role changes and deactivation, teams,
  workspaces, and a screenshot tour of every page (light; dark and 360 px
  for the main pages). Both fail on console errors, page errors, CSP
  violations, failed requests and unexpected HTTP errors, and save
  screenshots to `e2e-output/`.
- The browser tests need `playwright` or `playwright-core` and a Chromium;
  without them they print why and exit 0. `MM_E2E_CHROMIUM` names a browser
  executable; `MM_E2E_STEPS=2,5` runs selected steps while developing.
- Lint and format from the repository root:
  `node_modules/.bin/oxlint examples/mini-monday` and
  `node_modules/.bin/oxfmt --check examples/mini-monday`.

## Limitations

- **Demo sign-in.** In demo mode anyone who can reach the server is signed
  in as the admin and can switch to any user. Set `MM_DEMO_LOGIN=0` to turn
  it off; there is then no real sign-in flow at all.
- **One account.** There is a single account (`id "1"`) with no sign-up,
  passwords, invitations by email or multi-tenancy.
- **In-memory sessions.** Browser sessions live in the server process
  (24 h idle timeout) and are lost on restart. The two API tokens are
  created when the store is seeded; there is no UI to create or revoke
  tokens.
- **Containing workspace names.** Content reached only through a grant
  (a guest's Shareable board, a private board in a closed workspace) still
  shows its workspace's name, because `Board.workspace` and
  `Doc.workspace` are non-null; the workspace's description, members and
  other content stay hidden.
- **Scale.** Search, My work, Shared with me and the guest directory scan
  every accessible record per request, and persistence rewrites one JSON
  file. Activity keeps the newest 1,000 entries per board and the inbox
  the newest 200 notifications per user.
- **Editing.** Docs and notes have no real-time co-editing (concurrent
  saves surface as a version conflict), and undo in docs is the browser's
  per-block undo.
- **Not production software.** No TLS termination, backups, audit log
  export, email, accessibility audit beyond the checks above, or security
  review beyond this example's tests.
