/**
 * The fake DOM of the import view tests: `installImportDom(t)` installs
 * `fake-dom.js`'s document and adds the few DOM APIs the import views read
 * (`querySelector(All)` with simple selectors and descendant
 * combinators, `classList`, `click()`), plus small query helpers and a
 * call recorder. `VIEW_PREVIEW` is a Preview with a long workspace (ten
 * boards, one imported before) for the tree and people views.
 */
import {
  FakeElement,
  findAll,
  fire,
  hasClass,
  installFakeDom,
} from "./fake-dom.js";

/** `tag`, `.class`, `tag.a.b`, `[attr]` and `[attr="value"]`. */
const SELECTOR =
  /^([a-z0-9-]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i;

function matches(element, selector) {
  const [, tag, classes, attribute, value] = SELECTOR.exec(selector);
  if (tag && element.localName !== tag) return false;
  const wanted = classes.split(".").filter(Boolean);
  if (!wanted.every((name) => hasClass(element, name))) return false;
  if (!attribute) return true;
  const actual = element.getAttribute(attribute);
  return value === undefined ? actual !== null : actual === value;
}

let patched = false;

/** Adds the DOM APIs the import views need to the fake elements (once). */
function patchFakeDom() {
  if (patched) return;
  patched = true;
  Object.assign(FakeElement.prototype, {
    /** Simple selectors and descendant combinators ("tbody tr"). */
    querySelectorAll(selector) {
      let scope = [this];
      for (const part of selector.trim().split(/\s+/)) {
        const found = scope.flatMap((root) =>
          findAll(root, (el) => el !== root && matches(el, part)),
        );
        scope = [...new Set(found)];
      }
      return scope;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    click() {
      fire(this, "click");
    },
  });
  Object.defineProperty(FakeElement.prototype, "classList", {
    get() {
      const names = () => this.className.split(/\s+/).filter(Boolean);
      const set = (list) =>
        this.setAttribute("class", [...new Set(list)].join(" "));
      return {
        contains: (name) => names().includes(name),
        add: (name) => set([...names(), name]),
        remove: (name) => set(names().filter((each) => each !== name)),
        toggle: (name, force) => {
          const on = force ?? !names().includes(name);
          set(
            on ? [...names(), name] : names().filter((each) => each !== name),
          );
          return on;
        },
      };
    },
  });
}

/** Installs the fake document for test `t` (see the module comment). */
export function installImportDom(t) {
  patchFakeDom();
  return installFakeDom(t);
}

export const $ = (root, selector) => root.querySelector(selector);
export const $$ = (root, selector) => root.querySelectorAll(selector);
export const label = (button) => $(button, ".btn-label").textContent;

/** A function that records its first argument in `.calls`. */
export function recorder() {
  const calls = [];
  const fn = (value) => calls.push(value);
  fn.calls = calls;
  return fn;
}

export const VIEW_PREVIEW = {
  source_label: "monday.com account Acme",
  totals: {
    workspaces: 1,
    boards: 10,
    items: 9,
    subitems: 0,
    updates: 0,
    docs: 1,
    users: 2,
  },
  workspaces: [
    {
      source_id: "w1",
      name: "Acme",
      kind: "open",
      target: "new",
      boards: Array.from({ length: 10 }, (_, index) => ({
        source_id: `b${index}`,
        name: `Board ${index}`,
        kind: "public",
        included: index !== 1,
        counts: { items: 1, subitems: 0, updates: 0, columns: 2, groups: 1 },
        source_url:
          index === 0
            ? "https://acme.monday.com/boards/1"
            : "javascript:alert(1)",
        reimport:
          index === 2
            ? { board_id: "42", name: "Board 2", imported_at: "2026-10-01" }
            : null,
        import_name:
          index === 2 ? "Board 2 (imported again)" : `Board ${index}`,
      })),
      docs: [
        {
          source_id: "d1",
          title: "Handbook",
          visibility: "private",
          included: true,
          blocks: 3,
        },
      ],
    },
  ],
  users: [
    {
      source_id: "u1",
      name: "Sam",
      email: "sam@x.test",
      proposal: "skip",
      action: "skip",
      match: null,
    },
    {
      source_id: "u2",
      name: "Anon",
      email: null,
      proposal: "skip",
      action: "skip",
      match: null,
      note: "No email to match",
    },
  ],
  targets: [{ id: "7", name: "Marketing", kind: "open" }],
  warnings: [
    {
      code: "column_as_text",
      message: "Files became text",
      path: "workspaces[0].boards[0].columns[1]",
    },
    {
      code: "column_as_text",
      message: "Tags became text",
      path: "workspaces[0].boards[3].columns[2]",
    },
    { code: "truncated", message: "Name cut", path: "users[1]" },
  ],
};
