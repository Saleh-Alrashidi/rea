/**
 * Fixtures of the task view tests: a board shaped like an imported
 * ClickUp meetings list (department statuses plus Closed, every role
 * column, a long-text "Minuts" field, a second unroled "Status" and
 * "Priority"), tasks on it, and `installTaskDom(t)`: `fake-dom.js`'s
 * document plus the few DOM APIs the task view uses (`firstChild`,
 * `closest`, `querySelectorAll("[data-focus-key]")`, document click
 * listeners) and text
 * inputs that drop line breaks from their value, as browsers do.
 */

import { prepareColumns } from "../web/ui/board/values.js";
import { FakeElement, findAll, installFakeDom } from "./fake-dom.js";

const statusSettings = (labels, colors, types) =>
  JSON.stringify({
    labels,
    labels_colors: colors,
    ...(types ? { labels_types: types } : {}),
  });

const column = (id, title, type, { role, settings = "{}" } = {}) => ({
  id,
  title,
  type,
  ...(role ? { role } : {}),
  settings_str: settings,
});

/** A ClickUp-shaped board with `items` (see the module comment). */
export function meetingsBoard(items) {
  const columns = prepareColumns([
    column("name", "Name", "name"),
    column("status", "Status", "status", {
      role: "status",
      settings: statusSettings(
        { 0: "facility", 1: "psych dept", 2: "Closed", 5: "" },
        { 0: "#ff7800", 1: "#1090e0", 2: "#008844", 5: "#c4c4c4" },
        { 0: "custom", 1: "custom", 2: "closed" },
      ),
    }),
    column("people", "Assignees", "people", { role: "assignees" }),
    column("due", "Due date", "date", { role: "due_date" }),
    column("start", "Start date", "date", { role: "start_date" }),
    column("priority", "Priority", "status", {
      role: "priority",
      settings: statusSettings(
        { 0: "Urgent", 1: "High", 2: "Normal", 3: "Low" },
        { 0: "#f50000", 1: "#f8ae00", 2: "#6fddff", 3: "#d8d8d8" },
      ),
    }),
    column("estimate", "Time estimate", "numbers", { role: "time_estimate" }),
    column("tags", "Tags", "text", { role: "tags" }),
    column("description", "Description", "text", { role: "description" }),
    column("minuts", "Minuts", "text"),
    column("files", "Files", "text"),
    column("state", "Status", "status", {
      settings: statusSettings(
        { 0: "Working on it", 1: "Done" },
        { 0: "#fdab3d", 1: "#00c875" },
      ),
    }),
    column("count", "#", "numbers"),
    column("priority2", "Priority", "status", {
      settings: statusSettings({ 0: "High" }, { 0: "#f8ae00" }),
    }),
  ]);
  return {
    id: "1",
    name: "Weekly Meetings",
    columns,
    groups: [
      { id: "open", title: "Open", color: "#579bfc", position: 0 },
      { id: "closed", title: "Closed", color: "#00c875", position: 1 },
    ],
    views: [{ id: "1", name: "List", type: "list" }],
    workspace: { id: "4", name: "Clinic" },
    workspaceAccessible: true,
    assignableUsers: [],
    import: { source: "clickup" },
    items,
  };
}

/** A decoded board item (`decodeItem`'s shape). */
export function task(id, name, values = {}, extra = {}) {
  return {
    id,
    name,
    groupId: "open",
    createdAt: null,
    parentId: null,
    updatesCount: 0,
    values: { status: null, people: [], ...values },
    texts: {},
    ...extra,
  };
}

/** A text `<input>` whose value drops line breaks, as browsers do. */
class FakeTextInput extends FakeElement {
  constructor() {
    super("input");
    let value = "";
    Object.defineProperty(this, "value", {
      get: () => value,
      set: (next) => {
        const type = this.getAttribute("type") ?? "text";
        value = type === "text" ? String(next).replace(/[\r\n]/g, "") : next;
      },
    });
  }
}

let patched = false;

function patchElements() {
  if (patched) return;
  patched = true;
  Object.assign(FakeElement.prototype, {
    /** `[attr]` selectors only (enough for focus.js). */
    closest(selector) {
      const name = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      for (let node = this; node?.nodeType === 1; node = node.parentNode) {
        if (name ? node.hasAttribute(name) : false) return node;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== "[data-focus-key]") throw new Error(selector);
      return findAll(this, (node) => node.dataset.focusKey !== undefined);
    },
  });
  Object.defineProperty(FakeElement.prototype, "firstChild", {
    get() {
      return this.childNodes[0] ?? null;
    },
  });
}

/**
 * Installs the fake document for test `t` (see the module comment);
 * `document.clicks()` runs the document's click listeners.
 */
export function installTaskDom(t) {
  patchElements();
  const doc = installFakeDom(t);
  const listeners = new Set();
  doc.createElement = (tag) =>
    tag === "input" ? new FakeTextInput() : new FakeElement(tag);
  doc.addEventListener = (type, listener) => {
    if (type === "click") listeners.add(listener);
  };
  doc.removeEventListener = (_type, listener) => listeners.delete(listener);
  doc.clicks = () => {
    for (const listener of listeners) listener({ type: "click" });
  };
  return doc;
}
