/**
 * The routes of the fake ClickUp REST API (`clickup-server.js`): the
 * query parameters each accepts (`queryProblem` names the first misuse)
 * and handlers answering in ClickUp's v2 / v3 shapes from
 * `clickupFixture()` data. A handler throws FakeError for a missing
 * entity (404 `{ err, ECODE }`).
 */
const TASK_PAGE = 100;
const COMMENT_PAGE = 25;
const ARCHIVED = { archived: { re: /^false$/, required: true } };
const TASKS = {
  page: { re: /^\d{1,4}$/, required: true },
  include_closed: { re: /^true$/, required: true },
  subtasks: { re: /^(?:true|false)$/, required: true },
  archived: { re: /^false$/, required: true },
};
const COMMENTS = {
  start: { re: /^\d{1,15}$/, with: "start_id" },
  start_id: { re: /^\w{1,64}$/, with: "start" },
};
const DOCS = {
  limit: { re: /^(?:[1-9]\d|100)$/ },
  deleted: { re: /^false$/ },
  archived: { re: /^false$/ },
  // The documented request parameter; `next_cursor` (deprecated) is refused.
  cursor: { re: /^[\w=-]{1,200}$/ },
};
const PAGES = {
  max_page_depth: { re: /^-1$/, required: true },
  content_format: { re: /^text\/md$/, required: true },
};
const S = "([^/]+)";

const ROUTES = [
  ["teams", new RegExp("^/api/v2/team$"), [], {}],
  ["spaces", new RegExp(`^/api/v2/team/${S}/space$`), ["team"], ARCHIVED],
  ["folders", new RegExp(`^/api/v2/space/${S}/folder$`), ["space"], ARCHIVED],
  [
    "folder_lists",
    new RegExp(`^/api/v2/folder/${S}/list$`),
    ["folder"],
    ARCHIVED,
  ],
  ["space_lists", new RegExp(`^/api/v2/space/${S}/list$`), ["space"], ARCHIVED],
  ["list", new RegExp(`^/api/v2/list/${S}$`), ["list"], {}],
  ["fields", new RegExp(`^/api/v2/list/${S}/field$`), ["list"], {}],
  ["tasks", new RegExp(`^/api/v2/list/${S}/task$`), ["list"], TASKS],
  ["comments", new RegExp(`^/api/v2/task/${S}/comment$`), ["task"], COMMENTS],
  ["replies", new RegExp(`^/api/v2/comment/${S}/reply$`), ["comment"], {}],
  ["docs", new RegExp(`^/api/v3/workspaces/${S}/docs$`), ["team"], DOCS],
  [
    "pages",
    new RegExp(`^/api/v3/workspaces/${S}/docs/${S}/pages$`),
    ["team", "doc"],
    PAGES,
  ],
];

export class FakeError extends Error {
  constructor(status, err, ecode) {
    super(err);
    this.status = status;
    this.ecode = ecode;
  }
}
const notFound = (what) => {
  throw new FakeError(404, `${what} not found`, "ITEM_013");
};
const find = (rows, id, what) =>
  rows.find((row) => row.id === id) ?? notFound(what);

// ------------------------------------------------------------ shapes

const spaceRef = (data, id) => ({
  id,
  name: find(data.spaces, id, "Space").name,
  access: true,
});

function listShape(data, list) {
  const folder = list.folder_id
    ? find(data.folders, list.folder_id, "Folder")
    : null;
  const shape = {
    id: list.id,
    name: list.name,
    orderindex: 0,
    content: list.content,
    status: null,
    priority: null,
    assignee: null,
    task_count: data.tasks.filter((t) => t.list_id === list.id).length,
    due_date: null,
    start_date: null,
    folder: folder
      ? { id: folder.id, name: folder.name, hidden: false, access: true }
      : {
          id: `hidden-${list.space_id}`,
          name: "hidden",
          hidden: true,
          access: true,
        },
    space: spaceRef(data, list.space_id),
    archived: list.archived,
    override_statuses: list.statuses.length > 2,
    permission_level: "create",
  };
  if (list.private !== undefined) shape.private = list.private;
  return shape;
}

const visible = (rows, query) =>
  rows.filter((row) => query.archived !== "false" || !row.archived);

function customFields(list, task) {
  const defs = [...list.fields, ...task.extra_fields];
  return defs.map((def) =>
    Object.hasOwn(task.fields, def.id)
      ? { ...def, value: task.fields[def.id] }
      : { ...def },
  );
}

function taskShape(data, task) {
  const list = find(data.lists, task.list_id, "List");
  const {
    list_id: _list,
    fields: _fields,
    extra_fields: _extra,
    ...rest
  } = task;
  return {
    ...rest,
    custom_fields: customFields(list, task),
    list: { id: list.id, name: list.name, access: true },
    project: {
      id: list.folder_id ?? "hidden",
      name: "folder",
      hidden: !list.folder_id,
      access: true,
    },
    folder: {
      id: list.folder_id ?? "hidden",
      name: "folder",
      hidden: !list.folder_id,
      access: true,
    },
    space: { id: list.space_id },
  };
}

function taskPage(data, params, query) {
  const list = find(data.lists, params.list, "List");
  const tasks = data.tasks.filter(
    (t) =>
      t.list_id === list.id &&
      !t.archived &&
      (query.subtasks === "true" || t.parent === null),
  );
  const start = Number(query.page) * TASK_PAGE;
  const page = tasks.slice(start, start + TASK_PAGE);
  return {
    tasks: page.map((t) => taskShape(data, t)),
    last_page: start + TASK_PAGE >= tasks.length,
  };
}

function commentPage(data, params, query) {
  find(data.tasks, params.task, "Task");
  const all = [...(data.comments[params.task] ?? [])].sort(
    (a, b) => Number(b.date) - Number(a.date) || Number(b.id) - Number(a.id),
  );
  let from = 0;
  if (query.start_id !== undefined) {
    const index = all.findIndex(
      (c) => c.id === query.start_id && c.date === query.start,
    );
    if (index === -1) throw new FakeError(400, "Invalid start", "CMT_001");
    from = index + 1;
  }
  return { comments: all.slice(from, from + COMMENT_PAGE) };
}

function docPage(data, params, query) {
  const limit = Number(query.limit ?? 50);
  const docs = data.docs.filter(
    (d) =>
      d.team_id === params.team &&
      (query.deleted !== "false" || !d.deleted) &&
      (query.archived !== "false" || !d.archived),
  );
  const offset = query.cursor
    ? Number(Buffer.from(query.cursor, "base64url").toString())
    : 0;
  const page = docs
    .slice(offset, offset + limit)
    .map(({ pages: _pages, team_id: _team, ...doc }) => doc);
  const body = { docs: page };
  if (offset + limit < docs.length) {
    body.next_cursor = Buffer.from(String(offset + limit)).toString(
      "base64url",
    );
  }
  return body;
}

export const HANDLERS = {
  teams: (data) => {
    const users = new Map(data.users.map((user) => [user.id, user]));
    const teams = data.teams.map((team) => ({
      id: team.id,
      name: team.name,
      color: team.color,
      avatar: null,
      members: team.members.map((id) => ({ user: { ...users.get(id) } })),
    }));
    return { teams };
  },
  spaces: (data, p, q) => {
    find(data.teams, p.team, "Team");
    const spaces = visible(
      data.spaces.filter((s) => s.team_id === p.team),
      q,
    );
    return {
      spaces: spaces.map(({ team_id: _team, ...space }) => ({
        ...space,
        color: "#7b68ee",
        avatar: null,
        admin_can_manage: true,
        statuses: [],
        multiple_assignees: true,
        features: {
          due_dates: { enabled: true },
          time_estimates: { enabled: true },
        },
      })),
    };
  },
  folders: (data, p, q) => {
    find(data.spaces, p.space, "Space");
    const folders = visible(
      data.folders.filter((f) => f.space_id === p.space),
      q,
    );
    return {
      folders: folders.map(({ space_id, ...folder }) => ({
        ...folder,
        orderindex: 0,
        override_statuses: false,
        hidden: false,
        space: {
          id: space_id,
          name: find(data.spaces, space_id, "Space").name,
        },
        task_count: "0",
        lists: visible(
          data.lists.filter((l) => l.folder_id === folder.id),
          q,
        ).map((l) => listShape(data, l)),
      })),
    };
  },
  folder_lists: (data, p, q) => {
    find(data.folders, p.folder, "Folder");
    const lists = visible(
      data.lists.filter((l) => l.folder_id === p.folder),
      q,
    );
    return { lists: lists.map((l) => listShape(data, l)) };
  },
  space_lists: (data, p, q) => {
    find(data.spaces, p.space, "Space");
    const lists = data.lists.filter(
      (l) => l.space_id === p.space && l.folder_id === null,
    );
    return { lists: visible(lists, q).map((l) => listShape(data, l)) };
  },
  list: (data, p) => {
    const list = find(data.lists, p.list, "List");
    return {
      ...listShape(data, list),
      statuses: list.statuses,
      inbound_address: "a.b@tasks.clickup.com",
    };
  },
  fields: (data, p) => ({ fields: find(data.lists, p.list, "List").fields }),
  tasks: taskPage,
  comments: commentPage,
  replies: (data, p) => ({ comments: data.replies[p.comment] ?? [] }),
  docs: (data, p, q) => {
    find(data.teams, p.team, "Workspace");
    return docPage(data, p, q);
  },
  pages: (data, p) =>
    find(
      data.docs.filter((d) => d.team_id === p.team),
      p.doc,
      "Doc",
    ).pages,
};

/** The route, params and query spec of `path`, or null. */
export function matchRoute(path) {
  for (const [route, pattern, keys, query] of ROUTES) {
    const match = pattern.exec(path);
    if (match) {
      const params = Object.fromEntries(
        keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]),
      );
      return { route, params, spec: query };
    }
  }
  return null;
}

/** What is wrong with `query` for `spec`, or null. */
export function queryProblem(spec, query) {
  for (const [key, value] of Object.entries(query)) {
    if (!Object.hasOwn(spec, key)) return `unknown query parameter ${key}`;
    if (!spec[key].re.test(value)) return `invalid ${key}=${value}`;
    if (spec[key].with && query[spec[key].with] === undefined)
      return `${key} needs ${spec[key].with}`;
  }
  const missing = Object.keys(spec).find(
    (key) => spec[key].required && query[key] === undefined,
  );
  return missing ? `missing query parameter ${missing}` : null;
}
