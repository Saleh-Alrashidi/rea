/**
 * Cross-resource lists: `search`, `shared_with_me` and the admin content
 * directory. Every candidate is filtered with `server/access.js` before it
 * can match, so results, their order and their number never reveal
 * inaccessible records. The content directory is metadata only (title,
 * privacy, owner, workspace) and never lists notes.
 */
import {
  isActive,
  membersOf,
  requireCapability,
  resourceAccess,
  subjectGrants,
  teamVisible,
  workspaceAccess,
} from "../access.js";
import { BOARD_KIND_LABELS } from "../store-state.js";
import { LIMITS } from "../input.js";
import {
  accessibleBoards,
  allBoards,
  badInput,
  byTitle,
  lookupUser,
  namesFor,
  perRequest,
  plural,
  read,
  readLimit,
  viewerOf,
  visibleUsers,
  wrapAll,
} from "./common.js";

const MAX_SEARCH_RESULTS = 50;
const ROLE_TEXT = { editor: "Can edit", viewer: "Can view" };

const result = (kind, record, { title, subtitle = null, url }) => ({
  kind,
  id: record.id,
  title: title ?? record.name ?? record.title,
  subtitle,
  url,
});
const order = (a, b) => a.kind.localeCompare(b.kind) || byTitle(a, b);

/**
 * Boards, docs and notes the caller can open, with their access role
 * (once per request, like every list below: a query may alias these
 * fields up to the field budget).
 */
const accessibleContent = (ctx) =>
  perRequest(ctx, "content", () => {
    const { store } = ctx;
    const viewer = viewerOf(ctx);
    const pairs = (kind, records) =>
      records.flatMap((record) => {
        const role = resourceAccess(store, viewer, kind, record);
        return role === null ? [] : [{ kind, record, role }];
      });
    return [
      ...pairs("board", accessibleBoards(ctx)),
      ...pairs("doc", store.listDocs()),
      ...pairs("note", store.listNotes()),
    ];
  });

const boardResult = (board) =>
  result("board", board, {
    subtitle: `${BOARD_KIND_LABELS[board.board_kind]} board`,
    url: `#/boards/${board.id}`,
  });
const docResult = (doc) =>
  result("doc", doc, {
    subtitle: doc.visibility === "private" ? "Private doc" : "Workspace doc",
    url: `#/docs/${doc.id}`,
  });
function noteResult(ctx, note) {
  const mine = note.owner_id === viewerOf(ctx).id;
  const owner = namesFor(ctx)(note.owner_id);
  const subtitle = mine ? "Your note" : `Shared by ${owner}`;
  return result("note", note, { subtitle, url: `#/notes/${note.id}` });
}

/** Items and forms of the accessible boards. */
function boardContent(store, boards) {
  return boards.flatMap((board) => {
    const { items } = store.listItems({
      boardId: board.id,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const url = (item) => `#/boards/${board.id}/items/${item.id}`;
    return [
      ...items.map((item) =>
        result("item", item, { subtitle: board.name, url: url(item) }),
      ),
      ...store.listForms({ boardId: board.id }).map((form) =>
        result("form", form, {
          subtitle: board.name,
          url: `#/forms/${form.id}`,
        }),
      ),
    ];
  });
}

function directoryResults(ctx) {
  const { store } = ctx;
  const viewer = viewerOf(ctx);
  const users = visibleUsers(ctx).map((user) => {
    const status = isActive(user) ? null : "Deactivated";
    const subtitle = [user.title, status].filter(Boolean).join(" · ") || null;
    return result("user", user, { subtitle, url: "#/teams" });
  });
  const teams = store
    .listTeams()
    .filter((team) => teamVisible(viewer, team))
    .map((team) =>
      result("team", team, {
        subtitle: plural(team.members.length, "member"),
        url: `#/teams/${team.id}`,
      }),
    );
  const workspaces = store
    .listWorkspaces()
    .filter((workspace) => workspaceAccess(store, viewer, workspace) !== null)
    .map((workspace) =>
      result("workspace", workspace, {
        subtitle:
          workspace.kind === "open" ? "Open workspace" : "Closed workspace",
        url: `#/workspaces/${workspace.id}`,
      }),
    );
  return [...users, ...teams, ...workspaces];
}

const contentResult = (ctx, { kind, record }) => {
  if (kind === "board") return boardResult(record);
  if (kind === "doc") return docResult(record);
  return noteResult(ctx, record);
};

/**
 * Every record the caller could find, as SearchResults in result order
 * with their lower-cased titles (`match`), once per request.
 */
const candidates = (ctx) =>
  perRequest(ctx, "search", () => {
    const content = accessibleContent(ctx);
    const boards = content.filter((entry) => entry.kind === "board");
    const records = boards.map((entry) => entry.record);
    const all = [
      ...content.map((entry) => contentResult(ctx, entry)),
      ...boardContent(ctx.store, records),
      ...directoryResults(ctx),
    ].sort(order);
    return all.map((entry) => ({ entry, match: entry.title.toLowerCase() }));
  });

function search(_p, args, ctx) {
  const limit = readLimit(args.limit, MAX_SEARCH_RESULTS);
  const term = args.query.trim().toLowerCase();
  if (term.length > LIMITS.name) {
    badInput(`query must be at most ${LIMITS.name} characters`);
  }
  if (term === "") return [];
  const results = [];
  for (const { entry, match } of candidates(ctx)) {
    if (!match.includes(term)) continue;
    results.push(entry);
    if (results.length === limit) break;
  }
  return results;
}

/** Content reached through an explicit grant where the caller is no owner. */
const sharedWithMe = (_p, _a, ctx) =>
  perRequest(ctx, "shared_with_me", () => {
    const { store } = ctx;
    const viewer = viewerOf(ctx);
    const shared = ({ kind, record, role }) =>
      role !== "owner" &&
      subjectGrants(store, viewer, membersOf(kind, record)) !== null;
    return accessibleContent(ctx)
      .filter(shared)
      .map((content) => {
        const entry = contentResult(ctx, content);
        return {
          ...entry,
          subtitle: ROLE_TEXT[content.role] ?? entry.subtitle,
        };
      })
      .sort(order);
  });

/** The first user owner grant of a board or doc, else its creator. */
function ownerOf(ctx, record) {
  const grant = record.members.find(
    (entry) => entry.kind === "user" && entry.role === "owner",
  );
  const id = grant?.id ?? record.creator_id ?? record.created_by ?? null;
  return lookupUser(ctx, id);
}

function contentDirectory(_p, _a, ctx) {
  requireCapability(ctx, "admin_directory");
  return perRequest(ctx, "content_directory", () => {
    const { store } = ctx;
    const entry = (kind, record, privacy) => ({
      kind,
      id: record.id,
      title: record.name ?? record.title,
      privacy,
      owner: ownerOf(ctx, record),
      workspace: store.getWorkspace(record.workspace_id),
    });
    const boards = allBoards(store);
    return [
      ...boards.map((board) => entry("board", board, board.board_kind)),
      ...store.listDocs().map((doc) => entry("doc", doc, doc.visibility)),
    ].sort(order);
  });
}

export const definition = {
  types: {
    Query: `search(query:String!,limit:Int=20):[SearchResult!]!
      shared_with_me:[SearchResult!]!
      admin_content_directory:[ContentEntry!]!`,
    SearchResult:
      "kind:String! id:ID! title:String! subtitle:String url:String!",
    ContentEntry: `kind:String! id:ID! title:String! privacy:String!
      owner:User workspace:Workspace`,
  },
  resolvers: {
    Query: wrapAll(read, {
      search,
      shared_with_me: sharedWithMe,
      admin_content_directory: contentDirectory,
    }),
  },
  extras: {
    "Query.search": { description: "Accessible records whose title matches." },
    "Query.admin_content_directory": {
      description: "Admins: every board and doc (metadata only).",
    },
  },
};
