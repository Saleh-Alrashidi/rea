/**
 * Board views that own their content once mounted (instead of being rebuilt
 * from board state on every refresh): app views (an iframe wired with the
 * host bridge) and the Activity and Forms views. Also the board's status
 * messages (loading skeleton, unavailable, error).
 *
 * A mount is keyed (`<boardId>:<view>…`); drawing the same key again keeps
 * the mounted content, a different key destroys it first. Mounted views
 * receive the board's change events through `emit("events", change)`.
 */

import { h } from "../../dom.js";
import { renderMessage } from "../components/empty-state.js";
import { skeletonBlock, skeletonLine } from "../components/skeleton.js";
import { mountAppView } from "./app-view.js";

/** A table-shaped placeholder: two groups of rows. */
function tableSkeleton() {
  const group = (rows) => [
    skeletonLine({ variant: "title", width: "180px" }),
    Array.from({ length: rows }, (_, index) =>
      h(
        "div",
        { class: "skeleton-row" },
        skeletonLine({ width: `${42 + ((index * 17) % 30)}%` }),
        skeletonLine({ variant: "pill", width: "120px" }),
        skeletonLine({ variant: "avatar" }),
        skeletonLine({ width: "90px" }),
      ),
    ),
  ];
  return skeletonBlock({
    label: "Loading board",
    className: "board-skeleton",
    children: [group(4), group(3)].flat(),
  });
}

/**
 * Status messages of the board view. A missing board and one the user
 * cannot access read the same, so access never leaks existence.
 */
export function renderBoardStatus(container, { status, onRetry, onHome }) {
  container.dataset.viewKey = status;
  if (status === "loading" || !status) {
    container.replaceChildren(tableSkeleton());
    return;
  }
  const messages = {
    missing: {
      iconName: "board",
      title: "This board isn’t available",
      text: "It may have been deleted, or you don’t have access to it.",
      action: { label: "Go to Home", icon: "home", onClick: onHome },
    },
    error: {
      iconName: "alert",
      title: "We couldn’t load this board",
      text: "Check your connection and try again.",
      action: { label: "Try again", icon: "refresh", onClick: onRetry },
    },
  };
  renderMessage(container, messages[status] ?? messages.error);
}

/**
 * Creates the embedded-view slot for one board page.
 * @param {{ container: HTMLElement }} options
 */
export function createEmbeddedSlot({ container }) {
  let mounted = null;

  function unmount() {
    container.classList.remove("app-active");
    if (!mounted) return;
    const previous = mounted;
    mounted = null;
    try {
      previous.destroy();
    } catch (error) {
      globalThis.console?.error?.("Embedded view cleanup failed", error);
    }
  }

  /** Mounts the app view of `installId` (no-op when already mounted). */
  function mountApp({ key, board, installId, host, onMissing }) {
    if (mounted?.key === key) return;
    unmount();
    container.dataset.viewKey = key;
    const view = board.views.find(
      (entry) =>
        entry.type === "app" && String(entry.app_install_id) === installId,
    );
    if (!view) {
      renderMessage(container, {
        iconName: "app",
        title: "App view not found",
        text: "The app may have been removed from this board.",
        action: { label: "Open the main table", onClick: onMissing },
      });
      return;
    }
    container.classList.add("app-active");
    const handle = mountAppView(container, { view, host });
    mounted = { key, view, emit: handle.emit, destroy: handle.destroy };
  }

  /**
   * Mounts a self-loading view (no-op when `key` is already mounted).
   * `create(root)` returns `{ emit(type, data), destroy() }`.
   */
  function mountView({ key, create }) {
    if (mounted?.key === key) return;
    unmount();
    container.dataset.viewKey = key;
    const root = h("div", { class: "board-embedded-page" });
    container.replaceChildren(root);
    const handle = create(root);
    mounted = {
      key,
      view: null,
      emit: handle.emit,
      destroy() {
        handle.destroy();
        root.remove();
      },
    };
  }

  return {
    mountApp,
    mountView,
    unmount,
    /** The mounted record (`{ key, view, emit }`; `view` for apps) or null. */
    current: () => mounted,
    /** Sends an event (`events`, `context`, `filter`) to the mounted view. */
    emit: (type, data) => mounted?.emit(type, data) ?? false,
  };
}
