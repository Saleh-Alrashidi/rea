/**
 * The review step's model (SPEC-4 §4 and §6.3): which boards and docs are
 * included, where each source workspace goes and what happens to each
 * source person, built from a scan's Preview and turned into the plan of
 * `POST /import/run`. Pure; the review view mutates a selection through
 * these functions and re-renders from it.
 *
 * ```
 * selection = { users: Map(source_id → action), targets: Map(workspace
 *   source_id → "new" | workspace id), boards: Set(source_id),
 *   docs: Set(source_id), manual: Set(user source_id chosen by hand) }
 * ```
 *
 * User actions are the plan's: "match:<user id>", "invite:member",
 * "invite:viewer", "invite:guest" or "skip". The server checks the plan
 * again (`server/import/plan.js`); this model only offers the choices the
 * preview allows (invites need an email, matches an active user).
 */

export const INVITE_ACTIONS = Object.freeze([
  { value: "invite:member", label: "Invite as member" },
  { value: "invite:viewer", label: "Invite as viewer" },
  { value: "invite:guest", label: "Invite as guest" },
]);

export const SKIP = "skip";
const NO_EMAIL = "They have no email in the source, so they can’t be invited";

/** "match", "invite" or "skip" for a plan action. */
export function actionKind(action) {
  if (typeof action !== "string") return SKIP;
  if (action.startsWith("match:")) return "match";
  if (action.startsWith("invite:")) return "invite";
  return SKIP;
}

/** The selection the preview proposes (everything it marks included). */
export function createSelection(preview) {
  const boards = new Set();
  const docs = new Set();
  const targets = new Map();
  for (const workspace of preview.workspaces) {
    targets.set(workspace.source_id, workspace.target ?? "new");
    for (const board of workspace.boards) {
      if (board.included !== false) boards.add(board.source_id);
    }
    for (const doc of workspace.docs) {
      if (doc.included !== false) docs.add(doc.source_id);
    }
  }
  const users = new Map(
    preview.users.map((user) => [user.source_id, user.action ?? SKIP]),
  );
  return { users, targets, boards, docs, manual: new Set() };
}

/** Sets the action the admin chose for one person by hand. */
export function chooseAction(selection, sourceId, action) {
  selection.users.set(sourceId, action);
  selection.manual.add(sourceId);
}

/**
 * The action dropdown of one source person: groups of options, the
 * proposal first. `people` are Worklane users (`{ id, name, email,
 * status }`); only active ones can be matched.
 *
 * @returns {{ label: string | null, options: { value: string, label: string,
 *   disabled?: boolean, title?: string }[] }[]}
 */
export function userChoices(user, people = []) {
  const first = [];
  const proposed = actionKind(user.proposal) === "match" && user.match;
  if (proposed) {
    const email = user.match.email ? ` (${user.match.email})` : "";
    first.push({
      value: user.proposal,
      label: `Match ${user.match.name}${email}`,
    });
  }
  first.push({ value: SKIP, label: "Skip (leave out)" });
  const invites = INVITE_ACTIONS.map((option) =>
    user.email ? { ...option } : { ...option, disabled: true, title: NO_EMAIL },
  );
  const matches = people
    .filter((person) => person.status !== "deactivated")
    .filter((person) => `match:${person.id}` !== user.proposal)
    .map((person) => ({
      value: `match:${person.id}`,
      label: person.email ? `${person.name} (${person.email})` : person.name,
    }));
  const groups = [
    { label: null, options: first },
    { label: "Invite to Worklane", options: invites },
  ];
  if (matches.length > 0) {
    groups.push({ label: "Match another Worklane user", options: matches });
  }
  return groups;
}

const entriesOf = (workspace) => [
  ...workspace.boards.map((board) => ["boards", board.source_id]),
  ...workspace.docs.map((doc) => ["docs", doc.source_id]),
];

/** "all", "some" or "none" of a workspace's boards and docs included. */
export function workspaceState(selection, workspace) {
  const entries = entriesOf(workspace);
  const included = entries.filter(([kind, id]) => selection[kind].has(id));
  if (included.length === 0) return "none";
  return included.length === entries.length ? "all" : "some";
}

/** Includes (or leaves out) every board and doc of `workspace`. */
export function setWorkspace(selection, workspace, on) {
  for (const [kind, id] of entriesOf(workspace)) {
    if (on) selection[kind].add(id);
    else selection[kind].delete(id);
  }
}

/** Includes (or leaves out) everything in the preview. */
export function setAll(selection, preview, on) {
  for (const workspace of preview.workspaces) {
    setWorkspace(selection, workspace, on);
  }
}

/** Includes or leaves out one board (`kind` "boards") or doc ("docs"). */
export function setEntry(selection, { kind, id, on }) {
  if (on) selection[kind].add(id);
  else selection[kind].delete(id);
}

/**
 * Sets `action` for every person not matched to a Worklane user right now
 * (matches by email or by hand stay) whose action was not chosen by hand
 * (`chooseAction`); invites skip people without an email. Returns `{
 * changed, kept }`: how many changed, and how many chosen by hand would
 * have changed but were kept.
 */
export function applyToUnmatched(selection, preview, action) {
  const result = { changed: 0, kept: 0 };
  for (const user of preview.users) {
    const current = selection.users.get(user.source_id);
    if (actionKind(current) === "match") continue;
    if (actionKind(action) === "invite" && !user.email) continue;
    if (current === action) continue;
    if (selection.manual?.has(user.source_id)) {
      result.kept += 1;
      continue;
    }
    selection.users.set(user.source_id, action);
    result.changed += 1;
  }
  return result;
}

/** `{ match, invite, skip }` counts of the chosen actions. */
export function peopleCounts(preview, selection) {
  const counts = { match: 0, invite: 0, skip: 0 };
  for (const user of preview.users) {
    counts[actionKind(selection.users.get(user.source_id))] += 1;
  }
  return counts;
}

/**
 * The people shown in the table: `query` matches name or email
 * (case-insensitive), `show` keeps "all", or only people whose chosen
 * action is "match", "invite" or "skip".
 */
export function filterPeople(preview, selection, { query = "", show = "all" }) {
  const needle = query.trim().toLowerCase();
  return preview.users.filter((user) => {
    const kind = actionKind(selection.users.get(user.source_id));
    if (show !== "all" && kind !== show) return false;
    if (!needle) return true;
    const text = `${user.name}\n${user.email ?? ""}`.toLowerCase();
    return text.includes(needle);
  });
}

/** The plan of `POST /import/run` (every choice explicit). */
export function toPlan(selection, preview) {
  const users = {};
  for (const user of preview.users) {
    users[user.source_id] = selection.users.get(user.source_id) ?? SKIP;
  }
  const workspaceMap = {};
  const boards = [];
  const docs = [];
  for (const workspace of preview.workspaces) {
    workspaceMap[workspace.source_id] =
      selection.targets.get(workspace.source_id) ?? "new";
    for (const board of workspace.boards) {
      if (selection.boards.has(board.source_id)) boards.push(board.source_id);
    }
    for (const doc of workspace.docs) {
      if (selection.docs.has(doc.source_id)) docs.push(doc.source_id);
    }
  }
  return { users, workspace_map: workspaceMap, include: { boards, docs } };
}

function addBoard(summary, board) {
  summary.boards += 1;
  summary.items += board.counts?.items ?? 0;
  summary.subitems += board.counts?.subitems ?? 0;
  summary.updates += board.counts?.updates ?? 0;
}

/** What the plan would import (the numbers of the summary sentence). */
export function summarize(selection, preview) {
  const summary = { boards: 0, docs: 0, items: 0, subitems: 0, updates: 0 };
  const targetNames = new Map(
    preview.targets.map((target) => [String(target.id), target.name]),
  );
  let created = 0;
  const existing = new Set();
  for (const workspace of preview.workspaces) {
    if (workspaceState(selection, workspace) === "none") continue;
    for (const board of workspace.boards) {
      if (selection.boards.has(board.source_id)) addBoard(summary, board);
    }
    summary.docs += workspace.docs.filter((doc) =>
      selection.docs.has(doc.source_id),
    ).length;
    const target = selection.targets.get(workspace.source_id) ?? "new";
    if (target === "new") created += 1;
    else existing.add(targetNames.get(String(target)) ?? "a workspace");
  }
  return {
    ...summary,
    newWorkspaces: created,
    existingWorkspaces: [...existing],
    people: peopleCounts(preview, selection),
    empty: summary.boards + summary.docs === 0,
  };
}

const number = (value) => value.toLocaleString("en-US");
const counted = (value, noun, plural = `${noun}s`) =>
  `${number(value)} ${value === 1 ? noun : plural}`;

/** "a, b and c" */
export function joinList(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function contentText(summary) {
  const details = [counted(summary.items, "item")];
  if (summary.subitems > 0) details.push(counted(summary.subitems, "subitem"));
  if (summary.updates > 0) details.push(counted(summary.updates, "update"));
  const parts = [];
  if (summary.boards > 0) {
    parts.push(`${counted(summary.boards, "board")} (${joinList(details)})`);
  }
  if (summary.docs > 0) parts.push(counted(summary.docs, "doc"));
  return joinList(parts);
}

function targetText(summary) {
  const parts = [];
  if (summary.newWorkspaces > 0) {
    parts.push(`${counted(summary.newWorkspaces, "new workspace")}`);
  }
  for (const name of summary.existingWorkspaces) parts.push(`“${name}”`);
  return joinList(parts);
}

function peopleText({ match, invite, skip }) {
  const parts = [];
  if (match > 0) parts.push(`${counted(match, "person", "people")} matched`);
  if (invite > 0) parts.push(`${number(invite)} invited`);
  if (skip > 0) parts.push(`${number(skip)} skipped`);
  return parts.length > 0 ? `People: ${joinList(parts)}.` : "";
}

/** The sentence next to the Import button. */
export function summaryText(summary) {
  if (summary.empty) return "Choose at least one board or doc to import.";
  const what = `Import ${contentText(summary)} into ${targetText(summary)}.`;
  return [what, peopleText(summary.people)].filter(Boolean).join(" ");
}
