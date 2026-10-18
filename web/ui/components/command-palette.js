/**
 * Command palette (Ctrl/⌘+K): a modal combobox over `search(query)` results
 * (boards, items, docs, notes, forms, people, teams, workspaces the user
 * can access) and quick actions. Arrow keys move, Enter opens, Esc closes.
 *
 * ```js
 * const palette = createCommandPalette({ router, actions: [
 *   { id: "new-board", label: "New board", icon: "grid", run: () => flows.board() },
 * ]});
 * palette.open();
 * ```
 */

import { request } from "../../api.js";
import { h } from "../../dom.js";
import { hashFromUrl } from "../../router.js";
import { openDialog } from "./dialog.js";
import { icon } from "./icon.js";
import { resourceKind } from "./labels.js";

export const SEARCH_QUERY = `query CommandSearch($query: String!, $limit: Int) {
  search(query: $query, limit: $limit) { kind id title subtitle url }
}`;

const SEARCH_DELAY_MS = 150;
const SEARCH_LIMIT = 20;
const MAX_QUERY = 200;

function matches(action, term) {
  if (!term) return true;
  const text = [action.label, ...(action.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  return text.includes(term);
}

/**
 * The options shown for `state`: matching quick actions, then results.
 * Exported for tests.
 */
export function paletteOptions({ actions, results, query }) {
  const term = query.trim().toLowerCase();
  const quick = actions
    .filter((action) => matches(action, term))
    .map((action) => ({ group: "Quick actions", ...action }));
  const found = (results ?? []).map((result) => ({
    group: "Results",
    id: `${result.kind}:${result.id}`,
    label: result.title,
    hint: result.subtitle ?? resourceKind(result.kind).label,
    icon: resourceKind(result.kind).icon,
    href: hashFromUrl(result.url),
  }));
  return [...quick, ...found.filter((option) => option.href)];
}

function optionElement(option, { index, active, onPick, onHover }) {
  return h(
    "div",
    {
      id: `palette-option-${index}`,
      role: "option",
      class: ["palette-option", active && "active"],
      "aria-selected": active ? "true" : "false",
      on: {
        click: () => onPick(option),
        mousemove: () => !active && onHover(index),
      },
    },
    h(
      "span",
      { class: "palette-option-icon" },
      icon(option.icon ?? "arrowRight"),
    ),
    h(
      "span",
      { class: "palette-option-text" },
      h("span", { class: "palette-option-label" }, option.label),
      option.hint
        ? h("span", { class: "palette-option-hint" }, option.hint)
        : null,
    ),
    active
      ? icon("arrowRight", { size: 14, className: "palette-option-go" })
      : null,
  );
}

function statusLine(state) {
  if (state.loading) return "Searching…";
  if (state.error) return "Search is unavailable right now.";
  if (state.query.trim() && state.results?.length === 0) {
    return `No results for “${state.query.trim()}”.`;
  }
  return "";
}

function pick(s, option) {
  s.dialog.close();
  if (option.run) option.run();
  else if (option.href) s.router.navigate(option.href);
}

function groupElements(s, options) {
  const groups = [];
  let index = 0;
  for (const name of ["Quick actions", "Results"]) {
    const entries = options.filter((option) => option.group === name);
    if (entries.length === 0) continue;
    groups.push(
      h(
        "div",
        { role: "group", class: "palette-group", "aria-label": name },
        h("div", { class: "palette-group-label", "aria-hidden": "true" }, name),
        entries.map((option) => {
          const i = index++;
          return optionElement(option, {
            index: i,
            active: i === s.active,
            onPick: (picked) => pick(s, picked),
            onHover: (next) => setActive(s, next),
          });
        }),
      ),
    );
  }
  return groups;
}

function render(s) {
  const options = paletteOptions({
    actions: s.actions,
    results: s.results,
    query: s.query,
  });
  s.options = options;
  s.active = Math.min(s.active, Math.max(0, options.length - 1));
  s.list.replaceChildren(...groupElements(s, options));
  s.status.textContent = statusLine(s);
  s.input.setAttribute(
    "aria-activedescendant",
    options.length > 0 ? `palette-option-${s.active}` : "",
  );
  s.list
    .querySelector(".palette-option.active")
    ?.scrollIntoView?.({ block: "nearest" });
}

function setActive(s, index) {
  s.active = index;
  render(s);
}

async function search(s) {
  const query = s.query.trim();
  const seq = (s.seq += 1);
  if (!query) {
    Object.assign(s, { results: null, loading: false, error: false });
    render(s);
    return;
  }
  s.loading = true;
  render(s);
  try {
    const data = await request(SEARCH_QUERY, { query, limit: SEARCH_LIMIT });
    if (seq !== s.seq || s.closed) return;
    Object.assign(s, { results: data.search, loading: false, error: false });
  } catch {
    if (seq !== s.seq || s.closed) return;
    Object.assign(s, { results: [], loading: false, error: true });
  }
  s.active = 0;
  render(s);
}

function onKeydown(s, event) {
  const count = s.options.length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    setActive(s, (s.active + step + count) % count);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const option = s.options[s.active];
    if (option) pick(s, option);
  }
}

function onInput(s, event) {
  s.query = event.currentTarget.value;
  s.active = 0;
  globalThis.clearTimeout(s.timer);
  s.timer = globalThis.setTimeout(() => search(s), SEARCH_DELAY_MS);
  render(s);
}

function content(s) {
  s.input = h("input", {
    class: "palette-input",
    type: "text",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    "aria-autocomplete": "list",
    "aria-label": "Search Worklane",
    placeholder: "Search boards, items, docs, people… or type a command",
    maxlength: MAX_QUERY,
    autocomplete: "off",
    spellcheck: "false",
    autofocus: true,
    on: {
      input: (event) => onInput(s, event),
      keydown: (event) => onKeydown(s, event),
    },
  });
  s.list = h("div", {
    id: "palette-list",
    class: "palette-list",
    role: "listbox",
    "aria-label": "Results",
  });
  s.status = h("p", { class: "palette-status", role: "status" });
  const key = (text) => h("kbd", { class: "kbd" }, text);
  return h(
    "div",
    { class: "palette" },
    h(
      "div",
      { class: "palette-input-row" },
      icon("search", { size: 18 }),
      s.input,
      key("Esc"),
    ),
    s.list,
    s.status,
    h(
      "div",
      { class: "palette-footer", "aria-hidden": "true" },
      h("span", null, key("↑"), key("↓"), " to move"),
      h("span", null, key("Enter"), " to open"),
    ),
  );
}

/**
 * @param {{ router: { navigate(hash: string): void },
 *   actions: { id: string, label: string, icon?: string, hint?: string,
 *     keywords?: string[], run(): void }[] | (() => object[]) }} options
 * @returns {{ open(): void, close(): void, isOpen(): boolean }}
 */
export function createCommandPalette({ router, actions }) {
  let session = null;

  function open() {
    if (session) {
      session.input.focus();
      return;
    }
    const s = {
      router,
      query: "",
      results: null,
      loading: false,
      error: false,
      closed: false,
      active: 0,
      seq: 0,
      timer: null,
      options: [],
      actions: typeof actions === "function" ? actions() : actions,
    };
    session = s;
    s.dialog = openDialog({
      title: "Search and commands",
      size: "lg",
      className: "command-palette",
      content: () => content(s),
      onClose() {
        s.closed = true;
        globalThis.clearTimeout(s.timer);
        if (session === s) session = null;
      },
    });
    render(s);
  }

  return {
    open,
    close: () => session?.dialog.close(),
    isOpen: () => session !== null,
  };
}
