/**
 * Toast notifications in a polite live region. Messages are text only,
 * clipped, time-limited and capped in number so an embedded app cannot
 * flood the page.
 *
 * `toast` is the object handed to pages as `ctx.toast`:
 *
 * ```js
 * ctx.toast.success("Board created");
 * ctx.toast.error(error, "Couldn’t save");   // uses error.message when set
 * ctx.toast.show({ message, type: "info", action: { label: "Undo", onClick } });
 * ```
 */

import { h } from "../../dom.js";
import { icon } from "./icon.js";

const TYPES = new Set(["success", "error", "info"]);
const ICONS = { success: "check", error: "alert", info: "info" };
const DEFAULT_TIMEOUT = 4000;
const MIN_TIMEOUT = 1500;
const MAX_TIMEOUT = 30_000;
const MAX_TOASTS = 4;
const MAX_MESSAGE = 300;

let region = null;
/** Each shown toast's dismissal, so one pushed out still reports it. */
const dismissals = new WeakMap();

/** Sets the element that holds toasts (an `aria-live` region). */
export function mountToasts(element) {
  region = element;
}

function clampTimeout(timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, timeout));
}

function clip(text) {
  const value = String(text);
  return value.length > MAX_MESSAGE
    ? `${value.slice(0, MAX_MESSAGE - 1)}…`
    : value;
}

/**
 * Shows a toast. `source` names an embedded app so its notices are labelled;
 * `action` adds one button (it dismisses the toast, then runs `onClick`).
 * `onDismiss` runs once when the toast goes, however it goes. Returns
 * `{ dismiss() }`, or null when no toast region is mounted.
 * @param {{ message: string, type?: "success" | "error" | "info",
 *   timeout?: number, source?: string,
 *   action?: { label: string, onClick(): void },
 *   onDismiss?: () => void }} options
 * @returns {{ dismiss(): void } | null}
 */
export function showToast(options) {
  const { message, type = "info", timeout, source, action } = options;
  if (!region) return null;
  const kind = TYPES.has(type) ? type : "info";
  let timer = null;
  let gone = false;
  const dismiss = () => {
    globalThis.clearTimeout(timer);
    toast.remove();
    if (gone) return;
    gone = true;
    options.onDismiss?.();
  };
  const toast = h(
    "div",
    {
      class: ["toast", `toast-${kind}`],
      role: kind === "error" ? "alert" : "status",
    },
    h("span", { class: "toast-icon" }, icon(ICONS[kind])),
    h(
      "div",
      { class: "toast-text" },
      source ? h("span", { class: "toast-source" }, `${clip(source)}: `) : null,
      clip(message),
    ),
    action
      ? h(
          "button",
          {
            type: "button",
            class: "toast-action",
            on: {
              click() {
                dismiss();
                action.onClick();
              },
            },
          },
          clip(action.label),
        )
      : null,
    h(
      "button",
      {
        type: "button",
        class: "icon-btn icon-btn-sm toast-close",
        "aria-label": "Dismiss notification",
        on: { click: dismiss },
      },
      icon("close", { size: 14 }),
    ),
  );
  while (region.childElementCount >= MAX_TOASTS) {
    const oldest = region.firstElementChild;
    dismissals.get(oldest)?.();
    oldest.remove();
  }
  dismissals.set(toast, dismiss);
  region.append(toast);
  timer = globalThis.setTimeout(dismiss, clampTimeout(timeout));
  return { dismiss };
}

/** Shows an error toast for a failed request. */
export function showError(error, fallback = "Something went wrong") {
  const message =
    error instanceof Error && error.message ? error.message : fallback;
  showToast({ message, type: "error", timeout: 6000 });
}

/** `ctx.toast`. */
export const toast = Object.freeze({
  show: showToast,
  error: showError,
  success: (message) => showToast({ message, type: "success" }),
  info: (message) => showToast({ message, type: "info" }),
});
