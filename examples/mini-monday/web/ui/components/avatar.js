/**
 * Avatars: initials on the user's color (`User.color`, or a palette color
 * derived from the ID when the color is missing or malformed), team tiles
 * and overlapping stacks with a "+N" overflow chip.
 *
 * ```js
 * avatar(user)                         // 32 px
 * avatar(user, { size: "sm" })         // 24 px
 * teamAvatar(team, { size: "sm" })
 * avatarStack(users, { max: 3, size: "sm" })
 * ```
 */

import { h } from "../../dom.js";
import { icon } from "./icon.js";

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const PALETTE = Object.freeze([
  "#5b5bd6",
  "#d6409f",
  "#12a594",
  "#e5484d",
  "#0d74ce",
  "#ab4aba",
  "#cc4e00",
  "#218358",
  "#8e4ec6",
  "#3e63dd",
]);
const SIZES = new Set(["xs", "sm", "md", "lg"]);

/** Up to two initials from a display name. */
export function initialsOf(name) {
  const words = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? [words[0]] : [words[0], words.at(-1)];
  return letters.map((word) => [...word][0].toUpperCase()).join("");
}

/** The avatar color of a user-like record. */
export function colorOf(person) {
  if (COLOR_PATTERN.test(person?.color ?? "")) return person.color;
  const id = Number(person?.id);
  return PALETTE[Number.isSafeInteger(id) ? id % PALETTE.length : 0];
}

function sizeClass(size) {
  return `avatar-${SIZES.has(size) ? size : "md"}`;
}

/**
 * Initials avatar for `person` (`{ id, name, initials?, color? }`).
 * @param {object | null} person
 * @param {{ size?: "xs" | "sm" | "md" | "lg", title?: string | null }} [options]
 * @returns {HTMLSpanElement}
 */
export function avatar(person, { size = "md", title } = {}) {
  const name = person?.name ?? "Unknown";
  const element = h(
    "span",
    {
      class: ["avatar", sizeClass(size)],
      title: title === undefined ? name : title,
      "aria-hidden": "true",
    },
    person?.initials || initialsOf(name),
  );
  element.style.backgroundColor = colorOf(person);
  return element;
}

/**
 * A team tile (`{ id, name }`).
 * @param {object} team
 * @param {{ size?: "xs" | "sm" | "md" | "lg" }} [options]
 */
export function teamAvatar(team, { size = "md" } = {}) {
  return h(
    "span",
    {
      class: ["avatar", "avatar-team", sizeClass(size)],
      title: team?.name ?? "Team",
      "aria-hidden": "true",
    },
    icon("team", { size: size === "lg" ? 20 : 14 }),
  );
}

/**
 * Avatar for a share subject: `{ kind: "user" | "team", … }`.
 * @param {{ kind: string }} subject
 * @param {{ size?: "xs" | "sm" | "md" | "lg" }} [options]
 */
export function subjectAvatar(subject, options) {
  return subject?.kind === "team"
    ? teamAvatar(subject, options)
    : avatar(subject, options);
}

/**
 * Overlapping avatars for `people`, at most `max`, then "+N". The stack is
 * labelled with every name for assistive technology.
 * @param {object[]} people
 * @param {{ max?: number, size?: "xs" | "sm" | "md" | "lg" }} [options]
 * @returns {HTMLSpanElement}
 */
export function avatarStack(people, { max = 3, size = "sm" } = {}) {
  const list = Array.isArray(people) ? people : [];
  const shown = list.slice(0, max);
  const extra = list.length - shown.length;
  const names = list.map((person) => person?.name ?? "Unknown").join(", ");
  return h(
    "span",
    { class: "avatar-stack", role: "img", "aria-label": names, title: names },
    shown.map((person) => subjectAvatar(person, { size, title: null })),
    extra > 0
      ? h(
          "span",
          {
            class: ["avatar", "avatar-more", sizeClass(size)],
            "aria-hidden": "true",
          },
          `+${extra}`,
        )
      : null,
  );
}
