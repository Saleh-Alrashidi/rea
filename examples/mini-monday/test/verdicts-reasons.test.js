/**
 * Member and share-candidate verdicts beyond the booleans (SPEC-2 §6,
 * `server/access.js`): the role a grant really gives (`effective_role`),
 * the server's explanation of a row (`reason`, `note`), and their cost:
 * a member list scans the resource's owners once, not once per member and
 * role (so a board with hundreds of owner grants answers in linear time).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CAPPED_NOTE, GRANT_REFUSALS } from "../server/access.js";
import { createStore } from "../server/store.js";
import { seedIds, startTestServers } from "./helpers.js";

const MEMBERS = `query B($b: [ID!]) { boards(ids: $b) { members {
  id role can_remove can_change_role role_options effective_role reason } } }`;
const SHARE = `mutation S($b: ID!, $u: [ID!]!, $r: AccessRole!) { share(
  resource_kind: board, resource_id: $b, subject_kind: user, subject_ids: $u,
  role: $r) { id role can_remove effective_role reason } }`;
const LAST_OWNER =
  "This board needs at least one owner who can manage it. Make someone else an owner first.";

test("a viewer account given Owner: the server explains both rows", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users, boards } = servers.ids;
  const alex = servers.as(users.alex);
  // The invite offers Owner to Jordan (canGrant accepts it), noting the cap.
  const candidates = await alex.data(
    `query C($b: ID!) { share_candidates(resource_kind: board, resource_id: $b,
      query: "jordan") { id eligible role_options note user { role } } }`,
    { b: boards.hiring },
  );
  assert.deepEqual(candidates.share_candidates, [
    {
      id: users.jordan,
      eligible: true,
      role_options: ["owner", "editor", "viewer"],
      note: CAPPED_NOTE,
      user: { role: "viewer" },
    },
  ]);
  const after = await alex.data(SHARE, {
    b: boards.hiring,
    u: [users.jordan],
    r: "owner",
  });
  const byId = Object.fromEntries(after.share.map((m) => [m.id, m]));
  // Jordan's grant reads Owner but gives viewer access, so Alex is still
  // the only owner who can manage the board.
  assert.deepEqual(byId[users.jordan], {
    id: users.jordan,
    role: "owner",
    can_remove: true,
    effective_role: "viewer",
    reason: CAPPED_NOTE,
  });
  assert.deepEqual(byId[users.alex], {
    id: users.alex,
    role: "owner",
    can_remove: false,
    effective_role: "owner",
    reason: LAST_OWNER,
  });
  assert.equal(byId[users.noa].reason, null, "nothing limits an editor");
  // Non-owners get the effective role but no explanations.
  const noa = await servers.as(users.noa).data(MEMBERS, { b: [boards.hiring] });
  const jordan = noa.boards[0].members.find((m) => m.id === users.jordan);
  assert.equal(jordan.effective_role, "viewer");
  assert.equal(jordan.reason, null);
});

test("deactivated members and guests a board does not admit are explained", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { store } = servers;
  const { users, boards } = servers.ids;
  // Noa (an editor of the private Hiring plan) becomes a guest: her grant
  // stays but gives her nothing. Morgan (deactivated) keeps a grant too.
  store.updateUser(users.noa, { role: "guest" }, { actorId: users.alex });
  store.activateUser(users.morgan);
  store.share({
    resourceKind: "board",
    resourceId: boards.hiring,
    subjectKind: "user",
    subjectIds: [users.morgan],
    role: "editor",
    actorId: users.alex,
  });
  store.deactivateUser(users.morgan);
  const alex = servers.as(users.alex);
  const data = await alex.data(MEMBERS, { b: [boards.hiring] });
  const byId = Object.fromEntries(data.boards[0].members.map((m) => [m.id, m]));
  assert.deepEqual(
    [byId[users.noa].effective_role, byId[users.noa].can_remove],
    [null, true],
  );
  assert.equal(
    byId[users.noa].reason,
    `${GRANT_REFUSALS.guest_not_allowed}; this grant gives no access.`,
  );
  assert.deepEqual(
    [byId[users.morgan].effective_role, byId[users.morgan].reason],
    [null, "Deactivated account: it can only be removed."],
  );
});

/** A view of `store` that counts `getUser` calls. */
function countingView(store) {
  const counter = { calls: 0 };
  const getUser = (id) => {
    counter.calls += 1;
    return store.getUser(id);
  };
  return { view: Object.freeze({ ...store, getUser }), counter };
}

test("member verdicts on a board with 300 owner grants scan the owners once", async (t) => {
  const store = await createStore({ file: null });
  const { users } = seedIds(store);
  const owners = Array.from({ length: 300 }, (_, i) =>
    store.createUser({ name: `Owner ${i}`, email: `owner${i}@example.test` }),
  ).map((user) => user.id);
  const board = store.createBoard({
    name: "Big",
    creatorId: users.sam,
    boardKind: "private",
  });
  const grant = (ids, role) =>
    store.share({
      resourceKind: "board",
      resourceId: board.id,
      subjectKind: "user",
      subjectIds: ids,
      role,
      actorId: users.sam,
    });
  grant(owners, "owner");
  // A viewer account and a deactivated user among the owners: neither
  // counts as an effective owner.
  grant([users.jordan], "owner");
  store.activateUser(users.morgan);
  grant([users.morgan], "owner");
  store.deactivateUser(users.morgan);
  const { view, counter } = countingView(store);
  const servers = await startTestServers({ store: view });
  t.after(() => servers.close());
  const sam = servers.as(users.sam);
  counter.calls = 0;
  const data = await sam.data(MEMBERS, { b: [board.id] });
  const members = data.boards[0].members;
  assert.equal(members.length, 303);
  // One owner scan plus a few lookups per member; the old per-member and
  // per-role scans needed about 4 x 300 x 300.
  assert.ok(
    counter.calls < 10 * members.length,
    `${counter.calls} user lookups for ${members.length} members`,
  );
  // With 301 effective owners every grant can go and take any role.
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  for (const id of [users.sam, owners[0], owners[299], users.jordan]) {
    assert.equal(byId[id].can_remove, true, id);
    assert.deepEqual(byId[id].role_options, ["owner", "editor", "viewer"]);
  }
  assert.deepEqual(byId[users.morgan].role_options, []);
  assert.equal(byId[users.jordan].effective_role, "viewer");
  // Down to one effective owner (Sam) besides the capped and the
  // deactivated grants: the verdicts agree with canGrant's last-owner rule.
  for (const id of owners) {
    store.unshare({
      resourceKind: "board",
      resourceId: board.id,
      subjectKind: "user",
      subjectId: id,
      actorId: users.sam,
    });
  }
  const small = await sam.data(MEMBERS, { b: [board.id] });
  const left = Object.fromEntries(
    small.boards[0].members.map((m) => [m.id, m]),
  );
  assert.deepEqual(
    [left[users.sam].can_remove, left[users.sam].role_options],
    [false, ["owner"]],
  );
  assert.equal(left[users.jordan].can_remove, true);
  assert.equal(left[users.morgan].can_remove, true);
});
