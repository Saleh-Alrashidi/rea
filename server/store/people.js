/**
 * Users, teams and API tokens (SPEC-2 §2).
 *
 * Users carry an account role, a title, a status and a color. Emails are
 * unique case-insensitively. At least one active admin always remains:
 * demoting or deactivating the last one fails with `last_admin`. Role
 * changes notify the user (kind `role`) unless they made the change.
 * Teams keep at least one owner once they have one; deleting a team
 * removes its grants everywhere.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ACCOUNT_ROLES, isActive } from "../access.js";
import {
  LIMITS,
  byId,
  commit,
  failure,
  invalid,
  nextId,
  optional,
  push,
  readChoice,
  readName,
  readText,
  readTitle,
  removeWhere,
  replace,
  withChanges,
} from "../store-state.js";
import { notify } from "./activity.js";

/** Avatar colors, assigned in turn to new users and workspaces. */
export const PALETTE = Object.freeze([
  "#5b5bd6",
  "#d6336c",
  "#0b8a5f",
  "#c2410c",
  "#0369a1",
  "#7c3aed",
  "#4d7c0f",
  "#b45309",
]);

const digest = (text) => createHash("sha256").update(text, "utf8").digest();

/** Compares digests of every record so timing reveals no partial matches. */
export function findSecret(records, field, value) {
  if (typeof value !== "string" || value === "") return null;
  const wanted = digest(value);
  const same = (record) => timingSafeEqual(digest(record[field]), wanted);
  return records.filter(same)[0] ?? null;
}

export function readEmail(value) {
  if (typeof value !== "string") throw new TypeError("email must be a string");
  const email = value.trim();
  const parts = email.split("@");
  const valid =
    parts.length === 2 &&
    parts.every((part) => part !== "") &&
    !/\s/.test(email) &&
    email.length <= LIMITS.email;
  return valid ? email : invalid("Emails need one @ and no spaces");
}

const sameEmail = (a, b) => a.toLowerCase() === b.toLowerCase();

export function insertUser(ctx, { name, email, role, title, status }) {
  const { state } = ctx;
  return push(state.users, {
    id: nextId(state),
    name,
    email,
    role,
    title: title ?? null,
    status: status ?? "active",
    color: PALETTE[state.users.length % PALETTE.length],
    created_at: ctx.now(),
  });
}

export function insertTeam(ctx, { name, description, members }) {
  const { state } = ctx;
  return push(state.teams, {
    id: nextId(state),
    name,
    description: description ?? null,
    members,
    created_at: ctx.now(),
  });
}

const activeAdmins = (state) =>
  state.users.filter((u) => u.role === "admin" && isActive(u));

function userApi(ctx) {
  const { state } = ctx;
  const emailTaken = (email, exceptId = null) =>
    state.users.some((u) => u.id !== exceptId && sameEmail(u.email, email));
  const lastAdmin = (user) =>
    user.role === "admin" && isActive(user) && activeAdmins(state).length === 1;
  const save = (user, next) => {
    replace(state.users, user, next);
    return commit(ctx, { type: "user_updated", user_ids: [user.id] }, next);
  };
  const setStatus = (id, status) => {
    const user = byId(state.users, id);
    if (!user) return null;
    if (user.status === status) return user;
    if (status === "deactivated" && lastAdmin(user)) {
      return failure("last_admin", {
        message: "Keep at least one active admin",
      });
    }
    return save(user, { ...user, status });
  };
  return {
    listUsers: () => [...state.users],
    getUser: (id) => byId(state.users, id),
    findUserByEmail: (email) =>
      typeof email === "string"
        ? (state.users.find((u) => sameEmail(u.email, email.trim())) ?? null)
        : null,
    /** Invites a user (status active). Duplicate emails → `email_taken`. */
    createUser({ name, email, role = "member", title = null } = {}) {
      const fields = {
        name: readName(name, "Name"),
        email: readEmail(email),
        role: readChoice(role, ACCOUNT_ROLES, "role"),
        title: readTitle(title, "Title"),
      };
      if (emailTaken(fields.email)) return failure("email_taken");
      const user = insertUser(ctx, fields);
      return commit(ctx, { type: "user_created", user_ids: [user.id] }, user);
    },
    /** Changes name, title and/or account role; `title: null` clears. */
    updateUser(id, { name, title, role } = {}, { actorId = null } = {}) {
      const user = byId(state.users, id);
      if (!user) return null;
      const changes = {
        name: optional(name, (v) => readName(v, "Name")),
        title: title === undefined ? undefined : readTitle(title, "Title"),
        role: optional(role, (v) => readChoice(v, ACCOUNT_ROLES, "role")),
      };
      const roleChanged =
        changes.role !== undefined && changes.role !== user.role;
      if (roleChanged && lastAdmin(user)) {
        return failure("last_admin", {
          message: "Keep at least one active admin",
        });
      }
      const next = withChanges(user, changes);
      if (roleChanged) {
        const who = byId(state.users, actorId)?.name ?? "An admin";
        notify(ctx, {
          userIds: [user.id],
          actorId,
          kind: "role",
          text: `${who} changed your account role to ${next.role}`,
          url: "#/home",
        });
      }
      return save(user, next);
    },
    deactivateUser: (id) => setStatus(id, "deactivated"),
    activateUser: (id) => setStatus(id, "active"),
    findApiToken: (token) => findSecret(state.tokens, "token", token),
    /** All API tokens, for printing at startup. */
    listApiTokens: () => [...state.tokens],
  };
}

/** Validates user IDs for team membership (known and active). */
function readMemberIds(state, userIds) {
  if (!Array.isArray(userIds)) throw new TypeError("user IDs must be an array");
  const ids = [...new Set(userIds)];
  for (const id of ids) {
    if (!isActive(byId(state.users, id)))
      invalid(`Unknown or inactive user ${JSON.stringify(String(id))}`);
  }
  return ids;
}

function removeTeamGrants(state, teamId) {
  const keep = (grant) => !(grant.kind === "team" && grant.id === teamId);
  const collections = [
    ["workspaces", "members"],
    ["boards", "members"],
    ["docs", "members"],
    ["notes", "shares"],
  ];
  for (const [name, field] of collections) {
    for (const record of state[name]) {
      if (record[field].every(keep)) continue;
      replace(state[name], record, {
        ...record,
        [field]: record[field].filter(keep),
      });
    }
  }
}

function teamApi(ctx) {
  const { state } = ctx;
  const event = (type, team) => ({
    type,
    resource_kind: "team",
    resource_id: team.id,
  });
  const save = (team, next) => {
    replace(state.teams, team, next);
    return commit(ctx, event("team_updated", next), next);
  };
  return {
    listTeams: () => [...state.teams],
    getTeam: (id) => byId(state.teams, id),
    /** Teams `userId` belongs to. */
    listUserTeams: (userId) =>
      state.teams.filter((t) => t.members.some((m) => m.user_id === userId)),
    /** Creates a team; the creator becomes its owner. */
    createTeam({
      name,
      description = null,
      creatorId = null,
      memberIds = [],
    } = {}) {
      const title = readName(name, "Team name");
      const text = readText(description, "Description");
      const owners =
        creatorId === null ? [] : readMemberIds(state, [creatorId]);
      const others = readMemberIds(state, memberIds).filter(
        (id) => !owners.includes(id),
      );
      const members = [
        ...owners.map((user_id) => ({ user_id, role: "owner" })),
        ...others.map((user_id) => ({ user_id, role: "member" })),
      ];
      const team = insertTeam(ctx, { name: title, description: text, members });
      return commit(ctx, event("team_created", team), team);
    },
    updateTeam(id, { name, description } = {}) {
      const team = byId(state.teams, id);
      if (!team) return null;
      const next = withChanges(team, {
        name: optional(name, (v) => readName(v, "Team name")),
        description: optional(description, (v) => readText(v, "Description")),
      });
      return save(team, next);
    },
    /** Adds users as members (or owners); `asOwner` promotes existing ones. */
    addTeamMembers(id, userIds, { asOwner = false } = {}) {
      const team = byId(state.teams, id);
      if (!team) return null;
      const ids = readMemberIds(state, userIds);
      const role = asOwner ? "owner" : "member";
      const members = team.members.map((m) =>
        ids.includes(m.user_id) && asOwner ? { ...m, role } : m,
      );
      for (const user_id of ids) {
        if (!members.some((m) => m.user_id === user_id))
          members.push({ user_id, role });
      }
      return save(team, { ...team, members });
    },
    /** Removes members; a team that has owners keeps at least one. */
    removeTeamMembers(id, userIds) {
      const team = byId(state.teams, id);
      if (!team) return null;
      if (!Array.isArray(userIds))
        throw new TypeError("user IDs must be an array");
      const gone = new Set(userIds);
      const members = team.members.filter((m) => !gone.has(m.user_id));
      const hadOwner = team.members.some((m) => m.role === "owner");
      if (hadOwner && !members.some((m) => m.role === "owner")) {
        return failure("last_owner", {
          message: "A team keeps at least one owner",
        });
      }
      return save(team, { ...team, members });
    },
    /** Deletes the team and every grant it held. */
    deleteTeam(id) {
      const team = byId(state.teams, id);
      if (!team) return null;
      removeTeamGrants(state, id);
      removeWhere(state.teams, (record) => record === team);
      return commit(ctx, event("team_deleted", team), team);
    },
  };
}

export function peopleApi(ctx) {
  return { ...userApi(ctx), ...teamApi(ctx) };
}
