/**
 * An update's body, built from `Update.body_parts` only (SPEC-6 §2.2):
 * the server parsed the body and named each mention for this reader, so
 * nothing here reads the token syntax. Text is text nodes (the body
 * element keeps line breaks, `pre-wrap`, in its own direction,
 * `dir="auto"`); links open in a new tab (`rel="noopener noreferrer"`).
 *
 * Mentions are chips: a person opens their profile popover, a team its
 * page, a task its task view (on its own board). A task the reader cannot
 * open has no name and reads "Private task"; a person or team the reader
 * may not see keeps the name the author saw, without a link.
 */

import { h } from "../../dom.js";
import { itemHash, teamHash } from "../../router.js";
import { avatar } from "../components/avatar.js";
import { icon } from "../components/icon.js";
import { openPopover } from "../components/popover.js";

/** What a task mention reads when the reader cannot open its board. */
export const PRIVATE_TASK = "Private task";

function profile(user, part) {
  const record = user ?? { id: part.id, name: part.text };
  return h(
    "div",
    { class: "mention-profile" },
    avatar(record, { size: "lg" }),
    h(
      "div",
      { class: "mention-profile-text" },
      h("strong", { class: "mention-profile-name", dir: "auto" }, record.name),
      record.title ? h("span", { dir: "auto" }, record.title) : null,
      record.email
        ? h(
            "a",
            { href: `mailto:${record.email}`, class: "mention-profile-email" },
            record.email,
          )
        : null,
    ),
  );
}

function userChip(part, users) {
  if (!part.id) {
    return h("span", { class: "mention-chip", dir: "auto" }, `@${part.text}`);
  }
  const chip = h(
    "button",
    {
      type: "button",
      class: "mention-chip mention-user",
      dir: "auto",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      on: {
        click: () =>
          openPopover({
            anchor: chip,
            label: part.text,
            className: "mention-profile-popover",
            content: profile(users?.get(part.id) ?? null, part),
          }),
      },
    },
    `@${part.text}`,
  );
  return chip;
}

function teamChip(part) {
  const text = `@${part.text}`;
  if (!part.id) return h("span", { class: "mention-chip", dir: "auto" }, text);
  return h(
    "a",
    {
      class: "mention-chip mention-team",
      href: teamHash(part.id),
      dir: "auto",
    },
    icon("team", { size: 12 }),
    text,
  );
}

function taskChip(part) {
  if (part.text === null) {
    return h(
      "span",
      {
        class: "mention-chip mention-private",
        title: "You can’t open this task",
      },
      icon("lock", { size: 12 }),
      PRIVATE_TASK,
    );
  }
  const content = [icon("item", { size: 12 }), part.text];
  if (!part.boardId) {
    return h(
      "span",
      { class: "mention-chip mention-task", dir: "auto" },
      content,
    );
  }
  return h(
    "a",
    {
      class: "mention-chip mention-task",
      href: itemHash(part.boardId, part.id),
      dir: "auto",
    },
    content,
  );
}

function partNode(part, users) {
  switch (part.type) {
    case "user":
      return userChip(part, users);
    case "team":
      return teamChip(part);
    case "item":
      return taskChip(part);
    case "link":
      return h(
        "a",
        { href: part.url, rel: "noopener noreferrer", target: "_blank" },
        part.text,
      );
    default:
      return part.text;
  }
}

/**
 * The body element of an update (`parts`), `users` (the directory, by ID)
 * giving profile details.
 * @param {object[]} parts decoded body parts (`updates-data.js`)
 * @param {{ users?: Map<string, object>, className?: string }} [options]
 */
export function updateBody(parts, { users, className } = {}) {
  return h(
    "div",
    { class: ["update-body", className], dir: "auto" },
    parts.map((part) => partNode(part, users)),
  );
}
