/**
 * Adversarial privacy suite over HTTP (SPEC-2 §1.2, §3): every seeded user
 * (admin Alex, members Sam/Noa/Priya, viewer Jordan, guest Chris,
 * deactivated Morgan) reads, enumerates and mutates every resource kind,
 * and each answer must be exactly the spec's: accessible records only,
 * NOT_FOUND (indistinguishable from a missing record) without access,
 * FORBIDDEN with access but too low a role.
 *
 * Enumeration through search, shared_with_me, my_work, the directory and
 * deactivation are in api-privacy.test.js; SSE, app storage, session
 * tokens and public forms per user in http-privacy.test.js; sharing flows
 * in api-sharing.test.js.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SEED_USERS,
  expectedCode,
  seedRole,
  seedRoleMap,
  startTestServers,
} from "./helpers.js";

const USERS = SEED_USERS.filter((user) => user !== "morgan");
async function setup(t) {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const clients = Object.fromEntries(
    USERS.map((user) => [user, servers.as(servers.ids.users[user])]),
  );
  return { ...servers, clients };
}

const rolesOf = (records) =>
  Object.fromEntries(records.map((record) => [record.id, record.my_access]));

test("every user lists exactly the workspaces, boards, docs, notes and forms granted", async (t) => {
  const { clients, ids, store } = await setup(t);
  const query = `{ workspaces { id my_access } boards(limit: 100) { id my_access }
    docs { id my_access } notes { id my_access } forms { id board { id } } }`;
  for (const user of USERS) {
    const data = await clients[user].data(query);
    for (const [kind, list] of [
      ["workspace", data.workspaces],
      ["board", data.boards],
      ["doc", data.docs],
      ["note", data.notes],
    ]) {
      const expected = seedRoleMap(ids, kind, user);
      assert.deepEqual(rolesOf(list), expected, `${user} ${kind}s`);
    }
    const boards = Object.keys(seedRoleMap(ids, "board", user));
    const forms = store
      .listForms()
      .filter((form) => boards.includes(form.board_id))
      .map((form) => form.id);
    const listed = data.forms.map((form) => form.id);
    assert.deepEqual(listed.sort(), forms.sort(), `${user} forms`);
  }
});

test("lookups by ID return only accessible records; unknown and hidden look alike", async (t) => {
  const { clients, ids, store } = await setup(t);
  const boardIds = Object.values(ids.boards);
  const itemIds = store.listItems({ boardId: ids.boards.hiring }).items;
  const allItems = boardIds.flatMap(
    (boardId) => store.listItems({ boardId, limit: 100 }).items,
  );
  assert.ok(itemIds.length > 0);
  const query = `query L($b: [ID!], $i: [ID!]!, $d: [ID!]) {
    boards(ids: $b, limit: 100) { id } items(ids: $i) { id board { id } }
    docs(ids: $d) { id } }`;
  for (const user of USERS) {
    const variables = {
      b: [...boardIds, "999999"],
      i: [...allItems.map((item) => item.id), "999999"],
      d: [...Object.values(ids.docs), "999999"],
    };
    const data = await clients[user].data(query, variables);
    const boards = Object.keys(seedRoleMap(ids, "board", user));
    assert.deepEqual(data.boards.map((b) => b.id).sort(), boards.sort(), user);
    assert.ok(data.items.every((item) => boards.includes(item.board.id)));
    const reachable = allItems.filter((item) => boards.includes(item.board_id));
    assert.equal(data.items.length, reachable.length, `${user} items`);
    const docs = Object.keys(seedRoleMap(ids, "doc", user));
    assert.deepEqual(data.docs.map((d) => d.id).sort(), docs.sort(), user);
    const forms = "query F($b: ID) { forms(board_id: $b) { id } }";
    for (const [key, boardId] of Object.entries(ids.boards)) {
      const code = await clients[user].code(forms, { b: boardId });
      assert.equal(code, expectedCode(seedRole("board", key, user), "viewer"));
    }
    assert.equal(await clients[user].code(forms, { b: "999999" }), "NOT_FOUND");
  }
});

/** Board-level operations whose success changes nothing visible. */
function boardOperations(store, board) {
  const [item] = store.listItems({ boardId: board.id }).items;
  const owner = board.members.find((grant) => grant.role === "owner");
  const b = board.id;
  return [
    [
      "owner",
      "update_board(board_id: $b, board_attribute: name, new_value: $v) { id }",
      { v: board.name },
      "$v: String!",
    ],
    [
      "owner",
      "set_board_kind(board_id: $b, board_kind: $k) { id }",
      { k: board.board_kind },
      "$k: BoardKind!",
    ],
    [
      "owner",
      'create_column(board_id: $b, title: "Extra", column_type: text) { id }',
    ],
    [
      "owner",
      "share(resource_kind: board, resource_id: $b, subject_kind: user, subject_ids: [$u], role: owner) { id }",
      { u: owner.id },
      "$u: ID!",
    ],
    ["editor", 'create_group(board_id: $b, group_name: "Extra") { id }'],
    ["editor", 'create_item(board_id: $b, item_name: "Extra") { id }'],
    [
      "editor",
      'change_simple_column_value(board_id: $b, item_id: $i, column_id: "name", value: $v) { id }',
      { i: item.id, v: item.name },
      "$i: ID!, $v: String",
    ],
    [
      "editor",
      "move_item_to_group(item_id: $i, group_id: $g) { id }",
      { i: item.id, g: item.group_id },
      "$i: ID!, $g: String!",
    ],
    [
      "editor",
      'create_update(item_id: $i, body: "Seen") { id }',
      { i: item.id },
      "$i: ID!",
    ],
  ].map(([minRole, field, extra = {}, defs = ""]) => {
    // Unused variables are allowed; every operation declares $b.
    const vars = defs ? `$b: ID!, ${defs}` : "$b: ID!";
    const query = `mutation Op(${vars}) { ${field} }`;
    return { minRole, query, variables: { b, ...extra } };
  });
}

test("board, group, column, item and update mutations: NOT_FOUND, FORBIDDEN or ok per role", async (t) => {
  const { clients, ids, store } = await setup(t);
  for (const [key, boardId] of Object.entries(ids.boards)) {
    for (const user of USERS) {
      const role = seedRole("board", key, user);
      for (const op of boardOperations(store, store.getBoard(boardId))) {
        const code = await clients[user].code(op.query, op.variables);
        assert.equal(
          code,
          expectedCode(role, op.minRole),
          `${user} on ${key}: ${op.query}`,
        );
      }
    }
  }
});

/** Doc, note, workspace and form operations that change nothing visible. */
function contentOperations(store, kind, record) {
  const owner = record.members?.find((grant) => grant.role === "owner");
  const share = (role) =>
    `share(resource_kind: ${kind}, resource_id: $id, subject_kind: user, subject_ids: [$u], role: ${role}) { id }`;
  const ops = {
    doc: [
      [
        "editor",
        "update_doc(doc_id: $id, expected_version: $n, title: $v) { id }",
        { n: record.version, v: record.title },
        "$n: Int!, $v: String",
      ],
      [
        "owner",
        "set_doc_visibility(doc_id: $id, visibility: $vis) { id }",
        { vis: record.visibility },
        "$vis: DocVisibility!",
      ],
      ["owner", share("owner"), { u: owner?.id }, "$u: ID!"],
    ],
    note: [
      [
        "editor",
        "update_note(note_id: $id, expected_version: $n, title: $v) { id }",
        { n: record.version, v: record.title },
        "$n: Int!, $v: String",
      ],
      [
        "owner",
        "unshare(resource_kind: note, resource_id: $id, subject_kind: user, subject_id: $u) { id }",
        { u: record.owner_id },
        "$u: ID!",
      ],
    ],
    workspace: [
      [
        "owner",
        "update_workspace(workspace_id: $id, name: $v) { id }",
        { v: record.name },
        "$v: String",
      ],
      ["owner", share("owner"), { u: owner?.id }, "$u: ID!"],
    ],
    form: [
      [
        "editor",
        "update_form(form_id: $id, title: $v) { id }",
        { v: record.title },
        "$v: String",
      ],
      ["editor", "regenerate_form_link(form_id: $id) { id }"],
    ],
  }[kind];
  return ops.map(([minRole, field, extra = {}, defs = ""]) => ({
    minRole,
    query: `mutation Op($id: ID!${defs ? `, ${defs}` : ""}) { ${field} }`,
    variables: { id: record.id, ...extra },
  }));
}

test("doc, note, workspace and form mutations: NOT_FOUND, FORBIDDEN or ok per role", async (t) => {
  const { clients, ids, store } = await setup(t);
  const getters = {
    doc: store.getDoc,
    note: store.getNote,
    workspace: store.getWorkspace,
    form: store.getForm,
  };
  const groups = {
    doc: "docs",
    note: "notes",
    workspace: "workspaces",
    form: "forms",
  };
  const formBoards = { feature: "roadmap", campaign: "marketing" };
  for (const kind of Object.keys(groups)) {
    for (const [key, id] of Object.entries(ids[groups[kind]])) {
      for (const user of USERS) {
        const role =
          kind === "form"
            ? seedRole("board", formBoards[key], user)
            : seedRole(kind, key, user);
        // Re-read per user: successful writes bump versions.
        for (const op of contentOperations(store, kind, getters[kind](id))) {
          const code = await clients[user].code(op.query, op.variables);
          assert.equal(
            code,
            expectedCode(role, op.minRole),
            `${user} on ${key}: ${op.query}`,
          );
        }
      }
    }
  }
});

test("creating content needs the account capability and editor access to the target", async (t) => {
  const { clients, ids } = await setup(t);
  const create = {
    board:
      'mutation C($w: ID) { create_board(board_name: "New", workspace_id: $w) { id } }',
    doc: 'mutation C($w: ID) { create_doc(title: "New", workspace_id: $w) { id } }',
  };
  const form =
    'mutation F($b: ID!) { create_form(board_id: $b, title: "New") { id } }';
  for (const user of USERS) {
    // Viewers and guests lack the capability, whatever the target.
    const capable = !["jordan", "chris"].includes(user);
    for (const [key, workspaceId] of Object.entries(ids.workspaces)) {
      const role = seedRole("workspace", key, user);
      const want = capable ? expectedCode(role, "editor") : "FORBIDDEN";
      for (const query of Object.values(create)) {
        assert.equal(
          await clients[user].code(query, { w: workspaceId }),
          want,
          `${user} ${key}`,
        );
      }
    }
    for (const [key, boardId] of Object.entries(ids.boards)) {
      const want = capable
        ? expectedCode(seedRole("board", key, user), "editor")
        : "FORBIDDEN";
      assert.equal(
        await clients[user].code(form, { b: boardId }),
        want,
        `${user} form on ${key}`,
      );
    }
    const workspace = 'mutation { create_workspace(name: "Mine") { id } }';
    assert.equal(
      await clients[user].code(workspace),
      capable ? null : "FORBIDDEN",
    );
    const note = 'mutation { create_note(title: "Mine") { my_access } }';
    assert.deepEqual(await clients[user].data(note), {
      create_note: { my_access: "owner" },
    });
  }
});

test("destructive mutations are refused without enough access and work for owners", async (t) => {
  const { clients, ids, store } = await setup(t);
  const roadmapItem = store.listItems({ boardId: ids.boards.roadmap }).items[0];
  const cases = [
    [
      "board",
      "hiring",
      "owner",
      "mutation D($id: ID!) { delete_board(board_id: $id) { id } }",
      ids.boards.hiring,
    ],
    [
      "board",
      "roadmap",
      "editor",
      "mutation D($id: ID!) { delete_item(item_id: $id) { id } }",
      roadmapItem.id,
    ],
    [
      "board",
      "roadmap",
      "editor",
      'mutation D($id: ID!) { delete_group(board_id: $id, group_id: "done") { id } }',
      ids.boards.roadmap,
    ],
    [
      "doc",
      "brief",
      "owner",
      "mutation D($id: ID!) { delete_doc(doc_id: $id) { id } }",
      ids.docs.brief,
    ],
    [
      "note",
      "checklist",
      "owner",
      "mutation D($id: ID!) { delete_note(note_id: $id) { id } }",
      ids.notes.checklist,
    ],
    [
      "board",
      "marketing",
      "editor",
      "mutation D($id: ID!) { delete_form(form_id: $id) { id } }",
      ids.forms.campaign,
    ],
  ];
  for (const [kind, key, minRole, query, id] of cases) {
    const allowed = [];
    for (const user of USERS) {
      const want = expectedCode(seedRole(kind, key, user), minRole);
      if (want === null) allowed.push(user);
      else
        assert.equal(
          await clients[user].code(query, { id }),
          want,
          `${user} ${query}`,
        );
    }
    assert.ok(allowed.length > 0, query);
    assert.equal(await clients[allowed[0]].code(query, { id }), null, query);
    // Once gone, everyone sees NOT_FOUND.
    assert.equal(await clients[allowed[0]].code(query, { id }), "NOT_FOUND");
  }
  const empty =
    "mutation D($id: ID!) { delete_workspace(workspace_id: $id) { id } }";
  for (const user of USERS.filter((u) => u !== "alex")) {
    const want = expectedCode(
      seedRole("workspace", "leadership", user),
      "owner",
    );
    assert.equal(
      await clients[user].code(empty, { id: ids.workspaces.leadership }),
      want,
    );
  }
  const notEmpty = await clients.alex.error(empty, {
    id: ids.workspaces.leadership,
  });
  assert.equal(
    notEmpty.extensions.code,
    "BAD_USER_INPUT",
    "it still holds a board and a doc",
  );
});

test("errors for hidden records match errors for missing ones, message included", async (t) => {
  const { clients, ids, store } = await setup(t);
  const [launchItem] = store.listItems({ boardId: ids.boards.marketing }).items;
  const probes = [
    [
      "sam",
      'mutation P($id: ID!) { update_board(board_id: $id, board_attribute: name, new_value: "x") { id } }',
      ids.boards.hiring,
    ],
    [
      "chris",
      'mutation P($id: ID!) { update_doc(doc_id: $id, expected_version: 1, title: "x") { id } }',
      ids.docs.vision,
    ],
    [
      "alex",
      "mutation P($id: ID!) { delete_note(note_id: $id) { id } }",
      ids.notes.crit,
    ],
    [
      "noa",
      'mutation P($id: ID!) { update_workspace(workspace_id: $id, name: "x") { id } }',
      ids.workspaces.leadership,
    ],
    [
      "jordan",
      'mutation P($id: ID!) { update_form(form_id: $id, title: "x") { id } }',
      ids.forms.campaign,
    ],
    [
      "alex",
      'mutation P($id: ID!) { create_update(item_id: $id, body: "x") { id } }',
      launchItem.id,
    ],
  ];
  for (const [user, query, id] of probes) {
    const hidden = await clients[user].error(query, { id });
    const missing = await clients[user].error(query, { id: "999999" });
    assert.equal(hidden.extensions.code, "NOT_FOUND", query);
    assert.deepEqual(
      { ...hidden, message: hidden.message.replace(id, "<id>") },
      { ...missing, message: missing.message.replace("999999", "<id>") },
    );
  }
});
