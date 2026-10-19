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
 *
 * The composer posts with `actions.addUpdate`; its text is the page's
 * draft (`props.draft`, `props.onDraft`), so a refresh or reopening the
 * same task keeps it.
 */

import { h } from "../../dom.js";
import { avatar } from "../components/avatar.js";
import { formatTime, plural, timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { skeletonList } from "../components/skeleton.js";
import { activityEntries, linkParts, updateAuthor } from "./task-model.js";

/** The server's limit on an update's body. */
const MAX_UPDATE = 10_000;
/** Initials on a neutral gray (white text at 4.8:1) for source authors. */
const SOURCE_AUTHOR_COLOR = "#6b7280";
const TASK_COMPOSER = Object.freeze({
  placeholder: "Write a comment…",
  label: "Write a comment",
  submit: "Comment",
  focusKey: "task-composer",
});

/**
 * The avatar of an update's author (`updateAuthor`): the directory record
 * of the user (it carries the avatar color), or the initials of an
 * imported update's source author on a neutral color.
 */
function authorAvatar(author, users) {
  if (author.user) {
    const user = users?.get(String(author.user.id)) ?? author.user;
    return avatar(user, { size: "sm" });
  }
  return avatar(
    { name: author.name, color: SOURCE_AUTHOR_COLOR },
    { size: "sm" },
  );
}

/**
 * The comment composer: a textarea (Ctrl/⌘+Enter posts) whose text is
 * kept in the page's draft (`props.onDraft`), posted with
 * `actions.addUpdate`.
 * @param {{ item: object, actions: object, draft: string,
 *   onDraft(text: string): void }} props
 */
function composer(props) {
  const { item, actions, draft, onDraft } = props;
  const textarea = h("textarea", {
    class: "input composer-input",
    rows: 3,
    maxlength: MAX_UPDATE,
    placeholder: TASK_COMPOSER.placeholder,
    "aria-label": TASK_COMPOSER.label,
    dir: "auto",
    dataset: { focusKey: TASK_COMPOSER.focusKey },
    value: draft,
    on: {
      input: (event) => onDraft(event.currentTarget.value),
      keydown(event) {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          form.requestSubmit();
        }
      },
    },
  });
  const form = h(
    "form",
    {
      class: ["composer", "task-composer"],
      on: {
        submit(event) {
          event.preventDefault();
          const body = textarea.value.trim();
          if (!body) return;
          textarea.value = "";
          onDraft("");
          actions.addUpdate(item, body);
        },
      },
    },
    textarea,
    h(
      "div",
      { class: "composer-actions" },
      h("span", { class: "muted composer-hint" }, "Ctrl + Enter to post"),
      h(
        "button",
        { type: "submit", class: "btn btn-primary" },
        TASK_COMPOSER.submit,
      ),
    ),
  );
  return form;
}

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
        { class: "task-comment-body", dir: "auto" },
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
    return h("div", { class: "task-activity-footer" }, composer(props));
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
