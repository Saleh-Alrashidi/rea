/**
 * Notifications: the top-bar bell with the unread count and a dropdown
 * list (newest first) with two filters, All and Mentions
 * (`notifications(kinds: [mention])`, SPEC-6 §2.2). Each entry shows the
 * actor's avatar with its kind's icon (a mention "@", a reply, a like…).
 * Clicking an entry marks it read and opens its link (an update's link
 * opens the task view at that update); "Mark all read" clears the count.
 * New notifications arrive over the user's event stream
 * (`onNotification`), which refreshes the count and an open list.
 */

import { request } from "../../api.js";
import { h } from "../../dom.js";
import { hashFromUrl } from "../../router.js";
import { avatar } from "../components/avatar.js";
import { countBadge } from "../components/badge.js";
import { emptyState } from "../components/empty-state.js";
import { timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { notificationKind } from "../components/labels.js";
import { openPopover } from "../components/popover.js";
import { skeletonList } from "../components/skeleton.js";
import { tabs } from "../components/tabs.js";

export const NOTIFICATIONS_QUERY = `query ShellNotifications($kinds: [NotificationKind!]) {
  notifications(limit: 20, kinds: $kinds) {
    id kind text url read created_at
    actor { id name initials color }
  }
  unread_notifications_count
}`;
/** The list's filters: which kinds each one asks for (null: all). */
const FILTERS = Object.freeze({
  all: { label: "All", kinds: null },
  mentions: { label: "Mentions", kinds: ["mention"] },
});
export const UNREAD_COUNT_QUERY = `query ShellUnreadCount { unread_notifications_count }`;
export const MARK_READ_MUTATION = `mutation MarkNotificationsRead($ids: [ID!], $all: Boolean) {
  mark_notifications_read(ids: $ids, all: $all)
}`;

function unreadLabel(count) {
  if (count === 0) return "Notifications";
  return `Notifications, ${count} unread`;
}

/** The actor's avatar with the kind's icon on it, or the icon alone. */
function entryIcon(notification, kind) {
  const glyph = h(
    "span",
    { class: ["notification-icon", `notification-${notification.kind}`] },
    icon(kind.icon, { size: notification.actor ? 10 : 14 }),
  );
  if (!notification.actor) return glyph;
  return h(
    "span",
    { class: "notification-avatar" },
    avatar(notification.actor, { size: "sm" }),
    glyph,
  );
}

function entry(notification, onOpen) {
  const kind = notificationKind(notification.kind);
  return h(
    "li",
    null,
    h(
      "button",
      {
        type: "button",
        class: ["notification", !notification.read && "unread"],
        on: { click: () => onOpen(notification) },
      },
      entryIcon(notification, kind),
      h(
        "span",
        { class: "notification-body" },
        h("span", { class: "notification-text" }, notification.text),
        h(
          "span",
          { class: "notification-meta" },
          icon(kind.icon, { size: 12 }),
          `${kind.label} · ${timeAgo(notification.created_at)}`,
        ),
      ),
      notification.read
        ? null
        : h(
            "span",
            { class: "unread-dot" },
            h("span", { class: "visually-hidden" }, "Unread"),
          ),
    ),
  );
}

function setCount(n, count) {
  n.count = Number.isSafeInteger(count) && count > 0 ? count : 0;
  n.badge.hidden = n.count === 0;
  n.badge.textContent = n.count > 99 ? "99+" : String(n.count);
  n.button.setAttribute("aria-label", unreadLabel(n.count));
}

async function load(n) {
  n.seq += 1;
  const seq = n.seq;
  try {
    const { kinds } = FILTERS[n.filter];
    const data = await request(NOTIFICATIONS_QUERY, { kinds });
    if (seq !== n.seq) return;
    n.items = data.notifications;
    n.error = false;
    setCount(n, data.unread_notifications_count);
  } catch {
    if (seq !== n.seq) return;
    n.error = true;
  }
  n.popover?.update();
}

/** Shows the list of `filter` ("all" or "mentions"). */
function setFilter(n, filter) {
  if (!Object.hasOwn(FILTERS, filter) || n.filter === filter) return;
  n.filter = filter;
  n.items = null;
  n.popover?.update();
  load(n);
}

async function markRead(n, variables) {
  try {
    const data = await request(MARK_READ_MUTATION, variables);
    return Number.isSafeInteger(data.mark_notifications_read);
  } catch (error) {
    n.toast.error(error, "Couldn’t update notifications");
    return false;
  }
}

/** Marks a notification read once it is opened (here or from Home). */
function markOpened(n, notification) {
  if (notification.read) return;
  notification.read = true;
  setCount(n, n.count - 1);
  markRead(n, { ids: [notification.id] });
}

function openNotification(n, notification) {
  n.popover?.close();
  markOpened(n, notification);
  const hash = hashFromUrl(notification.url);
  if (hash) n.router.navigate(hash);
}

async function markAllRead(n) {
  for (const item of n.items ?? []) item.read = true;
  setCount(n, 0);
  n.popover?.update();
  if (!(await markRead(n, { all: true }))) load(n);
}

function listContent(n) {
  if (n.error) {
    return emptyState({
      icon: "alert",
      title: "Couldn’t load notifications",
      compact: true,
      action: { label: "Try again", onClick: () => load(n) },
    });
  }
  if (!n.items)
    return skeletonList({ rows: 3, label: "Loading notifications" });
  if (n.items.length === 0) {
    return n.filter === "mentions"
      ? emptyState({
          icon: "at",
          title: "No mentions yet",
          text: "When someone @mentions you in an update, it shows up here.",
          compact: true,
        })
      : emptyState({
          icon: "inbox",
          title: "You’re all caught up",
          text: "New shares, assignments, mentions and replies appear here.",
          compact: true,
        });
  }
  return h(
    "ul",
    { class: "notification-list" },
    n.items.map((item) => entry(item, (picked) => openNotification(n, picked))),
  );
}

function panel(n) {
  return h(
    "div",
    { class: "notifications-panel" },
    h(
      "div",
      { class: "panel-header" },
      h("h2", { class: "panel-title" }, "Notifications"),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost btn-sm",
          disabled: n.count === 0,
          on: { click: () => markAllRead(n) },
        },
        icon("check"),
        h("span", null, "Mark all read"),
      ),
    ),
    tabs({
      label: "Show",
      className: "notifications-filter",
      items: Object.entries(FILTERS).map(([id, filter]) => ({
        id,
        label: filter.label,
        icon: id === "mentions" ? "at" : null,
        focusKey: `notifications-filter:${id}`,
      })),
      active: n.filter,
      onSelect: (id) => setFilter(n, id),
    }),
    listContent(n),
  );
}

function toggle(n) {
  n.popover = openPopover({
    anchor: n.button,
    label: "Notifications",
    content: () => panel(n),
    placement: "bottom-end",
    className: "notifications-popover",
    onClose: () => (n.popover = null),
  });
  if (n.popover) load(n);
}

async function onNotification(n, event) {
  if (typeof event?.text === "string" && event.text) {
    n.toast.show({ message: event.text, type: "info" });
  }
  try {
    const data = await request(UNREAD_COUNT_QUERY);
    setCount(n, data.unread_notifications_count);
  } catch {
    setCount(n, n.count + 1);
  }
  if (n.popover) load(n);
}

/**
 * Creates the bell. `router` navigates; `toast` reports failures.
 * @param {{ router: object, toast: object }} options
 * @returns {{ element: HTMLElement, setCount(count: number): void,
 *   refresh(): Promise<void>, onNotification(event: object): void,
 *   markOpened(notification: object): void }}
 */
export function createNotifications({ router, toast }) {
  const n = {
    router,
    toast,
    count: 0,
    items: null,
    error: false,
    popover: null,
    filter: "all",
    seq: 0,
  };
  n.badge = countBadge(0);
  n.button = h(
    "button",
    {
      type: "button",
      class: "icon-btn topbar-btn notifications-btn",
      "aria-label": unreadLabel(0),
      title: "Notifications",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      on: { click: () => toggle(n) },
    },
    icon("bell", { size: 18 }),
    n.badge,
  );
  return {
    element: n.button,
    setCount: (count) => setCount(n, count),
    refresh: () => load(n),
    onNotification: (event) => onNotification(n, event),
    markOpened: (notification) => markOpened(n, notification),
  };
}
