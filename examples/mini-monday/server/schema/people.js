/**
 * People: the account, users (the directory), teams and their mutations.
 * Who may see which users and teams is decided by `server/access.js`
 * (`visibleUserIds`, `teamVisible`); users outside the caller's directory
 * are reported exactly like unknown IDs, in lists, counts, search, as
 * share subjects and in every User-valued field (`lookupUser`).
 */
import { describe } from "../input.js";
import {
  can,
  canManageTeam,
  capabilitiesOf,
  isAdmin,
  requireCapability,
  teamRole,
  teamVisible,
} from "../access.js";
import {
  badInput,
  fail,
  initials,
  lookupUser,
  notFound,
  pick,
  read,
  readDescription,
  readIds,
  readLimit,
  readName,
  storeResult,
  viewerOf,
  visibleUsers,
  wrapAll,
  write,
} from "./common.js";

/**
 * Checks share or team-member subjects: every ID must be a user (or team)
 * the caller may see, else BAD_USER_INPUT with the same message as an
 * unknown ID. Returns the deduplicated IDs.
 */
export function readSubjectIds(ctx, { kind, ids }) {
  const viewer = viewerOf(ctx);
  const wanted = readIds(ids);
  if (wanted.length === 0) badInput("List at least one user or team");
  for (const id of wanted) {
    const found =
      kind === "team"
        ? teamVisible(viewer, ctx.store.getTeam(id))
        : lookupUser(ctx, id) !== null;
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
  const users = visibleUsers(ctx);
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
    pick(visibleUsers(ctx), ids).slice(0, readLimit(limit)),
  teams: (_p, _a, ctx) => {
    const viewer = viewerOf(ctx);
    return ctx.store.listTeams().filter((team) => teamVisible(viewer, team));
  },
  account,
});

/** A visible user for `update_user`, or NOT_FOUND. */
const visibleUser = (ctx, userId) =>
  lookupUser(ctx, userId) ?? notFound("User", userId);

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
  set_team_member_role(_p, args, ctx) {
    const team = managedTeam(ctx, args.team_id);
    const [userId] = readSubjectIds(ctx, { kind: "user", ids: [args.user_id] });
    const result = ctx.store.setTeamMemberRole(team.id, userId, args.role);
    return storeResult(result, () => notFound("Team", team.id));
  },
  delete_team(_p, args, ctx) {
    const team = managedTeam(ctx, args.team_id);
    const result = ctx.store.deleteTeam(team.id, { actorId: viewerOf(ctx).id });
    return storeResult(result, () => notFound("Team", team.id));
  },
});

const User = {
  is_admin: (user) => isAdmin(user),
  initials: (user) => initials(user.name),
  // The caller's own account capabilities; other users show none.
  capabilities: (user, _a, ctx) =>
    user.id === viewerOf(ctx).id ? capabilitiesOf(user) : [],
  teams: (user, _a, ctx) => {
    const viewer = viewerOf(ctx);
    return ctx.store
      .listUserTeams(user.id)
      .filter((team) => teamVisible(viewer, team));
  },
};

/** The team's members the caller may see. */
const teamMemberRecords = (team, ctx) =>
  team.members.flatMap((member) => {
    const user = lookupUser(ctx, member.user_id);
    return user ? [{ user, role: member.role }] : [];
  });

const Team = {
  members: (team, _a, ctx) => teamMemberRecords(team, ctx),
  member_count: (team, _a, ctx) => teamMemberRecords(team, ctx).length,
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
      created_at:String! teams:[Team!]! capabilities:[String!]!`,
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
      set_team_member_role(team_id:ID!,user_id:ID!,role:String!):Team!
      delete_team(team_id:ID!):Team!`,
  },
  resolvers: { Query, Mutation, User, Team },
  extras: {
    "Query.me": { description: "The calling user." },
    "Query.users": { description: "Users the caller may see." },
    "User.capabilities": {
      description:
        "The caller's account capabilities (from access.can) on `me`; [] for everyone else.",
    },
    "Team.can_manage": {
      description:
        "Admins and team owners; a viewer account that owns the team cannot.",
    },
    "Mutation.set_team_member_role": {
      description: 'Makes a team member "owner" or "member" in one change.',
    },
  },
};
