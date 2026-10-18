/**
 * The board activity timeline's data rules (no DOM): how each activity
 * kind reads as a sentence, which values show as from → to chips (status
 * chips take the label color from the board's column settings) and how
 * entries group into days.
 *
 * Entries are the API's `ActivityLog` records (SPEC-2 §2): `kind`, `actor`
 * or `actor_label`, `item_id`/`item_name`, `column_id`, `from_text`,
 * `to_text`, `created_at`. Unknown kinds still render, as a generic change.
 */

import { formatDay, todayString } from "../components/format.js";
import { SOMEONE } from "../components/labels.js";

/**
 * A sentence part: plain `text`, an emphasised `strong` name, or an
 * `item` reference (`{ id, name }`; `id` is null when the item is gone).
 * @typedef {{ text: string } | { strong: string } |
 *   { item: { id: string | null, name: string } }} Segment
 */

/**
 * @typedef {object} ActivityDescription
 * @property {string} icon            icon name for the entry
 * @property {Segment[]} segments     the sentence after the actor's name
 * @property {{ text: string | null, color: string | null } | null} from
 * @property {{ text: string | null, color: string | null } | null} to
 * @property {string | null} detail  a line under the sentence, or null
 */

const text = (value) => ({ text: value });
const strong = (value) => ({ strong: value ?? "" });

/** A chip for a from/to value, or null when the change has no side. */
function chip(value, color = null) {
  return value === null || value === undefined ? null : { text: value, color };
}

/** Date column values read as days ("Oct 20"); other texts as given. */
function chipText(column, value) {
  if (column?.type !== "date") return value;
  return formatDay(value) || value;
}

/** The label color of a status text in `column`, or null. */
function statusColor(column, label) {
  if (column?.type !== "status" || !label) return null;
  return (
    column.status?.options.find((option) => option.label === label)?.color ??
    null
  );
}

function itemRef(entry, board) {
  const id = entry.item_id;
  const exists =
    id !== null && (board?.items ?? []).some((item) => item.id === id);
  return { item: { id: exists ? id : null, name: entry.item_name ?? "" } };
}

/** Kinds whose `from_text` → `to_text` pair shows as chips. */
const CHIP_KINDS = new Set([
  "item_renamed",
  "item_moved",
  "column_value_changed",
  "group_renamed",
  "board_kind_changed",
  "member_role_changed",
]);

function sentence(entry, board, column) {
  const item = itemRef(entry, board);
  const columnName = column?.title ?? "a column";
  const into = entry.to_text ? [text(" in "), strong(entry.to_text)] : [];
  switch (entry.kind) {
    case "item_created":
      return { icon: "plus", segments: [text("created "), item, ...into] };
    case "item_renamed":
      return { icon: "edit", segments: [text("renamed "), item] };
    case "item_moved":
      return { icon: "arrowRight", segments: [text("moved "), item] };
    case "item_deleted":
      return {
        icon: "trash",
        segments: [text("deleted "), { item: { ...item.item, id: null } }],
      };
    case "column_value_changed":
      return {
        icon: "edit",
        segments: [text("changed "), strong(columnName), text(" on "), item],
      };
    case "form_submitted":
      return { icon: "forms", segments: [text("submitted "), item, ...into] };
    default:
      return null;
  }
}

function boardSentence(entry) {
  switch (entry.kind) {
    case "group_created":
      return {
        icon: "plus",
        segments: [text("added the group "), strong(entry.to_text)],
      };
    case "group_renamed":
      return { icon: "edit", segments: [text("renamed a group")] };
    case "group_deleted":
      return {
        icon: "trash",
        segments: [text("deleted the group "), strong(entry.from_text)],
      };
    case "column_created":
      return {
        icon: "plus",
        segments: [text("added the column "), strong(entry.to_text)],
      };
    case "board_kind_changed":
      return { icon: "lock", segments: [text("changed the board type")] };
    case "member_added":
      return {
        icon: "userPlus",
        segments: [text("gave access to "), strong(entry.to_text)],
      };
    case "member_removed":
      return {
        icon: "users",
        segments: [text("removed access for "), strong(entry.from_text)],
      };
    case "member_role_changed":
      return { icon: "users", segments: [text("changed a member’s access")] };
    case "ownership_taken":
      return {
        icon: "admin",
        segments: [text("took ownership of the board as an admin")],
      };
    case "board_imported":
      return {
        icon: "inbox",
        segments: [text("imported this board")],
        // The source and what came from it, as the server summarized it.
        detail: entry.to_text ?? null,
      };
    default:
      return null;
  }
}

const GENERIC = Object.freeze({
  icon: "activity",
  segments: [text("made a change")],
});

/**
 * Describes one activity entry against the loaded `board` (its columns
 * name changed values and its items decide which item names are links).
 * @returns {ActivityDescription}
 */
export function describeActivity(entry, board) {
  const columns = board?.columns ?? [];
  const column =
    columns.find((candidate) => candidate.id === entry.column_id) ?? null;
  const known = sentence(entry, board, column) ?? boardSentence(entry);
  // Unknown kinds show whatever from → to values they carry.
  const chips = CHIP_KINDS.has(entry.kind) || !known;
  const side = (value) =>
    chips ? chip(chipText(column, value), statusColor(column, value)) : null;
  return {
    detail: null,
    ...(known ?? GENERIC),
    from: side(entry.from_text),
    to: side(entry.to_text),
  };
}

/**
 * The actor of an entry for display: the user (with avatar data), a form
 * (`form_submitted`, labelled "Form: Feature request"), or a person the
 * viewer may not see, whom the server labels "Someone" and gives no
 * `actor` record. A user acting through something else (an import,
 * labelled "Import from monday.com") has that label as `via`.
 * @returns {{ kind: "user", user: object, name: string,
 *   via: string | null } | { kind: "form" | "hidden", name: string }}
 */
export function activityActor(entry) {
  if (entry.actor) {
    const label = entry.actor_label;
    return {
      kind: "user",
      user: { ...entry.actor, id: String(entry.actor.id) },
      name: entry.actor.name,
      via: label && label !== entry.actor.name ? label : null,
    };
  }
  return {
    kind: entry.kind === "form_submitted" ? "form" : "hidden",
    name: entry.actor_label || SOMEONE,
  };
}

/** The local calendar day ("YYYY-MM-DD") of an ISO timestamp, or null. */
export function localDay(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : todayString(date);
}

/** "Today", "Yesterday" or a long date for a "YYYY-MM-DD" day. */
export function dayLabel(day, now = new Date()) {
  if (day === null) return "Earlier";
  const today = todayString(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === today) return "Today";
  if (day === todayString(yesterday)) return "Yesterday";
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year, month - 1, date);
  return value.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: year === now.getFullYear() ? undefined : "numeric",
  });
}

/**
 * Groups entries (newest first) into consecutive days, keeping the order:
 * `[{ day, label, entries }]`.
 */
export function groupActivityByDay(entries, now = new Date()) {
  const days = [];
  for (const entry of entries) {
    const day = localDay(entry.created_at);
    let group = days.at(-1);
    if (!group || group.day !== day) {
      group = { day, label: dayLabel(day, now), entries: [] };
      days.push(group);
    }
    group.entries.push(entry);
  }
  return days;
}
