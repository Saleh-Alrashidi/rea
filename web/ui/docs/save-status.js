/**
 * Save feedback shared by the doc and note editors: a compact status
 * ("Saving…", "Saved", "Unsaved changes", "Not saved") fed by autosave
 * snapshots, and the banners shown when saving stops (a version conflict
 * with Reload / Copy my version, lost access, or a failure with Retry).
 *
 * Routine states are not announced; banners use `role="alert"`, so
 * assistive technology hears only what needs attention.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";

const STATES = {
  saved: { icon: "check", label: "Saved" },
  pending: { icon: "edit", label: "Unsaved changes" },
  saving: { icon: "refresh", label: "Saving…" },
  failed: { icon: "alert", label: "Not saved" },
  conflict: { icon: "alert", label: "Not saved" },
};

/**
 * The status chip.
 * @returns {{ element: HTMLElement, update(snapshot: { status: string }): void }}
 */
export function createSaveStatus() {
  const element = h("span", {
    class: "save-status",
    dataset: { status: "saved" },
  });
  let shown = null;
  function update(snapshot) {
    const status = Object.hasOwn(STATES, snapshot?.status)
      ? snapshot.status
      : "saved";
    if (status === shown) return;
    shown = status;
    const info = STATES[status];
    element.dataset.status = status;
    element.replaceChildren(
      icon(info.icon, { size: 14 }),
      h("span", null, info.label),
    );
  }
  update({ status: "saved" });
  return { element, update };
}

/**
 * A banner with a title, one sentence and actions.
 * @param {{ tone?: "warning" | "danger" | "info", iconName?: string,
 *   title: string, text?: string,
 *   actions?: { label: string, icon?: string, onClick(): void,
 *     variant?: string }[] }} options
 */
export function editorBanner({
  tone = "warning",
  iconName = "alert",
  title,
  text,
  actions = [],
}) {
  return h(
    "div",
    { class: ["banner", `banner-${tone}`, "editor-banner"], role: "alert" },
    icon(iconName),
    h(
      "div",
      { class: "editor-banner-text" },
      h("strong", null, title),
      text ? h("span", null, ` ${text}`) : null,
    ),
    actions.length > 0
      ? h(
          "div",
          { class: "editor-banner-actions" },
          actions.map((action) =>
            button({
              label: action.label,
              icon: action.icon,
              size: "sm",
              variant: action.variant ?? "secondary",
              onClick: action.onClick,
            }),
          ),
        )
      : null,
  );
}

/**
 * The banner for a stopped autosave, or null while saving works.
 * `what` names the record ("doc", "note").
 *
 * @param {{ status: string, error?: { code?: string, message?: string } }} snapshot
 * @param {{ what: string, onReload(): void, onCopy(): void,
 *   onRetry(): void }} actions
 */
export function saveBanner(snapshot, { what, onReload, onCopy, onRetry }) {
  if (snapshot.status === "conflict") {
    return editorBanner({
      title: `This ${what} changed somewhere else.`,
      text: "Your latest edits weren’t saved. Reload to see the current version; copy your version first to keep it.",
      actions: [
        {
          label: "Reload",
          icon: "refresh",
          variant: "primary",
          onClick: onReload,
        },
        { label: "Copy my version", icon: "copy", onClick: onCopy },
      ],
    });
  }
  if (snapshot.status !== "failed") return null;
  const code = snapshot.error?.code;
  if (code === "NOT_FOUND") {
    return editorBanner({
      tone: "danger",
      title: `This ${what} isn’t available anymore.`,
      text: "It may have been deleted, or your access was removed.",
      actions: [{ label: "Copy my version", icon: "copy", onClick: onCopy }],
    });
  }
  if (code === "FORBIDDEN") {
    return editorBanner({
      title: `You can no longer edit this ${what}.`,
      text: "Your access changed. Reload to see it as it is now.",
      actions: [
        {
          label: "Reload",
          icon: "refresh",
          variant: "primary",
          onClick: onReload,
        },
        { label: "Copy my version", icon: "copy", onClick: onCopy },
      ],
    });
  }
  return editorBanner({
    tone: "danger",
    title: "Your changes weren’t saved.",
    text: snapshot.error?.message || "The server didn’t answer.",
    actions: [{ label: "Try again", icon: "refresh", onClick: onRetry }],
  });
}

/** Copies `text` to the clipboard; resolves true on success. */
export async function copyText(text) {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
