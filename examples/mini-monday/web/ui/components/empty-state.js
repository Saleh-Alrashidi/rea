/**
 * Empty, error and status messages: an icon, a title, one sentence and an
 * optional action (a button with `onClick`, or a link with `href`).
 *
 * ```js
 * emptyState({ icon: "docs", title: "No docs yet",
 *   text: "Docs hold specs, briefs and meeting notes.",
 *   action: { label: "New doc", icon: "plus", onClick: createDoc } })
 * renderMessage(container, { iconName: "alert", title: "Couldn’t load" })
 * ```
 */

import { clear, h } from "../../dom.js";
import { button, linkButton } from "./button.js";
import { icon as iconElement } from "./icon.js";

function actionElement(action, variant) {
  if (!action) return null;
  if (action.href) {
    return linkButton({
      label: action.label,
      href: action.href,
      icon: action.icon,
      variant,
    });
  }
  return button({
    label: action.label,
    icon: action.icon,
    variant,
    onClick: action.onClick,
    disabledReason: action.disabledReason,
  });
}

/**
 * @param {{ icon?: string, title: string, text?: string, busy?: boolean,
 *   compact?: boolean, tone?: "neutral" | "danger",
 *   action?: { label: string, icon?: string, onClick?: () => void,
 *     href?: string, disabledReason?: string } | null,
 *   secondaryAction?: { label: string, onClick?: () => void, href?: string } | null }} options
 * @returns {HTMLElement}
 */
export function emptyState(options) {
  const {
    icon = "board",
    title,
    text,
    busy = false,
    compact = false,
  } = options;
  return h(
    "div",
    {
      class: [
        "empty-state",
        compact && "compact",
        busy && "loading",
        options.tone === "danger" && "danger",
      ],
      role: busy ? "status" : null,
      "aria-busy": busy ? "true" : null,
    },
    h(
      "span",
      { class: "empty-icon" },
      iconElement(icon, { size: compact ? 20 : 28 }),
    ),
    h("h2", { class: "empty-title" }, title),
    text ? h("p", { class: "empty-text" }, text) : null,
    options.action || options.secondaryAction
      ? h(
          "div",
          { class: "empty-actions" },
          actionElement(options.action, "primary"),
          actionElement(options.secondaryAction, "secondary"),
        )
      : null,
  );
}

/**
 * Replaces `container`'s content with a message (the part-1 board API).
 * @param {HTMLElement} container
 * @param {{ iconName?: string, title: string, text?: string, busy?: boolean,
 *   action?: { label: string, onClick(): void } | null }} message
 */
export function renderMessage(container, message) {
  const { iconName, ...rest } = message;
  clear(container).append(emptyState({ ...rest, icon: iconName }));
}
