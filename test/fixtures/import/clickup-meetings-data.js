/**
 * A synthetic ClickUp account shaped like a department meetings list
 * (SPEC-5 §7), served by `clickup-server.js` for the ClickUp List and
 * task view browser test (`scripts/e2e-clickup.mjs`). One ClickUp
 * workspace "Harbor Learning Center" (9101) with space "Operations" and
 * the folderless list "Weekly Meetings":
 *
 * - statuses: twelve departments of type `custom`, each with its own
 *   color ("it support" is used by no task), plus "Closed" (`closed`);
 * - 60 top-level tasks and 40 subtasks under 13 parents (1–6 each; one
 *   parent's subtasks come before it in the task list, and some subtasks
 *   have a status of their own);
 * - a multi-line Description (`text_content`) on half of the tasks, a
 *   long-text field "Minutes" (ClickUp type `text`, multi-line), a text
 *   field of file names, a second drop-down "Status", a numbers field
 *   "#" and an empty drop-down "Priority";
 * - a few assignees, due and start dates;
 * - 32 comments on "Weekly sync agenda" (two comment pages, some with
 *   line breaks or a link, some by authors outside the team) and a few
 *   on other tasks;
 * - a little Arabic (a teammate's name, task names, comments).
 *
 * Every person, name and text is invented. `meetingsFixture({ now })`
 * returns a fresh copy whose dates lie around `now` (epoch ms).
 */
import { DAY, T0 } from "./clickup-data.js";

const HOUR = 3_600_000;
export const MEETINGS_LIST = "905101";
/** Custom field IDs of the list. */
export const MEETING_FIELD = Object.freeze({
  minutes: "7c2e0a51-0001-4d6e-8f00-5a1b0c000001",
  files: "7c2e0a51-0002-4d6e-8f00-5a1b0c000002",
  progress: "7c2e0a51-0003-4d6e-8f00-5a1b0c000003",
  number: "7c2e0a51-0004-4d6e-8f00-5a1b0c000004",
  priority: "7c2e0a51-0005-4d6e-8f00-5a1b0c000005",
});
/** Names the browser test looks for. */
export const MEETINGS = Object.freeze({
  board: "Weekly Meetings",
  busy: "Weekly sync agenda",
  busyComments: 32,
  outsider: "Jamie Brooks",
  arabicAuthor: "ريم عزيز",
  arabicTask: "مراجعة جدول الجلسات",
  /** A "facility" task with five subtasks, the first one closed. */
  parent: "Reorganize the supply room",
  closedSubtask: "Label the storage shelves",
  searchSubtask: "Count the paper stock",
  /** A "facility" task without subtasks. */
  plain: "Replace the hallway lights",
});

const person = (id, username, email, role = 3) => ({
  id,
  username,
  email,
  color: "#7b68ee",
  initials: username.slice(0, 1),
  profilePicture: null,
  role,
});
const USERS = [
  person(301, "Lina Haddad", "lina@harbor.test", 1),
  person(302, "Omar Saleh", "omar@harbor.test", 2),
  person(303, "Maya Torres", "maya@harbor.test"),
  person(304, "Ben Carter", "ben@harbor.test"),
  person(305, "سارة يوسف", "sara@harbor.test"),
  person(306, "Nora Kim", "nora@harbor.test"),
];
/** Comment authors outside the ClickUp workspace (no Worklane account). */
const OUTSIDERS = [
  { id: 401, username: MEETINGS.outsider, email: null, color: "#aa8d80" },
  { id: 402, username: MEETINGS.arabicAuthor, email: null, color: "#ee5e99" },
];
const ref = (id) => {
  const user = [...USERS, ...OUTSIDERS].find((entry) => entry.id === id);
  return { id, username: user.username, email: user.email, color: "#7b68ee" };
};

/** `[status, color]` in ClickUp order, every one of type `custom`. */
const DEPARTMENTS = [
  ["front desk", "#5f55ee"],
  ["facility", "#1090e0"],
  ["psych dept", "#b660e0"],
  ["slp dept", "#ee5e99"],
  ["ot dept", "#e16b16"],
  ["aba dept", "#f8ae00"],
  ["finance", "#0f9d9f"],
  ["hr", "#3db88b"],
  ["it support", "#656f7d"],
  ["outreach", "#aa8d80"],
  ["parents", "#d33d44"],
  ["admin", "#4466ff"],
];
const STATUSES = [
  ...DEPARTMENTS.map(([name, color], orderindex) => ({
    id: `wm_${orderindex}`,
    status: name,
    type: "custom",
    orderindex,
    color,
  })),
  {
    id: "wm_closed",
    status: "Closed",
    type: "closed",
    orderindex: DEPARTMENTS.length,
    color: "#008844",
  },
];

const option = (id, name, color, orderindex) => ({
  id,
  name,
  color,
  orderindex,
});
const field = (key, name, type, type_config = {}) => ({
  id: MEETING_FIELD[key],
  name,
  type,
  type_config,
  date_created: String(T0 - 90 * DAY),
  hide_from_guests: false,
  required: false,
});
const FIELDS = [
  field("minutes", "Minutes", "text"),
  field("files", "Files", "short_text"),
  field("progress", "Status", "drop_down", {
    options: [
      option("p-working", "Working on it", "#fdab3d", 0),
      option("p-done", "Done", "#00c875", 1),
      option("p-hold", "On hold", "#579bfc", 2),
      option("p-stuck", "Stuck", "#df2f4a", 3),
    ],
  }),
  field("number", "#", "number"),
  field("priority", "Priority", "drop_down", {
    options: [
      option("q-high", "High", "#df2f4a", 0),
      option("q-low", "Low", "#c4c4c4", 1),
    ],
  }),
];

/** `[name, department]` of the 60 top-level tasks, in list order. */
const TOPICS = [
  ["Weekly sync agenda", "admin"],
  ["Replace the hallway lights", "facility"],
  ["Therapy room schedule", "slp dept"],
  ["Reorganize the supply room", "facility"],
  ["Intake forms for new families", "front desk"],
  ["Assessment report template", "psych dept"],
  ["Sensory room equipment", "ot dept"],
  ["Parent newsletter for November", "parents"],
  ["Budget review for Q4", "finance"],
  ["Staff training calendar", "hr"],
  [MEETINGS.arabicTask, "slp dept"],
  ["Behavior plan check-ins", "aba dept"],
  ["Community fair booth", "outreach"],
  ["Waiting room seating", "front desk"],
  ["Fire drill schedule", "facility"],
  ["Group session pilot", "psych dept"],
  ["Fine motor kits", "ot dept"],
  ["Speech screening day", "slp dept"],
  ["Payroll calendar", "finance"],
  ["Onboarding checklist", "hr"],
  ["اجتماع أولياء الأمور", "parents"],
  ["Data sheets for sessions", "aba dept"],
  ["School partnership letters", "outreach"],
  ["Phone message routine", "front desk"],
  ["Parking lot repainting", "facility"],
  ["Testing materials order", "psych dept"],
  ["Handwriting group", "ot dept"],
  ["Articulation games library", "slp dept"],
  ["Insurance claims backlog", "finance"],
  ["Holiday coverage plan", "hr"],
  ["Visiting day for parents", "parents"],
  ["Reinforcer inventory", "aba dept"],
  ["Social media posts", "outreach"],
  ["Visitor sign-in tablet", "front desk"],
  ["Air conditioning service", "facility"],
  ["Case review rotation", "psych dept"],
  ["Weighted vests check", "ot dept"],
  ["AAC device loans", "slp dept"],
  ["Petty cash rules", "finance"],
  ["Performance reviews", "hr"],
  ["Home program handouts", "parents"],
  ["Supervision hours log", "aba dept"],
  ["Open house invitations", "outreach"],
  ["Front desk coverage", "front desk"],
  ["Playground inspection", "facility"],
  ["Consent form update", "admin"],
  ["Room booking rules", "admin"],
  ["Monthly report to the board", "admin"],
  ["Cleaning contract", "facility"],
  ["Volunteer program", "outreach"],
  ["Old intake binder", "Closed"],
  ["Summer camp wrap-up", "Closed"],
  ["Printer replacement", "Closed"],
  ["Spring fundraiser", "Closed"],
  ["Lost and found box", "Closed"],
  ["Keys inventory", "Closed"],
  ["Staff lounge fridge", "facility"],
  ["Quiet hours policy", "admin"],
  ["Translation of forms", "parents"],
  ["First aid kits", "hr"],
];

/** Subtask names by the index of their parent in TOPICS. */
const SUBTASKS = new Map([
  [
    0,
    [
      "Collect department updates",
      "Book the meeting room",
      "Send the agenda",
      "Print the handouts",
      "Take the minutes",
      "Share the action items",
    ],
  ],
  [
    3,
    [
      MEETINGS.closedSubtask,
      MEETINGS.searchSubtask,
      "Move the art supplies",
      "Order more bins",
      "Post a map on the door",
    ],
  ],
  [
    5,
    [
      "Draft the summary page",
      "Check the score tables",
      "Add a logo",
      "Proofread the report",
    ],
  ],
  [7, ["Write the intro", "Pick the photos", "Translate to Arabic", "Send it"]],
  [8, ["Compare with last year", "List the open invoices", "Ask for quotes"]],
  [11, ["Weekly check-in form", "Review with supervisors", "Share results"]],
  [14, ["Pick the dates", "Tell the staff", "Time the evacuation"]],
  [17, ["Book the gym", "Print the flyers", "Recruit volunteers"]],
  [20, ["Choose a date", "Invite the families", "Prepare the slides"]],
  [24, ["Get two quotes", "Pick a weekend"]],
  [30, ["Set the program", "Arrange snacks"]],
  [45, ["Ask a lawyer to read it"]],
  [47, ["Collect the numbers"]],
]);
/** Parents whose subtasks the task list holds before the parent. */
const CHILDREN_FIRST = new Set([5]);
/** Subtasks (`<parent index>:<n>`) with a status other than their parent's. */
const SUBTASK_STATUS = new Map([
  ["0:1", "Closed"],
  ["0:2", "Closed"],
  ["0:3", "front desk"],
  ["3:0", "Closed"],
  ["7:2", "parents"],
  ["14:0", "Closed"],
]);

const DESCRIPTION_LINES = [
  "Raised in the weekly meeting by the department lead.",
  "Owner: the department lead; deadline: before the next meeting.",
  "Next step: confirm the budget with finance.",
  "يرجى إحضار التقارير الشهرية",
  "Bring the latest numbers and any open questions.",
  "Keep the families informed by email and on the notice board.",
];
const MINUTES_LINES = [
  "Agreed to try the new plan for two weeks.",
  "Follow-up assigned; review next Sunday.",
  "تم الاتفاق على الموعد الجديد يوم الأحد",
  "Budget approved up to the amount discussed.",
  "Waiting on a reply from the supplier.",
];

/** A multi-line text of `count` lines from `lines`, starting at `from`. */
const textOf = (lines, from, count) =>
  Array.from(
    { length: count },
    (_, n) => `${n + 1}. ${lines[(from + n) % lines.length]}`,
  ).join("\n");

function busyDescription() {
  const steps = DESCRIPTION_LINES.map((line, n) => `- ${line} (${n + 1})`);
  return [
    "The agenda of the weekly all-departments meeting.",
    "",
    "Before the meeting:",
    ...steps,
    "",
    "During the meeting each department gives a two-minute update, then",
    "we go through open items in status order and close what is done.",
    "Notes go into the Minutes field of the task they belong to.",
    "Agenda link: https://notes.harbor.test/weekly-sync",
  ].join("\n");
}

/** Custom field values of top-level task `index`. */
function fieldValues(index) {
  const values = {};
  if (index % 3 !== 2) {
    values[MEETING_FIELD.minutes] =
      `Minutes, week ${(index % 12) + 1}:\n` +
      textOf(MINUTES_LINES, index, 2 + (index % 3));
  }
  if (index % 6 === 1) {
    values[MEETING_FIELD.files] = `agenda-${index + 1}.pdf, notes.docx`;
  }
  if (index % 2 === 0) values[MEETING_FIELD.progress] = (index / 2) % 4;
  if (index % 4 !== 3) values[MEETING_FIELD.number] = String(index + 1);
  if (index === 0) values[MEETING_FIELD.files] = "room-plan.png, agenda.pdf";
  return values;
}

/** Due dates of top-level tasks by index, in days from now. */
const DUE_IN = new Map([
  [0, 2],
  [4, -3],
  [9, 6],
  [13, -1],
  [16, 9],
]);

/** Assignees, dates and description of top-level task `index`. */
function details(index, now) {
  const extra = {};
  if (index % 3 === 0) {
    extra.assignees = [ref(USERS[(index / 3) % USERS.length].id)];
  }
  if (index === 0) extra.assignees = [ref(301), ref(302), ref(305)];
  // Due in days from now (two overdue), and a start a week before.
  const due = DUE_IN.get(index);
  if (due !== undefined) {
    extra.due_date = String(now + due * DAY);
    extra.due_date_time = false;
  }
  if (due !== undefined && index % 2 === 0) {
    extra.start_date = String(now + (due - 7) * DAY);
    extra.start_date_time = false;
  }
  if (index === 0) extra.text_content = busyDescription();
  else if (index % 2 === 0) {
    extra.text_content = textOf(DESCRIPTION_LINES, index, 2 + (index % 4));
  }
  return extra;
}

const statusOf = (name) => {
  const found = STATUSES.find((entry) => entry.status === name);
  return { ...found };
};

/** A task in ClickUp's shape (`clickup-server.js` reads `fields`). */
function task(id, name, { now, statusName, created, ...extra }) {
  return {
    list_id: MEETINGS_LIST,
    id,
    custom_id: null,
    name,
    text_content: "",
    description: "",
    status: statusOf(statusName),
    orderindex: "1.00000000000000000000000000000000",
    date_created: String(created),
    date_updated: String(now - DAY),
    date_closed: null,
    date_done: null,
    archived: false,
    creator: ref(301),
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
    team_id: "9101",
    url: `https://app.clickup.com/t/${id}`,
    permission_level: "create",
    ...extra,
  };
}

const topId = (index) => `87a${String(1000 + index)}`;

function subtasksOf(index, now) {
  const [, department] = TOPICS[index];
  return (SUBTASKS.get(index) ?? []).map((name, n) =>
    task(`87b${String(1000 + index * 10 + n)}`, name, {
      now,
      statusName: SUBTASK_STATUS.get(`${index}:${n}`) ?? department,
      created: now - (40 - index) * DAY + (n + 1) * HOUR,
      parent: topId(index),
      top_level_parent: topId(index),
      assignees: n === 0 ? [ref(USERS[index % USERS.length].id)] : [],
    }),
  );
}

function tasks(now) {
  const all = [];
  TOPICS.forEach(([name, department], index) => {
    const parent = task(topId(index), name, {
      now,
      statusName: department,
      created: now - (60 - index) * DAY,
      creator: ref(index % 5 === 4 ? 302 : 301),
      fields: fieldValues(index),
      ...details(index, now),
    });
    const children = subtasksOf(index, now);
    if (CHILDREN_FIRST.has(index)) all.push(...children, parent);
    else all.push(parent, ...children);
  });
  return all;
}

// ------------------------------------------------------------ comments

const BUSY_LINES = [
  "Added the facility items to the agenda.",
  "Can we move the meeting to 10:00?\nThe therapy rooms are booked at 9.",
  "تم الاتفاق على الموعد الجديد يوم الأحد",
  "Minutes from last week are in the shared folder:\nhttps://notes.harbor.test/minutes/last-week",
  "Please bring the monthly numbers.",
  "I will be late, start without me.",
  "شكراً للجميع على الحضور",
  "Two new families start on Monday.\nThe intake forms are ready.\nPlease check the schedule.",
];
const BUSY_AUTHORS = [301, 302, 401, 303, 305, 402, 302, 301];

/** A comment at `at` (epoch ms) in ClickUp's shape. */
const comment = ({ id, at, user, text }) => ({
  id: String(id),
  comment: [{ text }],
  comment_text: text,
  user,
  resolved: false,
  assignee: null,
  assigned_by: null,
  reactions: [],
  date: String(at),
  reply_count: 0,
});

function comments(now) {
  const start = now - 20 * DAY;
  const busy = Array.from({ length: MEETINGS.busyComments }, (_, n) =>
    comment({
      id: 8001 + n,
      at: start + n * 9 * HOUR,
      user: ref(BUSY_AUTHORS[n % BUSY_AUTHORS.length]),
      text: `${BUSY_LINES[n % BUSY_LINES.length]}${n % 8 === 0 ? ` (week ${n / 8 + 1})` : ""}`,
    }),
  );
  const byTask = { [topId(0)]: busy };
  for (let index = 1; index < TOPICS.length; index += 5) {
    byTask[topId(index)] = Array.from({ length: 1 + (index % 3) }, (_, n) =>
      comment({
        id: 9001 + index * 10 + n,
        at: now - (30 - index / 2) * DAY + n * HOUR,
        user: ref(n === 1 ? 401 : USERS[(index + n) % USERS.length].id),
        text: BUSY_LINES[(index + n) % BUSY_LINES.length],
      }),
    );
  }
  return byTask;
}

const place = (id, fields) => ({
  id,
  private: false,
  archived: false,
  ...fields,
});

/** A fresh copy of the meetings account (see the module comment). */
export function meetingsFixture({ now = T0 } = {}) {
  return {
    users: USERS.map((user) => ({ ...user })),
    teams: [
      {
        id: "9101",
        name: "Harbor Learning Center",
        color: "#7b68ee",
        members: USERS.map((user) => user.id),
      },
    ],
    spaces: [place("91010001", { team_id: "9101", name: "Operations" })],
    folders: [],
    lists: [
      {
        id: MEETINGS_LIST,
        space_id: "91010001",
        folder_id: null,
        name: MEETINGS.board,
        content: "Topics of the weekly all-departments meeting",
        archived: false,
        statuses: STATUSES,
        fields: FIELDS,
      },
    ],
    tasks: tasks(now),
    comments: comments(now),
    replies: {},
    docs: [],
  };
}
