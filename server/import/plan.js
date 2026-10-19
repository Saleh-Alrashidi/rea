/**
 * Import plans (SPEC-4 §4): the admin's choices for one validated
 * snapshot, checked against the snapshot and the store, and the user
 * mapping proposal the preview shows.
 *
 * ```
 * plan = {
 *   users: { [user source_id]: "match:<user id>" | "invite:member"
 *            | "invite:viewer" | "invite:guest" | "skip" },
 *   workspace_map: { [workspace source_id]: "new" | "<workspace id>" },
 *   include: { boards?: [board source_id], docs?: [doc source_id] },
 * }
 * ```
 *
 * Every part is optional: a user without a choice gets the proposal (a
 * match by email, case-insensitive, with an active Worklane user, else
 * `skip`), a workspace goes to a new Worklane workspace, and a missing
 * `include.boards` / `include.docs` list includes all of them. Existing
 * target workspaces must be ones the importer may import into
 * (`access.canImportInto`); invites need the source user's email.
 */
import { canImportInto, isActive } from "../access.js";
import { ID_PATTERN, isPlainObject } from "../input.js";

const PLAN_KEYS = new Set(["users", "workspace_map", "include"]);
const INCLUDE_KEYS = new Set(["boards", "docs"]);
export const INVITE_ROLES = Object.freeze(["member", "viewer", "guest"]);
const MATCH = /^match:(\d{1,16})$/;
const INVITE = /^invite:(\w+)$/;

const keyPath = (base, key) => `${base}[${JSON.stringify(key)}]`;

/**
 * The proposed mapping of source `user`: `{ action, match, note }` with
 * `action` "match:<id>" (an active user with the same email) or "skip".
 */
export function proposeUser(store, user) {
  if (user.email === null) {
    return { action: "skip", match: null, note: "No email to match" };
  }
  const found = store.findUserByEmail(user.email);
  if (isActive(found)) {
    return { action: `match:${found.id}`, match: found, note: null };
  }
  const note = found
    ? "The Worklane user with this email is deactivated"
    : null;
  return { action: "skip", match: null, note };
}

/** Parses one user choice into `{ kind, userId?, role? }` or a message. */
function readAction(store, choice, user) {
  if (choice === "skip") return { kind: "skip" };
  const match = typeof choice === "string" ? MATCH.exec(choice) : null;
  if (match) {
    const target = ID_PATTERN.test(match[1]) ? store.getUser(match[1]) : null;
    return isActive(target)
      ? { kind: "match", userId: target.id }
      : "match must name an active Worklane user";
  }
  const invite = typeof choice === "string" ? INVITE.exec(choice) : null;
  if (invite && INVITE_ROLES.includes(invite[1])) {
    return user.email === null
      ? "This user has no email, so they cannot be invited"
      : { kind: "invite", role: invite[1] };
  }
  return 'Expected "match:<user id>", "invite:member", "invite:viewer", "invite:guest" or "skip"';
}

/** An object of choices keyed by known source IDs, or an error. */
function readChoices(value, { path, known, errors }) {
  if (value === undefined || value === null) return new Map();
  if (!isPlainObject(value)) {
    errors.push({ path, message: "Expected an object" });
    return new Map();
  }
  const choices = new Map();
  for (const [key, choice] of Object.entries(value)) {
    if (known.has(key)) choices.set(key, choice);
    else
      errors.push({ path: keyPath(path, key), message: "Unknown source ID" });
  }
  return choices;
}

function readUsers(snapshot, { raw, store, errors }) {
  const byId = new Map(snapshot.users.map((user) => [user.source_id, user]));
  const path = "plan.users";
  const choices = readChoices(raw, { path, known: byId, errors });
  const users = new Map();
  for (const user of snapshot.users) {
    const proposal = proposeUser(store, user);
    const choice = choices.get(user.source_id) ?? proposal.action;
    const action = readAction(store, choice, user);
    if (typeof action === "string") {
      errors.push({ path: keyPath(path, user.source_id), message: action });
      continue;
    }
    users.set(user.source_id, { ...action, choice, proposal });
  }
  return users;
}

function readTargets(snapshot, { raw, store, importer, errors }) {
  const known = new Map(snapshot.workspaces.map((w) => [w.source_id, w]));
  const path = "plan.workspace_map";
  const choices = readChoices(raw, { path, known, errors });
  const targets = new Map();
  for (const workspace of snapshot.workspaces) {
    const choice = choices.get(workspace.source_id) ?? "new";
    if (choice === "new") {
      targets.set(workspace.source_id, null);
      continue;
    }
    const target =
      typeof choice === "string" && ID_PATTERN.test(choice)
        ? store.getWorkspace(choice)
        : null;
    if (target && canImportInto(store, importer, target)) {
      targets.set(workspace.source_id, target);
      continue;
    }
    const message = 'Expected "new" or a Space you can import into';
    errors.push({ path: keyPath(path, workspace.source_id), message });
  }
  return targets;
}

/** The included source IDs of one kind; null (everything) when absent. */
function readIncluded(raw, { path, known, errors }) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > known.size + 1000) {
    errors.push({ path, message: "Expected a list of source IDs" });
    return null;
  }
  const included = new Set();
  for (const [index, id] of raw.entries()) {
    if (typeof id === "string" && known.has(id)) included.add(id);
    else
      errors.push({ path: `${path}[${index}]`, message: "Unknown source ID" });
  }
  return included;
}

function readInclude(snapshot, { raw, errors }) {
  const boards = new Set();
  const docs = new Set();
  for (const workspace of snapshot.workspaces) {
    for (const board of workspace.boards) boards.add(board.source_id);
    for (const doc of workspace.docs) docs.add(doc.source_id);
  }
  if (raw === undefined || raw === null) return { boards, docs };
  if (!isPlainObject(raw)) {
    errors.push({ path: "plan.include", message: "Expected an object" });
    return { boards, docs };
  }
  for (const key of Object.keys(raw)) {
    if (!INCLUDE_KEYS.has(key))
      errors.push({ path: `plan.include.${key}`, message: "Unknown field" });
  }
  const read = (key, known) =>
    readIncluded(raw[key], { path: `plan.include.${key}`, known, errors }) ??
    known;
  return { boards: read("boards", boards), docs: read("docs", docs) };
}

/**
 * Checks `plan` (see the module comment) for `snapshot` (validated) and
 * the importer. Returns `{ ok: true, plan }` with `plan = { users:
 * Map(source_id → { kind: "match" | "invite" | "skip", userId?, role?,
 * choice, proposal }), targets: Map(workspace source_id → workspace
 * record | null for new), boards: Set, docs: Set }`, or `{ ok: false,
 * errors: [{ path, message }] }`.
 */
export function checkPlan(snapshot, plan, { store, importerId }) {
  const errors = [];
  const raw = plan ?? {};
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [{ path: "plan", message: "Expected an object" }],
    };
  }
  for (const key of Object.keys(raw)) {
    if (!PLAN_KEYS.has(key))
      errors.push({ path: `plan.${key}`, message: "Unknown field" });
  }
  const importer = store.getUser(importerId);
  const checked = {
    users: readUsers(snapshot, { raw: raw.users, store, errors }),
    targets: readTargets(snapshot, {
      raw: raw.workspace_map,
      store,
      importer,
      errors,
    }),
    ...readInclude(snapshot, { raw: raw.include, errors }),
  };
  return errors.length > 0
    ? { ok: false, errors: errors.slice(0, 50) }
    : { ok: true, plan: checked };
}
