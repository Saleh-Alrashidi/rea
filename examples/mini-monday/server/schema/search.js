/**
 * Cross-resource lists: `search`, `shared_with_me` and the admin content
 * directory. Every candidate is filtered with `server/access.js` before it
 * can match, so results, their order and their number never reveal
 * inaccessible records. The content directory is metadata only (title,
 * privacy, owner, workspace) and never lists notes.
 */
import {
  isActive,
  requireCapability,
  resourceAccess,
  subjectGrants,
  workspaceAccess,
} from "../access.js";
import {
  MAX_NAME_LENGTH,
  allBoards,
  badInput,
  byTitle,
  read,
  readLimit,
  viewerOf,
  wrapAll,
} from "./common.js";
import { teamVisible, visibleUsers } from "./people.js";

const MAX_SEARCH_RESULTS = 50;
const BOARD_KINDS = { public: "Main", private: "Private", share: "Shareable" };
const ROLE_TEXT = { editor: "Can edit", viewer: "Can view" };

const result = (kind, record, { title, subtitle = null, url }) => ({
  kind,
  id: record.id,
  title: title ?? record.name ?? record.title,
  subtitle,
  url,
});
const order = (a, b) => a.kind.localeCompare(b.kind) || byTitle(a, b);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Boards, docs and notes the caller can open, with their access role. */
function accessibleContent(store, viewer) {
  const pairs = (kind, records) =>
    records.flatMap((record) => {
      const role = resourceAccess(store, viewer, kind, record);
      return role === null ? [] : [{ kind, record, role }];
    });
  return [
    ...pairs("board", allBoards(store)),
    ...pairs("doc", store.listDocs()),
    ...pairs("note", store.listNotes()),
  ];
}

const boardResult = (board) =>
  result("board", board, {
    subtitle: `${BOARD_KINDS[board.board_kind]} board`,
    url: `#/boards/${board.id}`,
  });
const docResult = (doc) =>
  result("doc", doc, {
    subtitle: doc.visibility === "private" ? "Private doc" : "Workspace doc",
    url: `#/docs/${doc.id}`,
  });
function noteResult(store, viewer, note) {
  const owner = store.getUser(note.owner_id);
  const mine = note.owner_id === viewer.id;
  const subtitle = mine ? "Your note" : `Shared by ${owner?.name ?? "someone"}`;
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

function directoryResults(store, viewer) {
  const users = visibleUsers(store, viewer).map((user) => {
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

/** Every record `viewer` could find, as SearchResults. */
function candidates(store, viewer) {
  const content = accessibleContent(store, viewer);
  const boards = content.filter((entry) => entry.kind === "board");
  const own = content.map(({ kind, record }) => {
    if (kind === "board") return boardResult(record);
    if (kind === "doc") return docResult(record);
    return noteResult(store, viewer, record);
  });
  return [
    ...own,
    ...boardContent(
      store,
      boards.map((entry) => entry.record),
    ),
    ...directoryResults(store, viewer),
  ];
}

function search(_p, args, ctx) {
  const limit = readLimit(args.limit, MAX_SEARCH_RESULTS);
  const term = args.query.trim().toLowerCase();
  if (term.length > MAX_NAME_LENGTH) {
    badInput(`query must be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (term === "") return [];
  return candidates(ctx.store, viewerOf(ctx))
    .filter((entry) => entry.title.toLowerCase().includes(term))
    .sort(order)
    .slice(0, limit);
}

/** Content reached through an explicit grant where the caller is no owner. */
function sharedWithMe(_p, _a, ctx) {
  const { store } = ctx;
  const viewer = viewerOf(ctx);
  const field = { board: "members", doc: "members", note: "shares" };
  return accessibleContent(store, viewer)
    .filter(
      ({ kind, record, role }) =>
        role !== "owner" &&
        subjectGrants(store, viewer, record[field[kind]]) !== null,
    )
    .map(({ kind, record, role }) => {
      const entry =
        kind === "board"
          ? boardResult(record)
          : kind === "doc"
            ? docResult(record)
            : noteResult(store, viewer, record);
      return { ...entry, subtitle: ROLE_TEXT[role] ?? entry.subtitle };
    })
    .sort(order);
}

/** The first user owner grant of a board or doc, else its creator. */
function ownerOf(store, record) {
  const grant = record.members.find(
    (entry) => entry.kind === "user" && entry.role === "owner",
  );
  const id = grant?.id ?? record.creator_id ?? record.created_by ?? null;
  return id ? store.getUser(id) : null;
}

function contentDirectory(_p, _a, ctx) {
  requireCapability(ctx, "admin_directory");
  const { store } = ctx;
  const entry = (kind, record, privacy) => ({
    kind,
    id: record.id,
    title: record.name ?? record.title,
    privacy,
    owner: ownerOf(store, record),
    workspace: store.getWorkspace(record.workspace_id),
  });
  return [
    ...allBoards(store).map((board) => entry("board", board, board.board_kind)),
    ...store.listDocs().map((doc) => entry("doc", doc, doc.visibility)),
  ].sort(order);
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
