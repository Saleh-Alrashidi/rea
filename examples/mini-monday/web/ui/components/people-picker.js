/**
 * People picker: a combobox that selects users and teams as chips. Arrow
 * keys move, Enter adds, Backspace on an empty query removes the last chip.
 * Suggestions come from one of two sources:
 *
 * - a local list (`users`, `teams`), filtered by name and email as you
 *   type; deactivated users are never offered (team pickers);
 * - `search(query)` → Promise of suggestions the server computed, such as
 *   `share_candidates`: each one is offered only when `eligible` is not
 *   false, and otherwise shows its `reason`. Results are cached per query
 *   for the picker's lifetime and late answers to older queries are
 *   dropped; `initial` seeds the empty query. While a query is pending its
 *   previous rows stay visible but inert, and an Enter pressed meanwhile
 *   adds the first eligible person or team of that query's answer.
 *
 * ```js
 * const picker = peoplePicker({ users, teams, label: "Add people or teams",
 *   excluded: new Set(["user:1"]) });
 * const remote = peoplePicker({ label: "Add people or teams",
 *   search: (query) => fetchCandidates(query), initial: firstPage });
 * picker.selection();   // [{ kind: "user", id: "2", name: "Sam Lee", … }]
 * ```
 */

import { h } from "../../dom.js";
import { subjectAvatar } from "./avatar.js";
import { roleBadge } from "./badge.js";
import { icon } from "./icon.js";

const MAX_SUGGESTIONS = 8;
const SEARCH_DELAY_MS = 150;
/** Queries whose answers a picker keeps (oldest dropped first). */
const MAX_CACHED = 50;
let nextId = 0;

/** Every selectable subject: active users, then teams. Exported for tests. */
export function pickerSubjects({ users, teams = [], allowTeams = true }) {
  const people = users
    .filter((user) => user.status !== "deactivated")
    .map((user) => ({
      ...user,
      kind: "user",
      id: String(user.id),
      accountRole: user.role ?? null,
    }));
  const groups = allowTeams
    ? teams.map((team) => ({ ...team, kind: "team", id: String(team.id) }))
    : [];
  return [...people, ...groups];
}

const keyOf = (subject) => `${subject.kind}:${subject.id}`;
const offered = (subject) => subject.eligible !== false;

/**
 * The local source: subjects outside `excluded` whose name or email
 * contains `query` (case-insensitive). Exported for tests.
 */
export function localSource({ users, teams, allowTeams, excluded }) {
  const subjects = pickerSubjects({ users, teams, allowTeams });
  const skip = excluded ?? new Set();
  return (query) => {
    const term = query.toLowerCase();
    return subjects.filter(
      (subject) =>
        !skip.has(keyOf(subject)) &&
        (!term ||
          subject.name.toLowerCase().includes(term) ||
          (subject.email ?? "").toLowerCase().includes(term)),
    );
  };
}

/** "Team · 1 member", "Team · 3 members"; just "Team" when unknown. */
export function teamDetail(count) {
  if (!Number.isInteger(count)) return "Team";
  return `Team · ${count} ${count === 1 ? "member" : "members"}`;
}

function describe(subject) {
  if (!offered(subject)) return subject.reason ?? "Can’t be added here";
  if (typeof subject.subtitle === "string") return subject.subtitle;
  if (subject.kind === "team") return teamDetail(subject.member_count);
  return subject.email ?? "";
}

/** The current results minus chosen subjects (at most MAX_SUGGESTIONS). */
function suggestions(p) {
  const chosen = new Set(p.selected.map(keyOf));
  return p.results
    .filter((subject) => !chosen.has(keyOf(subject)))
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * The suggestions the picker reports (`onSuggestions`): those of an open
 * list or of a typed query, never rows of a pending query.
 */
function reported(p) {
  if (p.status === "loading") return [];
  return p.open || p.query.trim() !== "" ? suggestions(p) : [];
}

// ------------------------------------------------------------- results

function remember(p, query, list) {
  p.cache.delete(query);
  p.cache.set(query, list);
  if (p.cache.size > MAX_CACHED) p.cache.delete(p.cache.keys().next().value);
}

function settle(p, seq, list) {
  if (seq !== p.seq) return;
  p.status = list ? "ready" : "error";
  p.results = list ?? [];
  if (list && p.remote) remember(p, p.searched, list);
  // A new answer starts at its first eligible row.
  p.active = Math.max(0, suggestions(p).findIndex(offered));
  const enter = p.pendingEnter === seq;
  p.pendingEnter = null;
  renderList(p);
  // Enter pressed while this query was pending: add its first eligible row.
  const first = enter ? p.suggestions.find(offered) : null;
  if (first) add(p, first);
}

/** Asks the source for the current query (debounced for `search`). */
function lookup(p) {
  const seq = (p.seq += 1);
  const query = p.query.trim();
  globalThis.clearTimeout(p.timer);
  p.searched = query;
  if (!p.remote) {
    settle(p, seq, p.source(query));
    return;
  }
  if (p.cache.has(query)) {
    settle(p, seq, p.cache.get(query));
    return;
  }
  p.status = "loading";
  renderList(p);
  p.timer = globalThis.setTimeout(() => {
    Promise.resolve()
      .then(() => p.source(query))
      .then(
        (list) => settle(p, seq, Array.isArray(list) ? list : []),
        () => settle(p, seq, null),
      );
  }, SEARCH_DELAY_MS);
}

// --------------------------------------------------------------- chips

function changed(p) {
  renderChips(p);
  p.onChange?.([...p.selected]);
}

function add(p, subject) {
  if (!offered(subject)) return;
  p.selected.push(subject);
  p.query = "";
  p.input.value = "";
  p.active = 0;
  changed(p);
  lookup(p);
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

// ---------------------------------------------------------------- list

/**
 * One row. Rows of a pending query (`stale`) are shown dimmed and inert:
 * neither a click nor Enter can add what the new query may not offer.
 */
function optionElement(p, subject, { index, stale = false }) {
  const active = !stale && index === p.active;
  const ok = offered(subject);
  const flagged =
    subject.kind === "user" &&
    (subject.accountRole === "guest" || subject.accountRole === "viewer");
  return h(
    "div",
    {
      id: stale ? null : `${p.id}-option-${index}`,
      role: "option",
      class: [
        "picker-option",
        active && "active",
        !ok && "disabled",
        stale && "stale",
      ],
      "aria-selected": active ? "true" : "false",
      "aria-disabled": ok && !stale ? null : "true",
      title: ok ? null : describe(subject),
      on: {
        // Keep focus in the input so the list stays open.
        mousedown: (event) => event.preventDefault(),
        click: () => {
          if (!stale) add(p, subject);
        },
      },
    },
    subjectAvatar(subject, { size: "sm" }),
    h(
      "span",
      { class: "picker-option-text" },
      h("span", { class: "picker-option-name" }, subject.name),
      h("span", { class: "picker-option-hint" }, describe(subject)),
    ),
    flagged ? roleBadge(subject.accountRole) : null,
  );
}

function emptyText(p) {
  if (p.status === "loading") return "Searching…";
  if (p.status === "error") return "Couldn’t load suggestions";
  return p.query.trim()
    ? "No matching people or teams"
    : (p.emptyText ?? "Everyone already has access");
}

function renderList(p) {
  const loading = p.status === "loading";
  // Only an answered query has live options; a pending one shows the
  // previous rows as stale.
  p.suggestions = p.open && !loading ? suggestions(p) : [];
  const stale = p.open && loading ? suggestions(p) : [];
  // Clamp to the live rows (a closed or pending list keeps the position).
  if (p.suggestions.length > 0) {
    p.active = Math.min(p.active, p.suggestions.length - 1);
  }
  const empty = p.open && p.suggestions.length === 0 && stale.length === 0;
  p.list.replaceChildren(
    ...p.suggestions.map((subject, index) =>
      optionElement(p, subject, { index }),
    ),
    ...stale.map((subject, index) =>
      optionElement(p, subject, { index, stale: true }),
    ),
    empty ? h("div", { class: "picker-empty" }, emptyText(p)) : "",
  );
  p.list.hidden = !p.open;
  p.list.setAttribute("aria-busy", p.status === "loading" ? "true" : "false");
  p.input.setAttribute("aria-expanded", p.open ? "true" : "false");
  if (p.suggestions.length > 0) {
    p.input.setAttribute("aria-activedescendant", `${p.id}-option-${p.active}`);
  } else {
    p.input.removeAttribute("aria-activedescendant");
  }
  p.onSuggestions?.(reported(p));
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
    if (p.open && p.status === "loading") {
      // Answered by settle() for this query only (typing on drops it).
      p.pendingEnter = p.seq;
      return;
    }
    const subject = p.suggestions[p.active];
    if (p.open && subject) add(p, subject);
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

function inputElement(p, { label, placeholder, focusKey, describedBy }) {
  return h("input", {
    class: "picker-input",
    type: "text",
    role: "combobox",
    "aria-label": label,
    "aria-describedby": describedBy ?? null,
    dataset: { focusKey },
    "aria-expanded": "false",
    "aria-controls": `${p.id}-list`,
    "aria-autocomplete": "list",
    autocomplete: "off",
    placeholder: placeholder ?? "Add people or teams",
    on: {
      input(event) {
        p.query = event.currentTarget.value;
        p.open = true;
        lookup(p);
      },
      focus() {
        // Focus put back after a change (`focus({ open: false })`) leaves
        // the list closed, so it does not cover what changed.
        if (p.quietFocus) {
          p.quietFocus = false;
          return;
        }
        p.open = true;
        // A remote picker asks for its first suggestions when first used.
        if (p.seq === 0) lookup(p);
        else renderList(p);
      },
      blur: () => globalThis.setTimeout(() => setOpen(p, false), 120),
      keydown: (event) => onKeydown(p, event),
    },
  });
}

function createState(options) {
  const remote = typeof options.search === "function";
  const p = {
    id: `people-picker-${(nextId += 1)}`,
    remote,
    source: remote ? options.search : localSource(options),
    cache: new Map(),
    onChange: options.onChange,
    onSuggestions: options.onSuggestions,
    emptyText: options.emptyText,
    selected: [],
    query: "",
    searched: "",
    open: false,
    active: 0,
    seq: 0,
    pendingEnter: null,
    quietFocus: false,
    timer: null,
    status: "ready",
    results: [],
    suggestions: [],
  };
  if (remote && Array.isArray(options.initial)) {
    p.cache.set("", options.initial);
  }
  return p;
}

/**
 * @param {{ users?: object[], teams?: object[], allowTeams?: boolean,
 *   excluded?: Set<string>, search?: (query: string) => Promise<object[]>,
 *   initial?: object[], label: string, placeholder?: string,
 *   emptyText?: string, onChange?: (selection: object[]) => void,
 *   onSuggestions?: (shown: object[]) => void, focusKey?: string,
 *   describedBy?: string }} options
 *   Suggestions are `{ kind, id, name, subtitle?, email?, eligible?,
 *   reason?, accountRole?, … }`; `onSuggestions` gets the ones on offer in
 *   an open list or for a typed query (none while a query is pending).
 *   `focusKey` and `describedBy` (an element ID) go on the input.
 * @returns {{ element: HTMLElement, selection(): object[], clear(): void,
 *   focus(options?: { open?: boolean }): void }}
 */
export function peoplePicker(options) {
  const p = createState(options);
  p.chips = h("span", { class: "picker-chips" });
  p.list = h("div", {
    class: "picker-list",
    id: `${p.id}-list`,
    role: "listbox",
    "aria-label": options.label,
    // Options are reached through aria-activedescendant; a scrollable list
    // would otherwise be a Tab stop of its own in Chromium.
    tabindex: "-1",
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
  if (!p.remote || p.cache.has("")) lookup(p);
  return {
    element,
    selection: () => [...p.selected],
    clear() {
      p.selected = [];
      p.query = "";
      p.input.value = "";
      changed(p);
      lookup(p);
    },
    focus({ open = true } = {}) {
      p.quietFocus = !open;
      p.input.focus();
      p.quietFocus = false;
    },
  };
}
