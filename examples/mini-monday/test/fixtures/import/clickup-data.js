/**
 * The fake ClickUp account behind `clickup-server.js`, in ClickUp's own
 * terms (REST v2 / v3 field names). Two ClickUp workspaces ("teams"):
 *
 * - "Acme Corp" (9001): Dana, Fox, Walter, Gina (guest) and a member
 *   without a name. Spaces "Product" (open; folders "Engineering" with
 *   "Sprint 12", "Backlog" (private) and an archived list, "Secret
 *   projects" (private folder) with "Plans", an archived folder, and the
 *   folderless "Inbox") and "Leadership" (private space; "Hiring"), plus
 *   an archived space. Sprint 12 has every status type, every custom
 *   field type, 230 tasks (three task pages), subtasks two levels deep,
 *   an archived task, and comments (30 on one task: two comment pages,
 *   with a threaded reply). Docs: a handbook with nested pages and every
 *   markdown construct, docs parented to a folder, a list, the workspace
 *   and an unknown space, a deleted doc and 50 notes (two doc pages;
 *   `clickup-docs-data.js`).
 * - "Side Project" (9002): Dana and Sam, space "Garden" with "Seeds".
 *
 * `clickupFixture()` returns a fresh copy, so tests may change it.
 */
import { clickupDocs } from "./clickup-docs-data.js";

export const CLICKUP_TOKEN = "pk_4242_FAKECLICKUPTOKEN7Q2W9E4R1T6Y";
/** 2023-11-14T22:13:20.000Z */
export const T0 = 1_700_000_000_000;
export const DAY = 86_400_000;
export const SPRINT_TASKS = 230;
export const FIELD = Object.freeze({
  stage: "6b1d0f4e-0001-4c55-9a0e-5d1f0a000001",
  areas: "6b1d0f4e-0002-4c55-9a0e-5d1f0a000002",
  points: "6b1d0f4e-0003-4c55-9a0e-5d1f0a000003",
  budget: "6b1d0f4e-0004-4c55-9a0e-5d1f0a000004",
  rating: "6b1d0f4e-0005-4c55-9a0e-5d1f0a000005",
  launch: "6b1d0f4e-0006-4c55-9a0e-5d1f0a000006",
  notes: "6b1d0f4e-0007-4c55-9a0e-5d1f0a000007",
  code: "6b1d0f4e-0008-4c55-9a0e-5d1f0a000008",
  email: "6b1d0f4e-0009-4c55-9a0e-5d1f0a000009",
  phone: "6b1d0f4e-0010-4c55-9a0e-5d1f0a000010",
  link: "6b1d0f4e-0011-4c55-9a0e-5d1f0a000011",
  reviewer: "6b1d0f4e-0012-4c55-9a0e-5d1f0a000012",
  approved: "6b1d0f4e-0013-4c55-9a0e-5d1f0a000013",
  office: "6b1d0f4e-0014-4c55-9a0e-5d1f0a000014",
  progress: "6b1d0f4e-0015-4c55-9a0e-5d1f0a000015",
  score: "6b1d0f4e-0016-4c55-9a0e-5d1f0a000016",
  related: "6b1d0f4e-0017-4c55-9a0e-5d1f0a000017",
  files: "6b1d0f4e-0018-4c55-9a0e-5d1f0a000018",
  hidden: "6b1d0f4e-0019-4c55-9a0e-5d1f0a000019",
});

const person = (id, username, email, role = 3) => ({
  id,
  username,
  email,
  color: "#7b68ee",
  initials: username
    ? username
        .split(" ")
        .map((p) => p[0])
        .join("")
    : null,
  profilePicture: null,
  role,
});

const USERS = [
  person(101, "Dana Scully", "dana@acme.test", 1),
  person(102, "Fox Mulder", "fox@acme.test", 2),
  person(103, "Walter Skinner", "walter@acme.test"),
  person(104, "Gina Guest", "gina@partner.test", 4),
  person(106, null, "nobody@acme.test"),
  // Not a member any more, still assigned to a task.
  person(105, "Alex Krycek", "alex@former.test"),
  person(201, "Sam Side", "sam@side.test"),
];
const SPRINT_STATUSES = [
  {
    id: "sc1_3",
    status: "complete",
    type: "done",
    orderindex: 3,
    color: "#6BC950",
  },
  {
    id: "sc1_0",
    status: "to do",
    type: "open",
    orderindex: 0,
    color: "#d3d3d3",
  },
  {
    id: "sc1_2",
    status: "review",
    type: "custom",
    orderindex: 2,
    color: "#a875ff",
  },
  {
    id: "sc1_1",
    status: "in progress",
    type: "custom",
    orderindex: 1,
    color: "#4194f6",
  },
  {
    id: "sc1_4",
    status: "closed",
    type: "closed",
    orderindex: 4,
    color: "#008844",
  },
];
const BASIC_STATUSES = [
  { id: "b0", status: "Open", type: "open", orderindex: 0, color: "#d3d3d3" },
  {
    id: "b1",
    status: "Closed",
    type: "closed",
    orderindex: 1,
    color: "#6bc950",
  },
];

const def = (key, name, type, type_config = {}) => ({
  id: FIELD[key],
  name,
  type,
  type_config,
  date_created: String(T0 - 30 * DAY),
  hide_from_guests: false,
  required: false,
});

const SPRINT_FIELDS = [
  def("stage", "Stage", "drop_down", {
    default: 0,
    placeholder: null,
    options: [
      { id: "opt-ship", name: "Ship", color: null, orderindex: 2 },
      { id: "opt-design", name: "Design", color: "#04A9F4", orderindex: 0 },
      { id: "opt-build", name: "Build", color: "#ff7fab", orderindex: 1 },
      { id: "opt-empty", name: "  ", color: "#000000", orderindex: 3 },
    ],
  }),
  def("areas", "Areas", "labels", {
    options: [
      { id: "lab-api", label: "API", color: "#2ecd6f" },
      { id: "lab-ui", label: "UI", color: "#e50000" },
    ],
  }),
  def("points", "Story points", "number"),
  def("budget", "Budget", "currency", { precision: 2, currency_type: "USD" }),
  def("rating", "Confidence", "emoji", { code_point: "2b50", count: 5 }),
  def("launch", "Launch date", "date"),
  def("notes", "Notes", "text"),
  def("code", "Code name", "short_text"),
  def("email", "Contact email", "email"),
  def("phone", "Contact phone", "phone"),
  def("link", "Spec link", "url"),
  def("reviewer", "Reviewer", "users", { single_user: true }),
  def("approved", "Approved", "checkbox"),
  def("office", "Office", "location"),
  def("progress", "Progress", "manual_progress", {
    method: "manual",
    start: 0,
    end: 100,
  }),
  def("score", "Score", "formula", { formula: "1+1" }),
  def("related", "Related tasks", "tasks"),
  def("files", "Files", "attachment"),
];
/** A field the list does not report but its tasks carry. */
export const HIDDEN_FIELD = def("hidden", "Hidden field", "short_text");

/** Every custom field type with a value (on "Plan the sprint"). */
const RICH_VALUES = {
  [FIELD.stage]: 1,
  [FIELD.areas]: ["lab-ui", "lab-api"],
  [FIELD.points]: "8",
  [FIELD.budget]: 1250.5,
  [FIELD.rating]: 4,
  [FIELD.launch]: String(T0 + 10 * DAY),
  [FIELD.notes]: "Line one\nLine two",
  [FIELD.code]: "Bluebird",
  [FIELD.email]: "pm@acme.test",
  [FIELD.phone]: "+1 555 0100",
  [FIELD.link]: "https://specs.acme.test/sprint-12",
  [FIELD.reviewer]: [
    { id: 103, username: "Walter Skinner", email: "walter@acme.test" },
  ],
  [FIELD.approved]: true,
  [FIELD.office]: {
    location: { lat: 40.7, lng: -74 },
    formatted_address: "1 Main St, Springfield",
  },
  [FIELD.progress]: { percent_completed: 40 },
  [FIELD.score]: 2,
  [FIELD.related]: [
    { id: "86c0002", name: "Ship it" },
    { id: "86c0003", name: "Write tests" },
  ],
  [FIELD.files]: [
    {
      id: "att-1",
      title: "brief.pdf",
      url: "https://files.acme.test/brief.pdf",
    },
  ],
};

const ref = (id) => {
  const { username, email, color, initials, profilePicture } = USERS.find(
    (u) => u.id === id,
  );
  return { id, username, email, color, initials, profilePicture };
};
const status = (statuses, name) => {
  const found = statuses.find((s) => s.status === name);
  return found
    ? { ...found }
    : { status: name, type: "custom", orderindex: 9, color: "#ff0000" };
};
const priority = (name) => {
  const ids = { urgent: "1", high: "2", normal: "3", low: "4" };
  const colors = {
    urgent: "#f50000",
    high: "#ffcc00",
    normal: "#6fddff",
    low: "#d8d8d8",
  };
  return name
    ? {
        id: ids[name],
        priority: name,
        color: colors[name],
        orderindex: ids[name],
      }
    : null;
};

/** A task in ClickUp's shape; `fields` are custom field values by ID. */
function task(list, id, name, extra = {}) {
  const first = list.statuses.reduce((a, b) =>
    b.orderindex < a.orderindex ? b : a,
  );
  const { statusName = first.status, ...rest } = extra;
  return {
    list_id: list.id,
    id,
    custom_id: null,
    name,
    text_content: "",
    description: "",
    status: status(list.statuses, statusName),
    orderindex: "1.00000000000000000000000000000000",
    date_created: String(T0 - 20 * DAY),
    date_updated: String(T0 - DAY),
    date_closed: null,
    date_done: null,
    archived: false,
    creator: ref(101),
    assignees: [],
    group_assignees: [],
    watchers: [],
    checklists: [],
    tags: [],
    parent: null,
    top_level_parent: null,
    priority: null,
    due_date: null,
    start_date: null,
    points: null,
    time_estimate: null,
    time_spent: 0,
    fields: {},
    extra_fields: [],
    dependencies: [],
    linked_tasks: [],
    team_id: "9001",
    url: `https://app.clickup.com/t/${id}`,
    permission_level: "create",
    ...rest,
  };
}

function sprintTasks(list) {
  const tasks = [
    task(list, "86c0001", "Plan the sprint", {
      statusName: "in progress",
      assignees: [ref(101), ref(102)],
      due_date: String(T0),
      due_date_time: true,
      start_date: String(T0 - 2 * DAY),
      start_date_time: false,
      priority: priority("urgent"),
      time_estimate: 5_400_000,
      tags: [
        { name: "backend", tag_fg: "#fff", tag_bg: "#000" },
        { name: "api" },
      ],
      text_content: "Planning notes\n",
      date_created: String(T0 - 10 * DAY),
      creator: ref(102),
      fields: RICH_VALUES,
      extra_fields: [HIDDEN_FIELD],
    }),
    task(list, "86c0002", "Ship it", {
      statusName: "complete",
      assignees: [ref(105)],
      group_assignees: [{ id: "grp-1", name: "Launch crew" }],
      priority: priority("low"),
      time_estimate: "1234567",
      text_content: "x".repeat(2500),
      checklists: [
        { id: "c1", name: "Checklist", items: [{ id: "i1", name: "Done" }] },
      ],
      points: 3,
      fields: {
        [FIELD.stage]: 9,
        [FIELD.approved]: false,
        [FIELD.areas]: ["lab-api", "lab-gone"],
        [FIELD.hidden]: "only on tasks",
      },
      extra_fields: [HIDDEN_FIELD],
    }),
    task(list, "86c0003", "Write tests", {
      statusName: "closed",
      priority: priority("high"),
    }),
    task(list, "86c0004", "Unit tests", {
      parent: "86c0003",
      top_level_parent: "86c0003",
    }),
    task(list, "86c0005", "Fixtures", {
      parent: "86c0004",
      top_level_parent: "86c0003",
      priority: priority("normal"),
    }),
    task(list, "86c0006", "Blocked work", {
      statusName: "blocked",
      fields: { [FIELD.stage]: "opt-ship" },
    }),
    task(list, "86c0007", "Archived task", { archived: true }),
  ];
  for (let n = tasks.length; n <= SPRINT_TASKS; n += 1) {
    tasks.push(task(list, `86c${String(1000 + n)}`, `Task ${n}`));
  }
  return tasks;
}

function lists() {
  const list = (id, [space_id, folder_id], name, extra = {}) => ({
    id,
    space_id,
    folder_id,
    name,
    content: "",
    archived: false,
    statuses: BASIC_STATUSES,
    fields: [],
    ...extra,
  });
  return [
    list("901101", ["90010001", "90011001"], "Sprint 12", {
      content: "Current sprint",
      statuses: SPRINT_STATUSES,
      fields: SPRINT_FIELDS,
    }),
    list("901102", ["90010001", "90011001"], "Backlog", { private: true }),
    list("901106", ["90010001", "90011001"], "Old list", { archived: true }),
    list("901103", ["90010001", "90011002"], "Plans"),
    list("901104", ["90010001", null], "Inbox", {
      content: "Everything new lands here",
    }),
    list("901105", ["90010002", null], "Hiring"),
    list("902101", ["90020001", null], "Seeds"),
  ];
}

function otherTasks(all) {
  const at = (id) => all.find((list) => list.id === id);
  return [
    task(at("901102"), "86d0001", "Idea one"),
    task(at("901102"), "86d0002", "Idea two", { statusName: "Closed" }),
    task(at("901103"), "86d0003", "Secret plan"),
    task(at("901104"), "86d0004", "Triage"),
    task(at("901104"), "86d0005", "Follow-up", { parent: "86c0001" }),
    task(at("901105"), "86d0006", "Hire a designer", { assignees: [ref(101)] }),
    task(at("902101"), "86e0001", "Plant tomatoes", {
      assignees: [ref(201)],
      team_id: "9002",
    }),
  ];
}

/** A comment `minutes` after T0; `extra` overrides ClickUp fields. */
const comment = ([id, minutes], user, text, extra = {}) => ({
  id: String(id),
  comment: [{ text }],
  comment_text: text,
  user,
  resolved: false,
  assignee: null,
  assigned_by: null,
  reactions: [],
  date: String(T0 + minutes * 60_000),
  reply_count: 0,
  ...extra,
});

function comments() {
  const plan = Array.from({ length: 30 }, (_, n) => {
    const text = n === 0 ? "Planning started" : `Comment ${n + 1}`;
    const extra = n === 9 ? { reply_count: 2 } : {};
    return comment([5001 + n, n], ref(n % 2 === 0 ? 101 : 102), text, extra);
  });
  const bot = { id: -1, username: "ClickBot", email: null, color: null };
  return {
    "86c0001": plan,
    "86c0003": [comment([6001, 5], bot, "Status changed by automation\n")],
    "86d0006": [
      comment([6002, 7], ref(101), "", {
        comment: [{ text: "Rich " }, { text: "text" }],
        comment_text: undefined,
      }),
    ],
  };
}

const replies = () => ({
  5010: [
    comment([7001, 100], ref(103), "First reply"),
    comment([7002, 101], ref(101), "Second reply"),
  ],
});

const place = (id, fields) => ({
  id,
  private: false,
  archived: false,
  ...fields,
});

/** A fresh copy of the fake ClickUp account (see the module comment). */
export function clickupFixture() {
  const all = lists();
  const sprint = all[0];
  return {
    users: USERS.map((user) => ({ ...user })),
    teams: [
      {
        id: "9001",
        name: "Acme Corp",
        color: "#536cfe",
        members: [101, 102, 103, 104, 106],
      },
      {
        id: "9002",
        name: "Side Project",
        color: "#40bc86",
        members: [101, 201],
      },
    ],
    spaces: [
      place("90010001", { team_id: "9001", name: "Product" }),
      place("90010002", { team_id: "9001", name: "Leadership", private: true }),
      place("90010003", { team_id: "9001", name: "Old space", archived: true }),
      place("90020001", { team_id: "9002", name: "Garden" }),
    ],
    folders: [
      place("90011001", { space_id: "90010001", name: "Engineering" }),
      place("90011002", {
        space_id: "90010001",
        name: "Secret projects",
        private: true,
      }),
      place("90011003", {
        space_id: "90010001",
        name: "Old folder",
        archived: true,
      }),
    ],
    lists: all,
    tasks: [...sprintTasks(sprint), ...otherTasks(all)],
    comments: comments(),
    replies: replies(),
    docs: clickupDocs(T0),
  };
}
