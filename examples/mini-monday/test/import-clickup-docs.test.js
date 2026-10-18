/**
 * Docs of the ClickUp connector (SPEC-4 §3.2) against the fake ClickUp v3
 * API: listing pages, placement by parent, visibility, page trees as
 * blocks, and the markdown → block conversion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { markdownBlocks } from "../server/import/connectors/clickup-docs.js";
import {
  codes,
  docs,
  fullScan,
  routed,
} from "./fixtures/import/clickup-scan.js";

test("docs: v3 pages, placement and visibility", async () => {
  const { server, snapshot } = await fullScan();
  const listing = routed(server, "docs");
  assert.deepEqual(
    listing.map((r) => [
      r.params.team,
      r.query.limit,
      r.query.deleted,
      r.query.archived,
      !!r.query.next_cursor,
    ]),
    [
      ["9001", "50", "false", "false", false],
      ["9001", "50", "false", "false", true],
      ["9002", "50", "false", "false", false],
    ],
  );
  const pages = routed(server, "pages");
  assert.equal(pages.length, 55, "every doc but the deleted one");
  assert.ok(
    pages.every(
      (r) =>
        r.query.max_page_depth === "-1" && r.query.content_format === "text/md",
    ),
  );
  const placed = snapshot.workspaces.map((ws) => [
    ws.name,
    ws.docs.map((d) => d.title).slice(0, 2),
  ]);
  assert.deepEqual(placed, [
    ["Acme Corp / Product", ["Engineering handbook", "Secret plan"]],
    ["Acme Corp / Leadership", ["Hiring rubric"]],
    ["Side Project / Garden", []],
    ["Acme Corp / Workspace docs", ["Company wiki", "Lost doc"]],
  ]);
  assert.equal(
    snapshot.workspaces[0].docs.length,
    52,
    "handbook, secret plan, 50 notes",
  );
  assert.ok(!docs(snapshot).some((d) => d.title === "Deleted doc"));
  const visibility = Object.fromEntries(
    docs(snapshot)
      .slice(0, 3)
      .map((d) => [d.title, d.visibility]),
  );
  assert.deepEqual(visibility, {
    "Engineering handbook": "workspace",
    "Secret plan": "private",
    "Note 1": "private",
  });
  const [lost] = codes(snapshot, "unknown_workspace");
  assert.equal(lost.path, "workspaces[3]");
  assert.match(
    lost.message,
    /"Lost doc" \(90019999\).*"Acme Corp \/ Workspace docs"/,
  );
  assert.equal(
    codes(snapshot, "unknown_workspace").length,
    1,
    "workspace-level docs are no loss",
  );
  assert.deepEqual(
    docs(snapshot).find((d) => d.title === "Company wiki").blocks,
    [{ type: "paragraph", text: "Hello" }],
    "a page named like its doc adds no heading",
  );
});

test("doc pages become blocks with page headings", async () => {
  const { snapshot, valid } = await fullScan();
  const handbook = docs(snapshot).find(
    (d) => d.title === "Engineering handbook",
  );
  assert.equal(handbook.source_id, "8chand-1");
  assert.deepEqual(handbook.blocks, [
    { type: "heading1", text: "Welcome" },
    { type: "paragraph", text: "Intro paragraph with **bold** text" },
    { type: "heading2", text: "Setup" },
    { type: "heading2", text: "Deep heading" },
    { type: "bulleted", text: "Install Node" },
    { type: "bulleted", text: "Clone the repo" },
    { type: "todo", text: "Read the guide", checked: false },
    { type: "todo", text: "Get access", checked: true },
    { type: "numbered", text: "First step" },
    { type: "numbered", text: "Second step" },
    { type: "quote", text: "Remember this" },
    { type: "divider", text: "" },
    { type: "code", text: "const x = 1;\n\nconsole.log(x);" },
    { type: "paragraph", text: "Last line" },
    { type: "heading2", text: "Onboarding" },
    { type: "todo", text: "Laptop", checked: true },
    { type: "todo", text: "Badge", checked: false },
    { type: "heading2", text: "Day one" },
    { type: "paragraph", text: "Say hi" },
    { type: "heading1", text: "Release process" },
    { type: "numbered", text: "Branch" },
    { type: "numbered", text: "Ship" },
    { type: "code", text: "unclosed code" },
  ]);
  const lost = docs(valid.snapshot).find((d) => d.title === "Lost doc");
  assert.deepEqual(lost.blocks, []);
  assert.ok(!valid.snapshot.warnings.some((w) => w.code === "unknown_block"));
});

test("markdown lines become blocks", () => {
  const blocks = [];
  markdownBlocks(
    [
      "# Title ##",
      "#hashtag",
      "####### seven",
      "- - -",
      "  * [X] Indented done",
      "+ plus",
      "-not a bullet",
      "10. ten",
      ">quote",
      "````",
      "```",
      "```` not a fence",
      "still code",
      "`````",
      "~~~ts",
      "```",
      "~~~",
      "after",
    ].join("\r\n"),
    (block) => blocks.push(block),
  );
  assert.deepEqual(blocks, [
    { type: "heading1", text: "Title" },
    { type: "paragraph", text: "#hashtag" },
    { type: "paragraph", text: "####### seven" },
    { type: "divider", text: "" },
    { type: "todo", text: "Indented done", checked: true },
    { type: "bulleted", text: "plus" },
    { type: "paragraph", text: "-not a bullet" },
    { type: "numbered", text: "ten" },
    { type: "quote", text: "quote" },
    { type: "code", text: "```\n```` not a fence\nstill code" },
    { type: "code", text: "```" },
    { type: "paragraph", text: "after" },
  ]);
  const none = [];
  markdownBlocks(undefined, (block) => none.push(block));
  assert.deepEqual(none, []);
});
