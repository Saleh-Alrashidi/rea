/**
 * Read-only chips for assigned items (My work, Home): the status as a
 * colored chip and the due date with today / overdue accents (finished
 * items are never shown as overdue).
 */

import { h } from "../../dom.js";
import { formatDay, todayString } from "../components/format.js";
import { icon } from "../components/icon.js";
import { REASONS } from "../components/permissions.js";
import { isOverdue } from "./my-work-data.js";
import { statusOption, textColorOn } from "./values.js";

/** A static status chip for a work item (`loadMyWork` record). */
export function statusChip(item) {
  const option = item.statusColumn
    ? statusOption(item.statusColumn, item.status)
    : null;
  const chip = h(
    "span",
    {
      class: ["status-chip", !option?.label && "empty"],
      title: item.canEdit ? null : REASONS.viewOnly,
    },
    option?.label || "No status",
  );
  if (option?.label) {
    chip.style.backgroundColor = option.color;
    chip.style.color = textColorOn(option.color);
  }
  return chip;
}

/** Due date text with "Today" and overdue accents. */
export function dueChip(item, today = todayString()) {
  if (!item.due) return h("span", { class: "due-chip empty" }, "No date");
  const overdue = isOverdue(item, today);
  return h(
    "span",
    {
      class: ["due-chip", overdue && "overdue", item.due === today && "today"],
    },
    icon("calendar", { size: 12 }),
    item.due === today ? "Today" : formatDay(item.due),
  );
}
