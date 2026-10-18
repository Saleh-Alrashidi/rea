/**
 * Toast notifications in a polite live region. Messages are text only,
 * clipped, time-limited and capped in number so an embedded app cannot
 * flood the page.
 */

import { h } from "../dom.js";
import { icon } from "./icons.js";

const TYPES = new Set(["success", "error", "info"]);
const DEFAULT_TIMEOUT = 4000;
const MIN_TIMEOUT = 1500;
const MAX_TIMEOUT = 30_000;
const MAX_TOASTS = 4;
const MAX_MESSAGE = 300;

let region = null;

/** Sets the element that holds toasts (an `aria-live` region). */
export function mountToasts(element) {
  region = element;
}

function clampTimeout(timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, timeout));
}

/**
 * Shows a toast. `source` names an embedded app so its notices are labelled.
 * @param {{ message: string, type?: "success" | "error" | "info",
 *   timeout?: number, source?: string }} options
 */
export function showToast({ message, type = "info", timeout, source }) {
  if (!region) return;
  const kind = TYPES.has(type) ? type : "info";
  const text = String(message);
  const clipped =
    text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
  let timer = null;
  const dismiss = () => {
    globalThis.clearTimeout(timer);
    toast.remove();
  };
  const toast = h(
    "div",
    {
      class: ["toast", `toast-${kind}`],
      role: kind === "error" ? "alert" : "status",
    },
    h(
      "span",
      { class: "toast-icon" },
      icon(kind === "error" ? "alert" : "check"),
    ),
    h(
      "div",
      { class: "toast-text" },
      source ? h("span", { class: "toast-source" }, `${source}: `) : null,
      clipped,
    ),
    h(
      "button",
      {
        type: "button",
        class: "icon-btn toast-close",
        "aria-label": "Dismiss notification",
        on: { click: dismiss },
      },
      icon("close"),
    ),
  );
  while (region.childElementCount >= MAX_TOASTS) {
    region.firstElementChild.remove();
  }
  region.append(toast);
  timer = globalThis.setTimeout(dismiss, clampTimeout(timeout));
}

/** Shows an error toast for a failed request. */
export function showError(error, fallback = "Something went wrong") {
  const message =
    error instanceof Error && error.message ? error.message : fallback;
  showToast({ message, type: "error", timeout: 6000 });
}
