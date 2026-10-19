/**
 * Badges: small labelled pills for roles, access, kinds and counts.
 * Tones: neutral, primary, success, warning, danger, info.
 *
 * ```js
 * badge("Beta", { tone: "info" })
 * roleBadge("guest")             // "Guest" (warning tone)
 * accessBadge("viewer")          // "View only" (eye icon)
 * boardKindBadge("private")      // lock icon + "Private"
 * countBadge(3, { label: "3 unread notifications" })
 * ```
 */

import { h } from "../../dom.js";
import { icon as iconElement } from "./icon.js";
import {
  accessRole,
  accountRole,
  boardKind,
  docVisibility,
  workspaceKind,
} from "./labels.js";

const TONES = new Set([
  "neutral",
  "primary",
  "success",
  "warning",
  "danger",
  "info",
]);

/**
 * @param {string} label
 * @param {{ tone?: string, icon?: string, title?: string, className?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function badge(
  label,
  { tone = "neutral", icon, title, className } = {},
) {
  return h(
    "span",
    {
      class: [
        "badge",
        `badge-${TONES.has(tone) ? tone : "neutral"}`,
        className,
      ],
      title: title ?? null,
    },
    icon ? iconElement(icon, { size: 12 }) : null,
    h("span", null, label),
  );
}

/** Account role badge (admin / member / viewer / guest). */
export function roleBadge(role) {
  const info = accountRole(role);
  return badge(info.label, {
    tone: info.tone ?? "neutral",
    title: info.description,
    className: "role-badge",
  });
}

/**
 * Access badge for a resource: "View only" for viewers, "Owner" and
 * "Editor" otherwise. Returns null for no access.
 */
export function accessBadge(myAccess) {
  if (myAccess === "viewer") {
    return badge("View only", {
      tone: "warning",
      icon: "eye",
      title: "You can view but not edit",
      className: "view-only-badge",
    });
  }
  if (myAccess !== "owner" && myAccess !== "editor") return null;
  const info = accessRole(myAccess);
  return badge(info.label, { tone: "neutral", title: info.description });
}

/** Board kind badge (Main / Private / Shareable). */
export function boardKindBadge(kind) {
  const info = boardKind(kind);
  return badge(info.label, {
    tone: kind === "public" ? "neutral" : "primary",
    icon: info.icon,
    title: info.description,
  });
}

/** Doc visibility badge (Workspace / Private). */
export function docVisibilityBadge(visibility) {
  const info = docVisibility(visibility);
  return badge(info.label, {
    tone: visibility === "private" ? "primary" : "neutral",
    icon: info.icon,
    title: info.description,
  });
}

/** Workspace kind badge (Open / Closed). */
export function workspaceKindBadge(kind) {
  const info = workspaceKind(kind);
  return badge(info.label, {
    tone: kind === "closed" ? "primary" : "neutral",
    icon: info.icon,
    title: info.description,
  });
}

const shownCount = (count) =>
  Number.isSafeInteger(count) && count > 0 ? count : 0;
const countText = (value) => (value > 99 ? "99+" : String(value));

/**
 * A numeric count bubble (notifications); hidden when zero. Counts above 99
 * show as "99+". `label` is its accessible text. `setBadgeCount` changes
 * the count it shows.
 */
export function countBadge(count, { label } = {}) {
  const value = shownCount(count);
  return h(
    "span",
    {
      class: "count-badge",
      hidden: value === 0,
      "aria-label": label ?? null,
    },
    countText(value),
  );
}

/** Shows `count` in `badge` (a `countBadge`). */
export function setBadgeCount(badge, count) {
  const value = shownCount(count);
  badge.hidden = value === 0;
  badge.textContent = countText(value);
}
