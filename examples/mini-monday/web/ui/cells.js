/**
 * Column value editors shared by the table, kanban cards and the item card:
 * status pills with a label picker, people avatars with a picker, date,
 * numbers and text inputs. Editors receive decoded UI values (`values.js`)
 * and report changes through `onChange(nextValue)`.
 */

import { h } from "../dom.js";
import { icon } from "./icons.js";
import { inlineInput } from "./inline-edit.js";
import { openPopover } from "./popover.js";
import { statusOption } from "./values.js";

const AVATAR_COLORS = Object.freeze([
  "#e2445c",
  "#00a359",
  "#0073ea",
  "#a25ddc",
  "#e2832a",
  "#037f4c",
  "#d6491f",
  "#784bd1",
  "#0086c0",
  "#bb3354",
]);
const MAX_AVATARS = 3;

/** Initials avatar for `user` (`{ id, name, initials }`). */
export function avatar(user, { small = false } = {}) {
  const id = Number(user?.id);
  const color =
    AVATAR_COLORS[Number.isFinite(id) ? id % AVATAR_COLORS.length : 0];
  const element = h(
    "span",
    { class: ["avatar", small && "avatar-small"], title: user?.name ?? "" },
    user?.initials || "?",
  );
  element.style.backgroundColor = color;
  return element;
}

/** Up to three avatars for `ids`, then a "+N" chip. */
export function avatarStack(ids, users) {
  const shown = ids.slice(0, MAX_AVATARS).map((id) =>
    avatar(users.get(id) ?? { id, name: `User ${id}`, initials: "?" }, {
      small: true,
    }),
  );
  const extra = ids.length - shown.length;
  return h(
    "span",
    { class: "avatar-stack" },
    shown,
    extra > 0
      ? h("span", { class: "avatar avatar-small avatar-more" }, `+${extra}`)
      : null,
  );
}

function statusChoice({ option, selected, onPick }) {
  const button = h(
    "button",
    {
      type: "button",
      class: ["status-choice", selected && "selected"],
      "aria-pressed": selected ? "true" : "false",
      on: { click: () => onPick(option.index) },
    },
    option.label,
  );
  button.style.backgroundColor = option.color;
  return button;
}

/**
 * Colored status pill; clicking opens a label picker.
 * @param {{ column: object, value: number | null, label: string,
 *   onChange(index: number | null): void, focusKey?: string,
 *   placeholder?: string }} options
 */
export function statusPill(options) {
  const { column, value, label, onChange, focusKey, placeholder } = options;
  const option = statusOption(column, value);
  const text = option?.label ?? "";
  const pill = h(
    "button",
    {
      type: "button",
      class: ["status-pill", !text && "empty"],
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-label": `${label}: ${text || "not set"}. Change status`,
      dataset: { focusKey },
      on: { click: () => openStatusPicker() },
    },
    text ||
      (placeholder ? h("span", { class: "placeholder" }, placeholder) : ""),
  );
  // Blank labels use the theme's empty color from CSS.
  if (text) pill.style.backgroundColor = option.color;

  function openStatusPicker() {
    const popover = openPopover({
      anchor: pill,
      label: `Choose ${column.title}`,
      content: () =>
        h(
          "div",
          { class: "status-picker" },
          (column.status?.options ?? []).map((choice) =>
            statusChoice({
              option: choice,
              selected: choice.index === value,
              onPick(index) {
                popover.close();
                if (index !== value) onChange(index);
              },
            }),
          ),
          h(
            "button",
            {
              type: "button",
              class: "status-choice status-clear",
              on: {
                click() {
                  popover.close();
                  if (value !== null) onChange(null);
                },
              },
            },
            "Clear",
          ),
        ),
    });
  }

  return pill;
}

function personRow({ user, checked, onToggle }) {
  const checkbox = h("input", {
    type: "checkbox",
    checked,
    on: { change: (event) => onToggle(user.id, event.currentTarget.checked) },
  });
  return h(
    "label",
    { class: "person-option", dataset: { name: user.name.toLowerCase() } },
    checkbox,
    avatar(user, { small: true }),
    h("span", { class: "person-name" }, user.name),
  );
}

function filterPeople(list, term) {
  const folded = term.trim().toLowerCase();
  for (const row of list.children) {
    row.hidden = folded !== "" && !row.dataset.name.includes(folded);
  }
}

/**
 * People avatars; clicking opens a checklist of users. Each toggle reports
 * the full new list of user IDs.
 * @param {{ column: object, value: string[], users: Map, label: string,
 *   onChange(ids: string[]): void, focusKey?: string }} options
 */
function peopleButton({ column, value, users, label, onChange, focusKey }) {
  const ids = Array.isArray(value) ? value : [];
  const names = ids.map((id) => users.get(id)?.name ?? `User ${id}`);
  const button = h(
    "button",
    {
      type: "button",
      class: "people-button",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-label": `${label}: ${names.join(", ") || "nobody"}. Change people`,
      dataset: { focusKey },
      on: { click: () => openPicker() },
    },
    ids.length > 0
      ? avatarStack(ids, users)
      : h("span", { class: "people-empty" }, icon("person")),
  );

  function openPicker() {
    const selected = new Set(ids);
    const list = h(
      "div",
      { class: "people-list" },
      [...users.values()].map((user) =>
        personRow({
          user,
          checked: selected.has(user.id),
          onToggle(id, on) {
            if (on) selected.add(id);
            else selected.delete(id);
            onChange([...selected]);
          },
        }),
      ),
    );
    const search = h("input", {
      class: "input input-small",
      type: "search",
      placeholder: "Search people",
      "aria-label": "Search people",
      "data-autofocus": true,
      on: { input: (event) => filterPeople(list, event.currentTarget.value) },
    });
    openPopover({
      anchor: button,
      label: `Choose ${column.title}`,
      content: h("div", { class: "people-picker" }, search, list),
    });
  }

  return button;
}

function dateInput({ value, label, onChange, focusKey }) {
  return h("input", {
    class: ["inline-input", "cell-date", !value && "empty"],
    type: "date",
    "aria-label": label,
    dataset: { focusKey },
    value: value ?? "",
    on: {
      change(event) {
        const next = event.currentTarget.value || null;
        event.currentTarget.classList.toggle("empty", next === null);
        onChange(next);
      },
    },
  });
}

/**
 * Returns the editor element for `column` showing `value`.
 * `placeholder` is shown in an empty status pill.
 * @param {{ column: object, value: unknown, users: Map, itemName: string,
 *   onChange(next: unknown): void, focusKey?: string,
 *   placeholder?: string }} options
 */
export function cellEditor(options) {
  const { column, value, users, itemName, onChange, focusKey } = options;
  const label = `${column.title} for ${itemName}`;
  switch (column.type) {
    case "status":
      return statusPill({
        column,
        value,
        label,
        onChange,
        focusKey,
        placeholder: options.placeholder,
      });
    case "people":
      return peopleButton({ column, value, users, label, onChange, focusKey });
    case "date":
      return dateInput({ value, label, onChange, focusKey });
    case "numbers":
    case "text":
      return inlineInput({
        value: value ?? "",
        label,
        type: column.type === "numbers" ? "number" : "text",
        className: column.type === "numbers" ? "cell-number" : "cell-text",
        maxLength: 2000,
        focusKey,
        onCommit: (next) => onChange(next === "" ? null : next),
      });
    default:
      return h("span", { class: "cell-unsupported" }, "—");
  }
}
