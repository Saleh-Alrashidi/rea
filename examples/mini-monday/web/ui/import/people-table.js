/**
 * The review step's people table (SPEC-4 §6.3): each source person with
 * their email and an action dropdown — the proposal (a match by email),
 * "Skip", invites as member / viewer / guest (only with an email) and a
 * match with any other active Worklane user. A search box and a filter
 * narrow long lists; "Everyone not matched" sets one action for all
 * people not matched to a Worklane user (by email or by hand), and keeps
 * the actions chosen by hand in their rows.
 *
 * At most PAGE rows are drawn at first ("Show all" draws the rest), so a
 * source with thousands of people stays responsive.
 *
 * `peopleTable({ preview, selection, people, onChange })` → `{ element }`;
 * `people` are Worklane users for the match options.
 */

import { h } from "../../dom.js";
import { avatar } from "../components/avatar.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import {
  INVITE_ACTIONS,
  SKIP,
  actionKind,
  applyToUnmatched,
  chooseAction,
  filterPeople,
  peopleCounts,
  userChoices,
} from "./plan-model.js";

const PAGE = 100;
const number = (value) => value.toLocaleString("en-US");
const FILTERS = Object.freeze([
  { value: "all", label: "Everyone" },
  { value: "match", label: "Matched" },
  { value: "invite", label: "To invite" },
  { value: "skip", label: "Skipped" },
]);
const NOTES = Object.freeze({
  "invite:guest": "Guests only get access to Shareable boards.",
  "invite:viewer": "Viewers can view boards but not edit them.",
});

function noteText(user, action) {
  if (Object.hasOwn(NOTES, action)) return NOTES[action];
  if (action === user.proposal && actionKind(action) === "match") {
    return "Matched by email";
  }
  if (user.note) return user.note;
  if (!user.email) return "No email in the source";
  return actionKind(action) === SKIP ? "No Worklane user with this email" : "";
}

function actionSelect(t, user) {
  const current = t.selection.users.get(user.source_id) ?? SKIP;
  const note = h("span", { class: "import-person-note" });
  const draw = (action) => (note.textContent = noteText(user, action));
  const groups = userChoices(user, t.people).map((group) => {
    const options = group.options.map((option) =>
      h(
        "option",
        {
          value: option.value,
          disabled: option.disabled ?? false,
          title: option.title ?? null,
        },
        option.label,
      ),
    );
    return group.label
      ? h("optgroup", { label: group.label }, options)
      : options;
  });
  const select = h(
    "select",
    {
      class: "input input-small import-person-action",
      "aria-label": `Action for ${user.name}`,
      value: current,
      dataset: { sourceId: user.source_id },
      on: {
        change: (event) => {
          const action = event.currentTarget.value;
          chooseAction(t.selection, user.source_id, action);
          draw(action);
          t.changed();
        },
      },
    },
    groups,
  );
  draw(current);
  return { select, note };
}

function personRow(t, user) {
  const { select, note } = actionSelect(t, user);
  return h(
    "tr",
    { class: "import-person" },
    h(
      "th",
      { scope: "row", class: "admin-sticky" },
      h(
        "span",
        { class: "admin-person compact" },
        avatar({ name: user.name }, { size: "sm", title: null }),
        h(
          "span",
          null,
          h("span", { class: "admin-person-name" }, user.name),
          // Shown instead of the Email column on narrow screens.
          h(
            "span",
            { class: "import-person-email-inline" },
            user.email ?? "No email",
          ),
        ),
      ),
    ),
    h(
      "td",
      { class: ["import-person-email", !user.email && "admin-muted"] },
      user.email ?? "No email",
    ),
    h("td", null, select),
    h("td", { class: "import-person-note-cell" }, note),
  );
}

function drawRows(t) {
  const shown = filterPeople(t.preview, t.selection, t.filter);
  const visible = t.showAll ? shown : shown.slice(0, PAGE);
  const rows = visible.map((user) => personRow(t, user));
  if (rows.length === 0) {
    const cell = { colspan: "4", class: "admin-empty-row" };
    rows.push(h("tr", null, h("td", cell, "No one matches.")));
  }
  t.body.replaceChildren(...rows);
  const total = t.preview.users.length;
  t.status.textContent =
    shown.length === total
      ? `${number(total)} ${total === 1 ? "person" : "people"}`
      : `Showing ${number(shown.length)} of ${number(total)} people`;
  t.more.hidden = t.showAll || shown.length <= PAGE;
  t.more.querySelector(".btn-label").textContent =
    `Show all ${number(shown.length)}`;
}

function drawCounts(t) {
  const counts = peopleCounts(t.preview, t.selection);
  t.counts.textContent = `${number(counts.match)} matched · ${number(counts.invite)} to invite · ${number(counts.skip)} skipped`;
}

function toolbar(t) {
  const search = h("input", {
    class: "input input-small",
    type: "search",
    placeholder: "Search people",
    "aria-label": "Search people by name or email",
    autocomplete: "off",
    on: {
      input: (event) => {
        t.filter.query = event.currentTarget.value;
        drawRows(t);
      },
    },
  });
  const show = h(
    "select",
    {
      class: "input input-small",
      "aria-label": "Show people",
      on: {
        change: (event) => {
          t.filter.show = event.currentTarget.value;
          drawRows(t);
        },
      },
    },
    FILTERS.map((option) => h("option", { value: option.value }, option.label)),
  );
  return h(
    "div",
    { class: "import-people-tools" },
    h("label", { class: "admin-search" }, icon("search", { size: 14 }), search),
    show,
  );
}

const people = (n) => `${number(n)} ${n === 1 ? "person" : "people"}`;

function bulkText({ changed, kept }) {
  const done =
    changed === 0 ? "Nothing changed." : `${people(changed)} updated.`;
  if (kept === 0) return done;
  const verb = kept === 1 ? "was" : "were";
  return `${done} ${people(kept)} you set by hand ${verb} kept.`;
}

function bulkControl(t) {
  const id = "import-people-bulk";
  const select = h(
    "select",
    { id, class: "input input-small" },
    INVITE_ACTIONS.map((option) =>
      h("option", { value: option.value }, option.label),
    ),
    h("option", { value: SKIP }, "Skip"),
  );
  return h(
    "div",
    { class: "import-people-bulk" },
    h("label", { class: "field-hint", for: id }, "Everyone not matched:"),
    select,
    button({
      label: "Apply",
      size: "sm",
      onClick: () => {
        const result = applyToUnmatched(t.selection, t.preview, select.value);
        t.bulkStatus.textContent = bulkText(result);
        drawRows(t);
        t.changed();
      },
    }),
    t.bulkStatus,
  );
}

/** Builds the table (see the module comment). */
export function peopleTable({ preview, selection, people, onChange }) {
  const t = {
    preview,
    selection,
    people,
    filter: { query: "", show: "all" },
    showAll: false,
  };
  t.counts = h("span", { class: "import-people-counts" });
  t.status = h("span", { class: "import-people-status", role: "status" });
  t.bulkStatus = h("span", {
    class: "import-people-bulk-status",
    role: "status",
  });
  t.body = h("tbody");
  t.more = button({
    label: "Show all",
    size: "sm",
    variant: "ghost",
    onClick: () => {
      t.showAll = true;
      drawRows(t);
    },
  });
  t.changed = () => {
    drawCounts(t);
    onChange();
  };
  if (preview.users.length === 0) {
    return {
      element: h("p", { class: "muted" }, "The source lists no people."),
      counts: t.counts,
    };
  }
  const element = h(
    "div",
    { class: "import-people" },
    h("div", { class: "import-people-bar" }, toolbar(t), bulkControl(t)),
    h(
      "div",
      { class: "admin-table-scroll import-people-scroll" },
      h(
        "table",
        {
          class: "admin-table import-people-table",
          "aria-label": "People",
        },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { scope: "col", class: "admin-sticky" }, "Person"),
            h("th", { scope: "col" }, "Email"),
            h("th", { scope: "col" }, "Action"),
            h("th", { scope: "col" }, "Note"),
          ),
        ),
        t.body,
      ),
    ),
    h("div", { class: "import-people-foot" }, t.status, t.more),
  );
  drawRows(t);
  drawCounts(t);
  return { element, counts: t.counts };
}
