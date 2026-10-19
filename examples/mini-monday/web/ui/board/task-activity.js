/**
 * The task view's Activity pane (SPEC-5 §4.2): a header with the comment
 * count, the stream oldest first (`activityEntries`: who created the
 * task, a note about older comments not loaded, then each comment) and
 * the composer pinned at the bottom (hidden for view-only users, with a
 * note).
 *
 * A comment shows its author's avatar and name (an imported author has
 * no user: their initials on a neutral color and a muted tag naming the
 * source), a relative time with the full date as its title, and its body
 * as written (pre-wrap, `dir="auto"`) with http(s) URLs as links built as
 * DOM nodes (`linkParts`), never as HTML.
 */

import { h } from "../../dom.js";
import { plural, timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { skeletonList } from "../components/skeleton.js";
import { authorAvatar, composer, formatTime } from "./item-card.js";
import { activityEntries, linkParts, updateAuthor } from "./task-model.js";

const TASK_COMPOSER = Object.freeze({
  placeholder: "Write a comment…",
  label: "Write a comment",
  submit: "Comment",
  focusKey: "task-composer",
  className: "task-composer",
});

function timeElement(iso) {
  return h(
    "time",
    { class: "task-time", datetime: iso, title: formatTime(iso) || null },
    timeAgo(iso),
  );
}

function createdEntry(props, { creator, at }) {
  return h(
    "li",
    { class: "task-event" },
    icon("plus", { size: 12 }),
    h(
      "span",
      { class: "task-event-text" },
      creator
        ? [h("strong", { dir: "auto" }, creator.name), " created this task"]
        : "This task was created",
      at
        ? [h("span", { "aria-hidden": "true" }, " · "), timeElement(at)]
        : null,
    ),
  );
}

function olderEntry({ hidden }) {
  return h(
    "li",
    { class: "task-event" },
    icon("info", { size: 12 }),
    h(
      "span",
      { class: "task-event-text" },
      `${plural(hidden, "older comment")} not shown`,
    ),
  );
}

function bodyParts(body) {
  return linkParts(body).map((part) =>
    part.href
      ? h(
          "a",
          { href: part.href, rel: "noopener noreferrer", target: "_blank" },
          part.text,
        )
      : part.text,
  );
}

function commentEntry(props, update) {
  const author = updateAuthor(update, props.board.import?.source);
  return h(
    "li",
    { class: ["task-comment", update.pending && "pending"] },
    authorAvatar(author, props.users),
    h(
      "div",
      { class: "task-comment-main" },
      h(
        "div",
        { class: "task-comment-header" },
        h("span", { class: "task-comment-author", dir: "auto" }, author.name),
        author.tag
          ? h("span", { class: "task-comment-tag" }, author.tag)
          : null,
        timeElement(update.created_at),
      ),
      h(
        "p",
        { class: "update-body task-comment-body", dir: "auto" },
        bodyParts(update.body),
      ),
    ),
  );
}

function entryElement(props, entry) {
  if (entry.kind === "created") return createdEntry(props, entry);
  if (entry.kind === "older") return olderEntry(entry);
  return commentEntry(props, entry.update);
}

function footer(props) {
  if (props.caps.edit) {
    return h(
      "div",
      { class: "task-activity-footer" },
      composer(props, TASK_COMPOSER),
    );
  }
  return h(
    "p",
    { class: "task-activity-footer task-readonly-note" },
    icon("eye", { size: 14 }),
    "You have view-only access, so you can read comments but not post them.",
  );
}

/**
 * The Activity pane of the task in `props` (task view props: `detail`,
 * `board`, `users`, `caps`, `actions`, `draft`, `onDraft`). Its stream
 * (`#task-stream`) scrolls on its own; the task view keeps it at the end.
 */
export function activityPane(props) {
  const entries = activityEntries(props.detail);
  // Loaded comments plus the older ones not loaded.
  let comments = 0;
  for (const entry of entries) {
    if (entry.kind === "comment") comments += 1;
    else if (entry.kind === "older") comments += entry.hidden;
  }
  return h(
    "aside",
    { class: "task-activity", "aria-labelledby": "task-activity-heading" },
    h(
      "header",
      { class: "task-activity-header" },
      h(
        "h3",
        { class: "task-activity-title", id: "task-activity-heading" },
        "Activity",
      ),
      props.detail
        ? h(
            "span",
            { class: "task-activity-count" },
            icon("chat", { size: 14 }),
            plural(comments, "comment"),
          )
        : null,
    ),
    h(
      "div",
      {
        class: "task-stream",
        id: "task-stream",
        role: "region",
        tabindex: "0",
        "aria-label": "Comments",
      },
      props.detail
        ? h(
            "ol",
            { class: "task-stream-list" },
            entries.map((entry) => entryElement(props, entry)),
          )
        : skeletonList({ rows: 3, label: "Loading activity" }),
    ),
    footer(props),
  );
}
