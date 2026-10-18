/**
 * Write-side verdicts of SPEC-2 §6: people-column writes on every path
 * (create_item, change_column_value, change_simple_column_value,
 * change_multiple_column_values, form submissions) refuse people who
 * cannot open the board without rewriting existing values, and team
 * management applies capRole (a viewer account that owns a team cannot
 * manage it, and does not count as the team's last owner).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canManageTeam, teamManagers } from "../server/access.js";
import { expectedCode, seedRole, startTestServers } from "./helpers.js";

async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const client = (key) => servers.as(servers.ids.users[key]);
  return { ...servers, client };
}

const PERSON = `mutation P($b: ID!, $i: ID!, $v: String) {
  change_simple_column_value(board_id: $b, item_id: $i, column_id: "person", value: $v) {
    column_values(ids: ["person"]) { text } } }`;
const PERSON_JSON = `mutation P($b: ID!, $i: ID!, $v: String!) {
  change_column_value(board_id: $b, item_id: $i, column_id: "person", value: $v) { id } }`;
const MULTI = `mutation M($b: ID!, $i: ID!, $v: String!) {
  change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`;
const CREATE = `mutation C($b: ID!, $v: String) {
  create_item(board_id: $b, item_name: "Assigned", column_values: $v) { id } }`;
const people = (...ids) =>
  JSON.stringify({
    personsAndTeams: ids.map((id) => ({ id, kind: "person" })),
  });

test("every people-column write refuses users who cannot open the board", async (t) => {
  const { client, ids, store } = await setup(t);
  const { users, boards } = ids;
  const alex = client("alex");
  const board = boards.roadmap;
  const [item] = store.listItems({ boardId: board }).items;
  const before = store.getItem(item.id);
  const count = store.countItems(board);
  // Chris is a guest (Main boards exclude guests), Morgan is deactivated.
  for (const outsider of ["chris", "morgan"]) {
    const id = users[outsider];
    const name = store.getUser(id).name;
    const attempts = [
      [CREATE, { b: board, v: JSON.stringify({ person: id }) }],
      [
        CREATE,
        { b: board, v: JSON.stringify({ person: JSON.parse(people(id)) }) },
      ],
      [PERSON, { b: board, i: item.id, v: `${users.sam},${id}` }],
      [PERSON_JSON, { b: board, i: item.id, v: people(users.sam, id) }],
      [
        MULTI,
        {
          b: board,
          i: item.id,
          v: JSON.stringify({ name: "Renamed", person: id }),
        },
      ],
    ];
    for (const [query, variables] of attempts) {
      const error = await alex.error(query, variables);
      assert.deepEqual(
        [error?.extensions.code, error?.message],
        ["BAD_USER_INPUT", `${name} cannot access this board`],
        `${outsider}: ${query.slice(0, 40)}`,
      );
    }
  }
  assert.equal(store.countItems(board), count, "no item was created");
  assert.deepEqual(
    store.getItem(item.id),
    before,
    "nothing changed, not even the name",
  );
  // Anyone who can open the board, a viewer account included, is fine.
  const ok = await alex.data(PERSON, {
    b: board,
    i: item.id,
    v: `${users.jordan},${users.noa}`,
  });
  assert.deepEqual(ok.change_simple_column_value.column_values, [
    { text: "Jordan Blake, Noa Cohen" },
  ]);
});

test("people writes per role: NOT_FOUND, FORBIDDEN, or refused outsiders for editors", async (t) => {
  const { client, ids, store } = await setup(t);
  // A user every caller may see who cannot open the board.
  const outsiders = {
    roadmap: "chris",
    marketing: "sam",
    hiring: "sam",
    budget: "sam",
  };
  for (const user of ["alex", "sam", "noa", "priya", "jordan", "chris"]) {
    for (const [key, outsider] of Object.entries(outsiders)) {
      const board = ids.boards[key];
      const [item] = store.listItems({ boardId: board }).items;
      const variables = { b: board, i: item.id, v: ids.users[outsider] };
      const error = await client(user).error(PERSON, variables);
      const want = expectedCode(seedRole("board", key, user), "editor");
      assert.equal(
        error?.extensions.code,
        want ?? "BAD_USER_INPUT",
        `${user} ${key}`,
      );
      if (want === null) {
        const name = store.getUser(ids.users[outsider]).name;
        assert.equal(error.message, `${name} cannot access this board`);
      }
    }
  }
});

test("form submissions refuse people who cannot open the board", async (t) => {
  const { ids, store } = await setup(t);
  const form = store.getForm(ids.forms.feature);
  const count = store.countItems(form.board_id);
  const refused = store.submitForm(form.id, {
    name: "From the form",
    values: { person: [ids.users.chris] },
  });
  assert.deepEqual(refused, {
    ok: false,
    reason: "invalid",
    message: "Chris Taylor cannot access this board",
  });
  assert.equal(store.countItems(form.board_id), count);
  assert.equal(store.getForm(form.id).response_count, form.response_count);
  const accepted = store.submitForm(form.id, {
    name: "From the form",
    values: { person: [ids.users.sam] },
  });
  assert.deepEqual(accepted.values.person, [ids.users.sam]);
});

test("existing values are not rewritten when someone loses access", async (t) => {
  const { client, ids, store } = await setup(t);
  const { users, boards } = ids;
  const alex = client("alex");
  const board = boards.hiring;
  const [item] = store.listItems({ boardId: board }).items;
  assert.deepEqual(item.values.person, [users.noa]);
  const unshare = `mutation U($b: ID!, $u: ID!) { unshare(resource_kind: board, resource_id: $b,
    subject_kind: user, subject_id: $u) { id } }`;
  await alex.data(unshare, { b: board, u: users.noa });
  assert.deepEqual(store.getItem(item.id).values.person, [users.noa]);
  // Other columns still change, and keeping Noa in a rewrite is allowed.
  const status = `mutation S($b: ID!, $i: ID!) { change_simple_column_value(board_id: $b,
    item_id: $i, column_id: "status", value: "Done") { id } }`;
  await alex.data(status, { b: board, i: item.id });
  const kept = await alex.data(PERSON, {
    b: board,
    i: item.id,
    v: `${users.noa},${users.alex}`,
  });
  assert.deepEqual(kept.change_simple_column_value.column_values, [
    { text: "Noa Cohen, Alex Rivera" },
  ]);
  const added = await alex.error(PERSON, {
    b: board,
    i: item.id,
    v: `${users.noa},${users.sam}`,
  });
  assert.equal(added.message, "Sam Lee cannot access this board");
  assert.deepEqual(store.getItem(item.id).values.person, [
    users.noa,
    users.alex,
  ]);
});

test("change_multiple_column_values applies all values in one change", async (t) => {
  const { client, ids, store } = await setup(t);
  const board = ids.boards.roadmap;
  const [item] = store.listItems({ boardId: board }).items;
  const events = [];
  const off = store.on((event) => events.push(event));
  t.after(off);
  const revision = store.revision();
  const value = JSON.stringify({
    name: "Both at once",
    status: "Done",
    person: `${ids.users.sam}`,
  });
  await client("alex").data(MULTI, { b: board, i: item.id, v: value });
  assert.equal(store.revision(), revision + 1, "one committed change");
  const next = store.getItem(item.id);
  assert.equal(next.name, "Both at once");
  assert.deepEqual(next.values.person, [ids.users.sam]);
  assert.deepEqual(
    events.map((event) => [event.type, event.column_id ?? null]),
    [
      ["item_renamed", null],
      ["column_value_changed", "status"],
      ["column_value_changed", "person"],
      ["notification_created", null],
    ],
  );
});

test("team management applies capRole: viewer-account owners cannot manage", async (t) => {
  const { client, ids, store } = await setup(t);
  const { users, teams } = ids;
  const priya = client("priya");
  const jordan = client("jordan");
  const team = teams.marketing;
  const add = `mutation A($t: ID!, $u: [ID!]!) { add_team_members(team_id: $t, user_ids: $u,
    as_owner: true) { id } }`;
  await priya.data(add, { t: team, u: [users.jordan] });
  const seen = await jordan.data("{ teams { id my_role can_manage } }");
  const marketing = seen.teams.find((entry) => entry.id === team);
  assert.deepEqual(marketing, {
    id: team,
    my_role: "owner",
    can_manage: false,
  });
  const rename = `mutation R($t: ID!) { update_team(team_id: $t, name: "Mine") { id } }`;
  assert.equal(await jordan.code(rename, { t: team }), "FORBIDDEN");
  const invite = `mutation A($t: ID!, $u: [ID!]!) { add_team_members(team_id: $t, user_ids: $u) { id } }`;
  assert.equal(
    await jordan.code(invite, { t: team, u: [users.noa] }),
    "FORBIDDEN",
  );
  // Jordan does not count as an owner who keeps the team managed.
  const record = store.getTeam(team);
  assert.equal(canManageTeam(store.getUser(users.jordan), record), false);
  assert.deepEqual(teamManagers(store, record), [users.priya]);
  const leave = `mutation L($t: ID!, $u: [ID!]!) { remove_team_members(team_id: $t, user_ids: $u) { id } }`;
  assert.equal(
    await priya.code(leave, { t: team, u: [users.priya] }),
    "BAD_USER_INPUT",
  );
  const demote = `mutation D($t: ID!, $u: ID!) { set_team_member_role(team_id: $t, user_id: $u,
    role: "member") { id } }`;
  assert.equal(
    await priya.code(demote, { t: team, u: users.priya }),
    "BAD_USER_INPUT",
  );
  // Admins still manage, and a member account that owns the team does.
  assert.equal(
    (await client("alex").data(rename, { t: team })).update_team.id,
    team,
  );
  const own = await priya.data("{ teams { id can_manage } }");
  assert.ok(own.teams.find((entry) => entry.id === team).can_manage);
});
