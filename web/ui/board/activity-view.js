/**
 * Activity view (`#/boards/<id>/views/activity`): the board's history as a
 * timeline grouped by day, with actor avatars, item names (links to the
 * item card while the item exists) and from → to chips. It owns its data
 * once mounted (`live-view.js`): it loads the newest entries, reloads on
 * the board's change events and offers "Show older activity" up to the
 * API's limit.
 */

import { h } from "../../dom.js";
import { itemHash } from "../../router.js";
import { avatar } from "../components/avatar.js";
import { button } from "../components/button.js";
import { emptyState } from "../components/empty-state.js";
import { plural, timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { skeletonList } from "../components/skeleton.js";
import {
  activityActor,
  describeActivity,
  groupActivityByDay,
} from "./activity-model.js";
import { MAX_ACTIVITY, loadActivity } from "./board-data.js";
import { mountLiveView } from "./live-view.js";
import { textColorOn } from "./values.js";

const PAGE_SIZE = 100;

function actorAvatar(actor) {
  if (actor.kind === "user") return avatar(actor.user, { size: "sm" });
  return h(
    "span",
    { class: "avatar avatar-sm activity-bot", "aria-hidden": "true" },
    icon(actor.kind === "form" ? "forms" : "person", { size: 14 }),
  );
}

function segmentNode(segment, boardId) {
  if ("strong" in segment) {
    return h("strong", { class: "activity-name" }, segment.strong);
  }
  if ("item" in segment) {
    const { id, name } = segment.item;
    if (!id) return h("span", { class: "activity-item gone" }, name);
    return h(
      "a",
      { class: "activity-item", href: itemHash(boardId, id) },
      name,
    );
  }
  return segment.text;
}

function valueChip(value, className) {
  const element = h(
    "span",
    { class: ["activity-chip", className, !value.text && "empty"] },
    value.text || "Empty",
  );
  if (value.color) {
    element.style.backgroundColor = value.color;
    element.style.color = textColorOn(value.color);
    element.classList.add("colored");
  }
  return element;
}

function changeChips({ from, to }) {
  if (!from && !to) return null;
  const empty = { text: "", color: null };
  return h(
    "div",
    { class: "activity-change" },
    valueChip(from ?? empty, "from"),
    h(
      "span",
      { class: "activity-arrow" },
      icon("arrowRight", { size: 14 }),
      h("span", { class: "visually-hidden" }, " changed to "),
    ),
    valueChip(to ?? empty, "to"),
  );
}

function entryTime(iso) {
  const date = new Date(iso);
  const valid = !Number.isNaN(date.getTime());
  return h(
    "time",
    {
      class: "activity-time",
      datetime: iso,
      title: valid
        ? date.toLocaleString(undefined, {
            dateStyle: "full",
            timeStyle: "short",
          })
        : null,
    },
    valid
      ? date.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        })
      : "",
  );
}

function entryNode(entry, board) {
  const actor = activityActor(entry);
  const described = describeActivity(entry, board);
  return h(
    "li",
    { class: "activity-entry", dataset: { kind: entry.kind } },
    h(
      "span",
      { class: "activity-marker", "aria-hidden": "true" },
      icon(described.icon, { size: 12 }),
    ),
    actorAvatar(actor),
    h(
      "div",
      { class: "activity-body" },
      h(
        "p",
        { class: "activity-text" },
        h("strong", { class: "activity-actor" }, actor.name),
        actor.via
          ? h("span", { class: "activity-via" }, ` (${actor.via})`)
          : null,
        " ",
        described.segments.map((segment) => segmentNode(segment, board.id)),
      ),
      changeChips(described),
      described.detail
        ? h("p", { class: "activity-detail" }, described.detail)
        : null,
    ),
    h(
      "div",
      { class: "activity-when" },
      entryTime(entry.created_at),
      h("span", { class: "activity-ago" }, timeAgo(entry.created_at)),
    ),
  );
}

function timeline(entries, board) {
  return h(
    "div",
    { class: "activity-days" },
    groupActivityByDay(entries).map((group, index) => {
      const headingId = `activity-day-${index}`;
      return h(
        "section",
        { class: "activity-day", "aria-labelledby": headingId },
        h("h2", { class: "activity-day-label", id: headingId }, group.label),
        h(
          "ol",
          { class: "activity-list" },
          group.entries.map((entry) => entryNode(entry, board)),
        ),
      );
    }),
  );
}

function activityContent({ entries, limit, board, onMore }) {
  if (entries.length === 0) {
    return emptyState({
      icon: "activity",
      title: "No activity yet",
      text: "Changes to items, groups, columns and access will appear here.",
    });
  }
  const more = entries.length >= limit && limit < MAX_ACTIVITY;
  return h(
    "div",
    { class: "activity-view" },
    h(
      "p",
      { class: "activity-summary" },
      `Showing the latest ${plural(entries.length, "change")} on this board.`,
    ),
    timeline(entries, board),
    more
      ? button({
          label: "Show older activity",
          icon: "chevronDown",
          variant: "secondary",
          className: "activity-more",
          onClick: onMore,
        })
      : null,
  );
}

/**
 * Mounts the activity timeline into `root`. `getBoard()` returns the
 * loaded board (its columns and items describe the entries).
 * @param {HTMLElement} root
 * @param {{ boardId: string, getBoard(): object }} options
 * @returns {{ emit(type: string, data: unknown): boolean, destroy(): void }}
 */
export function mountActivityView(root, { boardId, getBoard }) {
  let limit = PAGE_SIZE;
  const view = mountLiveView(root, {
    label: "Activity",
    failure: "We couldn’t load the activity",
    // A board that became unavailable is reported by the board page.
    load: async () => (await loadActivity(boardId, { limit })) ?? [],
    placeholder: () => skeletonList({ rows: 6, label: "Loading activity" }),
    ready: (entries) =>
      activityContent({
        entries,
        limit,
        board: getBoard(),
        onMore() {
          limit = Math.min(MAX_ACTIVITY, limit + PAGE_SIZE);
          view.reload();
        },
      }),
  });
  return { emit: view.emit, destroy: view.destroy };
}
