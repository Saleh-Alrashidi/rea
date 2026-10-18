/**
 * Buttons. Variants: `primary` (one per view), `secondary` (outlined),
 * `ghost` (quiet, for toolbars) and `danger`. Sizes `sm` (28 px) and `md`
 * (32 px).
 *
 * A control the user cannot use is shown disabled with the reason as its
 * tooltip (`disabledReason`): it stays focusable (`aria-disabled`) so
 * keyboard and screen-reader users can discover why, and clicks are
 * swallowed.
 *
 * ```js
 * button({ label: "New board", icon: "plus", variant: "primary", onClick })
 * button({ label: "Share", disabledReason: REASONS.notOwner })
 * iconButton({ icon: "more", label: "Board actions", onClick })
 * linkButton({ label: "Open board", href: boardHash(id) })
 * ```
 */

import { h } from "../../dom.js";
import { icon as iconElement } from "./icon.js";

const VARIANTS = new Set(["primary", "secondary", "ghost", "danger"]);

function classes({ variant = "secondary", size = "md", block, className }) {
  return [
    "btn",
    `btn-${VARIANTS.has(variant) ? variant : "secondary"}`,
    size === "sm" && "btn-sm",
    block && "btn-block",
    className,
  ];
}

function guard(onClick, disabledReason) {
  return (event) => {
    if (disabledReason) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };
}

/**
 * Builds a `<button>`.
 * @param {{ label: string, icon?: string, iconEnd?: string,
 *   variant?: "primary" | "secondary" | "ghost" | "danger",
 *   size?: "sm" | "md", type?: "button" | "submit",
 *   onClick?: (event: MouseEvent) => void, disabled?: boolean,
 *   disabledReason?: string, title?: string, block?: boolean,
 *   className?: string, dataset?: object, ariaLabel?: string,
 *   hideLabel?: boolean }} options
 * @returns {HTMLButtonElement}
 */
export function button(options) {
  const { label, icon, iconEnd, disabledReason, hideLabel = false } = options;
  return h(
    "button",
    {
      type: options.type ?? "button",
      class: classes(options),
      disabled: options.disabled ?? false,
      "aria-disabled": disabledReason ? "true" : null,
      title: disabledReason ?? options.title ?? (hideLabel ? label : null),
      "aria-label": options.ariaLabel ?? (hideLabel ? label : null),
      dataset: options.dataset,
      on: { click: guard(options.onClick, disabledReason) },
    },
    icon ? iconElement(icon) : null,
    hideLabel ? null : h("span", { class: "btn-label" }, label),
    iconEnd ? iconElement(iconEnd, { size: 14 }) : null,
  );
}

/**
 * A square icon-only button; `label` is its accessible name and tooltip.
 * @param {{ icon: string, label: string, onClick?: (event: MouseEvent) => void,
 *   size?: "sm" | "md", disabledReason?: string, className?: string,
 *   pressed?: boolean, dataset?: object, attributes?: object }} options
 * @returns {HTMLButtonElement}
 */
export function iconButton(options) {
  const { icon, label, disabledReason, size = "md" } = options;
  return h(
    "button",
    {
      ...options.attributes,
      type: "button",
      class: ["icon-btn", size === "sm" && "icon-btn-sm", options.className],
      "aria-label": label,
      "aria-disabled": disabledReason ? "true" : null,
      "aria-pressed":
        options.pressed === undefined ? null : String(options.pressed),
      title: disabledReason ?? label,
      dataset: options.dataset,
      on: { click: guard(options.onClick, disabledReason) },
    },
    iconElement(icon, { size: size === "sm" ? 14 : 16 }),
  );
}

/**
 * A link styled as a button (for navigation such as "Open board").
 * @param {{ label: string, href: string, icon?: string,
 *   variant?: "primary" | "secondary" | "ghost" | "danger",
 *   size?: "sm" | "md", className?: string }} options
 * @returns {HTMLAnchorElement}
 */
export function linkButton(options) {
  return h(
    "a",
    { class: classes(options), href: options.href },
    options.icon ? iconElement(options.icon) : null,
    h("span", { class: "btn-label" }, options.label),
  );
}
