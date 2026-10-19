/**
 * The task view's Subtasks section (SPEC-5 §4.2): a heading with
 * "done/total" and a thin progress bar, one row per direct subtask (its
 * status circle, its name opening its own task view, assignee avatars and
 * due date) and, for editors, an "Add subtask" input (`create_subitem`).
 * Subtasks come from the loaded board, as in the List view.
 */

import { h } from "../../dom.js";
import { itemHash } from "../../router.js";
import { formatDay, plural, todayString } from "../components/format.js";
import { icon } from "../components/icon.js";
import { peopleStack } from "./cells.js";
import { statusCircle } from "./list-row.js";
import { subtasksOf } from "./task-model.js";

function progress({ done, total }) {
  const bar = h(
    "span",
    {
      class: "task-progress",
      role: "progressbar",
      "aria-label": "Subtasks done",
      "aria-valuemin": "0",
      "aria-valuemax": String(total),
      "aria-valuenow": String(done),
      "aria-valuetext": `${done} of ${total} done`,
    },
    h("span", { class: "task-progress-fill" }),
  );
  bar.style.setProperty("--progress", `${(100 * done) / total}%`);
  return [
    h(
      "span",
      { class: "task-progress-count", "aria-hidden": "true" },
      `${done}/${total}`,
    ),
    bar,
  ];
}

/** A subtask's comment count, assignees and due date (red if overdue). */
function subtaskMeta(props, { item, done }, roles) {
  const assignees = roles.assignees
    ? (item.values[roles.assignees.id] ?? [])
    : [];
  const due = roles.due_date ? (item.values[roles.due_date.id] ?? null) : null;
  const overdue = Boolean(due) && !done && due < todayString();
  const comments = item.updatesCount;
  return h(
    "span",
    { class: "task-subtask-meta" },
    comments > 0
      ? h(
          "span",
          {
            class: "task-subtask-comments",
            title: plural(comments, "comment"),
          },
          icon("chat", { size: 12 }),
          h(
            "span",
            null,
            String(comments),
            h(
              "span",
              { class: "visually-hidden" },
              comments === 1 ? " comment" : " comments",
            ),
          ),
        )
      : null,
    assignees.length > 0 ? peopleStack(assignees, props.users) : null,
    due
      ? h(
          "time",
          { class: ["task-subtask-due", overdue && "overdue"], datetime: due },
          formatDay(due),
        )
      : null,
  );
}

function subtaskRow(props, row, roles) {
  const { item, done } = row;
  return h(
    "li",
    { class: ["task-subtask", done && "done"], dataset: { itemId: item.id } },
    statusCircle(props, { item, key: `task-sub:${item.id}` }),
    h(
      "a",
      {
        class: "task-subtask-name",
        href: itemHash(props.board.id, item.id),
        dir: "auto",
        title: item.name,
        dataset: { focusKey: `task-sub-open:${item.id}` },
      },
      item.name,
    ),
    subtaskMeta(props, row, roles),
  );
}

function addSubtask(props) {
  const { item, actions } = props;
  const input = h("input", {
    class: "task-subtask-input",
    type: "text",
    maxlength: 255,
    placeholder: "Add subtask",
    dir: "auto",
    autocomplete: "off",
    "aria-label": `Add a subtask to ${item.name}`,
    dataset: { focusKey: "task-subtask-add" },
  });
  return h(
    "form",
    {
      class: "task-subtask-add",
      on: {
        submit(event) {
          event.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          input.value = "";
          actions.createSubitem({ parentId: item.id, name });
        },
      },
    },
    icon("plus", { size: 14 }),
    input,
  );
}

/**
 * The Subtasks section of `props.item`, or null for view-only users when
 * it has none.
 * @param {object} props task view props (`task-view.js`)
 * @param {object} layout `taskLayout(board.columns)`
 */
export function subtasksSection(props, layout) {
  const { board, item, detail, caps } = props;
  const { roles } = layout;
  const subtasks = subtasksOf(board, {
    item,
    status: roles.status,
    subitemsCount: detail?.subitemsCount,
  });
  const any = subtasks.total + subtasks.missing > 0;
  if (!any && !caps.edit) return null;
  const rowProps = { ...props, roles };
  return h(
    "section",
    {
      class: "task-section task-subtasks",
      "aria-labelledby": "task-subtasks-heading",
    },
    h(
      "div",
      { class: "task-section-head" },
      h(
        "h3",
        { class: "task-heading", id: "task-subtasks-heading" },
        "Subtasks",
      ),
      subtasks.total > 0 ? progress(subtasks) : null,
    ),
    subtasks.total > 0
      ? h(
          "ul",
          { class: "task-subtask-list" },
          subtasks.rows.map((row) => subtaskRow(rowProps, row, roles)),
        )
      : null,
    subtasks.missing > 0
      ? h(
          "p",
          { class: "task-note" },
          `${plural(subtasks.missing, "more subtask")} not loaded on this board.`,
        )
      : null,
    caps.edit ? addSubtask(props) : null,
  );
}
