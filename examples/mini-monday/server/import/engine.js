/**
 * The import engine (SPEC-4 §4). It reads only validated snapshots
 * (`snapshot.js`) and writes only through store mutators; who may import
 * is decided by `server/access.js` (`import_data`, `canImportInto`,
 * `canGrant`, `canBeAssigned`).
 *
 * - `preview(snapshot, { store, importerId, mapping })` → counts per
 *   workspace and board, the user mapping proposal, re-import flags, the
 *   workspaces the importer may import into and every warning. `mapping`
 *   is an optional plan (`plan.js`) whose choices the preview reflects.
 * - `run(snapshot, plan, { store, importerId, onProgress, signal, log })`
 *   → Report. Users are matched or invited first, then each included
 *   board is written as one batch (`store.importBoard`: one save, no
 *   per-item events or notifications) and each included doc is created;
 *   the importer owns everything created; the store decides whether a
 *   board with a source folder goes into a folder of its workspace
 *   (SPEC-6 §3.1, `store/imports.js`). `signal` stops the run between
 *   boards and docs; what was created stays and is reported. At the end
 *   the importer gets one `import_finished` notification.
 *
 * A board imported again (same `import.source` and `source_id`) becomes a
 * new copy named "<name> (imported again)"; nothing is merged.
 * Expected failures throw an ImportError (`code`, `details.errors`).
 */
import { can, canImportInto } from "../access.js";
import { LIMITS } from "../input.js";
import { boardSpec } from "./board-spec.js";
import { checkPlan } from "./plan.js";
import {
  boardWarnings,
  count,
  createReport,
  finishedText,
  link,
  skip,
  warn,
} from "./report.js";
import { SOURCE_NAMES, validateSnapshot } from "./snapshot.js";
import { updateCount } from "./snapshot-board.js";
import { truncate } from "./snapshot-rules.js";

export const AGAIN_SUFFIX = " (imported again)";

/** An expected import failure: `code` and `details` (`errors`). */
export class ImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.details = details;
  }
}

/** The activity label of imports from `source` ("Import from ClickUp"). */
export const importLabel = (source) => `Import from ${SOURCE_NAMES[source]}`;

/** The name a board gets; re-imports add AGAIN_SUFFIX within the limit. */
export const importName = (name, again) =>
  again
    ? `${truncate(name, LIMITS.name - AGAIN_SUFFIX.length)}${AGAIN_SUFFIX}`
    : name;

function checkedSnapshot(snapshot) {
  const checked = validateSnapshot(snapshot);
  if (checked.ok) return checked.snapshot;
  const { errors } = checked;
  throw new ImportError("INVALID_SNAPSHOT", "The scan result is not valid", {
    errors,
  });
}

function requireImporter(store, importerId) {
  const importer = store.getUser(importerId);
  if (can(importer, "import_data")) return importer;
  throw new ImportError("FORBIDDEN", "Only admins can import");
}

function checkedPlan(snapshot, plan, options) {
  const checked = checkPlan(snapshot, plan, options);
  if (checked.ok) return checked.plan;
  const { errors } = checked;
  throw new ImportError("INVALID_PLAN", "The import plan is not valid", {
    errors,
  });
}

// ----------------------------------------------------------------- preview

function boardCounts(board) {
  const subitems = board.items.filter((i) => i.parent_source_id !== null);
  const updates = board.items.reduce((sum, i) => sum + updateCount(i), 0);
  return {
    columns: board.columns.length,
    groups: board.groups.length,
    items: board.items.length - subitems.length,
    subitems: subitems.length,
    updates,
  };
}

/** The newest board imported earlier from the same source record. */
function earlierImport(store, source, board) {
  const found = store.listImportedBoards(source, board.source_id).at(-1);
  if (!found) return null;
  const { id, name } = found;
  return { board_id: id, name, imported_at: found.import.imported_at };
}

const userView = (user) =>
  user && { id: user.id, name: user.name, email: user.email, role: user.role };

function previewBoard(ctx, { board, path }) {
  const reimport = earlierImport(ctx.store, ctx.snapshot.source, board);
  return {
    source_id: board.source_id,
    name: board.name,
    kind: board.kind,
    source_url: board.source_url,
    path,
    included: ctx.plan.boards.has(board.source_id),
    counts: boardCounts(board),
    reimport,
    import_name: importName(board.name, reimport !== null),
  };
}

function previewWorkspace(ctx, { workspace, path }) {
  const { plan } = ctx;
  return {
    source_id: workspace.source_id,
    name: workspace.name,
    kind: workspace.kind,
    path,
    target: plan.targets.get(workspace.source_id)?.id ?? "new",
    boards: workspace.boards.map((board, index) =>
      previewBoard(ctx, { board, path: `${path}.boards[${index}]` }),
    ),
    docs: workspace.docs.map((doc, index) => ({
      source_id: doc.source_id,
      title: doc.title,
      visibility: doc.visibility,
      path: `${path}.docs[${index}]`,
      included: plan.docs.has(doc.source_id),
      blocks: doc.blocks.length,
    })),
  };
}

function totalsOf(workspaces, users) {
  const totals = { workspaces: workspaces.length, boards: 0, docs: 0, users };
  const keys = ["columns", "groups", "items", "subitems", "updates"];
  for (const key of keys) totals[key] = 0;
  const selected = { boards: 0, docs: 0, items: 0, subitems: 0, updates: 0 };
  for (const workspace of workspaces) {
    totals.boards += workspace.boards.length;
    totals.docs += workspace.docs.length;
    selected.docs += workspace.docs.filter((doc) => doc.included).length;
    for (const board of workspace.boards) {
      for (const key of keys) totals[key] += board.counts[key];
      if (!board.included) continue;
      selected.boards += 1;
      for (const key of ["items", "subitems", "updates"])
        selected[key] += board.counts[key];
    }
  }
  return { totals, selected };
}

/** The Preview of `snapshot` for the importer (see the module comment). */
export function preview(snapshot, { store, importerId, mapping = null }) {
  const snap = checkedSnapshot(snapshot);
  const importer = requireImporter(store, importerId);
  const plan = checkedPlan(snap, mapping, { store, importerId });
  const ctx = { store, snapshot: snap, plan };
  const workspaces = snap.workspaces.map((workspace, index) =>
    previewWorkspace(ctx, { workspace, path: `workspaces[${index}]` }),
  );
  const users = snap.users.map((user) => {
    const { choice, proposal } = plan.users.get(user.source_id);
    const { source_id, name, email } = user;
    const { match, note } = proposal;
    const mapped = { proposal: proposal.action, action: choice };
    return { source_id, name, email, ...mapped, match: userView(match), note };
  });
  const targets = store
    .listWorkspaces()
    .filter((workspace) => canImportInto(store, importer, workspace))
    .map(({ id, name, kind }) => ({ id, name, kind }));
  return {
    source: snap.source,
    source_name: SOURCE_NAMES[snap.source],
    source_label: snap.source_label,
    ...totalsOf(workspaces, users.length),
    workspaces,
    users,
    targets,
    warnings: snap.warnings,
  };
}

// --------------------------------------------------------------------- run

/** Invites one source user (an existing email becomes a match). */
function invite(ctx, { user, role, path }) {
  const { store, report } = ctx;
  const created = store.createUser({
    name: user.name,
    email: user.email,
    role,
  });
  if (created && created.ok !== false) {
    report.created.users += 1;
    return created.id;
  }
  const existing = store.findUserByEmail(user.email);
  if (created?.reason === "email_taken" && existing) {
    const message = `${user.email} already has a Worklane account, so it was matched instead of invited`;
    warn(report, { code: "invite_matched", message, path });
    return existing.id;
  }
  const message = `${user.name} could not be invited: ${created?.message ?? "invalid user"}`;
  warn(report, { code: "invite_failed", message, path });
  return null;
}

/** Map(user source_id → { userId | null, name }) after matches and invites. */
function resolveUsers(ctx) {
  const { snapshot, plan, report } = ctx;
  const people = new Map();
  for (const [index, user] of snapshot.users.entries()) {
    const action = plan.users.get(user.source_id);
    const path = `users[${index}]`;
    let userId = null;
    if (action.kind === "match") userId = action.userId;
    if (action.kind === "invite")
      userId = invite(ctx, { user, role: action.role, path });
    if (userId === null)
      skip(report, { kind: "user", entry: user, path, reason: "skipped" });
    people.set(user.source_id, { userId, name: user.name });
  }
  return people;
}

/** The included boards and docs in snapshot order; the rest are skipped. */
function plannedTasks({ snapshot, plan, report }) {
  const tasks = [];
  for (const [wi, workspace] of snapshot.workspaces.entries()) {
    const lists = [
      ["board", workspace.boards, plan.boards],
      ["doc", workspace.docs, plan.docs],
    ];
    for (const [kind, entries, included] of lists) {
      for (const [index, entry] of entries.entries()) {
        const path = `workspaces[${wi}].${kind}s[${index}]`;
        if (included.has(entry.source_id))
          tasks.push({ kind, entry, path, workspace });
        else skip(report, { kind, entry, path, reason: "excluded" });
      }
    }
  }
  return tasks;
}

/** The Worklane workspace of a source workspace, created on first use. */
function targetOf(ctx, workspace) {
  const { store, plan, report, targets, importerId } = ctx;
  if (targets.has(workspace.source_id)) return targets.get(workspace.source_id);
  let target = plan.targets.get(workspace.source_id);
  if (target === null) {
    const { name, description, kind } = workspace;
    const creatorId = importerId;
    target = store.createWorkspace({ name, description, kind, creatorId });
    if (!target || target.ok === false) return null;
    report.created.workspaces += 1;
    link(report, "workspace", target);
  }
  targets.set(workspace.source_id, target);
  return target;
}

function importOneBoard(ctx, { task, workspace }) {
  const { store, report, snapshot, importerId, people } = ctx;
  const board = task.entry;
  const built = boardSpec(board, { people, source: snapshot.source });
  const again = earlierImport(store, snapshot.source, board) !== null;
  const counts = boardCounts(board);
  const items = count(counts.items + counts.subitems, "item");
  const summary = `Imported from ${snapshot.source_label}: ${items}, ${count(counts.groups, "group")}`;
  const result = store.importBoard({
    workspaceId: workspace.id,
    importerId,
    name: importName(board.name, again),
    description: board.description,
    boardKind: board.kind,
    label: importLabel(snapshot.source),
    summary: truncate(summary, LIMITS.name),
    ...built.spec,
  });
  if (!result || result.ok === false) {
    const message = `“${board.name}” could not be imported: ${result?.message ?? "its Space is gone"}`;
    warn(report, { code: "board_failed", message, path: task.path });
    skip(report, { ...task, reason: "failed" });
    return;
  }
  for (const key of ["groups", "columns", "items", "updates"])
    report.created[key] += result.counts[key];
  report.created.boards += 1;
  link(report, "board", result.board);
  boardWarnings(report, { task, built, result, people, store });
}

function importOneDoc(ctx, { task, workspace }) {
  const { store, report, importerId } = ctx;
  const { title, visibility, blocks } = task.entry;
  const doc = store.createDoc({
    title,
    workspaceId: workspace.id,
    visibility,
    creatorId: importerId,
    blocks,
  });
  if (!doc || doc.ok === false) {
    const message = `“${title}” could not be imported: ${doc?.message ?? "its Space is gone"}`;
    warn(report, { code: "doc_failed", message, path: task.path });
    skip(report, { ...task, reason: "failed" });
    return;
  }
  report.created.docs += 1;
  link(report, "doc", doc);
}

/** Imports one board or doc; failures become warnings. */
function importTask(ctx, task) {
  const { report } = ctx;
  const name = task.entry.name ?? task.entry.title;
  try {
    const workspace = targetOf(ctx, task.workspace);
    if (workspace === null) {
      const message = `“${task.workspace.name}” could not be created, so “${name}” was not imported`;
      warn(report, { code: "workspace_failed", message, path: task.path });
      skip(report, { ...task, reason: "failed" });
    } else if (task.kind === "board") importOneBoard(ctx, { task, workspace });
    else importOneDoc(ctx, { task, workspace });
  } catch (error) {
    ctx.log?.error?.("mini-monday: import step failed", error);
    const message = `“${name}” could not be imported`;
    warn(report, { code: `${task.kind}_failed`, message, path: task.path });
    skip(report, { ...task, reason: "failed" });
  }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs `plan` for `snapshot` (see the module comment) and resolves with
 * the Report (`report.js`). `log.error` receives unexpected failures of
 * single boards or docs, which the report lists as failed.
 */
export async function run(snapshot, plan, options) {
  const { store, importerId, onProgress = () => {}, signal = null } = options;
  const snap = checkedSnapshot(snapshot);
  requireImporter(store, importerId);
  const checked = checkedPlan(snap, plan, { store, importerId });
  const report = createReport(snap);
  const ctx = { store, snapshot: snap, plan: checked, report, importerId };
  Object.assign(ctx, { targets: new Map(), log: options.log });
  const tasks = plannedTasks(ctx);
  const total = tasks.length;
  // A run cancelled before it starts writes nothing, invites included.
  ctx.people = signal?.aborted ? new Map() : resolveUsers(ctx);
  for (const [index, task] of tasks.entries()) {
    const allowed = can(store.getUser(importerId), "import_data");
    if (signal?.aborted || !allowed) {
      report.cancelled = true;
      const reason = allowed ? "cancelled" : "not_allowed";
      for (const rest of tasks.slice(index)) skip(report, { ...rest, reason });
      break;
    }
    const name = task.entry.name ?? task.entry.title;
    const message = `Importing “${name}”`;
    onProgress({ phase: `${task.kind}s`, done: index, total, message });
    importTask(ctx, task);
    await nextTurn();
  }
  const text = finishedText(report, importLabel(snap.source));
  const url = report.links[0]?.url ?? "#/import";
  store.recordImportFinished({ userId: importerId, text, url });
  onProgress({ phase: "done", done: total, total, message: text });
  return report;
}
