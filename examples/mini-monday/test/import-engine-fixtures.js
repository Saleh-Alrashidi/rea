/**
 * Hand-built import snapshots (SPEC-4 §2) for the importer suites
 * (`test/import-*.test.js`), named after the seeded Worklane users they
 * map to: Sam (member), Chris (guest), Jordan (viewer account) and Morgan
 * (deactivated) by email, plus a new person and one without an email.
 * Every call returns a fresh copy, so tests can change it freely.
 */
import { createStore } from "../server/store.js";
import { seedIds } from "./helpers.js";

/** The Roadmap board's columns: one of every Worklane type. */
function roadmapColumns() {
  return [
    {
      source_id: "status",
      title: "Status",
      type: "status",
      original_type: "status",
      labels: [
        { label: "Working on it", color: "#fdab3d" },
        { label: "Done", color: "#00c875" },
      ],
    },
    {
      source_id: "owner",
      title: "Owner",
      type: "people",
      original_type: "people",
    },
    { source_id: "due", title: "Due", type: "date", original_type: "date" },
    {
      source_id: "est",
      title: "Estimate",
      type: "numbers",
      original_type: "numbers",
    },
    {
      source_id: "notes",
      title: "Notes",
      type: "text",
      original_type: "long_text",
    },
  ];
}

/** The "Roadmap" board: a Shareable board with every column type. */
function roadmap() {
  return {
    source_id: "b-roadmap",
    name: "Roadmap",
    description: "Product roadmap",
    kind: "share",
    source_url: "https://acme.monday.com/boards/101",
    members: [
      { user_source_id: "u-sam", role: "editor" },
      { user_source_id: "u-chris", role: "viewer" },
      { user_source_id: "u-jordan", role: "editor" },
      { user_source_id: "u-morgan", role: "editor" },
      { user_source_id: "u-anon", role: "viewer" },
    ],
    columns: roadmapColumns(),
    groups: [
      { source_id: "g-now", title: "Now", color: "#fdab3d" },
      { source_id: "g-later", title: "Later", color: "#579bfc" },
    ],
    items: [
      {
        source_id: "i-1",
        name: "Launch site",
        group_source_id: "g-now",
        parent_source_id: null,
        values: {
          status: "Done",
          owner: ["u-sam", "u-anon"],
          due: "2026-11-01",
          est: 3,
          notes: "Ship it",
        },
        created_at: "2025-03-04T05:06:07.000Z",
        creator_source_id: "u-sam",
        updates: [
          {
            body: "Kickoff done",
            author_source_id: "u-sam",
            author_name: "Sam L.",
            created_at: "2025-03-05T00:00:00.000Z",
          },
          {
            body: "Ping",
            author_source_id: null,
            author_name: "Old Admin",
            created_at: null,
          },
        ],
      },
      {
        source_id: "i-2",
        name: "Write copy",
        group_source_id: "g-now",
        parent_source_id: "i-1",
        values: { status: "Working on it" },
        created_at: null,
        creator_source_id: null,
        updates: [],
      },
      {
        source_id: "i-3",
        name: "Later thing",
        group_source_id: "g-later",
        parent_source_id: null,
        values: { owner: ["u-chris"] },
        created_at: null,
        creator_source_id: null,
        updates: [],
      },
    ],
  };
}

/** The "Hiring" board: Private, so guests cannot join it. */
function hiring() {
  return {
    source_id: "b-hiring",
    name: "Hiring",
    description: null,
    kind: "private",
    source_url: null,
    members: [
      { user_source_id: "u-sam", role: "editor" },
      { user_source_id: "u-chris", role: "editor" },
    ],
    columns: [
      {
        source_id: "who",
        title: "Who",
        type: "people",
        original_type: "people",
      },
    ],
    groups: [{ source_id: "g", title: "Open roles", color: "#a25ddc" }],
    items: [
      {
        source_id: "h-1",
        name: "Designer",
        group_source_id: "g",
        parent_source_id: null,
        values: { who: ["u-jordan", "u-sam"] },
        created_at: null,
        creator_source_id: null,
        updates: [],
      },
    ],
  };
}

/** A small snapshot over two workspaces with one doc. */
export function sampleSnapshot() {
  return {
    source: "monday",
    source_label: "monday.com account Acme",
    users: [
      { source_id: "u-sam", name: "Sam L.", email: "SAM@example.test" },
      { source_id: "u-chris", name: "Chris T.", email: "chris@agency.test" },
      {
        source_id: "u-jordan",
        name: "Jordan B.",
        email: "jordan@example.test",
      },
      {
        source_id: "u-morgan",
        name: "Morgan D.",
        email: "morgan@example.test",
      },
      { source_id: "u-new", name: "Nia New", email: "nia@acme.test" },
      { source_id: "u-anon", name: "Anon", email: null },
    ],
    workspaces: [
      {
        source_id: "w-main",
        name: "Acme main",
        description: "From monday.com",
        kind: "open",
        boards: [roadmap(), hiring()],
        docs: [
          {
            source_id: "d-1",
            title: "Handbook",
            blocks: [
              { type: "heading1", text: "Welcome" },
              { type: "todo", text: "Read this", checked: true },
            ],
          },
        ],
      },
      {
        source_id: "w-archive",
        name: "Archive",
        description: null,
        kind: "closed",
        boards: [
          {
            ...hiring(),
            source_id: "b-old",
            name: "Old board",
            members: [],
            items: [],
          },
        ],
        docs: [],
      },
    ],
    warnings: [
      {
        code: "unsupported_column",
        message: "Column “Files” (file) became text",
        path: "workspaces[0].boards[0].columns[4]",
      },
    ],
  };
}

/** A fresh seeded in-memory store with its IDs and recorded events. */
export async function seededStore() {
  const store = await createStore({ file: null });
  const events = [];
  store.on((event) => events.push(event));
  return { store, ids: seedIds(store), events };
}
