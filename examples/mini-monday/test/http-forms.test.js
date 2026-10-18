/**
 * Public forms over HTTP (SPEC-2 §4): the form page, its definition and
 * submissions end to end (item, response count, activity, owner
 * notification), validation errors per question, the honeypot, the Origin
 * check, access modes (public, account, closed) and the per-IP rate limit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rawRequest, startTestServers } from "./helpers.js";

const JSON_TYPE = "application/json; charset=utf-8";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { store, ids } = servers;
  const token = (key) => store.getForm(ids.forms[key]).token;
  const host = (path, init) => fetch(new URL(path, servers.hostUrl), init);
  const submit = (key, body, headers = {}) =>
    host(`/f/${token(key)}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const definition = (key, headers = {}) =>
    host(`/f/${token(key)}/definition`, { headers });
  return { ...servers, token, host, submit, definition };
}

async function errorCode(response) {
  const body = await response.json();
  return body.errors[0].extensions.code;
}

test("GET /f/<token> serves the form page; unknown tokens get a 404 page", async (t) => {
  const { host, token, appsOrigin, hostUrl } = await setup(t);
  const page = await host(`/f/${token("feature")}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(
    await page.text(),
    /<script type="module" src="\/form-page.js">/,
  );
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, new RegExp(`frame-src ${appsOrigin}`));
  assert.equal(
    page.headers.get("set-cookie"),
    null,
    "form pages sign nobody in",
  );
  // Raw targets: fetch would normalize "%2e%2e" away.
  for (const path of ["/f/AAAAAAAAAAAAAAAAAAAAAA", "/f/short", "/f/%2e%2e"]) {
    const missing = await rawRequest(hostUrl, { path });
    assert.equal(missing.status, 404, path);
    assert.match(missing.body, /form-page\.js/);
  }
  const post = await host(`/f/${token("feature")}`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  const head = await host(`/f/${token("feature")}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  const nested = await rawRequest(hostUrl, {
    path: `/f/${token("feature")}/nope`,
  });
  assert.equal(nested.status, 404);
});

test("the definition lists questions with column types and status options", async (t) => {
  const { definition, store, ids } = await setup(t);
  const response = await definition("feature");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), JSON_TYPE);
  const form = store.getForm(ids.forms.feature);
  assert.deepEqual(await response.json(), {
    title: "Feature request",
    description: form.description,
    accent_color: "#5b5bd6",
    submit_message: "Thanks! The product team reviews every request.",
    questions: [
      {
        id: "q1",
        label: "Request title",
        help: "",
        required: true,
        type: "name",
      },
      { id: "q2", label: "Details", help: "", required: false, type: "text" },
      {
        id: "q3",
        label: "Priority-ish status",
        help: "",
        required: false,
        type: "status",
        options: ["Working on it", "Done", "Stuck"],
      },
      { id: "q4", label: "Needed by", help: "", required: false, type: "date" },
    ],
  });
  const text = JSON.stringify(await (await definition("feature")).json());
  assert.doesNotMatch(
    text,
    /Product roadmap|board/i,
    "nothing about the board",
  );
  const post = await fetch(response.url, { method: "POST" });
  assert.equal(post.status, 405);
});

test("a submission creates an item, counts it, logs activity and notifies owners", async (t) => {
  const { submit, store, ids, as } = await setup(t);
  const before = store.countItems(ids.boards.roadmap);
  const answers = {
    q1: "  Bulk edit  ",
    q2: "Select many rows",
    q3: "stuck",
    q4: "2026-12-01",
  };
  const response = await submit("feature", { answers, website: "" });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: "Thanks! The product team reviews every request.",
  });
  assert.equal(store.countItems(ids.boards.roadmap), before + 1);
  const { items } = store.listItems({
    boardId: ids.boards.roadmap,
    groupId: "next_up",
    limit: 100,
  });
  const item = items.at(-1);
  assert.equal(item.name, "Bulk edit");
  assert.deepEqual(item.values, {
    notes: "Select many rows",
    status: { index: 2 },
    date: "2026-12-01",
  });
  assert.equal(item.creator_id, null);
  assert.equal(store.getForm(ids.forms.feature).response_count, 1);
  const alex = as(ids.users.alex);
  const board = await alex.data(
    `query B($b: ID!) { boards(ids: [$b]) {
    activity_logs(limit: 1) { kind actor { id } actor_label item_name } } }`,
    { b: ids.boards.roadmap },
  );
  assert.deepEqual(board.boards[0].activity_logs[0], {
    kind: "form_submitted",
    actor: null,
    actor_label: "Form: Feature request",
    item_name: "Bulk edit",
  });
  const inbox = await alex.data(
    "{ notifications(limit: 1) { kind text url actor { id } } }",
  );
  assert.deepEqual(inbox.notifications[0], {
    kind: "form_response",
    text: "New response to “Feature request”: “Bulk edit”",
    url: `#/boards/${ids.boards.roadmap}/items/${item.id}`,
    actor: null,
  });
  // Only the required question is needed.
  const minimal = await submit("feature", { answers: { q1: "Dark mode" } });
  assert.equal(minimal.status, 201);
  assert.equal(store.getForm(ids.forms.feature).response_count, 2);
});

test("invalid answers are 400 with a question_id per problem; nothing is created", async (t) => {
  const { submit, store, ids } = await setup(t);
  const before = store.countItems(ids.boards.roadmap);
  const response = await submit("feature", {
    answers: { q1: "   ", q3: "Nope", q4: "2026-02-30", q2: 42 },
  });
  assert.equal(response.status, 400);
  const { errors } = await response.json();
  assert.deepEqual(
    errors.map((error) => [
      error.extensions.code,
      error.extensions.question_id,
    ]),
    [
      ["BAD_USER_INPUT", "q1"],
      ["BAD_USER_INPUT", "q2"],
      ["BAD_USER_INPUT", "q3"],
      ["BAD_USER_INPUT", "q4"],
    ],
  );
  assert.match(errors[0].message, /Request title is required/);
  const long = await submit("feature", { answers: { q1: "x".repeat(256) } });
  assert.equal(long.status, 400);
  for (const body of [{ answers: [] }, { answers: "x" }]) {
    const bad = await submit("feature", body);
    assert.equal(bad.status, 400);
    assert.equal(await errorCode(bad), "BAD_USER_INPUT");
  }
  assert.equal(await errorCode(await submit("feature", "{")), "BAD_REQUEST");
  const text = await submit("feature", "{}", { "Content-Type": "text/plain" });
  assert.equal(text.status, 415);
  assert.equal(store.countItems(ids.boards.roadmap), before);
  assert.equal(store.getForm(ids.forms.feature).response_count, 0);
});

test("a filled honeypot is acknowledged without creating anything", async (t) => {
  const { submit, store, ids } = await setup(t);
  const before = store.countItems(ids.boards.roadmap);
  const response = await submit("feature", {
    answers: { q1: "Spam" },
    website: "https://spam.example",
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).ok, true);
  assert.equal(store.countItems(ids.boards.roadmap), before);
  assert.equal(store.getForm(ids.forms.feature).response_count, 0);
});

test("submissions check Origin when one is sent", async (t) => {
  const { submit, hostOrigin } = await setup(t);
  const answers = { q1: "From elsewhere" };
  const foreign = await submit(
    "feature",
    { answers },
    { Origin: "http://evil.example" },
  );
  assert.equal(foreign.status, 403);
  assert.equal(await errorCode(foreign), "FORBIDDEN");
  const own = await submit("feature", { answers }, { Origin: hostOrigin });
  assert.equal(own.status, 201);
});

test("account forms need an active non-guest session; closed forms are 403", async (t) => {
  const { definition, submit, sessionFor, ids, hostOrigin, as, store } =
    await setup(t);
  const answers = { answers: { q1: "Spring campaign", q2: "2027-03-01" } };
  assert.equal((await definition("campaign")).status, 401);
  assert.equal((await submit("campaign", answers)).status, 401);
  const guest = sessionFor(ids.users.chris);
  assert.equal((await definition("campaign", guest)).status, 401);
  assert.equal((await submit("campaign", answers, guest)).status, 401);
  const viewer = sessionFor(ids.users.jordan);
  const crossSite = { Cookie: viewer.Cookie };
  assert.equal((await definition("campaign", crossSite)).status, 401);
  const fetchSite = { Cookie: viewer.Cookie, "Sec-Fetch-Site": "same-origin" };
  assert.equal((await definition("campaign", fetchSite)).status, 200);
  assert.equal((await definition("campaign", viewer)).status, 200);
  // Jordan cannot see the board, but may answer its account form.
  const sent = await submit("campaign", answers, viewer);
  assert.equal(sent.status, 201);
  assert.equal(store.getForm(ids.forms.campaign).response_count, 1);
  const priya = await as(ids.users.priya).data(
    "{ unread_notifications_count }",
  );
  assert.equal(priya.unread_notifications_count, 1);
  const close = `mutation C($f: ID!) { update_form(form_id: $f, access: closed) { access } }`;
  await as(ids.users.alex).data(close, { f: ids.forms.feature });
  for (const response of [
    await definition("feature"),
    await submit(
      "feature",
      { answers: { q1: "Late" } },
      { Origin: hostOrigin },
    ),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), "FORM_CLOSED");
  }
});

test("regenerating the link retires the old token", async (t) => {
  const { token, host, as, ids } = await setup(t);
  const old = token("feature");
  const regenerate = `mutation R($f: ID!) { regenerate_form_link(form_id: $f) { public_url } }`;
  const data = await as(ids.users.alex).data(regenerate, {
    f: ids.forms.feature,
  });
  const url = data.regenerate_form_link.public_url;
  assert.notEqual(url.split("/f/")[1], old);
  assert.equal((await host(`/f/${old}/definition`)).status, 404);
  assert.equal((await fetch(`${url}/definition`)).status, 200);
});

test("ten submissions per minute per client and form, then 429", async (t) => {
  const { submit, store, ids } = await setup(t);
  for (let n = 1; n <= 10; n += 1) {
    const response = await submit("feature", { answers: { q1: `Idea ${n}` } });
    assert.equal(response.status, 201, `submission ${n}`);
  }
  const limited = await submit("feature", { answers: { q1: "One more" } });
  assert.equal(limited.status, 429);
  assert.equal(await errorCode(limited), "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(store.getForm(ids.forms.feature).response_count, 10);
  // Honeypot hits count too; another form has its own budget.
  const honeypot = await submit("feature", { answers: {}, website: "x" });
  assert.equal(honeypot.status, 429);
  store.updateForm(ids.forms.campaign, { access: "public" });
  const other = await submit("campaign", { answers: { q1: "Separate" } });
  assert.equal(other.status, 201);
});
