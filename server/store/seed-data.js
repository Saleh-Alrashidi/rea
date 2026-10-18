/**
 * Seed tables (SPEC.md seed and SPEC-2 §2.1) used by `store/seed.js`.
 * Rows are "|"-separated fields; people are first-name keys ("alex").
 */
import { DEFAULT_CONTENT } from "./boards.js";

const DEFAULT_COLUMNS = DEFAULT_CONTENT.columns;

// name | email | role | title | status
export const FIRST_USERS = [
  "Alex Rivera|alex@example.test|admin|Head of Product|active",
  "Sam Lee|sam@example.test|member|Product Designer|active",
  "Noa Cohen|noa@example.test|member|Engineering Lead|active",
];
export const MORE_USERS = [
  "Priya Nair|priya@example.test|member|Marketing Manager|active",
  "Jordan Blake|jordan@example.test|viewer|Finance Analyst|active",
  "Chris Taylor|chris@agency.test|guest|Agency Partner|active",
  "Morgan Diaz|morgan@example.test|member|Former Engineer|deactivated",
];

// name | description | owner | members
export const TEAMS = [
  "Product|Builds the product|alex|sam,noa",
  "Marketing|Tells the world|priya|sam",
  "Leadership|Company direction|alex|",
];

// Items: group | name | status index | owners | date | estimate | notes
export const BOARDS = {
  roadmap: {
    name: "Product roadmap",
    description: "What we are building this quarter",
    groups: [
      "this_sprint|This sprint|#579bfc",
      "next_up|Next up|#a25ddc",
      "done|Done|#00c875",
    ],
    columns: [
      "name|Name|name",
      "status|Status|status",
      "person|Owner|people",
      "date|Due date|date",
      "estimate|Estimate|numbers",
      "notes|Notes|text",
    ],
    items: [
      "this_sprint|Design onboarding flow|0|alex|2026-10-20|5|Wireframes ready",
      "this_sprint|Set up CI pipeline|1|sam|2026-10-14|3|",
      "this_sprint|Fix login timeout bug|2|noa|2026-10-16|2|Waiting on auth logs",
      "next_up|Kanban drag and drop||alex,sam|2026-11-02|8|",
      "next_up|Dark mode polish|0|noa||3|Check table contrast",
      "next_up|API rate limits|||2026-11-10|5|Per-token budgets",
      "done|Board sharing|1|sam|2026-10-01||",
      "done|Item card comments|1|alex,noa|2026-10-05|2.5|Shipped in 2026-01",
    ],
  },
  // Priya and Chris join after the part-1 records, so these owners are
  // applied once they exist.
  marketing: {
    name: "Marketing launch",
    description: "Launch checklist for the next release",
    ...DEFAULT_CONTENT,
    items: [
      "topics|Write launch blog post|0|priya|2026-10-25||",
      "topics|Prepare demo video|2|chris|||",
      "topics|Announce on social|||2026-10-30||",
    ],
  },
  hiring: {
    name: "Hiring plan",
    description: "Open roles for 2027",
    groups: ["open_roles|Open roles|#579bfc", "filled|Filled|#00c875"],
    columns: DEFAULT_COLUMNS,
    items: [
      "open_roles|Senior backend engineer|0|noa|2026-11-15||",
      "open_roles|Product designer||alex|2026-12-01||",
      "filled|Engineering manager|1|alex|2026-09-30||",
    ],
  },
  budget: {
    name: "Budget 2027",
    description: "Planned spend by area",
    groups: ["opex|Operating costs|#579bfc", "investments|Investments|#a25ddc"],
    columns: [...DEFAULT_COLUMNS, "estimate|Amount|numbers"],
    items: [
      "opex|Cloud infrastructure|0|alex||120000|",
      "opex|Team offsites|5|alex|2027-03-01|18000|",
      "investments|Design system refresh|0|alex|2027-01-15|45000|",
    ],
  },
};

// Updates on the first roadmap item: author | body
export const UPDATES = [
  "sam|Can we review the wireframes on Thursday?",
  "alex|Yes, I will share the link before then.",
];

// type | text | "x" when a to-do is checked
export const DOCS = [
  {
    title: "Product vision",
    workspace: "main",
    visibility: "workspace",
    members: ["user:alex:owner"],
    blocks: [
      "heading1|Product vision",
      "paragraph|Worklane helps small teams plan, track and ship work in one calm place.",
      "paragraph|We favour clarity over configuration: every board should explain itself.",
      "heading2|This quarter",
      "todo|Ship shareable boards for agency partners|x",
      "todo|Launch forms for feature requests|",
      "todo|Publish the design system tokens|",
      "callout|Draft: comments welcome until Friday.",
    ],
  },
  {
    title: "Launch brief",
    workspace: "main",
    visibility: "private",
    members: ["user:priya:owner", "user:chris:viewer", "team:marketing:editor"],
    blocks: [
      "heading1|Launch brief",
      "paragraph|Goals, audiences and channels for the autumn launch.",
      "bulleted|Audience: operations leads at 20-200 person companies",
      "bulleted|Channels: blog, newsletter, partner webinars",
      "bulleted|Timing: last week of October",
      "quote|Make the first board feel finished in five minutes.",
    ],
  },
  {
    title: "Leadership offsite",
    workspace: "leadership",
    visibility: "workspace",
    members: ["user:alex:owner"],
    blocks: [
      "heading1|Leadership offsite",
      "paragraph|Two days to agree on the 2027 plan.",
      "numbered|Review the 2026 results",
      "numbered|Agree on three company priorities",
      "numbered|Budget and hiring plan",
      "divider|",
      "paragraph|Location and travel details follow.",
    ],
  },
];

// owner | title | body | color | "pinned" | shares (kind:key:role, comma-separated)
export const NOTES = [
  "alex|Ideas for Q1|Weekly product office hours\nTemplates gallery for new boards|#fff4c2|pinned|",
  "alex|1:1 with Sam|Career goals, design crit cadence, conference budget|#dff4ff||user:sam:viewer",
  "sam|Design crit notes|Empty states need one clear action.\nCheck focus rings in dark mode.|#e8f5e9||",
  "priya|Launch checklist|Blog post\nNewsletter\nPartner webinar invites|#fde7ef||team:marketing:editor",
];

// Questions: id | column | label | "required"
export const FORMS = [
  {
    board: "roadmap",
    title: "Feature request",
    description: "Tell us what would make Worklane better.",
    questions: [
      "q1|name|Request title|required",
      "q2|notes|Details|",
      "q3|status|Priority-ish status|",
      "q4|date|Needed by|",
    ],
    targetGroupId: "next_up",
    access: "public",
    submitMessage: "Thanks! The product team reviews every request.",
    createdBy: "alex",
  },
  {
    board: "marketing",
    title: "Campaign intake",
    description: "Request a campaign from the marketing team.",
    accentColor: "#d6336c",
    questions: ["q1|name|Campaign name|required", "q2|date|Launch date|"],
    access: "account",
    createdBy: "priya",
  },
];

// board | actor | kind | item index | column | from | to
export const ACTIVITY = [
  "roadmap|alex|item_created|5|||Next up",
  "roadmap|sam|column_value_changed|1|status|Working on it|Done",
  "roadmap|noa|column_value_changed|2|status|Working on it|Stuck",
  "roadmap|alex|column_value_changed|0|date|2026-10-17|2026-10-20",
  "marketing|priya|column_value_changed|1|status|Working on it|Stuck",
];

// user | actor | kind | target ("roadmap:<item index>" or "note:<title>")
export const INBOX = [
  "alex|sam|update|roadmap:0",
  "alex|noa|assign|roadmap:7",
  "sam|alex|share|note:1:1 with Sam",
  "sam|alex|assign|roadmap:3",
];
