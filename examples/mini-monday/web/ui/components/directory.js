/**
 * The account directory: users and teams the signed-in user may see (the
 * server filters both lists). Loaded once and shared by the names and
 * avatars of people columns and the team pickers; `refreshShell()`
 * invalidates it. Who may be assigned or invited is not read from it: the
 * server answers that (`Board.assignable_users`, `share_candidates`).
 * Switching the demo user reloads the page, so the cache never outlives
 * the session that filled it.
 */

import { request } from "../../api.js";

export const DIRECTORY_QUERY = `query Directory {
  users(limit: 500) { id name email initials color role status title }
  teams { id name description member_count }
}`;

let pending = null;

/**
 * @typedef {object} Directory
 * @property {Map<string, object>} users  user records by ID (all statuses)
 * @property {object[]} userList          the same users in API order
 * @property {object[]} teams             `{ id, name, description, member_count }`
 */

/**
 * Loads (or returns the cached) directory. A failed load is not cached.
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<Directory>}
 */
export function loadDirectory({ refresh = false } = {}) {
  if (refresh || !pending) {
    const attempt = request(DIRECTORY_QUERY).then((data) => {
      const userList = data.users.map((user) => ({
        ...user,
        id: String(user.id),
      }));
      return {
        users: new Map(userList.map((user) => [user.id, user])),
        userList,
        teams: data.teams.map((team) => ({ ...team, id: String(team.id) })),
      };
    });
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
  }
  return pending;
}

/** Drops the cache; the next `loadDirectory()` fetches again. */
export function invalidateDirectory() {
  pending = null;
}
