/**
 * Centered message for empty, loading and error states.
 */

import { clear, h } from "../dom.js";
import { icon } from "./icons.js";

/**
 * Replaces `container`'s content with a message.
 * @param {HTMLElement} container
 * @param {{ iconName?: string, title: string, text?: string, busy?: boolean,
 *   action?: { label: string, onClick(): void } | null }} message
 */
export function renderMessage(container, message) {
  const { iconName = "board", title, text, busy = false, action } = message;
  clear(container).append(
    h(
      "div",
      {
        class: ["empty-state", busy && "loading"],
        role: busy ? "status" : null,
        "aria-busy": busy ? "true" : null,
      },
      h("span", { class: "empty-icon" }, icon(iconName, { size: 32 })),
      h("h2", null, title),
      text ? h("p", null, text) : null,
      action
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-primary",
              on: { click: action.onClick },
            },
            action.label,
          )
        : null,
    ),
  );
}
