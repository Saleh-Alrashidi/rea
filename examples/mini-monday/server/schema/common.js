/**
 * Shared pieces of the GraphQL schema modules (`server/schema/*.js`):
 * input validation, error helpers, the scope wrappers, store-result
 * mapping, member records and the enums every module uses.
 *
 * Authorization is not decided here: resolvers ask `server/access.js`
 * (`require*`, `*Access`, `can`) and only map its answers. A missing record
 * and a record the caller cannot access produce the same NOT_FOUND error.
 */
import {
  actingUser,
  boardAccess,
  canManageMembers,
  directoryName,
  directoryUser,
  effectiveOwnerIds,
  memberVerdicts,
  membersOf,
  notFoundError,
  teamVisible,
  visibleUserIds,
} from "../access.js";
import { GraphQLError } from "../graphql/errors.js";
import { LIMITS } from "../input.js";
import {
  InputError,
  readName as readStoreName,
  readText,
} from "../store-state.js";
import { API_VERSIONS } from "../versions.js";

// Unspecified in the specs: every `limit` and `ids` argument is capped at
// the items_page maximum so that one request cannot ask for unbounded work.
const MAX_LIMIT = 500;

/** Throws a GraphQLError; usable as an expression (`x ?? fail(…)`). */
export const fail = (code, message, extensions) => {
  throw new GraphQLError(message, { code, extensions });
};
export const badInput = (message, extensions) =>
  fail("BAD_USER_INPUT", message, extensions);
/** NOT_FOUND worded exactly like `access.js` words hidden records. */
export const notFound = (what, id) => {
  throw notFoundError(what, id);
};

// ------------------------------------------------------------- validation

/** Runs a store-state reader; the rule it breaks becomes BAD_USER_INPUT. */
function asInput(reader) {
  try {
    return reader();
  } catch (error) {
    if (error instanceof InputError) badInput(error.message);
    throw error;
  }
}

/** A trimmed name of 1-255 characters (the store's name rule). */
export const readName = (value, label) =>
  asInput(() => readStoreName(value, label));

/**
 * Optional description text, at most 2,000 characters. null and undefined
 * are returned as they are (undefined means "unchanged" for updates).
 */
export function readDescription(value) {
  if (value === undefined || value === null) return value;
  return asInput(() => readText(value, "Description", LIMITS.description));
}

export function readLimit(value, max = MAX_LIMIT, label = "limit") {
  const valid = Number.isInteger(value) && value >= 1 && value <= max;
  return valid ? value : badInput(`${label} must be from 1 to ${max}`);
}

/** Returns the requested IDs without duplicates, or null when absent. */
export function readIds(ids) {
  if (ids === undefined || ids === null) return null;
  if (ids.length > MAX_LIMIT) badInput(`ids may list at most ${MAX_LIMIT}`);
  return [...new Set(ids)];
}

/** Filters `records` by an optional `ids` argument, keeping record order. */
export function pick(records, ids) {
  const wanted = readIds(ids);
  if (wanted === null) return records;
  const set = new Set(wanted);
  return records.filter((record) => set.has(record.id));
}

/** Parses a `*_json` argument; malformed JSON → BAD_USER_INPUT. */
export function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    return badInput(`${label} must be valid JSON`);
  }
}

// ---------------------------------------------------------- store results

const FAILURE_CODES = Object.freeze({
  version_conflict: "VERSION_CONFLICT",
  forbidden: "FORBIDDEN",
});
const FAILURE_MESSAGES = Object.freeze({
  email_taken: "That email address is already in use",
  form_closed: "This form is closed",
  version_conflict: "This was changed by someone else; reload to continue",
});

/**
 * Maps a store result to the API: a record is returned, a store failure
 * (`{ ok: false, reason }`) becomes BAD_USER_INPUT (or VERSION_CONFLICT
 * with `extensions.version`, or FORBIDDEN), and null (unknown ID) becomes
 * `onMissing()`.
 */
export function storeResult(result, onMissing) {
  if (result === null || result === undefined) return onMissing();
  if (result.ok !== false) return result;
  const code = FAILURE_CODES[result.reason] ?? "BAD_USER_INPUT";
  const message =
    result.message ?? FAILURE_MESSAGES[result.reason] ?? result.reason;
  const extensions =
    result.reason === "version_conflict" ? { version: result.version } : {};
  return fail(code, message, extensions);
}

// ------------------------------------------------------- scopes and users

/** Wraps a root resolver so that it first requires `scope`. */
export const scoped = (scope, resolve) => (parent, args, ctx, info) => {
  ctx.requireScope(scope);
  return resolve(parent, args, ctx, info);
};
export const read = (resolve) => scoped("boards:read", resolve);
export const write = (resolve) => scoped("boards:write", resolve);

/** The active user behind the request (principals always name one). */
export function viewerOf(ctx) {
  return (
    actingUser(ctx) ??
    fail("UNAUTHENTICATED", "The signed-in user is no longer active")
  );
}

/** Wraps every function of `resolvers` with `wrap` (read/write). */
export const wrapAll = (wrap, resolvers) =>
  Object.fromEntries(
    Object.entries(resolvers).map(([name, resolve]) => [name, wrap(resolve)]),
  );

// ------------------------------------------------------ per-request views

const REQUEST_CACHES = new WeakMap();

/**
 * `compute()` at most once per request (`ctx`), `key` and store revision.
 * Resolvers that scan everything the caller can access share one scan
 * however often a query aliases them, and any committed change (in this
 * request or a concurrent one) starts over. Without a store revision
 * (stub stores) nothing is cached.
 */
export function perRequest(ctx, key, compute) {
  const revision = ctx.store.revision?.();
  if (revision === undefined) return compute();
  let cache = REQUEST_CACHES.get(ctx);
  if (cache?.revision !== revision) {
    cache = { revision, values: new Map() };
    REQUEST_CACHES.set(ctx, cache);
  }
  if (!cache.values.has(key)) cache.values.set(key, compute());
  return cache.values.get(key);
}

/** The IDs of the users the caller may see, or null for everyone. */
const directoryOf = (ctx) =>
  perRequest(ctx, "directory", () => visibleUserIds(ctx.store, viewerOf(ctx)));

/**
 * `nameOf(userId)` for texts the caller reads: names inside their
 * directory, "Someone" outside it (SPEC-2 §6).
 */
export function namesFor(ctx) {
  const directory = directoryOf(ctx);
  return (id) => directoryName(ctx.store, directory, id);
}

/** The users the caller may see, in store order. */
export function visibleUsers(ctx) {
  const ids = directoryOf(ctx);
  const users = ctx.store.listUsers();
  return ids === null ? users : users.filter((user) => ids.has(user.id));
}

/**
 * A user the caller may see, else null: every User-valued field (authors,
 * actors, owners, members) and every people value resolves through this,
 * so hidden users look exactly like unknown IDs.
 */
export function lookupUser(ctx, id) {
  if (id === null || id === undefined) return null;
  return directoryUser(ctx.store, directoryOf(ctx), id);
}

/** Boards the caller can access, in store order. */
export const accessibleBoards = (ctx) =>
  perRequest(ctx, "boards", () => {
    const viewer = viewerOf(ctx);
    return allBoards(ctx.store).filter(
      (board) => boardAccess(ctx.store, viewer, board) !== null,
    );
  });

// ---------------------------------------------------------------- members

/**
 * The grants of `resource` as Member records `{ kind, id, name, role }`
 * plus the resource they belong to (for the verdict fields). User grants
 * outside the caller's directory and grants whose user or team no longer
 * exists are skipped; `Member.team` resolves only for visible teams.
 */
export function memberRecords(ctx, resourceKind, resource) {
  return membersOf(resourceKind, resource).flatMap((grant) => {
    const isUser = grant.kind === "user";
    const record = isUser
      ? lookupUser(ctx, grant.id)
      : ctx.store.getTeam(grant.id);
    if (!record) return [];
    const { kind, id, role } = grant;
    return [{ kind, id, role, name: record.name, resourceKind, resource }];
  });
}

/**
 * `access.memberVerdicts` for the caller, once per member and request; the
 * resource's effective owners and whether the caller manages it are
 * computed once per resource and request, so a member list costs one pass
 * over the grants rather than one per member.
 */
const verdictsOf = (ctx, member) => {
  const { resourceKind, resource, kind, id } = member;
  const scope = `${resourceKind}\u0000${resource.id}`;
  return perRequest(ctx, `member\u0000${scope}\u0000${kind}\u0000${id}`, () => {
    const viewer = viewerOf(ctx);
    const owners = perRequest(ctx, `owners\u0000${scope}`, () =>
      effectiveOwnerIds(ctx.store, resourceKind, resource),
    );
    const manages = perRequest(ctx, `manages\u0000${scope}`, () =>
      canManageMembers(ctx.store, viewer, resourceKind, resource),
    );
    const grant = member;
    const target = { viewer, resourceKind, resource, grant, owners, manages };
    return memberVerdicts(ctx.store, target);
  });
};

const Member = {
  user: (member, _a, ctx) =>
    member.kind === "user" ? lookupUser(ctx, member.id) : null,
  team: (member, _a, ctx) => {
    const team = member.kind === "team" ? ctx.store.getTeam(member.id) : null;
    return teamVisible(viewerOf(ctx), team) ? team : null;
  },
  can_remove: (member, _a, ctx) => verdictsOf(ctx, member).canRemove,
  can_change_role: (member, _a, ctx) => verdictsOf(ctx, member).canChangeRole,
  role_options: (member, _a, ctx) => verdictsOf(ctx, member).roleOptions,
  effective_role: (member, _a, ctx) => verdictsOf(ctx, member).effectiveRole,
  reason: (member, _a, ctx) => verdictsOf(ctx, member).reason,
};

export function initials(name) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const ends = words.length > 1 ? [words[0], words.at(-1)] : words;
  return ends
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
}

/** Every board record, in store order (the store pages by default). */
export const allBoards = (store) =>
  store.listBoards({ limit: Number.MAX_SAFE_INTEGER });

/** "1 member", "3 members". */
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Case-insensitive title order (for search results and directories). */
export const byTitle = (a, b) =>
  a.title.localeCompare(b.title, "en", { sensitivity: "base" }) ||
  Number(a.id) - Number(b.id);

// ------------------------------------------------------------- definition

export const definition = {
  enums: {
    ColumnType: ["name", "text", "status", "people", "date", "numbers"],
    State: ["active", "archived", "deleted"],
    StorageSegment: ["global", "instance"],
    BoardAttribute: ["name", "description"],
    GroupAttribute: ["title", "color"],
    AccountRole: ["admin", "member", "viewer", "guest"],
    UserStatus: ["active", "deactivated"],
    BoardKind: ["public", "private", "share"],
    AccessRole: ["owner", "editor", "viewer"],
    SubjectKind: ["user", "team"],
    ResourceKind: ["workspace", "board", "doc", "note"],
    WorkspaceKind: ["open", "closed"],
    DocVisibility: ["workspace", "private"],
    FormAccess: ["public", "account", "closed"],
    NoteScope: ["mine", "shared", "all"],
  },
  types: {
    Query: "version:Version! versions:[Version!]!",
    Version: "value:String! kind:String!",
    Member: `kind:SubjectKind! id:ID! name:String! role:AccessRole!
      user:User team:Team can_remove:Boolean! can_change_role:Boolean!
      role_options:[AccessRole!]! effective_role:AccessRole reason:String`,
  },
  resolvers: {
    Query: {
      version: (_p, _a, { apiVersion }) =>
        API_VERSIONS.find((version) => version.value === apiVersion),
      versions: () => API_VERSIONS,
    },
    Member,
  },
  extras: {
    "Query.version": { description: "The API version of this request." },
    "Member.effective_role": {
      description:
        "The role this grant really gives: viewer accounts are capped at viewer; null when it gives no access.",
    },
    "Member.reason": {
      description:
        "For owners: why this member's controls are off or its role is limited, when anything does.",
    },
  },
};
