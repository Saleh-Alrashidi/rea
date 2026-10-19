/**
 * Column value editors shared by the table, kanban cards and the item card:
 * status pills with a label picker, people avatars with a picker, date,
 * numbers and text inputs. Text goes through `textInput`, so a multi-line
 * value is edited in a textarea, never in an input that would drop its
 * line breaks. Editors receive decoded UI values (`values.js`) and report
 * changes through `onChange(nextValue)`, which may return a promise of
 * `false` when the server refused the change.
 *
 * View-only users get the same values as static elements (`readOnly`), so
 * a board looks the same whether or not it can be edited.
 *
 * People columns hold users only: the API rejects teams in column values,
 * so the people picker lists users (teams are offered where the API allows
 * them, such as the share dialog). It offers the board's
 * `assignable_users`, the server's list of who may be named on this board
 * (SPEC-2 §6); people already assigned who no longer qualify stay listed
 * only so they can be removed. The picker sends one change at a time and
 * undoes a toggle the server refused, so later toggles do not resend it.
 */

import { h } from "../../dom.js";
import { avatar, avatarStack } from "../components/avatar.js";
import { formatDay } from "../components/format.js";
import { icon } from "../components/icon.js";
import { inlineInput } from "../components/inline-edit.js";
import { onMenuKeydown } from "../components/menu.js";
import { openPopover } from "../components/popover.js";
import { MAX_TEXT, textInput } from "../components/text-editor.js";
import { personOf, statusOption, textColorOn } from "./values.js";

const ASSIGN_HINT = "Only people who can open this board can be assigned.";

/** User records for `ids` (unknown IDs read "Someone"). */
function peopleFor(ids, users) {
  return ids.map((id) => personOf(users, id));
}

const peopleNames = (ids, users) =>
  peopleFor(ids, users).map((user) => user.name);

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
 * Opens the label picker of status `column` next to `anchor`: a menu of
 * radio items (arrow keys, Home/End and typeahead move; focus starts on
 * the current label) plus "Clear". `onChange(index | null)` runs only for
 * a different label.
 * @param {{ anchor: HTMLElement, column: object, value: number | null,
 *   onChange(index: number | null): void }} options
 */
export function openStatusMenu({ anchor, column, value, onChange }) {
  const popover = openPopover({
    anchor,
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
  return popover;
}

/**
 * Colored status pill; clicking opens the label picker (`openStatusMenu`).
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
      on: {
        click: () => openStatusMenu({ anchor: pill, column, value, onChange }),
      },
    },
    text ||
      (placeholder ? h("span", { class: "placeholder" }, placeholder) : ""),
  );
  // Blank labels use the theme's empty color from CSS.
  if (text) {
    pill.style.backgroundColor = option.color;
    pill.style.color = textColorOn(option.color);
  }
  return pill;
}

/**
 * The people the picker lists: everyone the server says can be assigned,
 * then people still assigned who no longer can (removable only).
 * Exported for tests.
 */
export function personChoices({ ids, assignable, users }) {
  const offered = new Set(assignable.map((user) => user.id));
  const stale = ids
    .filter((id) => !offered.has(id))
    .map((id) => ({ ...personOf(users, id), assignable: false }));
  return [
    ...assignable.map((user) => ({ ...user, assignable: true })),
    ...stale,
  ];
}

function personHint(user) {
  if (user.status === "deactivated") return "Deactivated";
  if (!user.assignable) return "No access to this board";
  return user.title || null;
}

function personRow({ user, checked, onToggle }) {
  const checkbox = h("input", {
    type: "checkbox",
    checked,
    on: {
      change(event) {
        const box = event.currentTarget;
        // Someone without access can be removed but not added back. The
        // box stays focusable (aria-disabled), so focus stays in the list.
        if (box.getAttribute("aria-disabled") === "true") {
          box.checked = false;
          return;
        }
        if (!user.assignable && !box.checked) {
          box.setAttribute("aria-disabled", "true");
        }
        onToggle(user.id, box.checked, box);
      },
    },
  });
  const hint = personHint(user);
  return h(
    "label",
    {
      class: ["person-option", !user.assignable && "inactive"],
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
 * People avatars; clicking opens a checklist of the people who can be
 * assigned. Each toggle reports the full new list of user IDs.
 * @param {{ column: object, value: string[], users: Map,
 *   assignable: object[], label: string, onChange(ids: string[]): void,
 *   focusKey?: string }} options
 */
function peopleButton(options) {
  const { column, value, users, label, onChange, focusKey } = options;
  const ids = Array.isArray(value) ? value : [];
  const names = peopleNames(ids, users);
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
    const choices = personChoices({
      ids,
      assignable: options.assignable ?? [],
      users,
    });
    // One change at a time, each sending the selection as it is then.
    let queue = Promise.resolve();
    const toggle = (id, on, box) => {
      if (on) selected.add(id);
      else selected.delete(id);
      queue = queue.then(async () => {
        const accepted = await onChange([...selected]);
        if (accepted !== false) return;
        // Refused (the toast says why): undo it so it is not resent.
        if (on) selected.delete(id);
        else selected.add(id);
        box.checked = selected.has(id);
        box.removeAttribute("aria-disabled");
      });
    };
    const list = h(
      "div",
      { class: "people-list" },
      choices.map((user) =>
        personRow({ user, checked: selected.has(user.id), onToggle: toggle }),
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
      content: h(
        "div",
        { class: "people-picker" },
        search,
        list,
        h(
          "p",
          { class: "people-hint" },
          icon("info", { size: 12 }),
          ASSIGN_HINT,
        ),
      ),
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
  const names = peopleNames(ids, users);
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
 * `assignable` is the board's `assignable_users` (people columns).
 * @param {{ column: object, value: unknown, users: Map, itemName: string,
 *   assignable?: object[], onChange(next: unknown): void,
 *   focusKey?: string, placeholder?: string, readOnly?: boolean }} options
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
      return peopleButton({ ...options, label });
    case "date":
      return dateInput({ value, label, onChange, focusKey });
    case "numbers":
      return inlineInput({
        value: value ?? "",
        label,
        type: "number",
        className: "cell-number",
        focusKey,
        onCommit: (next) => onChange(next === "" ? null : next),
      });
    case "text":
      return textInput({
        value: value ?? "",
        label,
        className: "cell-text",
        maxLength: MAX_TEXT,
        focusKey,
        onCommit: (next) => onChange(next === "" ? null : next),
      });
    default:
      return h("span", { class: "cell-unsupported" }, "—");
  }
}
