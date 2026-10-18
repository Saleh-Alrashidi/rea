/**
 * Home (`#/home`): a greeting, quick-create tiles, a "My work" preview
 * (next due items), unread notifications, recent boards and docs and a
 * "Shared with me" preview. Every list comes from access-filtered queries.
 */

import { h } from "../dom.js";
import {
  boardHash,
  docHash,
  hashFromUrl,
  itemHash,
  myWorkHash,
  sharedHash,
} from "../router.js";
import { avatar } from "../ui/components/avatar.js";
import { docVisibilityBadge } from "../ui/components/badge.js";
import { emptyState } from "../ui/components/empty-state.js";
import { greeting, timeAgo } from "../ui/components/format.js";
import { icon } from "../ui/components/icon.js";
import { boardKind, resourceKind } from "../ui/components/labels.js";
import { setDocumentTitle } from "../ui/components/page-header.js";
import { can } from "../ui/components/permissions.js";
import { skeletonList } from "../ui/components/skeleton.js";
import { loadMyWork } from "../ui/board/my-work-data.js";
import { dueChip, statusChip } from "../ui/board/work-chips.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { createFlows } from "../ui/shell/create.js";
import { byRecency } from "../ui/shell/recent.js";

export const HOME_QUERY = `query HomePage {
  notifications(unread_only: true, limit: 5) {
    id kind text url read created_at
    actor { id name initials color }
  }
  shared_with_me { kind id title subtitle url }
  docs { id title visibility updated_at workspace { id name } }
  boards(limit: 100) { id name board_kind workspace { id name } }
}`;

const PREVIEW = 5;

function card({ title, iconName, link, body, className }) {
  const id = `home-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return h(
    "section",
    { class: ["panel", "home-card", className], "aria-labelledby": id },
    h(
      "header",
      { class: "panel-header" },
      h(
        "h2",
        { class: "panel-title", id },
        icon(iconName),
        h("span", null, title),
      ),
      link
        ? h(
            "a",
            { class: "panel-link", href: link.href },
            link.label,
            icon("arrowRight", { size: 14 }),
          )
        : null,
    ),
    body,
  );
}

function quickTiles(ctx, flows) {
  const create = can(ctx.me, "create_content");
  const tiles = [
    create && {
      label: "New board",
      text: "Plan work in a table or kanban",
      iconName: "grid",
      run: () => flows.board(),
    },
    create && {
      label: "New doc",
      text: "Write a spec, brief or agenda",
      iconName: "docs",
      run: () => flows.doc(),
    },
    can(ctx.me, "create_note") && {
      label: "New note",
      text: "Capture a private thought",
      iconName: "notes",
      run: () => flows.note(),
    },
    create && {
      label: "New form",
      text: "Collect requests into a board",
      iconName: "forms",
      run: () => flows.form(),
    },
  ].filter(Boolean);
  return h(
    "div",
    { class: "quick-tiles", role: "group", "aria-label": "Create" },
    tiles.map((tile) =>
      h(
        "button",
        { type: "button", class: "quick-tile", on: { click: tile.run } },
        h(
          "span",
          { class: "quick-tile-icon" },
          icon(tile.iconName, { size: 20 }),
        ),
        h(
          "span",
          { class: "quick-tile-text" },
          h("span", { class: "quick-tile-label" }, tile.label),
          h("span", { class: "quick-tile-hint" }, tile.text),
        ),
        icon("plus", { className: "quick-tile-plus" }),
      ),
    ),
  );
}

function workPreview(items) {
  // The next due items: finished ones are left out.
  const upcoming = items.filter((item) => !item.done).slice(0, PREVIEW);
  if (upcoming.length === 0) {
    return emptyState({
      icon: "myWork",
      title:
        items.length === 0
          ? "Nothing assigned to you"
          : "Everything assigned to you is done",
      text: "Items you’re added to appear here.",
      compact: true,
    });
  }
  return h(
    "ul",
    { class: "preview-list" },
    upcoming.map((item) =>
      h(
        "li",
        { class: "preview-row" },
        h(
          "a",
          { class: "preview-main", href: itemHash(item.boardId, item.id) },
          h("span", { class: "preview-title" }, item.name),
          h("span", { class: "preview-subtitle" }, item.boardName),
        ),
        statusChip(item),
        dueChip(item),
      ),
    ),
  );
}

function notificationPreview(notifications, ctx) {
  if (notifications.length === 0) {
    return emptyState({
      icon: "inbox",
      title: "You’re all caught up",
      text: "No unread notifications.",
      compact: true,
    });
  }
  return h(
    "ul",
    { class: "preview-list" },
    notifications.map((notification) => {
      const hash = hashFromUrl(notification.url);
      return h(
        "li",
        { class: "preview-row" },
        notification.actor
          ? avatar(notification.actor, { size: "sm" })
          : h("span", { class: "preview-icon" }, icon("bell", { size: 14 })),
        h(
          hash ? "a" : "div",
          {
            class: "preview-main",
            href: hash ?? null,
            // Opening it from Home reads it, as the bell does.
            on: hash
              ? { click: () => ctx.markNotificationRead(notification) }
              : null,
          },
          h("span", { class: "preview-title wrap" }, notification.text),
          h(
            "span",
            { class: "preview-subtitle" },
            timeAgo(notification.created_at),
          ),
        ),
      );
    }),
  );
}

/**
 * Every board the user can open: `boards` also lists boards reached only
 * through a grant (a guest's Shareable board, a private board in a closed
 * workspace), which the user's workspaces do not contain.
 */
function boardTiles(ctx, list) {
  const boards = list.map((board) => ({
    ...board,
    id: String(board.id),
    workspaceName: board.workspace.name,
  }));
  const recent = byRecency(ctx.me.id, "board", boards).slice(0, 6);
  if (recent.length === 0) {
    return emptyState({
      icon: "grid",
      title: "No boards yet",
      text: "Boards you can open appear here.",
      compact: true,
    });
  }
  return h(
    "ul",
    { class: "tile-grid" },
    recent.map((board) =>
      h(
        "li",
        null,
        h(
          "a",
          { class: "board-tile", href: boardHash(board.id) },
          h(
            "span",
            { class: "board-tile-icon" },
            icon(boardKind(board.board_kind).icon, { size: 18 }),
          ),
          h("span", { class: "board-tile-name" }, board.name),
          h(
            "span",
            { class: "board-tile-meta" },
            `${boardKind(board.board_kind).label} · ${board.workspaceName}`,
          ),
        ),
      ),
    ),
  );
}

function docList(ctx, docs) {
  const sorted = [...docs].sort((a, b) =>
    String(b.updated_at).localeCompare(String(a.updated_at)),
  );
  const recent = byRecency(ctx.me.id, "doc", sorted).slice(0, PREVIEW);
  if (recent.length === 0) {
    return emptyState({
      icon: "docs",
      title: "No docs yet",
      text: "Docs you can read appear here.",
      compact: true,
    });
  }
  return h(
    "ul",
    { class: "preview-list" },
    recent.map((doc) =>
      h(
        "li",
        { class: "preview-row" },
        h("span", { class: "preview-icon" }, icon("docs", { size: 14 })),
        h(
          "a",
          { class: "preview-main", href: docHash(doc.id) },
          h("span", { class: "preview-title" }, doc.title),
          h(
            "span",
            { class: "preview-subtitle" },
            `${doc.workspace?.name ?? ""} · edited ${timeAgo(doc.updated_at)}`,
          ),
        ),
        docVisibilityBadge(doc.visibility),
      ),
    ),
  );
}

function sharedPreview(shared) {
  const entries = shared
    .map((entry) => ({ ...entry, hash: hashFromUrl(entry.url) }))
    .filter((entry) => entry.hash);
  if (entries.length === 0) {
    return emptyState({
      icon: "shared",
      title: "Nothing shared with you yet",
      text: "Boards, docs and notes others share with you appear here.",
      compact: true,
    });
  }
  return h(
    "ul",
    { class: "tile-grid" },
    entries
      .slice(0, 4)
      .map((entry) =>
        h(
          "li",
          null,
          h(
            "a",
            { class: "board-tile", href: entry.hash },
            h(
              "span",
              { class: "board-tile-icon" },
              icon(resourceKind(entry.kind).icon, { size: 18 }),
            ),
            h("span", { class: "board-tile-name" }, entry.title),
            h(
              "span",
              { class: "board-tile-meta" },
              entry.subtitle ?? resourceKind(entry.kind).label,
            ),
          ),
        ),
      ),
  );
}

function hero(ctx) {
  const firstName = String(ctx.me.name ?? "").split(/\s+/)[0];
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return h(
    "header",
    { class: "home-hero" },
    h("p", { class: "page-eyebrow" }, today),
    h(
      "h1",
      { class: "page-title home-greeting" },
      `${greeting()}, ${firstName}`,
    ),
    h(
      "p",
      { class: "page-subtitle" },
      "Here’s what needs your attention across Worklane.",
    ),
  );
}

function renderHome(slots, ctx, { data, work }) {
  slots.work.replaceChildren(workPreview(work));
  slots.notifications.replaceChildren(
    notificationPreview(data.notifications, ctx),
  );
  slots.boards.replaceChildren(boardTiles(ctx, data.boards));
  slots.docs.replaceChildren(docList(ctx, data.docs));
  slots.shared.replaceChildren(sharedPreview(data.shared_with_me));
}

/** Page contract. */
export async function mount(container, ctx) {
  setDocumentTitle("Home");
  const flows = createFlows(ctx);
  const loading = (label) =>
    h("div", { class: "panel-body" }, skeletonList({ rows: 3, label }));
  const slots = {
    work: loading("Loading your work"),
    notifications: loading("Loading notifications"),
    boards: loading("Loading boards"),
    docs: loading("Loading docs"),
    shared: loading("Loading shared items"),
  };
  container.append(
    h(
      "div",
      { class: "page-container home" },
      hero(ctx),
      quickTiles(ctx, flows),
      h(
        "div",
        { class: "home-grid" },
        card({
          title: "My work",
          iconName: "myWork",
          link: { label: "View all", href: myWorkHash() },
          body: slots.work,
          className: "home-work",
        }),
        card({
          title: "Unread notifications",
          iconName: "bell",
          body: slots.notifications,
        }),
        card({ title: "Recent boards", iconName: "grid", body: slots.boards }),
        card({ title: "Recent docs", iconName: "docs", body: slots.docs }),
        card({
          title: "Shared with me",
          iconName: "shared",
          link: { label: "View all", href: sharedHash() },
          body: slots.shared,
          className: "home-shared",
        }),
      ),
    ),
  );
  let active = true;
  async function reload() {
    try {
      const [data, work] = await Promise.all([
        ctx.api.request(HOME_QUERY),
        loadMyWork({ limit: 20 }),
      ]);
      if (active) renderHome(slots, ctx, { data, work });
    } catch (error) {
      if (!active) return;
      slots.work.replaceChildren(
        emptyState({
          icon: "alert",
          title: "Couldn’t load Home",
          text: error.message,
          compact: true,
          action: { label: "Try again", onClick: reload },
        }),
      );
    }
  }
  const offs = [
    ctx.bus.on(BUS_EVENTS.notification, reload),
    ctx.bus.on(BUS_EVENTS.shell, reload),
  ];
  reload();
  return () => {
    active = false;
    for (const off of offs) off();
  };
}
