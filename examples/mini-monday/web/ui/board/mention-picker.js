/**
 * The mention picker's listbox (SPEC-6 §2.2): draws the state of
 * `mention-picker-model.js` under a composer's textarea and keeps the
 * textarea's ARIA in step (`aria-controls`, `aria-activedescendant`), so
 * focus never leaves the textarea while ↑/↓ move through the rows.
 *
 * People rows show an avatar (a team tile for teams), the name and the
 * email; people who cannot open the board come last, marked "No access".
 * Task rows show a status dot, the name and the board. A press on a row
 * keeps focus in the textarea (`pointerdown` is cancelled) and picks it.
 */

import { h } from "../../dom.js";
import { avatar, teamAvatar } from "../components/avatar.js";
import { icon } from "../components/icon.js";
import { safeColor } from "./values.js";

let nextId = 0;

const HEADINGS = Object.freeze({ people: "People", tasks: "Tasks" });
const EMPTY = Object.freeze({
  people: "No one matches",
  tasks: "No tasks match",
});

function rowLead(option) {
  if (option.kind === "team") return teamAvatar(option.record, { size: "sm" });
  if (option.kind === "user") return avatar(option.record, { size: "sm" });
  const dot = h("span", {
    class: ["mention-status-dot", !option.color && "empty"],
    title: option.statusLabel || "No status",
  });
  if (option.color) dot.style.backgroundColor = safeColor(option.color);
  return dot;
}

function row(option, { id, active, onPick, onHover }) {
  return h(
    "li",
    {
      id,
      role: "option",
      class: ["mention-option", active && "active", option.noAccess && "muted"],
      "aria-selected": active ? "true" : "false",
      dataset: { key: option.key },
      on: {
        pointerdown: (event) => event.preventDefault(),
        click: () => onPick(option),
        pointermove: () => onHover(),
      },
    },
    rowLead(option),
    h(
      "span",
      { class: "mention-option-text" },
      h("span", { class: "mention-option-name", dir: "auto" }, option.name),
      option.detail
        ? h(
            "span",
            { class: "mention-option-detail", dir: "auto" },
            option.detail,
          )
        : null,
    ),
    option.noAccess
      ? h(
          "span",
          {
            class: "mention-no-access",
            title: "Can’t open this board, so won’t be notified",
          },
          icon("lock", { size: 12 }),
          "No access",
        )
      : null,
  );
}

/**
 * Creates the listbox of a composer `textarea`. `paint(state)` draws the
 * picker state (hidden when closed); `onPick(option)` and `onActive(index)`
 * report mouse picks and hovers.
 * @param {{ textarea: HTMLTextAreaElement,
 *   onPick(option: object): void, onActive(index: number): void }} options
 */
export function createPickerList({ textarea, onPick, onActive }) {
  nextId += 1;
  const listId = `mention-picker-${nextId}`;
  const list = h("ul", {
    class: "mention-picker",
    id: listId,
    role: "listbox",
    hidden: true,
  });
  textarea.setAttribute("aria-autocomplete", "list");

  function paint(state) {
    const open = state.open;
    list.hidden = !open;
    if (!open) {
      list.replaceChildren();
      textarea.removeAttribute("aria-controls");
      textarea.removeAttribute("aria-activedescendant");
      return;
    }
    list.setAttribute("aria-label", HEADINGS[state.mode]);
    const optionId = (index) => `${listId}-${index}`;
    const rows = state.options.map((option, index) =>
      row(option, {
        id: optionId(index),
        active: index === state.active,
        onPick,
        onHover: () => index !== state.active && onActive(index),
      }),
    );
    list.replaceChildren(
      h(
        "li",
        { class: "mention-heading", role: "presentation" },
        HEADINGS[state.mode],
      ),
      ...(rows.length > 0
        ? rows
        : [
            h(
              "li",
              { class: "mention-empty", role: "presentation" },
              EMPTY[state.mode],
            ),
          ]),
    );
    textarea.setAttribute("aria-controls", listId);
    if (rows.length > 0) {
      textarea.setAttribute("aria-activedescendant", optionId(state.active));
      rows[state.active]?.scrollIntoView?.({ block: "nearest" });
    } else textarea.removeAttribute("aria-activedescendant");
  }

  return { element: list, paint };
}
