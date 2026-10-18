/**
 * The import Report (SPEC-4 §4) as `engine.run` builds it: created counts,
 * skipped entries, warnings (the snapshot's, then the run's) and links to
 * what was created, plus the texts that describe a run.
 *
 * Report = { created: { workspaces, boards, groups, columns, items,
 * updates, docs, users }, skipped: [{ kind, source_id, name, path, reason
 * }], warnings: [{ code, message, path }], links: [{ kind, id, url, title
 * }], cancelled }. Skip reasons: "skipped" (users), "excluded" (not
 * selected), "failed", "cancelled" and "not_allowed" (the importer lost
 * `import_data` during the run).
 */
import { resourceUrl } from "../store/activity.js";

const CREATED = [
  "workspaces",
  "boards",
  "groups",
  "columns",
  "items",
  "updates",
  "docs",
  "users",
];

/** "1 board", "3 boards". */
export const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A new report that starts with the snapshot's warnings. */
export function createReport(snapshot) {
  return {
    created: Object.fromEntries(CREATED.map((key) => [key, 0])),
    skipped: [],
    warnings: [...snapshot.warnings],
    links: [],
    cancelled: false,
  };
}

export const warn = (report, { code, message, path }) =>
  report.warnings.push({ code, message, path });

/** Lists a snapshot entry (user, board, doc) as skipped. */
export function skip(report, { kind, entry, path, reason }) {
  const name = entry.name ?? entry.title;
  report.skipped.push({ kind, source_id: entry.source_id, name, path, reason });
}

/** Links a created workspace, board or doc. */
export function link(report, kind, record) {
  const { id } = record;
  const title = record.name ?? record.title;
  report.links.push({ kind, id, url: resourceUrl(kind, id), title });
}

const names = (list) => [...list].join(", ");

/**
 * Warnings about what one imported board left out: grants `canGrant`
 * refused, members and people values of skipped users, and people who
 * cannot open the board (`store.importBoard`'s `refused` and
 * `unassigned`, `boardSpec`'s `notes`).
 */
export function boardWarnings(report, { task, built, result, people, store }) {
  const board = task.entry;
  for (const refusal of result.refused) {
    const index = built.memberIndex[refusal.index];
    const name = people.get(board.members[index].user_source_id)?.name;
    const message = `${name} was not given access to “${board.name}”: ${refusal.message}`;
    const path = `${task.path}.members[${index}]`;
    warn(report, { code: "grant_refused", message, path });
  }
  if (built.notes.members.length > 0) {
    const message = `Skipped users were not given access to “${board.name}”: ${names(built.notes.members)}`;
    const path = `${task.path}.members`;
    warn(report, { code: "members_skipped", message, path });
  }
  const columnOf = (key) =>
    board.columns.findIndex((column) => column.source_id === key);
  const columnPath = (key) => `${task.path}.columns[${columnOf(key)}]`;
  for (const [key, entry] of built.notes.people) {
    const { title } = board.columns[columnOf(key)];
    const message = `In “${title}”, skipped users were left out on ${count(entry.items, "item")}: ${names(entry.names)}`;
    warn(report, { code: "people_skipped", message, path: columnPath(key) });
  }
  const unassigned = new Map();
  for (const { columnKey, userIds } of result.unassigned) {
    const found = unassigned.get(columnKey) ?? new Set();
    for (const id of userIds) found.add(store.getUser(id)?.name ?? id);
    unassigned.set(columnKey, found);
  }
  for (const [key, found] of unassigned) {
    const { title } = board.columns[columnOf(key)];
    const message = `People who cannot open “${board.name}” were left out of “${title}”: ${names(found)}`;
    const path = columnPath(key);
    warn(report, { code: "people_unassignable", message, path });
  }
}

/** The `import_finished` notification text of a run labelled `label`. */
export function finishedText(report, label) {
  const { boards, docs, items } = report.created;
  const what = `${count(boards, "board")}, ${count(items, "item")} and ${count(docs, "doc")}`;
  const outcome = report.cancelled ? "was stopped after" : "finished:";
  return `${label} ${outcome} ${what}`;
}
