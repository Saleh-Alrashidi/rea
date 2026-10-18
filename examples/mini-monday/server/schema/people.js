/**
 * People: the account, users (the directory), teams and their mutations.
 *
 * Directory visibility (unspecified in SPEC-2, recorded with the builder
 * report): active non-guest users see every user and team. Guests see
 * themselves, the members of their teams and the people on the content
 * they can access (grants, note owners, board and doc authors, people
 * assigned to items), and only the teams they belong to. Users outside that set are reported exactly
 * like unknown IDs, in lists, counts, search and as share subjects.
 */
import {
  boardAccess,
  can,
  canManageTeam,
  docAccess,
  isAdmin,
  isGuest,
  membersOf,
  noteAccess,
  requireCapability,
  subjectUserIds,
  teamRole,
} from "../access.js";
import { peopleIds } from "../column-values.js";
import {
  allBoards,
  badInput,
  describe,
  fail,
  initials,
  notFound,
  pick,
  read,
  readDescription,
  readIds,
  readLimit,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

// --------------------------------------------------------------- directory

function addSubjects(store, ids, kind, resource) {
  for (const grant of membersOf(kind, resource)) {
    for (const id of subjectUserIds(store, grant)) ids.add(id);
  }
}

/** Adds the people assigned to items of `board` (people columns). */
function addAssignees(store, ids, board) {
  const people = store
    .listColumns(board.id)
    .filter((column) => column.type === "people");
  if (people.length === 0) return;
  const limit = Number.MAX_SAFE_INTEGER;
  for (const item of store.listItems({ boardId: board.id, limit }).items) {
    for (const column of people) {
      for (const id of peopleIds(column, item.values[column.id])) ids.add(id);
    }
  }
}

/** Users a guest may see (see the module comment). */
function guestDirectory(store, guest) {
  const ids = new Set([guest.id]);
  for (const team of store.listTeams()) {
    if (teamRole(team, guest) === null) continue;
    for (const member of team.members) ids.add(member.user_id);
  }
  for (const board of allBoards(store)) {
    if (boardAccess(store, guest, board) === null) continue;
    addSubjects(store, ids, "board", board);
    addAssignees(store, ids, board);
    if (board.creator_id) ids.add(board.creator_id);
  }
  for (const doc of store.listDocs()) {
    if (docAccess(store, guest, doc) === null) continue;
    addSubjects(store, ids, "doc", doc);
    for (const id of [doc.created_by, doc.updated_by]) if (id) ids.add(id);
  }
  for (const note of store.listNotes()) {
    if (noteAccess(store, guest, note) === null) continue;
    addSubjects(store, ids, "note", note);
    ids.add(note.owner_id);
  }
  return ids;
}

/** The users `viewer` may see, in store order. */
export function visibleUsers(store, viewer) {
  const users = store.listUsers();
  if (!isGuest(viewer)) return users;
  const ids = guestDirectory(store, viewer);
  return users.filter((user) => ids.has(user.id));
}

/** A lookup that only finds users `viewer` may see. */
export function visibleUserLookup(store, viewer) {
  const ids = new Set(visibleUsers(store, viewer).map((user) => user.id));
  return (id) => (ids.has(id) ? store.getUser(id) : null);
}

export const teamVisible = (viewer, team) =>
  Boolean(team) && (!isGuest(viewer) || teamRole(team, viewer) !== null);

/**
 * Checks share or team-member subjects: every ID must be a user (or team)
 * the caller may see, else BAD_USER_INPUT with the same message as an
 * unknown ID. Returns the deduplicated IDs.
 */
export function readSubjectIds(ctx, { kind, ids }) {
  const viewer = viewerOf(ctx);
  const wanted = readIds(ids);
  if (wanted.length === 0) badInput("List at least one user or team");
  const findUser = visibleUserLookup(ctx.store, viewer);
  for (const id of wanted) {
    const found =
      kind === "team"
        ? teamVisible(viewer, ctx.store.getTeam(id))
        : findUser(id) !== null;
    if (!found) {
      const label = kind === "team" ? "team" : "user";
      badInput(`Unknown ${label} ${describe(id)}`, { subject_id: id });
    }
  }
  return wanted;
}

/** A team the caller may see and manage (NOT_FOUND / FORBIDDEN). */
function managedTeam(ctx, teamId) {
  const viewer = viewerOf(ctx);
  const team = ctx.store.getTeam(teamId);
  if (!teamVisible(viewer, team)) notFound("Team", teamId);
  if (!canManageTeam(viewer, team)) {
    fail("FORBIDDEN", "Only team owners and admins can manage this team");
  }
  return team;
}

// --------------------------------------------------------------- resolvers

function account(_p, _a, ctx) {
  const users = visibleUsers(ctx.store, viewerOf(ctx));
  const counts = { admin: 0, member: 0, viewer: 0, guest: 0 };
  for (const user of users) counts[user.role] += 1;
  return {
    id: "1",
    name: "Worklane",
    user_count: users.length,
    role_counts_json: JSON.stringify(counts),
  };
}

const Query = wrapAll(read, {
  me: (_p, _a, ctx) => viewerOf(ctx),
  users: (_p, { ids, limit }, ctx) =>
    pick(visibleUsers(ctx.store, viewerOf(ctx)), ids).slice(
      0,
      readLimit(limit),
    ),
  teams: (_p, _a, ctx) => {
    const viewer = viewerOf(ctx);
    return ctx.store.listTeams().filter((team) => teamVisible(viewer, team));
  },
  account,
});

/** A visible user for `update_user`, or NOT_FOUND. */
function visibleUser(ctx, userId) {
  const user = visibleUserLookup(ctx.store, viewerOf(ctx))(userId);
  return user ?? notFound("User", userId);
}

function updateUser(_p, args, ctx) {
  const viewer = viewerOf(ctx);
  const target = visibleUser(ctx, args.user_id);
  const admin = can(viewer, "manage_users");
  if (!admin && target.id !== viewer.id) {
    fail("FORBIDDEN", "Only admins can change other users");
  }
  const role = args.role ?? undefined;
  if (role !== undefined && !admin) {
    fail("FORBIDDEN", "Only admins can change account roles");
  }
  const changes = {
    name: args.name == null ? undefined : readName(args.name, "Name"),
    title: args.title,
    role,
  };
  const options = { actorId: viewer.id };
  const result = ctx.store.updateUser(target.id, changes, options);
  return storeResult(result, () => notFound("User", target.id));
}

/** deactivate_user / activate_user: admins, never on themselves. */
const setStatus =
  (method) =>
  (_p, { user_id }, ctx) => {
    const admin = requireCapability(ctx, "manage_users");
    const user = ctx.store.getUser(user_id) ?? notFound("User", user_id);
    if (user.id === admin.id) {
      fail("FORBIDDEN", "You cannot change your own account status");
    }
    const result = ctx.store[method](user.id);
    return storeResult(result, () => notFound("User", user_id));
  };

function teamMembers(ctx, team, args, method) {
  const ids = readSubjectIds(ctx, { kind: "user", ids: args.user_ids });
  const options = method === "addTeamMembers" ? { asOwner: args.as_owner } : {};
  const result = ctx.store[method](team.id, ids, options);
  return storeResult(result, () => notFound("Team", team.id));
}

const Mutation = wrapAll(write, {
  invite_user(_p, args, ctx) {
    requireCapability(ctx, "manage_users");
    const fields = {
      name: readName(args.name, "Name"),
      email: args.email,
      role: args.role,
      title: args.title ?? null,
    };
    return storeResult(ctx.store.createUser(fields), () =>
      fail("BAD_USER_INPUT", "The user could not be created"),
    );
  },
  update_user: updateUser,
  deactivate_user: setStatus("deactivateUser"),
  activate_user: setStatus("activateUser"),
  create_team(_p, args, ctx) {
    const creator = requireCapability(ctx, "create_team");
    const memberIds =
      args.member_ids?.length > 0
        ? readSubjectIds(ctx, { kind: "user", ids: args.member_ids })
        : [];
    const result = ctx.store.createTeam({
      name: readName(args.name, "Team name"),
      description: readDescription(args.description) ?? null,
      creatorId: creator.id,
      memberIds,
    });
    return storeResult(result, () => badInput("The team could not be made"));
  },
  update_team(_p, args, ctx) {
    const team = managedTeam(ctx, args.team_id);
    const changes = {
      name: args.name == null ? undefined : readName(args.name, "Team name"),
      description: readDescription(args.description),
    };
    const result = ctx.store.updateTeam(team.id, changes);
    return storeResult(result, () => notFound("Team", team.id));
  },
  add_team_members: (_p, args, ctx) =>
    teamMembers(ctx, managedTeam(ctx, args.team_id), args, "addTeamMembers"),
  remove_team_members: (_p, args, ctx) =>
    teamMembers(ctx, managedTeam(ctx, args.team_id), args, "removeTeamMembers"),
  delete_team(_p, args, ctx) {
    const team = managedTeam(ctx, args.team_id);
    return storeResult(ctx.store.deleteTeam(team.id), () =>
      notFound("Team", team.id),
    );
  },
});

const User = {
  is_admin: (user) => isAdmin(user),
  initials: (user) => initials(user.name),
  teams: (user, _a, ctx) => {
    const viewer = viewerOf(ctx);
    return ctx.store
      .listUserTeams(user.id)
      .filter((team) => teamVisible(viewer, team));
  },
};

const teamMemberRecords = (team, store) =>
  team.members.flatMap((member) => {
    const user = store.getUser(member.user_id);
    return user ? [{ user, role: member.role }] : [];
  });

const Team = {
  members: (team, _a, { store }) => teamMemberRecords(team, store),
  member_count: (team, _a, { store }) => teamMemberRecords(team, store).length,
  my_role: (team, _a, ctx) => teamRole(team, viewerOf(ctx)),
  can_manage: (team, _a, ctx) => canManageTeam(viewerOf(ctx), team),
};

export const definition = {
  types: {
    Query: `me:User! users(ids:[ID!],limit:Int=50):[User!]! teams:[Team!]!
      account:Account!`,
    Account: "id:ID! name:String! user_count:Int! role_counts_json:String!",
    User: `id:ID! name:String! email:String! is_admin:Boolean! initials:String!
      role:AccountRole! title:String status:UserStatus! color:String!
      created_at:String! teams:[Team!]!`,
    Team: `id:ID! name:String! description:String members:[TeamMember!]!
      member_count:Int! my_role:String can_manage:Boolean!`,
    TeamMember: "user:User! role:String!",
    Mutation: `invite_user(name:String!,email:String!,role:AccountRole!,title:String):User!
      update_user(user_id:ID!,name:String,title:String,role:AccountRole):User!
      deactivate_user(user_id:ID!):User!
      activate_user(user_id:ID!):User!
      create_team(name:String!,description:String,member_ids:[ID!]):Team!
      update_team(team_id:ID!,name:String,description:String):Team!
      add_team_members(team_id:ID!,user_ids:[ID!]!,as_owner:Boolean=false):Team!
      remove_team_members(team_id:ID!,user_ids:[ID!]!):Team!
      delete_team(team_id:ID!):Team!`,
  },
  resolvers: { Query, Mutation, User, Team },
  extras: {
    "Query.me": { description: "The calling user." },
    "Query.users": { description: "Users the caller may see." },
  },
};
