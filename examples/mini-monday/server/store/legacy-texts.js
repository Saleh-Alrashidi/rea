/**
 * The upgrade of `mini-monday-store/2` data files to the current format
 * (`persistence.js` runs it once, when it loads a /2 file).
 *
 * Version 2 wrote the names of the people a text mentions into the text:
 * a notification begins with its actor's name, a people column's activity
 * texts list names joined by ", ", and member activity texts read
 * "<name> (<role>)". The current format stores those people as mentions
 * (rich text, `store/activity.js`), so each viewer reads only the names
 * their directory allows (SPEC-2 §6). Plain strings that remain hold no
 * user names (labels, titles, team names).
 *
 * The conversion fails closed: a name it cannot tie to exactly one user
 * becomes HIDDEN_USER_NAME for every viewer, and a notification text of an
 * unknown shape is replaced by a neutral one. Activity entries of user
 * actors drop their stored `actor_label` (the name at the time); the
 * label is kept only for non-user actors (forms).
 */
import { ACCESS_ROLES, HIDDEN_USER_NAME } from "../access.js";
import { deepFreeze, onBoard } from "../store-state.js";
import { byActor, mention } from "./activity.js";

export const LEGACY_FORMAT = "mini-monday-store/2";

/** What followed the actor's name in each kind of /2 notification text. */
const NOTIFICATION_RESTS = Object.freeze({
  share: [" shared the ", " (admin) took ownership of the "],
  assign: [" assigned you to "],
  update: [" posted an update on "],
  role: [" changed your account role to "],
});
const NEUTRAL_REST = " sent you a notification";
const MEMBER_KINDS = new Set([
  "member_added",
  "member_removed",
  "member_role_changed",
  "ownership_taken",
]);
const ROLE_SUFFIX = new RegExp(`^(.+) \\((${ACCESS_ROLES.join("|")})\\)$`, "s");

/** Name → IDs of the records with exactly that name. */
function namesIndex(records) {
  const index = new Map();
  for (const record of records) {
    index.set(record.name, [...(index.get(record.name) ?? []), record.id]);
  }
  return index;
}

function lookups(state) {
  const users = namesIndex(state.users);
  const teams = namesIndex(state.teams);
  const userNames = new Map(state.users.map((user) => [user.id, user.name]));
  return {
    nameOf: (id) => userNames.get(id) ?? null,
    /** The one user named `name`, else null (none, or ambiguous). */
    userNamed(name) {
      const ids = users.get(name) ?? [];
      return ids.length === 1 ? ids[0] : null;
    },
    isUserName: (name) => users.has(name),
    isTeamName: (name) => teams.has(name),
  };
}

/** "<actor><rest>" with the actor as a mention (renamed actors included). */
function notificationText(names, record) {
  const { text, kind } = record;
  const actorId = record.actor_id;
  const rests = NOTIFICATION_RESTS[kind];
  // Texts without an acting user named nobody ("Someone …", form responses).
  if (typeof text !== "string" || actorId === null || !rests) return text;
  const name = names.nameOf(actorId);
  const rest =
    name !== null && text.startsWith(name) ? text.slice(name.length) : null;
  if (rest !== null && rests.some((phrase) => rest.startsWith(phrase))) {
    return byActor(actorId, rest);
  }
  // Renamed since: everything before the last known phrase was the name.
  const at = Math.max(...rests.map((phrase) => text.lastIndexOf(phrase)));
  return byActor(actorId, at < 0 ? NEUTRAL_REST : text.slice(at));
}

/** "A, B" of a people value as mentions; unknown names are hidden. */
function peopleText(names, text) {
  if (typeof text !== "string" || text === "") return text;
  return text.split(", ").flatMap((name, index) => {
    const id = names.userNamed(name);
    const part = id === null ? { text: HIDDEN_USER_NAME } : mention(id);
    return index === 0 ? [part] : [{ text: ", " }, part];
  });
}

/** "<user> (<role>)" as a mention; team names stay text. */
function memberText(names, text) {
  if (typeof text !== "string") return text;
  const match = ROLE_SUFFIX.exec(text);
  if (!match) return HIDDEN_USER_NAME;
  const [, name, role] = match;
  const team = names.isTeamName(name);
  const id = team ? null : names.userNamed(name);
  if (id !== null) return [mention(id), { text: ` (${role})` }];
  // A team keeps its name; a name shared by a user and a team is unclear.
  if (team && !names.isUserName(name)) return text;
  return `${HIDDEN_USER_NAME} (${role})`;
}

function activityRecord(state, names, record) {
  const next = { ...record };
  if (record.actor_id !== null) next.actor_label = null;
  let convert = null;
  if (MEMBER_KINDS.has(record.kind)) convert = memberText;
  if (record.kind === "column_value_changed") {
    const column = onBoard(state.columns, record.board_id, record.column_id);
    // A column that is gone may have been a people column.
    if (column === null || column.type === "people") convert = peopleText;
  }
  if (convert !== null) {
    next.from_text = convert(names, record.from_text);
    next.to_text = convert(names, record.to_text);
  }
  return deepFreeze(next);
}

/**
 * Converts the texts of a validated /2 `state` in place (notifications
 * and activity), as described above.
 */
export function upgradeLegacyTexts(state) {
  const names = lookups(state);
  state.notifications = state.notifications.map((record) =>
    deepFreeze({ ...record, text: notificationText(names, record) }),
  );
  state.activity = state.activity.map((record) =>
    activityRecord(state, names, record),
  );
}
