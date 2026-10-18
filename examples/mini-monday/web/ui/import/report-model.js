/**
 * The done step's model (SPEC-4 §4 Report, §6.5): created counts as
 * tiles, links to what was created grouped by kind, and what was not
 * imported grouped by reason. Pure.
 *
 * Links come from the server (`report.links[].url`, "#/boards/12"); only
 * in-app hashes are kept (`hashFromUrl`), so report data can never point
 * the page elsewhere.
 */

import { hashFromUrl } from "../../router.js";

const CREATED = Object.freeze([
  {
    key: "workspaces",
    one: "Workspace",
    label: "Workspaces",
    icon: "workspace",
  },
  { key: "boards", one: "Board", label: "Boards", icon: "grid" },
  { key: "items", one: "Item", label: "Items", icon: "item" },
  { key: "updates", one: "Update", label: "Updates", icon: "chat" },
  { key: "docs", one: "Doc", label: "Docs", icon: "docs" },
  {
    key: "users",
    one: "Person invited",
    label: "People invited",
    icon: "userPlus",
  },
  { key: "groups", one: "Group", label: "Groups", icon: "table" },
  { key: "columns", one: "Column", label: "Columns", icon: "kanban" },
]);

const LINK_KINDS = Object.freeze([
  { kind: "workspace", title: "Workspaces", icon: "workspace" },
  { kind: "board", title: "Boards", icon: "grid" },
  { kind: "doc", title: "Docs", icon: "docs" },
]);

const REASONS = Object.freeze({
  cancelled: "Not imported because the import was stopped",
  not_allowed: "Not imported because you can no longer import",
  failed: "Failed",
  excluded: "Not selected",
  skipped: "People left out",
});

const KIND_NAMES = Object.freeze({
  user: "Person",
  board: "Board",
  doc: "Doc",
  workspace: "Workspace",
});

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** `[{ key, label, icon, value }]` for every created count ("1 Board"). */
export function createdTiles(created = {}) {
  return CREATED.map(({ one, ...entry }) => {
    const value = count(created[entry.key]);
    return { ...entry, label: value === 1 ? one : entry.label, value };
  });
}

/** Links grouped by kind: `[{ kind, title, icon, links: [{ title, href }] }]`. */
export function linkSections(links = []) {
  return LINK_KINDS.map((section) => ({
    ...section,
    links: links
      .filter((entry) => entry?.kind === section.kind)
      .map((entry) => ({
        title: String(entry.title ?? ""),
        href: hashFromUrl(String(entry.url ?? "")),
      }))
      .filter((entry) => entry.href !== null),
  })).filter((section) => section.links.length > 0);
}

/**
 * Entries that were not imported, grouped by reason (stops and failures
 * first): `[{ reason, title, entries: [{ kind, kindName, name, path }] }]`.
 */
export function skippedSections(skipped = []) {
  return Object.entries(REASONS)
    .map(([reason, title]) => ({
      reason,
      title,
      entries: skipped
        .filter((entry) => entry?.reason === reason)
        .map((entry) => ({
          kind: entry.kind,
          kindName: KIND_NAMES[entry.kind] ?? "Entry",
          name: String(entry.name ?? ""),
          path: String(entry.path ?? ""),
        })),
    }))
    .filter((section) => section.entries.length > 0);
}

const counted = (value, noun) =>
  `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;

/** The done step's heading and sentence. */
export function doneSummary(report) {
  const created = report?.created ?? {};
  const what = [
    counted(count(created.boards), "board"),
    counted(count(created.items), "item"),
    counted(count(created.docs), "doc"),
  ];
  const list = `${what.slice(0, -1).join(", ")} and ${what.at(-1)}`;
  if (report?.cancelled) {
    return {
      title: "Import stopped",
      text: `The import was stopped after ${list}. What was created stays; the rest is listed below.`,
    };
  }
  return { title: "Import finished", text: `Created ${list}.` };
}
