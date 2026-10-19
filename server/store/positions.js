/**
 * Item positions (SPEC-6 §1.2): `item.position` is one manual order per
 * board, a float persisted as `position:num`.
 *
 * - Every listing sorts by its grouping first, then by position, then by
 *   ID. The store's own listings group by board group (`boardOrder`:
 *   group position, then position, then ID), so the manual order holds
 *   inside every grouping a view picks.
 * - New items go after every item of their board (`nextItemPosition`:
 *   the board's highest position + POSITION_SPACING).
 * - A move puts an item at the midpoint between its neighbors in the
 *   board's manual order (`byPosition`). When a side has no neighbor (the
 *   start or end of the board) or the gap is too small to split, the
 *   board is renumbered first (`renumber`, spacing POSITION_SPACING,
 *   in manual order, so every grouping keeps its order) and the item takes
 *   the midpoint of the renumbered slots (`renumberedMidpoint`).
 * - Format /4 kept positions per group: `upgradeItemPositions` renumbers
 *   every board in its display order (group position, then position, then
 *   ID), so the Main table order is unchanged.
 *
 * Renumbering changes positions only; `updated_at` stays, as it is no
 * change of the items themselves.
 *
 * The sidebar order (SPEC-6 §3.1) uses the same numbers and rules:
 * Spaces (workspaces), folders, boards and docs carry an optional
 * `position` within their container (`sidebar.js` names the containers).
 * Records with a position come first by position, the rest after them;
 * ties and the rest go by ID (`bySidebarOrder`). New records go after
 * their container (`positionAfter`), and a move takes the midpoint of
 * its neighbors or renumbers the container first (`sidebarSlot`).
 */
import { deepFreeze, failure, sortedGroups } from "../store-state.js";

export const POSITION_SPACING = 1024;
/** Gaps smaller than this are not split; the board is renumbered. */
export const MIN_POSITION_GAP = 1e-6;

/** The board's manual order: position, then ID. */
export const byPosition = (a, b) =>
  a.position - b.position || Number(a.id) - Number(b.id);

/**
 * Board order for one board: group rank (index in `groups`, sorted by
 * position), then position, then ID.
 */
export function boardOrder(groups) {
  const rank = new Map(groups.map((group, index) => [group.id, index]));
  return (a, b) =>
    rank.get(a.group_id) - rank.get(b.group_id) || byPosition(a, b);
}

/** The position of a new item on `boardId`: after every item already there. */
export const nextItemPosition = (items, boardId) =>
  positionAfter(items.filter((item) => item.board_id === boardId));

/** `[id, position]` for `ordered` items at POSITION_SPACING (1024, 2048, …). */
const spaced = (ordered) =>
  ordered.map((item, index) => [item.id, (index + 1) * POSITION_SPACING]);

/**
 * Replaces the records of `list` (a state collection) whose position
 * `positions` (ID → position) changes.
 */
function applyPositions(list, positions) {
  for (let index = 0; index < list.length; index += 1) {
    const position = positions.get(list[index].id);
    if (position === undefined || position === list[index].position) continue;
    list[index] = deepFreeze({ ...list[index], position });
  }
}

/**
 * Renumbers `ordered` (records of `list`, e.g. the items of one board,
 * in the order to keep) at POSITION_SPACING.
 */
export function renumber(list, ordered) {
  applyPositions(list, new Map(spaced(ordered)));
}

/**
 * The /4 → /5 upgrade: renumbers each board's items in display order
 * (group position, then item position, then ID).
 */
export function upgradeItemPositions(state) {
  const positions = new Map();
  const boards = Map.groupBy(state.items, (item) => item.board_id);
  for (const [boardId, items] of boards) {
    const order = boardOrder(sortedGroups(state, boardId));
    for (const [id, position] of spaced(items.sort(order))) {
      positions.set(id, position);
    }
  }
  applyPositions(state.items, positions);
}

/**
 * The midpoint between the neighbors at indexes `lo` and `hi` of `order`
 * (the board's other items in manual order; -1 and `order.length` are
 * the start and end of the board), or null when a side has no neighbor
 * or the gap cannot be split: then the board is renumbered first.
 */
export function midpoint(order, { lo, hi }) {
  const low = order[lo]?.position;
  const high = order[hi]?.position;
  if (low === undefined || high === undefined) return null;
  const mid = (low + high) / 2;
  const splits = high - low >= MIN_POSITION_GAP && low < mid && mid < high;
  return splits ? mid : null;
}

/**
 * The midpoint between indexes `lo` and `hi` once `order` is renumbered
 * (index k at (k + 1) × POSITION_SPACING, so the start is 0 and the end
 * one spacing after the last item).
 */
export const renumberedMidpoint = ({ lo, hi }) =>
  ((lo + hi + 2) * POSITION_SPACING) / 2;

// ------------------------------------------------------------ sidebar order

/**
 * The sidebar order: records with a position by position, then those
 * without one; ties and the rest by ID.
 */
export function bySidebarOrder(a, b) {
  const [left, right] = [a.position ?? null, b.position ?? null];
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  }
  return Number(a.id) - Number(b.id);
}

/** A copy of `records` in sidebar order. */
export const inSidebarOrder = (records) => records.toSorted(bySidebarOrder);

/**
 * The position of a new record after `siblings` (the records of its
 * board or sidebar container): the highest position + POSITION_SPACING.
 */
export function positionAfter(siblings) {
  const last = siblings.reduce(
    (max, record) =>
      record.position === undefined ? max : Math.max(max, record.position),
    Number.NEGATIVE_INFINITY,
  );
  return (Number.isFinite(last) ? last : 0) + POSITION_SPACING;
}

/**
 * Where a record lands among `siblings` (the other records of its
 * container) right after `after` and/or right before `before` (records of
 * `siblings`, at least one): `{ position, order }`, where `order` is the
 * siblings in sidebar order to renumber first (null when the midpoint
 * splits), or an `invalid_neighbor` failure when `after` does not come
 * before `before`. A sibling without a position counts as a gap that
 * cannot be split.
 */
export function sidebarSlot(siblings, { after, before }) {
  const order = inSidebarOrder(siblings);
  const lo = after ? order.indexOf(after) : order.indexOf(before) - 1;
  const hi = before ? order.indexOf(before) : lo + 1;
  if (lo >= hi) {
    const message = "after_id must come before before_id";
    return failure("invalid_neighbor", { message });
  }
  const mid = midpoint(order, { lo, hi });
  if (mid !== null) return { position: mid, order: null };
  return { position: renumberedMidpoint({ lo, hi }), order };
}
