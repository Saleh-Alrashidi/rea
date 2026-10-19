/**
 * The review step's tree (SPEC-4 §6.3): source workspaces → boards/lists
 * → docs, each with an include checkbox and its counts, and per
 * workspace the target ("New Space" or an existing Space the admin may
 * import into, from the preview's `targets`). A workspace's
 * checkbox includes or leaves out everything in it and shows a mixed
 * state when only some is included.
 *
 * Boards imported before are flagged with the name the copy gets
 * ("<name> (imported again)") and a link to the earlier import. A preview
 * with nothing to import says so (and why that may be) instead.
 *
 * `reviewTree({ preview, selection, onChange })` → `{ element }`;
 * `onChange()` runs after every change to `selection`.
 */

import { h } from "../../dom.js";
import { boardHash } from "../../router.js";
import {
  badge,
  boardKindBadge,
  docVisibilityBadge,
  workspaceKindBadge,
} from "../components/badge.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import {
  setAll,
  setEntry,
  setWorkspace,
  workspaceState,
} from "./plan-model.js";
import { collapsibleList } from "./step-parts.js";

const number = (value) => (value ?? 0).toLocaleString("en-US");
const counted = (value, noun) =>
  `${number(value)} ${noun}${value === 1 ? "" : "s"}`;

function boardMeta(board) {
  const { counts = {} } = board;
  const parts = [counted(counts.items, "item")];
  if (counts.subitems > 0) parts.push(counted(counts.subitems, "subitem"));
  if (counts.updates > 0) parts.push(counted(counts.updates, "update"));
  parts.push(
    counted(counts.columns, "column"),
    counted(counts.groups, "group"),
  );
  return parts.join(" · ");
}

function sourceLink(board) {
  if (typeof board.source_url !== "string") return null;
  let url;
  try {
    url = new URL(board.source_url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return h(
    "a",
    {
      class: "import-source-link",
      href: url.href,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Open in the source",
      "aria-label": `Open “${board.name}” in the source`,
    },
    icon("open", { size: 14 }),
  );
}

function reimportNote(board) {
  if (!board.reimport) return null;
  return h(
    "p",
    { class: "import-reimport" },
    icon("refresh", { size: 14 }),
    h(
      "span",
      null,
      "Imported before as ",
      h("a", { href: boardHash(board.reimport.board_id) }, board.reimport.name),
      `. This creates a new copy named “${board.import_name}”.`,
    ),
  );
}

function entryRow(t, { kind, entry, meta, badges, extra }) {
  const id = t.nextId(kind);
  const box = h("input", {
    id,
    type: "checkbox",
    class: "import-entry-check",
    checked: t.selection[kind].has(entry.source_id),
    dataset: { kind, sourceId: entry.source_id },
    on: {
      change: (event) => {
        const on = event.currentTarget.checked;
        setEntry(t.selection, { kind, id: entry.source_id, on });
        t.sync();
      },
    },
  });
  return h(
    "li",
    { class: "import-entry" },
    box,
    h(
      "div",
      { class: "import-entry-main" },
      h(
        "div",
        { class: "import-entry-line" },
        h(
          "label",
          { class: "import-entry-name", for: id },
          icon(kind === "boards" ? "grid" : "docs", { size: 14 }),
          h("span", null, entry.name ?? entry.title),
        ),
        badges,
        kind === "boards" ? sourceLink(entry) : null,
      ),
      h("p", { class: "import-entry-meta" }, meta),
      extra,
    ),
  );
}

function boardRow(t, board) {
  return entryRow(t, {
    kind: "boards",
    entry: board,
    meta: boardMeta(board),
    badges: [
      board.kind ? boardKindBadge(board.kind) : null,
      board.reimport
        ? badge("Imported before", { tone: "warning", icon: "refresh" })
        : null,
    ],
    extra: reimportNote(board),
  });
}

function docRow(t, doc) {
  return entryRow(t, {
    kind: "docs",
    entry: doc,
    meta: counted(doc.blocks, "block"),
    badges: [doc.visibility ? docVisibilityBadge(doc.visibility) : null],
    extra: null,
  });
}

function targetSelect(t, workspace) {
  const id = t.nextId("target");
  const current = t.selection.targets.get(workspace.source_id) ?? "new";
  const select = h(
    "select",
    {
      id,
      class: "input input-small import-target",
      "aria-label": `Import “${workspace.name}” into`,
      value: current,
      on: {
        change: (event) => {
          t.selection.targets.set(
            workspace.source_id,
            event.currentTarget.value,
          );
          t.onChange();
        },
      },
    },
    h("option", { value: "new" }, `New Space “${workspace.name}”`),
    t.preview.targets.length > 0
      ? h(
          "optgroup",
          { label: "Existing Spaces" },
          t.preview.targets.map((target) =>
            h("option", { value: String(target.id) }, target.name),
          ),
        )
      : null,
  );
  return h(
    "div",
    { class: "import-target-field" },
    h("label", { class: "field-hint", for: id }, "Import into"),
    select,
  );
}

function workspaceBlock(t, workspace) {
  const id = t.nextId("ws");
  const box = h("input", {
    id,
    type: "checkbox",
    class: "import-ws-check",
    on: {
      change: (event) => {
        setWorkspace(t.selection, workspace, event.currentTarget.checked);
        t.sync();
      },
    },
  });
  t.workspaceBoxes.push({ box, workspace });
  const entries = [
    ...workspace.boards.map((board) => boardRow(t, board)),
    ...workspace.docs.map((doc) => docRow(t, doc)),
  ];
  const what = [counted(workspace.boards.length, "board")];
  if (workspace.docs.length > 0)
    what.push(counted(workspace.docs.length, "doc"));
  return h(
    "li",
    { class: "import-ws" },
    h(
      "div",
      { class: "import-ws-head" },
      box,
      h(
        "div",
        { class: "import-ws-main" },
        h(
          "label",
          { class: "import-ws-name", for: id },
          icon("workspace", { size: 16 }),
          h("span", null, workspace.name),
        ),
        h(
          "span",
          { class: "import-ws-meta" },
          workspace.kind ? workspaceKindBadge(workspace.kind) : null,
          h("span", null, what.join(" · ")),
        ),
      ),
      targetSelect(t, workspace),
    ),
    entryList(workspace, entries),
  );
}

/** The workspace's boards and docs (long lists collapsed, see step-parts). */
function entryList(workspace, entries) {
  if (entries.length === 0) {
    return h("p", { class: "import-empty muted" }, "Nothing to import here.");
  }
  return collapsibleList(entries, {
    class: "import-entries",
    "aria-label": `${workspace.name} content`,
  });
}

/** Whether the preview lists any board or doc. */
export const hasContent = (preview) =>
  preview.workspaces.some((ws) => ws.boards.length + ws.docs.length > 0);

function emptyTree() {
  return h(
    "div",
    { class: "import-review-empty" },
    h(
      "p",
      null,
      h("strong", null, "This scan found no boards or docs to import."),
    ),
    h(
      "p",
      null,
      "Check that the token belongs to the right account and that its user can open the boards (archived boards are skipped), or that the file has rows below its header. Then go back and scan again.",
    ),
  );
}

/** Puts every checkbox in step with the selection. */
function sync(t) {
  for (const box of t.element.querySelectorAll(".import-entry-check")) {
    box.checked = t.selection[box.dataset.kind].has(box.dataset.sourceId);
  }
  for (const { box, workspace } of t.workspaceBoxes) {
    const state = workspaceState(t.selection, workspace);
    box.checked = state === "all";
    box.indeterminate = state === "some";
    box.disabled = workspace.boards.length + workspace.docs.length === 0;
  }
}

/** Builds the tree (see the module comment). */
export function reviewTree({ preview, selection, onChange }) {
  if (!hasContent(preview)) return { element: emptyTree() };
  const t = { preview, selection, onChange, workspaceBoxes: [] };
  // Element IDs from a counter: source IDs are arbitrary text.
  let ids = 0;
  t.nextId = (kind) => `import-${kind}-${(ids += 1)}`;
  t.sync = () => {
    sync(t);
    onChange();
  };
  const all = (on) => {
    setAll(selection, preview, on);
    t.sync();
  };
  const list = h(
    "ul",
    { class: "import-tree", "aria-label": "Spaces to import" },
    preview.workspaces.map((workspace) => workspaceBlock(t, workspace)),
  );
  t.element = h(
    "div",
    { class: "import-tree-wrap" },
    h(
      "div",
      { class: "import-tree-tools" },
      button({
        label: "Select all",
        size: "sm",
        variant: "ghost",
        onClick: () => all(true),
      }),
      button({
        label: "Select none",
        size: "sm",
        variant: "ghost",
        onClick: () => all(false),
      }),
    ),
    list,
  );
  sync(t);
  return { element: t.element };
}
