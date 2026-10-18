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

The contracts are [`SPEC.md`](SPEC.md) (part 1: engine, API, platform),
[`SPEC-2.md`](SPEC-2.md) (part 2: the full workspace) and
[`SPEC-3.md`](SPEC-3.md) (part 3: private hosted deployment). This README
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

Configuration (environment variables; setting `PORT` switches to hosted
mode instead, see [Deploy privately on CranL](#deploy-privately-on-cranl)):

| Variable         | Default                        | Meaning                                           |
| ---------------- | ------------------------------ | ------------------------------------------------- |
| `MM_HOST_PORT`   | `4100`                         | Host (workspace app + API) port; `0` = free       |
| `MM_APPS_PORT`   | `4101`                         | Apps (iframe apps + SDK) port                     |
| `MM_BIND`        | `127.0.0.1`                    | Listen address for both servers                   |
| `MM_DATA_FILE`   | `.data/mini-monday.json`       | JSON persistence; `:memory:` disables it          |
| `MM_HOST_ORIGIN` | `http://localhost:<host port>` | Public host origin                                |
| `MM_APPS_ORIGIN` | `http://127.0.0.1:<apps port>` | Public apps origin (a different site on purpose)  |
| `MM_DEMO_LOGIN`  | on                             | `0` turns off auto sign-in and the user switcher  |
| `MM_TRUST_PROXY` | `0`                            | `1` takes client IPs (rate limits) from the proxy |

The data file format is `mini-monday-store/3`. A part-1 file is refused
with a message; move it away and the server reseeds. A
`mini-monday-store/2` file (which wrote people's names into notification
and activity texts) is upgraded once at start-up: names become mentions
rendered per viewer, a name that matches no single user becomes "Someone",
the old file is kept as `<file>.v2.bak` (private, like the data file) and
the result is saved as `/3`, which older versions refuse as unsupported.

## Deploy privately on CranL

[CranL](https://cranl.com/) builds an app from a GitHub repository
(Railpack or a Dockerfile), runs it on one port, gives it a
`https://….cranl.net` address and terminates HTTPS at its proxy. Setting
`PORT` switches Worklane to **hosted mode** (SPEC-3): one listener, a
password-protected **site gate** in front of everything and proxy-aware
rate limits. Without the site password, only the form links you make
public can be used.

1. **Give Worklane its own private repository.** CranL builds from the
   repository root (Railpack reads `package.json` there, and a Dockerfile
   must sit there), so this directory has to be the root. From a clone of
   this repository, push its history to a new private repository:

   ```sh
   gh repo create <you>/worklane --private   # or create it on github.com
   git subtree split --prefix examples/mini-monday -b worklane
   git push git@github.com:<you>/worklane.git worklane:main
   ```

2. **Connect GitHub in CranL** and allow it to read that repository.
3. **Create a project, then an app** in it from the repository and branch
   (`main`). Build type **Railpack** (auto-detects Node.js and runs
   `npm start`, which is `node server/main.js`) or **Dockerfile** (this
   directory's `Dockerfile`: `node:22-alpine`, non-root `node` user, port
   8080).
4. **Set the app's port to `8080`** and its environment variables:

   | Variable           | Value                                                                                                 |
   | ------------------ | ----------------------------------------------------------------------------------------------------- |
   | `PORT`             | `8080`, the app's port (the Dockerfile sets it too; a port the platform provides wins)                |
   | `MM_HOST_ORIGIN`   | The app's address, e.g. `https://worklane.cranl.net`: exactly the origin, no path or trailing slash   |
   | `MM_SITE_PASSWORD` | A long random password (at least 12 characters) for everyone who may use the site                     |
   | `MM_DATA_FILE`     | Optional: a file on a mounted volume, e.g. `/data/worklane.json` (see Data below)                     |
   | `MM_APPS_ORIGIN`   | Optional: a second domain for iframe apps (see Apps below)                                            |
   | `MM_TRUST_PROXY`   | Leave unset (hosted default `1`): the proxy appends the client's IP as the last `X-Forwarded-For` hop |
   | `MM_DEMO_LOGIN`    | Optional: `0` hides the demo user switcher                                                            |

5. **Health check path: `/healthz`** (200 `ok`, no data, no sign-in).
6. **Deploy and open the address.** Every page asks for the site password
   first; signing in opens the workspace as Alex Rivera, the admin. The
   app's log (visible only to the project's members) shows the address,
   whether the gate and apps are on, the data file and the two API tokens.
   It never shows the password.

A missing or invalid setting stops the server before it listens, with one
line per problem in the log and exit code 1:

```
mini-monday: MM_HOST_ORIGIN is required in hosted mode: the site's public origin, like https://worklane.cranl.net
mini-monday: MM_SITE_PASSWORD must be at least 12 characters long
```

**What is reachable without the password.** `/signin` with its
stylesheets and script, `/healthz`, `/robots.txt` (which disallows
everything), and the forms you set to **Public**: `/f/<token>` with the
files the form page loads. **Signed-in members** forms still need a
session and closed forms stay closed. Calls to `POST /v2` and
`GET /v2/events` with a valid API token work without the site session, so
keep the tokens secret. Everything else redirects page loads to
`/signin?next=<path>` (only same-site paths are followed afterwards) and
answers other requests with 401 `SITE_LOCKED`; the boards app then opens
the sign-in page and comes back to where it was. Every response carries
`X-Robots-Tag: noindex, nofollow` and, for an `https:` address,
`Strict-Transport-Security`; cookies are `Secure`.

**Sign-in.** The password is compared in constant time. A wrong one is
answered after a fixed ~300 ms delay, and 5 failures from one client IP
within 15 minutes refuse that IP for the rest of the window (429 with
`Retry-After`); successful sign-ins do not count. A site session ends
after 12 hours without use or at **Sign out**, after which the site shows
`/signin` again. Demo user switching keeps you signed in.

**Data.** The default data file lives on the container's disk, which may
not survive a redeploy or restart: the demo workspace is then seeded again
with new API tokens. To keep data, mount a volume (where your plan has
them), make it writable by the app's user (`node`, uid 1000, with the
Dockerfile) and set `MM_DATA_FILE` to a file on it.

**Apps.** Without `MM_APPS_ORIGIN` the app platform is off: boards show no
app views, `POST /apps/session-token` answers 404 and the page allows no
frames. To turn it on, point a second domain (another host name than
`MM_HOST_ORIGIN`, so apps never receive the site's cookie) at the same app
and set `MM_APPS_ORIGIN` to its origin; requests for that host reach the
apps handler on the same port.

**Try hosted mode locally** (`http:` is accepted for loopback hosts only):

```sh
PORT=8080 MM_HOST_ORIGIN=http://localhost:8080 \
  MM_SITE_PASSWORD='a long local password' npm start
```

`MM_PUBLIC_DEMO=1` instead of a password runs a deliberately public demo
(no gate, demo sign-in as in local mode); the server prints a loud warning.

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
| Implicit access to Main boards                          | owner        | editor       | viewer         | —            |
| Implicit access to workspace docs                       | editor       | editor       | viewer         | —            |
| Can be added to Private boards                          | ✓            | ✓            | ✓              |              |
| Can be added to Shareable boards, docs and notes        | ✓            | ✓            | ✓              | ✓            |
| Edit                                                    | per resource | per resource | never (viewer) | per resource |

Admins have no silent access to private content: the content directory
shows titles and owners only, and **Take ownership** adds the admin as an
owner in plain sight. The resource's owners get a notification that stays
in their inbox even if the admin removes themselves again, and boards also
log the takeover in the activity. On Main boards admins are implicit owners
(`server/access.js`, SPEC-2 §1.2); a kind change that would remove their
own access is refused until they add themselves as an owner.

### Sharing

One share dialog serves workspaces, boards, docs and notes. It shows the
visibility setting (board kind Main / Private / Shareable; doc Workspace /
Private; workspace Open / Closed; notes stay private until shared), the
current members with role menus, and a people-and-teams picker that
explains why someone is not eligible (guests only on Shareable boards,
docs and notes; deactivated users never) and lists those who can be added
first. The server computes every one of these verdicts and explanations
(`share_candidates` with `eligible`, `reason`, `role_options` and a `note`
such as "Viewer accounts can only view, whatever role they get.";
`Member.can_remove`, `Member.can_change_role`, `Member.role_options`, the
role the grant really gives in `Member.effective_role` and the row's
explanation in `Member.reason`), so the dialog never re-derives a rule or
writes its own reason. A role changes only when picked from its menu
(making someone an owner asks first); after any change focus returns to
the control that made it and a status line announces the result. In the
picker, Enter pressed before a search answers adds the first eligible
match of that search, never a row of the previous one. The last owner
cannot be removed or demoted; only owner
grants that give owner access count (not those of deactivated users,
viewer accounts or guests on boards that exclude them), and teams likewise
keep an owner who can manage them (a viewer account that owns a team
cannot manage it). Turning a Shareable board into
Main or Private asks first, then removes its guests. Granting a team covers
its current and future members, and the share notification names the role
each person really gets (a viewer account is told "viewer"). Deleting a
team logs the removal on every board it was a member of.

### Workspaces, boards and the inbox

- **Shell**: a top bar (search, notifications bell with live unread count,
  theme toggle, account menu) and a sidebar (Home, My work, Shared with me,
  Notes, the current workspace's boards, docs and forms, Teams, Admin).
  Ctrl/⌘+K opens the command palette over `search` plus quick actions.
- **Home**: greeting, quick-create tiles, next due items, unread
  notifications, recent boards and docs, and what was shared with you.
- **My work**: items assigned to you, grouped by Overdue / This week /
  Later / No date / Done (finished items are never overdue), with inline
  status changes.
- **Boards**: the part-1 table, kanban and app views, plus a kind badge,
  member avatars, Share, an **Activity** timeline (who changed what, with
  from → to chips) and a **Forms** view. Viewers get read-only cells and a
  "View only" badge; controls you cannot use are disabled with a reason.
- **People columns** accept only people who can open the board
  (`Board.assignable_users` lists them); someone who later loses access
  stays assigned until removed. A toggle the server refuses is undone in
  the picker, so later toggles do not resend it.
- **Live updates paused**: when a live-update stream is refused (too many
  open streams) or ends for good, a banner under the top bar (in the page
  flow and the Tab order, so it covers nothing) offers "Reload".
- **Notifications** for shares, assignments, updates on your items, form
  responses on your boards and role changes arrive live over SSE.

### Docs and notes

- **Docs**: block documents (headings, paragraphs, lists, to-dos, quotes,
  code, callouts, dividers). Each block is a `contenteditable` element
  holding plain text; Enter splits, Backspace merges, "/" opens the block
  menu (type to filter by name or by the shortcut it shows, such as `>` or
  `1.`; Escape or Tab gives the block back what was typed), Markdown-style
  shortcuts work. Changes autosave after 800 ms with
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
session token with its own backend. Apps act as their user: reading app
storage needs viewer access to the install's board and writing it needs
editor, so view-only users cannot change the shared note. Each storage
segment holds at most 1,000 live keys.

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
  main.js          env → config (local or hosted) → store → startServers
                   → banner with tokens
  http.js          host and apps handlers, their listeners (two locally,
                   one routed by Host when hosted), routes, headers
  routes/          graphql.js static.js forms.js auth.js apps.js common.js
                   gate.js (site gate, /signin) platform.js (/healthz,
                   /robots.txt) rate-limit.js (client IP, limiter)
  access.js        the only interpreter of roles, grants and teams
  store.js         createStore(): records, change events, persistence
  store/           people workspaces boards items docs notes forms grants
                   activity storage seed seed-data persistence
  schema.js        merges server/schema/*.js into one buildSchema() call
  schema/          common people workspaces boards items sharing docs notes
                   forms inbox search storage
  graphql/         parse.js schema.js validate.js execute.js errors.js
                   (the engine)
  auth.js          API tokens, browser sessions, app principals, JWTs
  events.js        server-sent events hub
  column-values.js parse and format column values
  input.js         limits, ID and color formats, the name rule
  versions.js      API version table
web/               the host app (plain ES modules, no build)
  main.js router.js api.js dom.js host-bridge.js form-page.js
  signin.html signin.js  the site gate's sign-in page
  pages/           one module per route (mount(container, ctx, params))
  ui/              components/ shell/ board/ docs/ notes/ forms/ admin/
                   teams/ workspaces/
  styles/          design tokens, base, components and feature sheets
apps/status-summary/  example iframe app
sdk/               the iframe-app SDK (served from the apps origin)
cli/               the mm CLI
scripts/           browser tests (e2e-smoke, e2e-roles, e2e-hosted) and
                   their harness
test/              node:test suites
```

**One owner for access.** `server/access.js` is the single module that
interprets account roles, user status, grants and team membership
(`workspaceAccess`, `boardAccess`, `docAccess`, `noteAccess`,
`formAccess`, `installAccess`, `can`, `canGrant`, `notificationVisible`,
`canManageTeam`, `canBeAssigned`, the member and share verdicts
`memberVerdicts` and `shareVerdict` with their explanations, and the
people directory:
`visibleUserIds`, `teamVisible`, `directoryName`). The store records facts
and keeps data rules (it asks `access.js` too); resolvers, HTTP routes, the
SSE hub and the app/session-token code all ask `access.js`. The web client
reads only the server's verdicts (`my_access`, `can_manage`, `can_open`,
`can_delete`, `role`, `me.capabilities`, `Board.assignable_users`, the
Member verdicts and `share_candidates`) to decide which controls to show
and whom to offer, and shows the server's reasons as they come. A
resource's effective owners are computed once per request
(`effectiveOwnerIds`), so member verdicts stay linear in the number of
members.

**Directory privacy.** A guest's directory is themselves, the members of
what is shared with them (user grants, the members of team grants, note
owners) and their teams' members; everyone else sees every user. People
outside the directory are absent from user lists, search, member lists,
team members and `assignable_users`, resolve to `null` in User-valued
fields (authors, actors, owners), and read "Someone" in texts. Texts that
name people (notification texts, activity `from_text`/`to_text`) are
stored as rich text with user IDs (`server/store/activity.js`) and
rendered per viewer at read time, over GraphQL and SSE alike; activity
actors are stored by ID. Data files from before this rule are converted
when loaded (`server/store/legacy-texts.js`, see Quick start). A people column shows hidden people as
"Someone" and leaves them out of `value`, and a guest rewriting the cell
keeps them assigned.

**Input rules.** `server/input.js` owns the limits (names 1–255,
descriptions ≤ 2,000, …), the record ID and `#rrggbb` color formats and the
name rule; the store, the GraphQL schema, column values and the HTTP
routes import them instead of keeping their own copies.

**GraphQL subset.** `server/graphql/` is a small, dependency-free engine:
queries and mutations (no subscriptions), variables with defaults,
aliases, fragments (named and inline), `@include`/`@skip`, full validation
before execution, input coercion, null propagation, and limits on query
length (100,000 characters), depth (12) and resolved fields (5,000).
Validation and argument coercion cost no more than the document's size
however often a fragment is spread, and fields sharing a response key
must have mergeable sub-selections. Lists that scan everything a caller
can access (search, My work, Shared with me, the directory) run once per
request however often a query aliases them. Fields carry
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
every change that can move it and ends the stream when access is lost.
`GET /v2/events?stream=me` streams the signed-in user's notification
events (`event: notification`, with the notification's `kind`, `url` and
`text` rendered for that user) and ends when the user is deactivated. A
stream opened with a browser session ends with that session (sign-out,
user switching, idle expiry at the next delivery or heartbeat). Streams
are indexed by board, user and session: a board change reaches only its
board's streams, with one access check per user; a user change only that
user's streams; a workspace change the streams of its boards; a team
change every board stream; doc and note changes none, so streams on
other boards cost a change nothing. The hub accepts
1,000 streams, at most 32 per user (more → 429). The web app refreshes
boards, the activity view, form response counts and the notification bell
from these streams.

## Security model

- **Not found, not forbidden.** A resource you cannot access answers
  `NOT_FOUND` with the same message as a missing one, and never appears in
  lists, search, counts, notifications, activity, SSE, form definitions or
  share pickers. `FORBIDDEN` is only for accessible resources where your
  role is too low.
- **Guests see their directory only**: people outside it never appear in
  lists or User fields and are named "Someone" in every text.
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
- **Private hosting** (SPEC-3, `server/routes/gate.js`): with a site
  password every host request needs a site session except the sign-in
  page, health and robots, public forms and API-token calls; see
  [Deploy privately on CranL](#deploy-privately-on-cranl).
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
node scripts/e2e-hosted.mjs    # hosted mode behind the site gate
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
  for the main pages). Its interaction steps (`e2e-roles-ux.mjs`,
  `e2e-roles-ux2.mjs`) cover keyboard focus (item card, drawer, popovers,
  status picker, skip link), unsaved-work guards, doc undo, number-cell
  typos, dark-mode contrast and live access changes; `e2e-roles-verdicts.mjs`
  and `e2e-roles-ux3.mjs` cover the server's verdicts and explanations in
  the share dialog and people pickers, refused assignees, the share dialog
  by keyboard and at 360 px, the "/" menu next to its block and the "Live
  updates paused" banner. Both fail on console
  errors, page errors, CSP violations, failed requests and unexpected HTTP
  errors, and save screenshots to `e2e-output/`.
- The `test/hosted-*.test.js` suites cover hosted mode: configuration
  checks, the gate for every route class, `next` sanitization, the
  password comparison and delay, rate limits behind a proxy, session
  expiry and sign-out, Host routing with and without an apps origin, and
  the headers. `e2e-hosted.mjs` starts hosted mode on a free `PORT` with a
  password and drives the redirect to `/signin`, a wrong password, signing
  in to the requested page, a board, demo switching, a public form signed
  out and signing out.
- The browser tests need `playwright` or `playwright-core` and a Chromium;
  without them they print why and exit 0. `MM_E2E_CHROMIUM` names a browser
  executable; `MM_E2E_STEPS=2,5` runs selected steps while developing.
- Lint and format from the repository root:
  `node_modules/.bin/oxlint examples/mini-monday` and
  `node_modules/.bin/oxfmt --check examples/mini-monday`.

## Limitations

- **Demo sign-in.** In local demo mode anyone who can reach the server is
  signed in as the admin and can switch to any user. Set `MM_DEMO_LOGIN=0`
  to turn it off; there is then no real sign-in flow at all.
- **One site password.** Hosted mode's gate has one shared password that
  signs in as the admin (user 1); there are no per-person accounts or
  passwords. Per-IP limits treat people behind one address as one client.
  `mm schema` reads `/v2/get_schema` without a token, which the gate
  refuses: run it against a local server.
- **One account.** There is a single account (`id "1"`) with no sign-up,
  passwords, invitations by email or multi-tenancy.
- **In-memory sessions.** Browser sessions live in the server process
  (24 h idle timeout, 12 h behind the site gate) and are lost on restart,
  like the sign-in failure counts. The two API tokens are
  created when the store is seeded; there is no UI to create or revoke
  tokens.
- **Containing workspace names.** Content reached only through a grant
  (a guest's Shareable board, a private board in a closed workspace) still
  shows its workspace's name, because `Board.workspace` and
  `Doc.workspace` are non-null; the workspace's description, members and
  other content stay hidden.
- **Scale.** Search, My work, Shared with me and the guest directory scan
  every accessible record once per request, and persistence rewrites one
  JSON file (temp files of interrupted saves are removed at start-up).
  Activity keeps the newest 1,000 entries per board and the inbox the
  newest 200 notifications per user. There is no request rate limit on
  `/v2`; each request's work is bounded by the query limits above.
- **Text limits count UTF-16 code units**, like the browser's
  `maxlength`: a name of 255 characters fits, but one made of emoji or
  other characters outside the Basic Multilingual Plane fits only half as
  many.
- **Deleting a workspace** needs it to be empty, including boards and
  docs that others keep private in it; `can_delete` says so up front, and
  only an admin can find such content (content directory, Take
  ownership).
- **Editing.** Docs and notes have no real-time co-editing (concurrent
  saves surface as a version conflict). Undo in docs is the editor's own
  doc-wide history (typing and structural edits, up to 200 steps), cleared
  when the doc is reloaded.
- **Not production software.** No TLS termination (hosted mode relies on
  the platform's proxy), backups, audit log
  export, email, accessibility audit beyond the checks above, or security
  review beyond this example's tests.
