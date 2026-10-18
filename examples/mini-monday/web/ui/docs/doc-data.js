/**
 * Docs data (no DOM): the GraphQL documents of the docs list and the doc
 * editor, record normalization, the list filters and the editor's
 * capabilities. Access comes only from the server's `my_access` (read
 * through `components/permissions.js`) and "Shared with me" from the
 * server's `shared_with_me`, so the client never re-derives who may see or
 * change a doc.
 */

import { SOMEONE } from "../components/labels.js";
import { hasRole } from "../components/permissions.js";
import { normalizeMember } from "../components/share-model.js";
import { parseBlocksJson, serializeBlocks } from "./blocks.js";

const PERSON = "id name initials color";

export const DOCS_LIST_QUERY = `query DocsList {
  docs {
    id title visibility my_access created_at updated_at
    workspace { id name color }
    created_by { ${PERSON} }
    updated_by { ${PERSON} }
  }
  shared_with_me { kind id }
}`;

export const DOC_QUERY = `query DocEditor($id: ID!) {
  docs(ids: [$id]) {
    id title visibility my_access version blocks_json created_at updated_at
    workspace { id name color can_open }
    created_by { ${PERSON} }
    updated_by { ${PERSON} }
    members { kind id name role user { ${PERSON} } }
  }
}`;

export const UPDATE_DOC_MUTATION = `mutation UpdateDoc($id: ID!, $expectedVersion: Int!, $title: String, $blocksJson: String) {
  update_doc(doc_id: $id, expected_version: $expectedVersion, title: $title, blocks_json: $blocksJson) {
    id title version updated_at
    updated_by { ${PERSON} }
  }
}`;

export const DELETE_DOC_MUTATION = `mutation DeleteDoc($id: ID!) {
  delete_doc(doc_id: $id) { id }
}`;

const person = (record) =>
  record ? { ...record, id: String(record.id) } : null;

/**
 * How the doc pages name the creator or last editor of a doc: "you", their
 * name, or "Someone" when the API leaves the person out because the
 * viewer may not see them (every doc records both).
 */
export function personLabel(record, meId) {
  if (!record) return SOMEONE;
  return record.id === String(meId) ? "you" : record.name;
}

/** Normalizes an API Doc (IDs as strings, parsed blocks when present). */
export function normalizeDoc(doc) {
  const record = {
    ...doc,
    id: String(doc.id),
    workspace: doc.workspace
      ? { ...doc.workspace, id: String(doc.workspace.id) }
      : null,
    created_by: person(doc.created_by),
    updated_by: person(doc.updated_by),
  };
  if (typeof doc.blocks_json === "string") {
    record.blocks = parseBlocksJson(doc.blocks_json);
  }
  if (Array.isArray(doc.members)) {
    record.members = doc.members.map(normalizeMember);
  }
  return record;
}

/**
 * Loads one doc for the editor, or null when it does not exist or the user
 * cannot access it (the API answers both the same way).
 */
export async function loadDoc(api, id) {
  try {
    const data = await api.request(DOC_QUERY, { id });
    const doc = data.docs.find((entry) => String(entry.id) === String(id));
    if (!doc) return null;
    const record = normalizeDoc(doc);
    // A doc can be shared with people outside its workspace; the server
    // says whether the workspace itself can be opened.
    record.workspaceAccessible = doc.workspace?.can_open === true;
    return record;
  } catch (error) {
    if (error?.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** Loads the docs list and the IDs of docs shared with the user. */
export async function loadDocsList(api) {
  const data = await api.request(DOCS_LIST_QUERY);
  const sharedIds = new Set(
    data.shared_with_me
      .filter((entry) => entry.kind === "doc")
      .map((entry) => String(entry.id)),
  );
  return { docs: data.docs.map(normalizeDoc), sharedIds };
}

/**
 * Saves editor changes (`{ title?, blocks? }`) with `expectedVersion`;
 * resolves with `{ id, title, version, updated_at, updated_by }`.
 */
export async function saveDoc(api, { id, changes, expectedVersion }) {
  const data = await api.request(UPDATE_DOC_MUTATION, {
    id,
    expectedVersion,
    title: changes.title ?? null,
    blocksJson: changes.blocks ? serializeBlocks(changes.blocks) : null,
  });
  return normalizeDoc(data.update_doc);
}

/** What the signed-in user may do with a loaded doc. */
export function docCapabilities(doc) {
  return {
    edit: hasRole(doc?.my_access, "editor"),
    manage: hasRole(doc?.my_access, "owner"),
    viewOnly: doc?.my_access === "viewer",
  };
}

export const DOC_FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "shared", label: "Shared with me" },
]);

/** Docs the user created ("Mine"). */
const isMine = (doc, meId) => doc.created_by?.id === String(meId);

function matches(doc, { workspaceId, query }) {
  if (workspaceId && doc.workspace?.id !== workspaceId) return false;
  const term = query?.trim().toLowerCase();
  return !term || doc.title.toLowerCase().includes(term);
}

/**
 * The docs list for the current filters, newest edit first.
 * "Mine" are docs the user created; "Shared with me" are the docs the
 * server lists in `shared_with_me`. Counts cover the workspace and search
 * filters, so each tab shows what selecting it would list.
 *
 * @param {object[]} docs normalized docs
 * @param {{ filter?: "all" | "mine" | "shared", workspaceId?: string | null,
 *   query?: string, meId: string, sharedIds: Set<string> }} options
 * @returns {{ rows: object[], counts: { all: number, mine: number, shared: number } }}
 */
export function docsView(docs, options) {
  const { filter = "all", meId, sharedIds } = options;
  const visible = docs.filter((doc) => matches(doc, options));
  const tests = {
    all: () => true,
    mine: (doc) => isMine(doc, meId),
    shared: (doc) => sharedIds.has(doc.id),
  };
  const counts = Object.fromEntries(
    Object.entries(tests).map(([key, test]) => [
      key,
      visible.filter(test).length,
    ]),
  );
  const rows = visible
    .filter(tests[filter] ?? tests.all)
    .sort(
      (a, b) =>
        String(b.updated_at).localeCompare(String(a.updated_at)) ||
        Number(b.id) - Number(a.id),
    );
  return { rows, counts };
}

/** The workspaces the listed docs belong to, by name (for the filter). */
export function docWorkspaces(docs) {
  const byId = new Map();
  for (const doc of docs) {
    if (doc.workspace) byId.set(doc.workspace.id, doc.workspace);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
