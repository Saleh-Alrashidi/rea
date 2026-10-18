/**
 * GraphQL documents and pure helpers of the Teams pages (`#/teams`,
 * `#/teams/<id>`). `teams` lists only the teams the user may see (guests:
 * their own teams), so an unknown and a hidden team read the same.
 * Managing a team needs `can_manage` (team owners and admins); the server
 * checks it again (`access.canManageTeam`) and keeps at least one owner.
 */

import { REASONS } from "../components/permissions.js";

export const TEAMS_QUERY = `query Teams {
  teams {
    id name description member_count my_role can_manage
    members { role user { id name initials color status title email } }
  }
}`;

export const TEAM_MUTATIONS = Object.freeze({
  create: `mutation CreateTeam($name: String!, $description: String, $memberIds: [ID!]) {
  create_team(name: $name, description: $description, member_ids: $memberIds) { id }
}`,
  update: `mutation UpdateTeam($teamId: ID!, $name: String, $description: String) {
  update_team(team_id: $teamId, name: $name, description: $description) { id }
}`,
  addMembers: `mutation AddTeamMembers($teamId: ID!, $userIds: [ID!]!, $asOwner: Boolean) {
  add_team_members(team_id: $teamId, user_ids: $userIds, as_owner: $asOwner) { id }
}`,
  removeMembers: `mutation RemoveTeamMembers($teamId: ID!, $userIds: [ID!]!) {
  remove_team_members(team_id: $teamId, user_ids: $userIds) { id }
}`,
  // The API promotes with add_team_members(as_owner: true) but has no
  // demotion, so an owner becomes a member by leaving and rejoining in one
  // request. Mutations run in order: when the removal is refused (the last
  // owner), the add leaves the existing owner unchanged.
  makeMember: `mutation MakeTeamMember($teamId: ID!, $userIds: [ID!]!) {
  removed: remove_team_members(team_id: $teamId, user_ids: $userIds) { id }
  added: add_team_members(team_id: $teamId, user_ids: $userIds, as_owner: false) { id }
}`,
  remove: `mutation DeleteTeam($teamId: ID!) {
  delete_team(team_id: $teamId) { id }
}`,
});

const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** The page's copy of an API team: string IDs, members owners first. */
export function normalizeTeam(raw) {
  const members = (raw.members ?? [])
    .filter((member) => member?.user)
    .map((member) => ({
      ...member.user,
      id: String(member.user.id),
      role: member.role === "owner" ? "owner" : "member",
    }))
    .sort((a, b) =>
      a.role === b.role ? byName(a, b) : a.role === "owner" ? -1 : 1,
    );
  return {
    id: String(raw.id),
    name: raw.name,
    description: raw.description ?? "",
    memberCount: Number.isSafeInteger(raw.member_count)
      ? raw.member_count
      : members.length,
    myRole:
      raw.my_role === "owner" || raw.my_role === "member" ? raw.my_role : null,
    canManage: raw.can_manage === true,
    members,
  };
}

/** Teams sorted: the user's own first, then by name. */
export function sortTeams(teams) {
  return [...teams].sort((a, b) => {
    const mine = Number(Boolean(b.myRole)) - Number(Boolean(a.myRole));
    return mine || byName(a, b);
  });
}

/**
 * What the user may do to `member` of `team`, as reasons for disabled
 * controls (null when allowed): `{ remove, promote, demote }`.
 */
export function memberActions(team, member) {
  if (!team.canManage) {
    const reason = "Only team owners and admins can change members";
    return { remove: reason, promote: reason, demote: reason };
  }
  const owners = team.members.filter((entry) => entry.role === "owner");
  const lastOwner = member.role === "owner" && owners.length <= 1;
  const keep = "A team keeps at least one owner";
  const inactive =
    member.status === "deactivated"
      ? "Deactivated people keep their current role"
      : null;
  return {
    remove: lastOwner ? keep : null,
    promote: member.role === "owner" ? "Already an owner" : inactive,
    demote:
      member.role !== "owner"
        ? "Already a member"
        : lastOwner
          ? keep
          : inactive,
  };
}

/** Reason the user can't create teams, or null. */
export function createTeamReason(canCreate) {
  return canCreate ? null : REASONS.noCreate;
}
