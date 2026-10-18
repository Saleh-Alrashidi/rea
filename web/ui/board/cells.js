/**
 * Column value editors shared by the table, kanban cards and the item card:
 * status pills with a label picker, people avatars with a picker, date,
 * numbers and text inputs. Editors receive decoded UI values (`values.js`)
 * and report changes through `onChange(nextValue)`.
 *
 * View-only users get the same values as static elements (`readOnly`), so
 * a board looks the same whether or not it can be edited.
 *
 * People columns hold users only: the API rejects teams in column values,
 * so the people picker lists users (teams are offered where the API allows
 * them, such as the share dialog).
 */

import { h } from "../../dom.js";
import { avatar, avatarStack } from "../components/avatar.js";
import { formatDay } from "../components/format.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { onMenuKeydown } from "../components/menu.js";
import { openPopover } from "../components/popover.js";
import { statusOption, textColorOn } from "./values.js";

/** User records for `ids` (unknown IDs get a placeholder name). */
function peopleFor(ids, users) {
  return ids.map(
    (id) => users.get(id) ?? { id, name: `User ${id}`, initials: "?" },
  );
}

/** Avatar stack for the user IDs of a people value. */
export function peopleStack(ids, users) {
  return avatarStack(peopleFor(ids, users), { size: "sm" });
}

/** A label of the status picker: a radio item of its menu. */
function statusChoice({ option, selected, onPick }) {
  const button = h(
    "button",
    {
      type: "button",
      role: "menuitemradio",
      tabindex: "-1",
      class: ["status-choice", selected && "selected"],
      "aria-checked": selected ? "true" : "false",
      // The picker opens on the current label, not the first one.
      "data-autofocus": selected ? true : null,
      on: { click: () => onPick(option.index) },
    },
    option.label,
  );
  button.style.backgroundColor = option.color;
  button.style.color = textColorOn(option.color);
  return button;
}

/**
 * Colored status pill; clicking opens a label picker, a menu of radio items
 * (arrow keys, Home/End and typeahead move; focus starts on the current
 * label).
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
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": `${label}: ${text || "not set"}. Change status`,
      dataset: { focusKey },
      on: { click: () => openStatusPicker() },
    },
    text ||
      (placeholder ? h("span", { class: "placeholder" }, placeholder) : ""),
  );
  // Blank labels use the theme's empty color from CSS.
  if (text) {
    pill.style.backgroundColor = option.color;
    pill.style.color = textColorOn(option.color);
  }

  function openStatusPicker() {
    const popover = openPopover({
      anchor: pill,
      label: `Choose ${column.title}`,
      role: "menu",
      content: () =>
        h(
          "div",
          { class: "status-picker", on: { keydown: onMenuKeydown } },
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
              role: "menuitem",
              tabindex: "-1",
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

function personHint(user) {
  if (user.status === "deactivated") return "Deactivated";
  return user.title || null;
}

function personRow({ user, checked, onToggle }) {
  const checkbox = h("input", {
    type: "checkbox",
    checked,
    on: { change: (event) => onToggle(user.id, event.currentTarget.checked) },
  });
  const hint = personHint(user);
  return h(
    "label",
    {
      class: ["person-option", user.status === "deactivated" && "inactive"],
      dataset: { name: user.name.toLowerCase() },
    },
    checkbox,
    avatar(user, { size: "sm" }),
    h(
      "span",
      { class: "person-text" },
      h("span", { class: "person-name" }, user.name),
      hint ? h("span", { class: "person-hint" }, hint) : null,
    ),
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
      ? peopleStack(ids, users)
      : h("span", { class: "people-empty" }, icon("person")),
  );

  function openPicker() {
    const selected = new Set(ids);
    // Deactivated users stay listed only while they are still assigned.
    const choices = [...users.values()].filter(
      (user) => user.status !== "deactivated" || selected.has(user.id),
    );
    const list = h(
      "div",
      { class: "people-list" },
      choices.map((user) =>
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

/** A static status pill (view-only boards). */
export function statusLabel(column, value) {
  const option = statusOption(column, value);
  const text = option?.label ?? "";
  const pill = h(
    "span",
    { class: ["status-pill", "readonly", !text && "empty"] },
    text,
  );
  if (text) {
    pill.style.backgroundColor = option.color;
    pill.style.color = textColorOn(option.color);
  }
  return pill;
}

/** Static people avatars (view-only boards). */
function peopleView({ value, users, label }) {
  const ids = Array.isArray(value) ? value : [];
  const names = ids.map((id) => users.get(id)?.name ?? `User ${id}`);
  return h(
    "span",
    {
      class: ["people-button", "readonly"],
      role: "img",
      "aria-label": `${label}: ${names.join(", ") || "nobody"}`,
    },
    ids.length > 0 ? peopleStack(ids, users) : null,
  );
}

function textView({ column, value }) {
  const text = column.type === "date" ? formatDay(value) : (value ?? "");
  return h(
    "span",
    {
      class: ["cell-readonly", `cell-readonly-${column.type}`],
      title: text || null,
    },
    column.type === "date" && value
      ? h("time", { datetime: value }, text)
      : text,
  );
}

/**
 * The static element for `column` showing `value` (view-only access).
 * @param {{ column: object, value: unknown, users: Map, label: string }} options
 */
function cellView({ column, value, users, label }) {
  if (column.type === "status") return statusLabel(column, value);
  if (column.type === "people") return peopleView({ value, users, label });
  if (["date", "numbers", "text"].includes(column.type)) {
    return textView({ column, value });
  }
  return h("span", { class: "cell-unsupported" }, "—");
}

/**
 * Returns the editor element for `column` showing `value`, or with
 * `readOnly` its static view. `placeholder` is shown in an empty status
 * pill.
 * @param {{ column: object, value: unknown, users: Map, itemName: string,
 *   onChange(next: unknown): void, focusKey?: string,
 *   placeholder?: string, readOnly?: boolean }} options
 */
export function cellEditor(options) {
  const { column, value, users, itemName, onChange, focusKey } = options;
  const label = `${column.title} for ${itemName}`;
  if (options.readOnly) return cellView({ column, value, users, label });
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
