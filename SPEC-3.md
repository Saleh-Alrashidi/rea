# Worklane specification, part 3: private hosted deployment

Parts 1 and 2 (`SPEC.md`, `SPEC-2.md`) describe the product. Part 3 makes it
deployable on a single-port platform such as [CranL](https://cranl.com/)
(Railpack build, `npm start`, platform-provided `PORT`, HTTPS terminated by a
proxy) **without exposing it publicly**. Local development keeps working exactly
as before when none of the new variables are set.

## 1. Modes

| Mode   | Selected when     | Behavior                                                                                      |
| ------ | ----------------- | --------------------------------------------------------------------------------------------- |
| local  | `PORT` is not set | Unchanged: two listeners (`MM_HOST_PORT`, `MM_APPS_PORT`), bind `127.0.0.1`, demo auto-login. |
| hosted | `PORT` is set     | One listener on `PORT`, bind `0.0.0.0` (`MM_BIND` overrides), private site gate, proxy-aware. |

Hosted-mode configuration (all read once at startup in `server/main.js`;
invalid or missing required values print one clear error per problem and exit
with code 1, never start half-configured):

| Variable           | Required                       | Meaning                                                                                                                                                                                                |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`             | yes                            | Listening port (platform provided).                                                                                                                                                                    |
| `MM_HOST_ORIGIN`   | yes                            | Public origin of the site, e.g. `https://worklane.cranl.net` (must be an origin: scheme + host [+ port], `https:` unless the host is loopback).                                                        |
| `MM_SITE_PASSWORD` | yes, unless `MM_PUBLIC_DEMO=1` | Shared password that unlocks the site. At least 12 characters.                                                                                                                                         |
| `MM_APPS_ORIGIN`   | no                             | Second public origin (another domain pointing at the same service) for iframe apps. Must differ in host from `MM_HOST_ORIGIN`. Unset → the app platform is disabled (see §3).                          |
| `MM_DATA_FILE`     | no                             | As before. Document that platform disks may be ephemeral; mount a volume for persistence.                                                                                                              |
| `MM_TRUST_PROXY`   | no                             | Default `1` in hosted mode, `0` locally. When `1`, the client IP for rate limits is the **last** entry of `X-Forwarded-For` (the hop added by the platform proxy), falling back to the socket address. |
| `MM_PUBLIC_DEMO`   | no                             | `1` disables the site gate on purpose (public demo). Startup prints a loud warning.                                                                                                                    |
| `MM_DEMO_LOGIN`    | no                             | As before (user switcher); still available behind the gate.                                                                                                                                            |

## 2. The site gate (`server/routes/gate.js`, owned there)

When `MM_SITE_PASSWORD` is set, every host request needs a **site session**
except:

- `GET /signin`, `POST /signin`, `GET /healthz`;
- the static assets the sign-in page needs (only the stylesheets it links and
  `signin.js`);
- public forms: `GET /f/<token>`, `GET /f/<token>/definition`,
  `POST /f/<token>/submit` and the assets `form.html` needs, keeping each form's
  own `public`/`account`/`closed` rules (an `account` form still needs a signed-in
  user);
- `POST /v2` and `GET /v2/events` with a valid API token in `Authorization`
  (tokens are credentials; cookie-based calls still need the gate).

Everything else redirects to `/signin?next=<path>` for `GET` HTML navigations
and answers `401 { errors: [{ message, extensions: { code: "SITE_LOCKED" } }] }`
for API/XHR requests. `next` accepts only a same-site path starting with a
single `/` (no `//`, no scheme, no backslashes); anything else becomes `/`.

Sign-in:

- `GET /signin` serves `web/signin.html` (CSP like the host page, no inline
  script/style) with a password field, the Worklane wordmark, and an error area.
- `POST /signin` takes JSON `{ password, next }` with `Content-Type:
  application/json` and an `Origin` equal to the host origin. The password is
  compared in constant time (compare SHA-256 digests with `timingSafeEqual`).
  Success → 200 `{ next }`, a new browser session for user `1` (the seed admin),
  and the session cookie. Failure → 401 `SITE_PASSWORD_INVALID` after a fixed
  ~300 ms delay.
- Rate limit: 5 failed attempts per client IP per 15 minutes → 429
  `RATE_LIMITED` with `Retry-After`; successful sign-ins do not count.
- `POST /auth/logout` ends the session and the next navigation shows `/signin`
  again (no auto-login in hosted mode).
- Site sessions expire after 12 hours of inactivity (sliding) and immediately
  on logout; demo user switching keeps the gate (it rotates the session but stays
  signed in).

`GET /healthz` → 200 `text/plain` `ok` with no data, for platform health checks.

## 3. Single listener and the app platform

- Hosted mode creates one HTTP server. Requests are routed by the `Host` header:
  the `MM_APPS_ORIGIN` host goes to the existing apps handler, every other host
  to the host handler. Unknown hosts are not rejected (platform proxies may
  rewrite), but CSP, cookies and Origin checks always use the configured
  origins.
- Without `MM_APPS_ORIGIN`, the app platform is disabled: board views of type
  `app` are omitted from `Board.views` (and `BoardView.app_url` is never
  returned), `POST /apps/session-token` returns 404, and the host CSP drops
  `frame-src`. The UI simply shows no app tabs. `README.md` explains how to add a
  second domain to enable apps.
- Local mode keeps its two listeners and behavior.

## 4. Security headers in hosted mode

- Cookies get `Secure` when the host origin is `https:` (all modes).
- `Strict-Transport-Security: max-age=31536000` when the host origin is
  `https:`.
- `X-Robots-Tag: noindex, nofollow` on every response; `/robots.txt` answers
  `User-agent: *` / `Disallow: /`.
- Existing CSP, `nosniff`, `Referrer-Policy`, COOP stay.

## 5. Startup output

Hosted mode prints the public URL, whether the gate is on, whether apps are
enabled, the data file location (or `:memory:`), and the two API tokens (the
platform's logs are visible only to the project's members). It never prints the
site password.

## 6. Packaging

- `package.json` `start` stays `node server/main.js` (Railpack runs it) — not
  editable by builders; it is already correct.
- `Dockerfile` (optional build type): `node:22-alpine`, non-root `node` user,
  copies the app without tests/e2e output, `ENV NODE_ENV=production`,
  `EXPOSE 8080`, `CMD ["node", "server/main.js"]`; plus `.dockerignore`
  (`.data`, `e2e-output`, `node_modules`, `test`, `scripts`, `*.md` except
  `README.md`).
- `README.md` gets a "Deploy privately on CranL" section: connect GitHub in
  CranL, create a project and an app from the private repository and branch,
  build type Railpack (auto) or Dockerfile, set `MM_HOST_ORIGIN` to the app's
  `https://…cranl.net` URL and `MM_SITE_PASSWORD`, optional `MM_APPS_ORIGIN`
  (second domain), optional volume for `MM_DATA_FILE`, health check path
  `/healthz`, and what is public (only form links you choose to make public).
