/**
 * Forms, Admin, Teams and Workspace pages: the pure logic behind them
 * (question list rules, answer checks, the public-form client's outcome
 * mapping, admin/team/workspace control rules) and, at the production
 * boundary, their GraphQL documents and the public-form client against
 * the real servers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../server/graphql/parse.js";
import * as AD from "../web/ui/admin/admin-data.js";
import { legendRows } from "../web/ui/admin/overview.js";
import { can } from "../web/ui/components/permissions.js";
import * as A from "../web/ui/forms/answers.js";
import * as B from "../web/ui/forms/builder-data.js";
import * as P from "../web/ui/forms/public-api.js";
import * as Q from "../web/ui/forms/questions.js";
import { FORM_MESSAGES } from "../web/ui/forms/renderer.js";
import * as T from "../web/ui/teams/teams-data.js";
import * as W from "../web/ui/workspaces/workspace-data.js";
import { startTestServers } from "./helpers.js";

const STATUS = JSON.stringify({
  labels: { 0: "Working on it", 1: "Done", 2: "Stuck", 5: "" },
});
const column = (id, type, settings = "{}") => ({
  id,
  title: id,
  type,
  settings_str: settings,
});
const COLUMNS = [
  column("name", "name"),
  column("status", "status", STATUS),
  column("person", "people"),
  column("date", "date"),
  column("estimate", "numbers"),
];
const NAME = { id: "q1", column_id: "name", label: "Title", required: false };
const pluck = (list, key = "id") => list.map((entry) => entry[key]);

test("question list: the name question stays first, required and kept", () => {
  for (const bad of ["[", '{"id":"q1"}', '[{"id":"a b","column_id":"x"}]']) {
    assert.equal(Q.parseQuestions(bad).ok, false, bad);
  }
  const parsed = Q.parseQuestions(JSON.stringify([NAME]));
  assert.equal(parsed.value[0].required, true, "name is always required");
  let list = parsed.value;
  const askable = pluck(Q.askableColumns(COLUMNS, list));
  assert.deepEqual(askable, ["status", "date", "estimate"], "no people/name");
  assert.equal(Q.addQuestion(list, COLUMNS[2]).ok, false, "people");
  for (const index of [1, 3, 4]) {
    list = Q.addQuestion(list, COLUMNS[index]).questions;
  }
  const ids = pluck(list);
  assert.equal(new Set(ids).size, 4, "unique IDs");
  assert.ok(
    ids.slice(1).every((id) => /^q_[a-z0-9]{2,26}$/.test(id)),
    ids,
  );
  assert.equal(Q.addQuestion(list, COLUMNS[1]).ok, false, "asked once");
  const counted = ["a", "a", "b"];
  const suffix = () => counted.shift();
  const taken = [{ id: "q1" }, { id: "q_a" }];
  assert.equal(Q.nextQuestionId(taken, suffix), "q_b", "skips taken IDs");

  assert.equal(Q.canMove(list, 1, -1), false, "nothing moves above the name");
  assert.equal(Q.moveQuestion(list, 0, 1), list, "the name never moves");
  list = Q.moveQuestion(list, 3, -1);
  const order = pluck(list, "column_id");
  assert.deepEqual(order, ["name", "status", "estimate", "date"]);
  list = Q.updateQuestion(list, 0, { required: false, label: "Ask" });
  assert.deepEqual([list[0].required, list[0].label], [true, "Ask"]);
  list = Q.updateQuestion(list, 1, { required: true, help: "Pick" });
  assert.equal(list[1].required, true);
  assert.equal(Q.removeQuestion(list, 0), list, "the name is kept");
  assert.equal(Q.removeQuestion(list, 2).length, 3);

  assert.equal(Q.questionsProblem(list), null);
  const blank = Q.updateQuestion(list, 2, { label: "  " });
  assert.equal(Q.questionsProblem(blank).index, 2);
  assert.equal(Q.questionsProblem(list, COLUMNS.slice(0, 2)).field, "column");
  const padded = Q.updateQuestion(list, 1, { label: " Hi " });
  assert.equal(JSON.parse(Q.serializeQuestions(padded))[1].label, "Hi");
});

test("answers: the definition is parsed once, answers checked before sending", () => {
  const question = (id, type, extra = {}) => ({
    id,
    label: id,
    required: false,
    type,
    ...extra,
  });
  const raw = {
    title: "Intake",
    description: "",
    accent_color: "javascript:alert(1)",
    submit_message: "  ",
    questions: [
      question("q1", "name", { required: true, help: null }),
      question("q2", "date"),
      question("q3", "status", { options: ["Done", "", 4, "Done"] }),
      question("q4", "numbers"),
    ],
  };
  const definition = A.normalizeDefinition(raw).value;
  assert.equal(definition.accent_color, "#5b5bd6", "unsafe colors replaced");
  assert.equal(definition.submit_message, A.DEFAULT_SUBMIT_MESSAGE);
  assert.equal(definition.description, null);
  assert.deepEqual(definition.questions[2].options, ["Done"]);
  const twice = { title: "x", questions: [raw.questions[0], raw.questions[0]] };
  for (const bad of [null, [], { title: 1, questions: [] }, twice]) {
    assert.equal(A.normalizeDefinition(bad).ok, false);
  }
  const [name, date, status, count] = definition.questions;
  const cases = [
    [name, "  ", /required/],
    [name, "x".repeat(256), /255/],
    [date, "", null],
    [date, "2026-02-30", /date/],
    [date, "2026-02-28", null],
    [status, "Stuck", /options/],
    [count, "12abc", /number/],
  ];
  for (const [q, value, expected] of cases) {
    const problem = A.answerProblem(q, value);
    if (expected) assert.match(problem, expected);
    else assert.equal(problem, null);
  }
  const values = { q1: " Bulk ", q2: "", q3: "Done", q4: "3.5" };
  assert.deepEqual(A.validateAnswers(definition.questions, values), {
    answers: { q1: "Bulk", q3: "Done", q4: "3.5" },
    errors: {},
  });
  const empty = A.validateAnswers(definition.questions, {});
  assert.deepEqual(Object.keys(empty.errors), ["q1"]);
  const split = A.splitSubmitErrors([
    { message: "Required", extensions: { question_id: "q1" } },
    { message: "Second", extensions: { question_id: "q1" } },
    { message: "General" },
    null,
  ]);
  assert.deepEqual(split, {
    fields: { q1: "Required" },
    messages: ["General", "This answer can’t be used"],
  });
});

test("public form client: tokens and outcomes are read once", () => {
  const token = "A".repeat(22);
  assert.equal(P.tokenFromPath(`/f/${token}/`), token);
  for (const path of ["/f/short", `/f/${token}/definition`, `/x/${token}`]) {
    assert.equal(P.tokenFromPath(path), null, path);
  }
  const closed = { errors: [{ extensions: { code: "FORM_CLOSED" } }] };
  const definitions = [
    [404, undefined, "unknown"],
    [403, closed, "closed"],
    [403, {}, "unavailable"],
    [401, {}, "signin"],
    [200, { nope: true }, "unavailable"],
  ];
  for (const [status, body, reason] of definitions) {
    assert.deepEqual(P.definitionOutcome(status, body), { ok: false, reason });
  }
  const ok = P.submitOutcome(201, { ok: true, message: " Thanks " });
  assert.deepEqual(ok, { ok: true, message: "Thanks" });
  const limited = P.submitOutcome(429, {}, { retryAfter: "17" });
  const expected = { ok: false, reason: "rate_limited", retryAfter: 17 };
  assert.deepEqual(limited, expected);
  assert.equal(P.submitOutcome(429, {}, { retryAfter: "x" }).retryAfter, 60);
  assert.equal(P.submitOutcome(500, undefined).reason, "unavailable");
  const bad = {
    errors: [{ message: "No", extensions: { question_id: "q2" } }],
  };
  assert.deepEqual(P.submitOutcome(400, bad), {
    ok: false,
    reason: "invalid",
    fields: { q2: "No" },
    messages: [],
  });
  const reasons = [
    "unknown",
    "closed",
    "signin",
    "rate_limited",
    "unavailable",
  ];
  for (const reason of reasons) {
    assert.ok(FORM_MESSAGES[reason]?.title, `message for ${reason}`);
  }
});

async function servers(t) {
  const started = await startTestServers();
  t.after(() => started.close());
  const { hostOrigin, store } = started;
  const via =
    (headers = {}) =>
    (path, init) =>
      fetch(new URL(path, hostOrigin), {
        ...init,
        headers: { ...init.headers, Origin: hostOrigin, ...headers },
      });
  const token = (key) => store.getForm(started.ids.forms[key]).token;
  return { ...started, via, token };
}

test("public form client against the real routes", async (t) => {
  const { store, ids, via, token, sessionFor } = await servers(t);
  const anonymous = { fetch: via() };
  const { definition } = await P.fetchDefinition(token("feature"), anonymous);
  const [title, , status, needed] = definition.questions;
  assert.ok(title.required && status.options.length > 0);
  const send = (answers, website = "") =>
    P.submitAnswers(token("feature"), { answers, website }, anonymous);

  const boardId = store.getForm(ids.forms.feature).board_id;
  const before = store.countItems(boardId);
  const invalid = await send({ [needed.id]: "2026-02-31" });
  assert.equal(invalid.reason, "invalid");
  assert.ok(invalid.fields[title.id] && invalid.fields[needed.id]);
  assert.equal((await send({ [title.id]: "Bot" }, "spam.example")).ok, true);
  assert.equal(store.countItems(boardId), before, "the honeypot adds nothing");
  const values = { [title.id]: " Bulk ", [status.id]: status.options[0] };
  const { answers } = A.validateAnswers(definition.questions, values);
  const sent = await send(answers);
  assert.deepEqual(sent, { ok: true, message: definition.submit_message });
  assert.equal(store.countItems(boardId), before + 1);

  const account = token("campaign");
  assert.equal((await P.fetchDefinition(account, anonymous)).reason, "signin");
  const sam = { fetch: via({ Cookie: sessionFor(ids.users.sam).Cookie }) };
  assert.equal((await P.fetchDefinition(account, sam)).ok, true);
  const old = token("feature");
  store.regenerateFormToken(ids.forms.feature);
  assert.equal((await P.fetchDefinition(old, anonymous)).reason, "unknown");
  store.updateForm(ids.forms.feature, { access: "closed" });
  const closed = await P.fetchDefinition(token("feature"), anonymous);
  assert.equal(closed.reason, "closed");
});

test("builder: the preview is the public definition; patches send their fields", async (t) => {
  const { ids, as, via, token } = await servers(t);
  const alex = as(ids.users.alex);
  const formId = ids.forms.feature;
  const located = await alex.data(B.FORM_LOCATE_QUERY);
  const boardId = located.forms.find((f) => String(f.id) === formId).board.id;
  const load = async () => {
    const data = await alex.data(B.FORM_BUILDER_QUERY, { ids: [boardId] });
    const raw = data.boards[0].forms.find((f) => String(f.id) === formId);
    return {
      form: B.normalizeForm(raw).value,
      columns: data.boards[0].columns,
    };
  };
  const { form, columns } = await load();
  const preview = A.normalizeDefinition(Q.definitionFromForm(form, columns));
  const live = await P.fetchDefinition(token("feature"), { fetch: via() });
  assert.deepEqual(preview.value, live.definition, "what respondents get");

  const next = Q.askableColumns(columns, form.questions)[0];
  const { questions } = Q.addQuestion(form.questions, next);
  const patch = { questions, submit_message: " Merci ", target_group_id: null };
  const variables = B.updateVariables(formId, patch);
  const sent = Object.keys(variables).sort();
  assert.deepEqual(sent, ["formId", "message", "questions", "target"]);
  await alex.data(B.FORM_MUTATIONS.update, variables);
  const saved = (await load()).form;
  assert.deepEqual(pluck(saved.questions), pluck(questions), "client IDs kept");
  assert.equal(saved.submit_message, "Merci");
  assert.equal(saved.target_group_id, null);
  assert.equal(saved.title, form.title, "absent fields stay");
  assert.equal(saved.access, form.access);
  const viewer = as(ids.users.jordan);
  const update = { formId, title: "Mine" };
  assert.equal(await viewer.code(B.FORM_MUTATIONS.update, update), "FORBIDDEN");
});

test("admin rules: never deactivate yourself, keep an admin, metadata-only directory", async (t) => {
  const me = { id: "1", role: "admin", status: "active" };
  const member = { id: "2", role: "member", status: "active" };
  const users = [me, member, { id: "3", role: "admin", status: "deactivated" }];
  assert.match(AD.userActions(me, me, users).roleReason, /active admin/);
  assert.match(AD.userActions(me, me, users).statusReason, /yourself/);
  assert.equal(AD.userActions(me, member, users).roleReason, null);
  const other = { id: "4", role: "admin", status: "active" };
  const twoAdmins = [...users, other];
  // The server lets an admin change their own role while another admin stays.
  assert.equal(AD.userActions(me, me, twoAdmins).roleReason, null);
  assert.match(AD.userActions(me, me, twoAdmins).statusReason, /yourself/);
  assert.match(AD.userActions(other, me, users).statusReason, /active admin/);
  assert.match(AD.userActions(member, me, users).statusReason, /Only admins/);
  const counts = AD.parseRoleCounts('{"admin":2,"member":-1,"guest":"x"}');
  assert.deepEqual(counts, { admin: 2, member: 0, viewer: 0, guest: 0 });
  assert.equal(AD.parseRoleCounts("{").admin, 0);
  const people = [{ name: "Sam", title: "Designer" }];
  assert.equal(AD.filterUsers(people, "DESIGN").length, 1);
  for (const row of legendRows().slice(0, 5)) {
    for (const role of AD.ROLE_ORDER) {
      assert.equal(typeof row.cells[role], "boolean", row.label);
    }
  }
  const admin = { id: "9", role: "admin", status: "active" };
  assert.equal(legendRows()[0].cells.admin, can(admin, "manage_users"));
  assert.equal(legendRows()[0].cells.member, false);

  const { ids, as } = await servers(t);
  const directory = await as(ids.users.alex).data(AD.ADMIN_CONTENT_QUERY);
  const rows = AD.contentRows(directory);
  const access = (title) => rows.find((row) => row.title === title).myAccess;
  assert.equal(access("Hiring plan"), "owner");
  assert.equal(access("Marketing launch"), null, "no silent access");
  assert.equal(access("Launch brief"), null);
  const docs = AD.filterContent(rows, { kind: "doc" });
  assert.ok(docs.length > 0 && docs.every((row) => row.kind === "doc"));
  const byOwner = AD.filterContent(rows, { query: "priya" });
  assert.ok(byOwner.length > 0, "owner names match");
  const length = AD.CONTENT_BOARD_LIMIT;
  const full = Array.from({ length }, (_, i) => ({ id: `9${i}` }));
  const partial = AD.contentRows({ ...directory, boards: full });
  const marketing = partial.find((row) => row.title === "Marketing launch");
  assert.equal(marketing.myAccess, undefined, "unknown, not absent");
  const sam = as(ids.users.sam);
  assert.equal(await sam.code(AD.ADMIN_CONTENT_QUERY), "FORBIDDEN");
  const noa = { userId: ids.users.noa };
  assert.equal(await sam.code(AD.ADMIN_MUTATIONS.deactivate, noa), "FORBIDDEN");
});

test("teams: owner rules and one-step role changes", async (t) => {
  const member = (id, name, role, status = "active") => ({
    role,
    user: { id, name, status },
  });
  const team = T.normalizeTeam({
    id: 5,
    name: "Product",
    can_manage: true,
    members: [
      member(3, "Noa", "member"),
      member(1, "Alex", "owner"),
      member(8, "Kai", "owner", "deactivated"),
      member(7, "Morgan", "member", "deactivated"),
    ],
  });
  const [owner, kai, morgan, noa] = team.members;
  assert.deepEqual(pluck(team.members), ["1", "8", "7", "3"], "owners first");
  // A deactivated owner cannot manage the team, so Alex is the last owner.
  assert.match(T.memberActions(team, owner).remove, /active owner/);
  assert.match(T.memberActions(team, owner).demote, /active owner/);
  assert.equal(T.memberActions(team, kai).demote, null);
  assert.equal(T.memberActions(team, noa).promote, null);
  assert.equal(T.memberActions(team, morgan).promote, null);
  const readOnly = { ...team, canManage: false };
  assert.match(T.memberActions(readOnly, noa).remove, /owners and admins/);

  const { as, store, ids: seed } = await servers(t);
  const alex = as(seed.users.alex);
  const teamId = seed.teams.product;
  const { noa: noaId, alex: alexId } = seed.users;
  const roleOf = (id) =>
    store.getTeam(teamId).members.find((entry) => entry.user_id === id)?.role;
  const changes = [];
  const off = store.on((change) => changes.push(change.type));
  t.after(off);
  const set = (userId, role) => ({ teamId, userId, role });
  await alex.data(T.TEAM_MUTATIONS.setRole, set(noaId, "owner"));
  assert.equal(roleOf(noaId), "owner");
  await alex.data(T.TEAM_MUTATIONS.setRole, set(noaId, "member"));
  assert.equal(roleOf(noaId), "member");
  assert.deepEqual(changes, ["team_updated", "team_updated"], "one each");
  const refused = await alex.call(
    T.TEAM_MUTATIONS.setRole,
    set(alexId, "member"),
  );
  assert.ok(refused.body.errors.length > 0, "the last owner stays an owner");
  assert.equal(roleOf(alexId), "owner");
  assert.equal(roleOf(noaId), "member", "nobody was removed");
  const sam = as(seed.users.sam);
  assert.equal(
    await sam.code(T.TEAM_MUTATIONS.remove, { teamId }),
    "FORBIDDEN",
  );
});

test("workspaces: delete only when empty, settings send what changed", async (t) => {
  const { ids, as } = await servers(t);
  const data = await as(ids.users.alex).data(W.WORKSPACE_QUERY);
  const raw = data.workspaces.find((w) => String(w.id) === ids.workspaces.main);
  const main = W.normalizeWorkspace(raw);
  assert.ok(main.canManage && main.forms.every((form) => form.board.name));
  // Alex sees 1 board and 1 doc; the server also counts hidden ones.
  assert.equal(main.canDelete, false);
  assert.equal(W.deleteReason(main), "Delete its 1 board and 1 doc first");
  const looksEmpty = { ...main, boards: [], docs: [] };
  assert.match(W.deleteReason(looksEmpty), /shared only with others/);
  assert.equal(W.deleteReason({ ...looksEmpty, canDelete: true }), null);
  assert.match(W.deleteReason({ ...main, canManage: false }), /owners/);
  // A workspace that looks empty to its owner is not offered for deletion
  // while someone else's private board is in it.
  const sam = as(ids.users.sam);
  const created = await sam.data(
    `mutation { create_workspace(name: "Side project") { id } }`,
  );
  const sideId = String(created.create_workspace.id);
  const side = async () =>
    W.normalizeWorkspace(
      (await sam.data(W.WORKSPACE_QUERY)).workspaces.find(
        (w) => String(w.id) === sideId,
      ),
    );
  assert.equal(W.deleteReason(await side()), null, "empty: deletable");
  await as(ids.users.noa).data(
    `mutation($w: ID!) { create_board(board_name: "Noa's plan",
      board_kind: private, workspace_id: $w) { id } }`,
    { w: sideId },
  );
  const hiding = await side();
  assert.deepEqual([hiding.boards.length, hiding.canDelete], [0, false]);
  assert.match(W.deleteReason(hiding), /shared only with others/);
  const values = {
    name: ` ${main.name} `,
    description: main.description,
    color: main.color.toUpperCase(),
    kind: main.kind,
  };
  assert.deepEqual(W.settingsChanges(main, values), {});
  const edited = { ...values, kind: "closed", color: "#00C875" };
  const changes = W.settingsChanges(main, edited);
  assert.deepEqual(changes, { kind: "closed", color: "#00c875" });
  const listed = (await sam.data(W.WORKSPACE_QUERY)).workspaces;
  assert.equal(
    pluck(listed).map(String).includes(ids.workspaces.leadership),
    false,
  );
  const rename = { id: ids.workspaces.main, name: "Mine" };
  assert.equal(
    await sam.code(W.WORKSPACE_MUTATIONS.update, rename),
    "FORBIDDEN",
  );
  const hidden = { id: ids.workspaces.leadership };
  assert.equal(
    await sam.code(W.WORKSPACE_MUTATIONS.remove, hidden),
    "NOT_FOUND",
  );
});

test("every forms, admin, teams and workspace document validates", async () => {
  const documents = {
    FORM_LOCATE_QUERY: B.FORM_LOCATE_QUERY,
    FORM_BUILDER_QUERY: B.FORM_BUILDER_QUERY,
    FORM_COUNT_QUERY: B.FORM_COUNT_QUERY,
    ...B.FORM_MUTATIONS,
    ADMIN_USERS_QUERY: AD.ADMIN_USERS_QUERY,
    ADMIN_CONTENT_QUERY: AD.ADMIN_CONTENT_QUERY,
    ...AD.ADMIN_MUTATIONS,
    TEAMS_QUERY: T.TEAMS_QUERY,
    ...T.TEAM_MUTATIONS,
    WORKSPACE_QUERY: W.WORKSPACE_QUERY,
    ...W.WORKSPACE_MUTATIONS,
  };
  const { createSchema } = await import("../server/schema.js");
  const { execute } = await import("../server/graphql/execute.js");
  const { createStore } = await import("../server/store.js");
  const { ALL_SCOPES } = await import("../server/auth.js");
  const context = {
    store: await createStore({ file: null }),
    principal: { kind: "session", userId: "1", scopes: new Set(ALL_SCOPES) },
    hostOrigin: "http://localhost:4100",
    appsOrigin: "http://127.0.0.1:4101",
    apiVersion: "2026-01",
    log: { error() {} },
    requireScope() {},
  };
  const schema = createSchema();
  const codes = new Set(["GRAPHQL_VALIDATION_FAILED", "GRAPHQL_PARSE_FAILED"]);
  for (const [name, source] of Object.entries(documents)) {
    // Empty variables: validation runs first, then required variables fail
    // coercion before any resolver runs.
    const document = parse(source);
    const result = await execute({
      schema,
      document,
      variables: {},
      apiVersion: "2026-01",
      context,
    });
    const invalid = (result.errors ?? []).filter((e) => codes.has(e.code));
    assert.deepEqual(pluck(invalid, "message"), [], name);
  }
});
