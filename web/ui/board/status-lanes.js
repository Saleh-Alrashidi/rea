/**
 * Lanes of a status column: one per label in label order, then "No
 * status" for items without a known label. The kanban view and the List
 * view's status and priority groups share them, so an item lands in the
 * same place in both.
 */

import { safeColor } from "./values.js";

/** Key of the lane for items without a known label. */
export const BLANK_LANE = "blank";
const BLANK_LABEL = "No status";

/** The lane key of status `value` (an index or null) in `column`. */
export function laneKey(column, value) {
  const known = column.status.options.some((option) => option.index === value);
  return known ? String(value) : BLANK_LANE;
}

/**
 * The lanes of `column`: `{ key, index, label, color, type? }` per label,
 * then the blank lane (`index` null) labelled `blankLabel`.
 */
export function lanesFor(column, { blankLabel = BLANK_LABEL } = {}) {
  const lanes = column.status.options.map((option) => ({
    key: String(option.index),
    index: option.index,
    label: option.label,
    color: option.color,
    ...(option.type ? { type: option.type } : {}),
  }));
  lanes.push({
    key: BLANK_LANE,
    index: null,
    label: blankLabel,
    color: safeColor(column.status.blank?.color),
  });
  return lanes;
}
