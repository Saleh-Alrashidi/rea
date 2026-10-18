/**
 * People picker: a combobox that selects users and teams as chips. Typing
 * filters by name and email; arrow keys move, Enter adds, Backspace on an
 * empty query removes the last chip. Deactivated users are never offered;
 * `eligibility(subject)` can disable others with a reason (for example
 * guests on boards that are not Shareable).
 *
 * ```js
 * const picker = peoplePicker({ users, teams, label: "Add people or teams",
 *   excluded: new Set(["user:1"]),
 *   eligibility: (subject) => ({ ok: true }) });
 * picker.selection();   // [{ kind: "user", id: "2", name: "Sam Lee", … }]
 * ```
 */

import { h } from "../../dom.js";
import { subjectAvatar } from "./avatar.js";
import { roleBadge } from "./badge.js";
import { icon } from "./icon.js";

const MAX_SUGGESTIONS = 8;
let nextId = 0;

/** Every selectable subject: active users, then teams. Exported for tests. */
export function pickerSubjects({ users, teams = [], allowTeams = true }) {
  const people = users
    .filter((user) => user.status !== "deactivated")
    .map((user) => ({ ...user, kind: "user", id: String(user.id) }));
  const groups = allowTeams
    ? teams.map((team) => ({ ...team, kind: "team", id: String(team.id) }))
    : [];
  return [...people, ...groups];
}

const keyOf = (subject) => `${subject.kind}:${subject.id}`;

function describe(subject) {
  if (subject.kind === "team") {
    const count = subject.member_count ?? 0;
    return `Team · ${count} ${count === 1 ? "member" : "members"}`;
  }
  return subject.email ?? "";
}

function suggestions(p) {
  const term = p.query.trim().toLowerCase();
  const chosen = new Set(p.selected.map(keyOf));
  return p.subjects
    .filter(
      (subject) =>
        !p.excluded.has(keyOf(subject)) && !chosen.has(keyOf(subject)),
    )
    .filter(
      (subject) =>
        !term ||
        subject.name.toLowerCase().includes(term) ||
        (subject.email ?? "").toLowerCase().includes(term),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((subject) => ({ subject, check: p.eligibility(subject) }));
}

function changed(p) {
  renderChips(p);
  p.onChange?.([...p.selected]);
}

function add(p, { subject, check }) {
  if (!check.ok) return;
  p.selected.push(subject);
  p.query = "";
  p.input.value = "";
  p.active = 0;
  changed(p);
  renderList(p);
}

function remove(p, subject) {
  p.selected = p.selected.filter((entry) => keyOf(entry) !== keyOf(subject));
  changed(p);
  renderList(p);
  p.input.focus();
}

function renderChips(p) {
  p.chips.replaceChildren(
    ...p.selected.map((subject) =>
      h(
        "span",
        { class: "picker-chip" },
        subjectAvatar(subject, { size: "xs" }),
        h("span", { class: "picker-chip-name" }, subject.name),
        h(
          "button",
          {
            type: "button",
            class: "picker-chip-remove",
            "aria-label": `Remove ${subject.name}`,
            on: { click: () => remove(p, subject) },
          },
          icon("close", { size: 12 }),
        ),
      ),
    ),
  );
}

function optionElement(p, { subject, check }, index) {
  const active = index === p.active;
  const flagged =
    subject.kind === "user" &&
    (subject.role === "guest" || subject.role === "viewer");
  return h(
    "div",
    {
      id: `${p.id}-option-${index}`,
      role: "option",
      class: ["picker-option", active && "active", !check.ok && "disabled"],
      "aria-selected": active ? "true" : "false",
      "aria-disabled": check.ok ? null : "true",
      title: check.ok ? null : check.reason,
      on: {
        // Keep focus in the input so the list stays open.
        mousedown: (event) => event.preventDefault(),
        click: () => add(p, { subject, check }),
      },
    },
    subjectAvatar(subject, { size: "sm" }),
    h(
      "span",
      { class: "picker-option-text" },
      h("span", { class: "picker-option-name" }, subject.name),
      h(
        "span",
        { class: "picker-option-hint" },
        check.ok ? describe(subject) : check.reason,
      ),
    ),
    flagged ? roleBadge(subject.role) : null,
  );
}

function renderList(p) {
  p.suggestions = p.open ? suggestions(p) : [];
  p.active = Math.min(p.active, Math.max(0, p.suggestions.length - 1));
  const empty = p.open && p.suggestions.length === 0;
  const emptyText = p.query
    ? "No matching people or teams"
    : "Everyone already has access";
  p.list.replaceChildren(
    ...p.suggestions.map((suggestion, index) =>
      optionElement(p, suggestion, index),
    ),
    empty ? h("div", { class: "picker-empty" }, emptyText) : "",
  );
  p.list.hidden = !p.open;
  p.input.setAttribute("aria-expanded", p.open ? "true" : "false");
  p.input.setAttribute(
    "aria-activedescendant",
    p.suggestions.length > 0 ? `${p.id}-option-${p.active}` : "",
  );
}

function setOpen(p, open) {
  p.open = open;
  renderList(p);
}

function onKeydown(p, event) {
  const count = p.suggestions.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!p.open) setOpen(p, true);
    if (count === 0) return;
    p.active =
      (p.active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    renderList(p);
  } else if (event.key === "Enter") {
    // Never submit the surrounding form from the picker.
    event.preventDefault();
    const suggestion = p.suggestions[p.active];
    if (p.open && suggestion) add(p, suggestion);
  } else if (
    event.key === "Backspace" &&
    p.input.value === "" &&
    p.selected.length > 0
  ) {
    remove(p, p.selected.at(-1));
  } else if (event.key === "Escape" && p.open) {
    event.preventDefault();
    event.stopPropagation();
    setOpen(p, false);
  }
}

function inputElement(p, { label, placeholder }) {
  return h("input", {
    class: "picker-input",
    type: "text",
    role: "combobox",
    "aria-label": label,
    "aria-expanded": "false",
    "aria-controls": `${p.id}-list`,
    "aria-autocomplete": "list",
    autocomplete: "off",
    placeholder: placeholder ?? "Add people or teams",
    on: {
      input(event) {
        p.query = event.currentTarget.value;
        p.active = 0;
        setOpen(p, true);
      },
      focus: () => setOpen(p, true),
      blur: () => globalThis.setTimeout(() => setOpen(p, false), 120),
      keydown: (event) => onKeydown(p, event),
    },
  });
}

/**
 * @param {{ users: object[], teams?: object[], allowTeams?: boolean,
 *   excluded?: Set<string>, label: string, placeholder?: string,
 *   eligibility?: (subject: object) => { ok: boolean, reason?: string },
 *   onChange?: (selection: object[]) => void }} options
 * @returns {{ element: HTMLElement, selection(): object[], clear(): void,
 *   focus(): void }}
 */
export function peoplePicker(options) {
  const p = {
    id: `people-picker-${(nextId += 1)}`,
    subjects: pickerSubjects(options),
    excluded: options.excluded ?? new Set(),
    eligibility: options.eligibility ?? (() => ({ ok: true })),
    onChange: options.onChange,
    selected: [],
    query: "",
    open: false,
    active: 0,
    suggestions: [],
  };
  p.chips = h("span", { class: "picker-chips" });
  p.list = h("div", {
    class: "picker-list",
    id: `${p.id}-list`,
    role: "listbox",
    "aria-label": options.label,
    hidden: true,
  });
  p.input = inputElement(p, options);
  const element = h(
    "div",
    { class: "people-picker-field" },
    h(
      "div",
      { class: "picker-control", on: { click: () => p.input.focus() } },
      icon("search", { className: "picker-search-icon" }),
      p.chips,
      p.input,
    ),
    p.list,
  );
  return {
    element,
    selection: () => [...p.selected],
    clear() {
      p.selected = [];
      p.query = "";
      p.input.value = "";
      changed(p);
      renderList(p);
    },
    focus: () => p.input.focus(),
  };
}
