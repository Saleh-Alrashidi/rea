/**
 * My work (`#/my-work`): items assigned to the user, grouped Overdue /
 * This week / Later / No date / Done, with board links and inline status changes
 * (read-only pills on boards the user can only view).
 */

import { h } from "../dom.js";
import { boardHash, homeHash, itemHash } from "../router.js";
import { badge } from "../ui/components/badge.js";
import { button } from "../ui/components/button.js";
import { emptyState } from "../ui/components/empty-state.js";
import { plural, todayString } from "../ui/components/format.js";
import { icon } from "../ui/components/icon.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { skeletonList } from "../ui/components/skeleton.js";
import { statusPill } from "../ui/board/cells.js";
import {
  MAX_MY_WORK,
  groupByDue,
  loadMyWork,
  setWorkStatus,
} from "../ui/board/my-work-data.js";
import { dueChip, statusChip } from "../ui/board/work-chips.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";

function statusControl(item, onChange) {
  if (!item.statusColumn) return h("span", { class: "status-chip empty" }, "—");
  if (!item.canEdit) return statusChip(item);
  return statusPill({
    column: item.statusColumn,
    value: item.status,
    label: `${item.statusColumn.title} for ${item.name}`,
    placeholder: "Set status",
    focusKey: `work-status:${item.id}`,
    onChange: (index) => onChange(item, index),
  });
}

function workRow(item, { today, onChange }) {
  return h(
    "li",
    { class: "work-row", dataset: { itemId: item.id } },
    h(
      "div",
      { class: "work-main" },
      h(
        "a",
        { class: "work-name", href: itemHash(item.boardId, item.id) },
        item.name,
      ),
      h(
        "span",
        { class: "work-context" },
        h(
          "a",
          { class: "work-board", href: boardHash(item.boardId) },
          icon("grid", { size: 12 }),
          item.boardName,
        ),
        item.group
          ? h("span", { class: "work-group-name" }, item.group.title)
          : null,
      ),
    ),
    h("div", { class: "work-status" }, statusControl(item, onChange)),
    h("div", { class: "work-due" }, dueChip(item, today)),
  );
}

function bucketSection(group, options) {
  const headingId = `work-${group.key}`;
  return h(
    "section",
    {
      class: ["panel", "work-bucket", `work-bucket-${group.key}`],
      "aria-labelledby": headingId,
    },
    h(
      "header",
      { class: "panel-header" },
      h("h2", { class: "panel-title", id: headingId }, group.label),
      badge(String(group.items.length), {
        tone: group.items.length > 0 ? group.tone : "neutral",
      }),
    ),
    group.items.length > 0
      ? h(
          "ul",
          { class: "work-list" },
          group.items.map((item) => workRow(item, options)),
        )
      : h(
          "p",
          { class: "panel-empty" },
          `Nothing ${group.key === "none" ? "without a date" : group.label.toLowerCase()}.`,
        ),
  );
}

function renderWork(body, items, options) {
  if (items.length === 0) {
    body.replaceChildren(
      emptyState({
        icon: "myWork",
        title: "Nothing is assigned to you",
        text: "When someone adds you to a People column, the item shows up here.",
        action: { label: "Go to Home", href: homeHash() },
      }),
    );
    return;
  }
  const groups = groupByDue(items, options.today).filter(
    (group) => group.items.length > 0 || !group.optional,
  );
  body.replaceChildren(
    items.length >= MAX_MY_WORK
      ? h(
          "p",
          { class: "banner banner-info" },
          icon("info", { size: 14 }),
          `Showing your first ${MAX_MY_WORK} assigned items.`,
        )
      : "",
    h(
      "div",
      { class: "work-buckets" },
      groups.map((group) => bucketSection(group, options)),
    ),
  );
}

/** Page contract. */
export async function mount(container, ctx) {
  setDocumentTitle("My work");
  const subtitle = h("span", null, "Items assigned to you across your boards");
  const body = h(
    "div",
    { class: "page-body" },
    skeletonList({ rows: 5, label: "Loading your work" }),
  );
  let active = true;
  let seq = 0;

  async function reload() {
    const mine = (seq += 1);
    let items;
    try {
      items = await loadMyWork();
    } catch (error) {
      if (!active || mine !== seq) return;
      body.replaceChildren(
        emptyState({
          icon: "alert",
          title: "Couldn’t load your work",
          text: error.message,
          action: { label: "Try again", onClick: reload },
        }),
      );
      return;
    }
    if (!active || mine !== seq) return;
    subtitle.textContent = `${plural(items.length, "item")} assigned to you across your boards`;
    renderWork(body, items, { today: todayString(), onChange: changeStatus });
  }

  async function changeStatus(item, index) {
    try {
      await setWorkStatus(item, index);
    } catch (error) {
      ctx.toast.error(error, "Couldn’t change the status");
    }
    reload();
  }

  container.append(
    h(
      "div",
      { class: "page-container" },
      pageHeader({
        title: "My work",
        icon: "myWork",
        subtitle,
        actions: [
          button({
            label: "Refresh",
            icon: "refresh",
            variant: "ghost",
            onClick: reload,
          }),
        ],
      }),
      body,
    ),
  );
  const off = ctx.bus.on(BUS_EVENTS.notification, reload);
  reload();
  return () => {
    active = false;
    off();
  };
}
