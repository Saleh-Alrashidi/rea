/**
 * Items of the monday.com fixture account, in monday's shapes: one column
 * of every `ColumnType` (`settings_str` as JSON text), column values with
 * `text`, JSON-text `value` and `__typename` (`display_value` for linked
 * columns), subitems whose columns carry `column { title settings_str }`,
 * and updates (newest first) with HTML `body`, `text_body` and replies.
 */

const json = (value) => (value === null ? null : JSON.stringify(value));
const pascal = (type) =>
  type.replace(/(^|_)([a-z])/g, (_, __, letter) => letter.toUpperCase());
const LINKED = new Set(["mirror", "board_relation", "dependency", "subtasks"]);

/** A board column from `[id, title, type, settings]`. */
export function column([id, title, type, settings = {}]) {
  const settings_str = JSON.stringify(settings);
  return { id, title, type, settings_str, archived: false };
}

/** A column value of `col` from `[text, value, extra]`, or an empty one. */
function columnValue(col, entry) {
  const linked = LINKED.has(col.type);
  const [text, value, extra] = entry ?? [linked ? null : "", null];
  return {
    __typename: `${pascal(col.type)}Value`,
    id: col.id,
    type: col.type,
    text,
    value: json(value),
    column: { title: col.title, settings_str: col.settings_str },
    ...(linked ? { display_value: "" } : {}),
    ...extra,
  };
}

/** Values for every non-name column (monday returns all of them). */
export function valuesFor(columns, entries = {}) {
  return columns
    .filter((col) => col.type !== "name")
    .map((col) => columnValue(col, entries[col.id]));
}

export function update(id, [text, html, at], extra = {}) {
  const creator = { id: "1", name: "Dana Scully" };
  return {
    id,
    body: html,
    text_body: text,
    created_at: at,
    creator,
    replies: [],
    ...extra,
  };
}

export const STATUS_SETTINGS = {
  labels: { 0: "Working on it", 1: "Done", 2: "Stuck", 3: "", 5: "" },
  labels_colors: {
    0: { color: "#fdab3d", border: "#e99729", var_name: "orange" },
    1: { color: "#00c875", border: "#00b461", var_name: "green-shadow" },
    2: { color: "#df2f4a", border: "#ce3048", var_name: "red-shadow" },
    3: { color: "#0086c0", border: "#3db0df", var_name: "blue-links" },
    5: { color: "#c4c4c4", border: "#b0b0b0", var_name: "grey" },
  },
  labels_positions_v2: { 0: 0, 1: 2, 2: 1, 3: 3, 5: 4 },
};

const UNIT = { unit: { symbol: "$", custom_unit: "", direction: "left" } };
const AREAS = {
  labels: [
    { id: 1, name: "Backend" },
    { id: 2, name: "Frontend" },
  ],
};

/** The Roadmap board's columns: one of every monday ColumnType. */
export const ROADMAP_COLUMNS = [
  ["name", "Name", "name"],
  ["status", "Status", "status", STATUS_SETTINGS],
  ["person", "Owner", "people"],
  ["date4", "Due", "date"],
  ["numbers", "Budget", "numbers", UNIT],
  ["text", "Summary", "text"],
  ["long_text", "Notes", "long_text"],
  ["dropdown", "Area", "dropdown", AREAS],
  ["tags", "Tags", "tags"],
  ["timeline", "Timeline", "timeline"],
  ["link", "Spec link", "link"],
  ["email", "Contact", "email"],
  ["phone", "Phone", "phone"],
  ["checkbox", "Approved", "checkbox"],
  ["rating", "Rating", "rating", { max_rating: 5 }],
  ["mirror", "Account owner", "mirror"],
  ["formula", "Score", "formula", { formula: "{numbers}*2" }],
  ["file", "Files", "file"],
  ["auto_number", "Ticket", "auto_number"],
  ["board_relation", "Customers", "board_relation", { boardIds: [900] }],
  ["button", "Ping", "button"],
  ["color_picker", "Brand color", "color_picker"],
  ["country", "Country", "country"],
  ["creation_log", "Created", "creation_log"],
  ["dependency", "Blocked by", "dependency"],
  ["doc", "Brief", "doc"],
  ["group", "Group", "group"],
  ["hour", "Standup", "hour"],
  ["integration", "Jira", "integration"],
  ["item_assignees", "Assignees", "item_assignees"],
  ["item_id", "Item ID", "item_id"],
  ["last_updated", "Last updated", "last_updated"],
  ["location", "Office", "location"],
  ["progress", "Progress", "progress"],
  ["subitems", "Subitems", "subtasks", { boardIds: [102] }],
  ["team", "Team", "team"],
  ["time_tracking", "Time tracked", "time_tracking"],
  ["unsupported", "Legacy", "unsupported"],
  ["vote", "Votes", "vote"],
  ["week", "Week", "week"],
  ["world_clock", "Clock", "world_clock"],
].map(column);

const people = (...ids) => ({
  personsAndTeams: ids.map(([id, kind = "person"]) => ({ id, kind })),
});
const linked = (...ids) => ({
  linkedPulseIds: ids.map((id) => ({ linkedPulseId: id })),
});
const FILE = { files: [{ name: "plan.pdf", assetId: 7, isImage: "false" }] };
const DOC_URL = "https://acme.monday.com/docs/55";
const SPEC_URL = "https://docs.acme.test/spec";
const WEEK = { week: { startDate: "2025-04-07", endDate: "2025-04-13" } };
const PLACE = { lat: "40.1", lng: "-75.2", address: "1 Main St, Springfield" };

/** [text, value, extra] per column of item "Launch MVP" (monday formats). */
export const LAUNCH_VALUES = {
  status: ["Done", { index: 1, post_id: null, changed_at: "2025-03-01" }],
  person: ["Dana Scully, Fox Mulder", people([1], [2])],
  date4: ["2025-04-30", { date: "2025-04-30", icon: null }],
  numbers: ["1250.5", "1250.5"],
  text: ["Ship the first version", "Ship the first version"],
  long_text: ["Line one\nLine two", { text: "Line one\nLine two" }],
  dropdown: ["Backend, Frontend", { ids: [1, 2] }],
  tags: ["launch, q2", { tag_ids: [11, 12] }],
  timeline: [
    "2025-04-01 - 2025-04-30",
    { from: "2025-04-01", to: "2025-04-30" },
  ],
  link: [`Spec - ${SPEC_URL}`, { url: SPEC_URL, text: "Spec" }],
  email: ["pm@acme.test", { email: "pm@acme.test", text: "pm@acme.test" }],
  phone: ["+15551234567", { phone: "+15551234567", countryShortName: "US" }],
  checkbox: ["v", { checked: "true" }],
  rating: ["4", { rating: 4 }],
  mirror: [null, null, { display_value: "Globex, Initech" }],
  formula: ["2501", null],
  file: ["https://acme.monday.com/protected_static/plan.pdf", FILE],
  auto_number: ["17", null],
  board_relation: [null, linked(9001), { display_value: "Globex" }],
  color_picker: ["#ff0000", { color: { hex: "#ff0000" } }],
  country: [
    "United States",
    { countryCode: "US", countryName: "United States" },
  ],
  creation_log: ["2025-03-01 10:00:00 UTC", null],
  dependency: [null, linked(1002), { display_value: "Fix login bug" }],
  doc: [DOC_URL, { files: [{ linkToFile: DOC_URL }] }],
  group: ["This sprint", null],
  hour: ["09:30", { hour: 9, minute: 30 }],
  integration: ["JIRA-42", null],
  item_assignees: ["Dana Scully", null],
  item_id: ["1001", null],
  last_updated: ["2025-03-02 08:00:00 UTC", null],
  location: [PLACE.address, PLACE],
  progress: ["100%", null],
  subitems: [
    null,
    linked(2001, 2002),
    { display_value: "Design spec, Build API" },
  ],
  team: ["Platform", { team_id: 51 }],
  time_tracking: ["01:00:00", { running: "false", duration: 3600 }],
  vote: ["2", { votersIds: [1, 2] }],
  week: ["2025-04-07 - 2025-04-13", WEEK],
  world_clock: ["Europe/London", { timezone: "Europe/London" }],
};

const BLOCKED = { labels: { 0: "Working on it", 1: "Done", 4: "Blocked" } };
BLOCKED.labels_colors = { 0: { color: "#fdab3d" }, 4: { color: "#7f5347" } };

/** Columns of the subitems board: Status/Owner match, Estimate/Notes do not. */
export const SUBITEM_COLUMNS = [
  ["name", "Name", "name"],
  ["status", "Status", "status", BLOCKED],
  ["person", "Owner", "people"],
  ["numbers", "Estimate", "numbers"],
  ["text", "Notes", "text"],
].map(column);

function subitems() {
  const draft = [
    "Draft attached",
    "<p>Draft attached</p>",
    "2025-03-03T09:00:00Z",
  ];
  const design = {
    id: "2001",
    name: "Design spec",
    created_at: "2025-03-02T09:00:00Z",
    creator: { id: "2" },
    column_values: valuesFor(SUBITEM_COLUMNS, {
      status: ["", { index: 4 }],
      person: ["Fox Mulder", people([2])],
      numbers: ["3", "3"],
      text: ["Needs review", "Needs review"],
    }),
    updates: [update("3101", draft)],
  };
  const api = {
    id: "2002",
    name: "Build API",
    created_at: "2025-03-02T10:00:00Z",
    creator: { id: "1" },
    column_values: valuesFor(SUBITEM_COLUMNS, {
      status: ["Done", { index: 1 }],
    }),
    updates: [],
  };
  return [design, api];
}

function launchUpdates() {
  const fox = { id: "2", name: "Fox Mulder" };
  const former = { id: "900", name: "Former Employee" };
  const reply = update(
    "3005",
    ["Thanks!", "<p>Thanks!</p>", "2025-03-04T12:30:00Z"],
    { creator: fox },
  );
  const html = "<p>Fish &amp; chips &lt;3<br>Second line &#x263A;</p>";
  // monday lists updates newest first.
  return [
    update("3004", ["", "<p><img src='x.png'></p>", "2025-03-05T08:00:00Z"]),
    update("3003", [null, html, "2025-03-04T12:00:00Z"], { replies: [reply] }),
    update(
      "3002",
      ["Kickoff done", "<p><b>Kickoff</b> done</p>", "2025-03-03T12:00:00Z"],
      { creator: former },
    ),
    update("3001", [
      "Planning started",
      "<p>Planning</p>",
      "2025-03-02T12:00:00Z",
    ]),
  ];
}

function hundredUpdates() {
  return Array.from({ length: 100 }, (_, n) => {
    const at = new Date(Date.UTC(2025, 0, 1, 0, 100 - n)).toISOString();
    return update(String(4000 + n), [`Note ${100 - n}`, "<p>Note</p>", at]);
  });
}

const item = (fields) => ({
  subitems: [],
  updates: [],
  creator: { id: "1" },
  ...fields,
});

/** Roadmap items: three hand-made ones and 450 fillers (three pages). */
export function roadmapItems(columns) {
  const launch = item({
    id: "1001",
    name: "Launch MVP",
    created_at: "2025-03-01T10:00:00Z",
    group: { id: "this_sprint" },
    column_values: valuesFor(columns, LAUNCH_VALUES),
    subitems: subitems(),
    updates: launchUpdates(),
  });
  const bug = item({
    id: "1002",
    name: "Fix login bug",
    created_at: "2025-03-01T11:00:00Z",
    creator: { id: "900" },
    group: { id: "this_sprint" },
    column_values: valuesFor(columns, {
      status: ["Stuck", { index: 2 }],
      person: ["Dana, Platform, Former", people([1], [51, "team"], [900])],
      // `value` is UTC; `text` is in the token user's zone (here UTC+9).
      date4: ["2025-05-03 08:30", { date: "2025-05-02", time: "23:30:00" }],
      text: ["x".repeat(2100), "x".repeat(2100)],
    }),
  });
  const odd = item({
    id: "1003",
    name: "N".repeat(300),
    created_at: "not a date",
    creator: null,
    group: { id: "next_up" },
    column_values: valuesFor(columns, {
      numbers: ["abc", "abc"],
      date4: ["", { date: "2025-02-30" }],
    }),
    updates: hundredUpdates(),
  });
  const filler = Array.from({ length: 450 }, (_, n) =>
    item({
      id: String(10_000 + n),
      name: `Backlog item ${n + 1}`,
      created_at: "2025-01-01T00:00:00Z",
      creator: { id: "3" },
      group: { id: n === 0 ? "gone" : "later" },
      column_values: valuesFor(columns, {
        status: n % 2 ? ["Working on it", { index: 0 }] : ["", null],
      }),
    }),
  );
  return [launch, bug, odd, ...filler];
}
