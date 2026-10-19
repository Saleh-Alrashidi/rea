/**
 * One monday-style update card of the Updates pane (SPEC-6 §2.3) and its
 * replies.
 *
 * - Header: the author's avatar and name (an imported author: initials
 *   on a neutral color and the source tag), the relative time with the
 *   full date as its title, "(edited)" and a "…" menu: Edit (the author),
 *   Pin to top / Unpin (editors, top-level only), Copy link (everyone) and
 *   Delete (the author or a board owner, after a confirmation).
 * - Body: `update-body.js` (body_parts only), or the edit box (a composer
 *   holding the body's text and mentions, Save / Cancel).
 * - Footer: Like (a toggle with its count; hovering or focusing the count
 *   lists the likers) and Reply, which opens a reply composer under the
 *   card. Viewers see the count and the menu's Copy link only.
 * - Replies: indented and smaller, oldest first, with Like and the menu;
 *   only the newest SHOWN_REPLIES show until "Show N more replies", which
 *   loads the thread whole ("Loading replies…" meanwhile).
 *
 * What the card shows besides the data (the edit box, open reply boxes,
 * the highlighted update) is the pane's `ui` state, so a live refresh
 * redraws it as it was; threads shown whole are the updates state's
 * `threads` (`updates-data.js`), which refreshes keep whole.
 */

import { h } from "../../dom.js";
import { updateHash } from "../../router.js";
import { avatar } from "../components/avatar.js";
import { formatTime, plural, timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { menuButton } from "../components/menu.js";
import { showToast } from "../components/toast.js";
import { decodeBody } from "./mention-tokens.js";
import { updateBody } from "./update-body.js";
import { updateComposer } from "./update-composer.js";
import {
  isPending,
  likersText,
  replyWindow,
  updateAuthor,
} from "./updates-model.js";

/** Initials on a neutral gray (white text at 4.8:1) for source authors. */
const SOURCE_AUTHOR_COLOR = "#6b7280";

/** The DOM ID of an update's element (the route scrolls to it). */
export const updateElementId = (id) => `update-${id}`;

function authorAvatar(cx, author, size) {
  if (author.user) {
    const user = cx.props.users?.get(String(author.user.id)) ?? author.user;
    return avatar(user, { size });
  }
  return avatar({ name: author.name, color: SOURCE_AUTHOR_COLOR }, { size });
}

function timeLine(update) {
  return [
    h(
      "time",
      {
        class: "update-time",
        datetime: update.createdAt,
        title: formatTime(update.createdAt) || null,
      },
      timeAgo(update.createdAt),
    ),
    update.editedAt
      ? h(
          "span",
          {
            class: "update-edited",
            title: `Edited ${formatTime(update.editedAt)}`,
          },
          "(edited)",
        )
      : null,
  ];
}

async function copyLink(cx, update) {
  const { board, item } = cx.props;
  const hash = updateHash(board.id, item.id, update.id);
  const url = new URL(hash, `${globalThis.location.origin}/`).href;
  try {
    await globalThis.navigator.clipboard.writeText(url);
    showToast({ message: "Link copied", type: "success" });
  } catch {
    showToast({ message: url, type: "info", timeout: 15_000 });
  }
}

function startEdit(cx, update) {
  cx.ui.editing = update.id;
  cx.ui.composers.delete(`edit:${update.id}`);
  cx.props.repaint();
  cx.props.focusIn(`composer:edit:${update.id}`, { caretAtEnd: true });
}

/**
 * The "…" menu's items for `update` (`parent`: a reply's update; null
 * for a top-level one). Exported for tests.
 */
export function updateMenuItems(cx, update, parent) {
  const { caps, actions, item } = cx.props;
  const pinnable = caps.edit && !parent;
  return [
    update.canEdit
      ? { label: "Edit", icon: "edit", onSelect: () => startEdit(cx, update) }
      : null,
    pinnable
      ? {
          label: update.pinned ? "Unpin" : "Pin to top",
          icon: "pin",
          onSelect: () => actions.pinUpdate(item, update),
        }
      : null,
    { label: "Copy link", icon: "link", onSelect: () => copyLink(cx, update) },
    update.canDelete ? { type: "separator" } : null,
    update.canDelete
      ? {
          label: "Delete",
          icon: "trash",
          danger: true,
          onSelect: () => actions.deleteUpdate(update),
        }
      : null,
  ];
}

function updateMenu(cx, update, parent) {
  if (isPending(update.id)) return null;
  return menuButton({
    icon: "more",
    label: parent ? "Reply actions" : "Update actions",
    size: "sm",
    className: "update-menu",
    dataset: { focusKey: `update-menu:${update.id}` },
    items: () => updateMenuItems(cx, update, parent),
  });
}

function header(cx, update, parent) {
  const author = updateAuthor(update, cx.props.board.import?.source);
  return h(
    "header",
    { class: "update-header" },
    // A reply's avatar sits beside its bubble (`replyEntry`).
    parent ? null : authorAvatar(cx, author, "md"),
    h(
      "div",
      { class: "update-who" },
      h("span", { class: "update-author", dir: "auto" }, author.name),
      author.tag ? h("span", { class: "update-source" }, author.tag) : null,
    ),
    h(
      "span",
      { class: "update-when" },
      icon("clock", { size: 12 }),
      timeLine(update),
    ),
    updateMenu(cx, update, parent),
  );
}

/** The like count, listing the likers on hover and focus. */
function likeCount(cx, update) {
  const text = likersText(update, cx.props.me?.id);
  if (!text) return null;
  const tipId = `update-likers-${update.id}`;
  return h(
    "span",
    { class: "update-likes" },
    h(
      "span",
      {
        class: "update-like-count",
        tabindex: "0",
        "aria-label": text,
        "aria-describedby": tipId,
        dataset: { focusKey: `update-likes:${update.id}` },
      },
      icon("like", { size: 12 }),
      String(update.likesCount),
    ),
    h("span", { class: "update-likers", id: tipId, role: "tooltip" }, text),
  );
}

function likeButton(cx, update) {
  const pending = isPending(update.id);
  return h(
    "button",
    {
      type: "button",
      class: ["update-action", "update-like", update.likedByMe && "liked"],
      "aria-pressed": update.likedByMe ? "true" : "false",
      disabled: pending,
      dataset: { focusKey: `update-like:${update.id}` },
      on: { click: () => cx.props.actions.likeUpdate(update) },
    },
    icon("like", { size: 14 }),
    h("span", null, update.likedByMe ? "Liked" : "Like"),
  );
}

function openReply(cx, update) {
  cx.ui.replying.add(update.id);
  cx.props.repaint();
  cx.props.focusIn(`composer:reply:${update.id}`, { caretAtEnd: true });
}

/** Who liked a top-level update, above its footer (when anyone did). */
function likesRow(cx, update) {
  const count = likeCount(cx, update);
  return count ? h("div", { class: "update-likes-row" }, count) : null;
}

/** Like and Reply, side by side (editors only). */
function footer(cx, update) {
  if (!cx.props.caps.edit) return null;
  return h(
    "div",
    { class: "update-footer" },
    likeButton(cx, update),
    h(
      "button",
      {
        type: "button",
        class: "update-action update-reply-button",
        disabled: isPending(update.id),
        dataset: { focusKey: `update-reply:${update.id}` },
        on: { click: () => openReply(cx, update) },
      },
      icon("reply", { size: 14 }),
      h("span", null, "Reply"),
    ),
  );
}

function editBox(cx, update) {
  const key = `edit:${update.id}`;
  const close = () => {
    cx.ui.editing = null;
    cx.ui.composers.delete(key);
    cx.props.repaint();
    cx.props.focusIn(`update-menu:${update.id}`);
  };
  return updateComposer({
    key,
    store: cx.ui.composers,
    initial: () => decodeBody(update.body),
    placeholder: "Edit your update…",
    label: "Edit update",
    submitLabel: "Save",
    hint: "Ctrl + Enter to save · Esc to cancel",
    className: "update-edit",
    sources: cx.sources,
    onCancel: close,
    async onSubmit(draft) {
      cx.ui.editing = null;
      const saved = await cx.props.actions.editUpdate(update, draft);
      if (!saved) cx.ui.editing = update.id;
      else cx.ui.composers.delete(key);
      return saved;
    },
    onRestore: () => cx.props.repaint(),
  });
}

function bodyOf(cx, update) {
  if (cx.ui.editing === update.id) return editBox(cx, update);
  return updateBody(update.parts, { users: cx.props.users });
}

function replyEntry(cx, parent, reply) {
  const author = updateAuthor(reply, cx.props.board.import?.source);
  const actions = [
    cx.props.caps.edit ? likeButton(cx, reply) : null,
    likeCount(cx, reply),
  ].filter(Boolean);
  return h(
    "li",
    {
      class: ["update-reply", ...stateClasses(cx, reply)],
      id: updateElementId(reply.id),
      tabindex: "-1",
      dataset: { updateId: reply.id, focusKey: `update:${reply.id}` },
    },
    authorAvatar(cx, author, "sm"),
    h(
      "div",
      { class: "update-reply-main" },
      h(
        "div",
        { class: "update-reply-bubble" },
        header(cx, reply, parent),
        bodyOf(cx, reply),
      ),
      actions.length > 0
        ? h("div", { class: "update-reply-actions" }, actions)
        : null,
    ),
  );
}

function replyComposer(cx, update) {
  const key = `reply:${update.id}`;
  const close = () => {
    cx.ui.replying.delete(update.id);
    cx.ui.composers.delete(key);
    cx.props.repaint();
    cx.props.focusIn(`update-reply:${update.id}`);
  };
  return updateComposer({
    key,
    store: cx.ui.composers,
    placeholder: "Write a reply…",
    label: `Reply to ${updateAuthor(update, cx.props.board.import?.source).name}`,
    submitLabel: "Reply",
    hint: "Ctrl + Enter to reply",
    className: "update-reply-composer",
    sources: cx.sources,
    onCancel: close,
    onSubmit: (draft) =>
      cx.props.actions.replyToUpdate(cx.props.item, update, draft),
    onRestore: () => cx.props.repaint(),
  });
}

/** "Show N more replies" ("Loading replies…" while the thread loads). */
function moreReplies(cx, update, hidden) {
  const loading = cx.props.updates?.loadingThreads?.has(update.id) ?? false;
  return h(
    "button",
    {
      type: "button",
      class: "update-more-replies",
      disabled: loading,
      "aria-busy": loading ? "true" : null,
      dataset: { focusKey: `update-more:${update.id}` },
      on: { click: () => cx.props.actions.showMoreReplies(update) },
    },
    loading
      ? "Loading replies…"
      : `Show ${plural(hidden, "more reply", "more replies")}`,
  );
}

function replies(cx, update) {
  const expanded = cx.props.updates?.threads?.has(update.id) ?? false;
  const { shown, hidden } = replyWindow(update, expanded);
  const replying = cx.props.caps.edit && cx.ui.replying.has(update.id);
  if (shown.length === 0 && hidden === 0 && !replying) return null;
  return h(
    "div",
    { class: "update-replies" },
    hidden > 0 ? moreReplies(cx, update, hidden) : null,
    shown.length > 0
      ? h(
          "ol",
          { class: "update-reply-list", "aria-label": "Replies" },
          shown.map((reply) => replyEntry(cx, update, reply)),
        )
      : null,
    replying ? replyComposer(cx, update) : null,
  );
}

function stateClasses(cx, update) {
  const highlight = cx.ui.highlight;
  const lit = highlight?.id === update.id && Date.now() < highlight.until;
  return [update.pending && "pending", lit && "highlight"];
}

/**
 * The card of top-level `update` (an `<li>`). `cx`: `{ props, ui,
 * sources }` (task view props, the pane's ui state, the composers'
 * mention sources).
 */
export function updateCard(cx, update) {
  return h(
    "li",
    {
      class: [
        "update-card",
        update.pinned && "pinned",
        ...stateClasses(cx, update),
      ],
      id: updateElementId(update.id),
      tabindex: "-1",
      dataset: { updateId: update.id, focusKey: `update:${update.id}` },
    },
    update.pinned
      ? h(
          "div",
          { class: "update-pinned" },
          icon("pin", { size: 12 }),
          "Pinned to top",
        )
      : null,
    header(cx, update, null),
    bodyOf(cx, update),
    likesRow(cx, update),
    footer(cx, update),
    replies(cx, update),
  );
}
