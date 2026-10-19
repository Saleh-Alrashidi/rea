/**
 * Tabs. Items with `href` render a navigation bar of links (the router owns
 * the selection; the active link gets `aria-current="page"`). Items without
 * `href` render an ARIA tablist with roving focus (arrow keys, Home, End)
 * that calls `onSelect(id)`.
 *
 * ```js
 * tabs({ label: "Filter", items: [{ id: "all", label: "All" },
 *   { id: "mine", label: "Mine", count: 3 }], active: "all", onSelect })
 * tabs({ label: "Board views", items: [{ id: "table", label: "Main table",
 *   icon: "table", href: viewHash(id) }], active: "table" })
 * ```
 */

import { h } from "../../dom.js";
import { icon as iconElement } from "./icon.js";

function tabContent(item) {
  return [
    item.icon ? iconElement(item.icon) : null,
    h("span", { class: "tab-label" }, item.label),
    Number.isSafeInteger(item.count)
      ? h("span", { class: "tab-count" }, String(item.count))
      : null,
  ];
}

function linkTabs({ label, items, active, className }) {
  return h(
    "nav",
    { class: ["tabs", className], "aria-label": label },
    items.map((item) =>
      h(
        "a",
        {
          class: ["tab", item.id === active && "active"],
          href: item.href,
          "aria-current": item.id === active ? "page" : null,
          dataset: { tab: item.id },
        },
        tabContent(item),
      ),
    ),
  );
}

function onTabKeydown(event) {
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
  if (!Object.hasOwn(keys, event.key)) return;
  const tabs = [
    ...event.currentTarget.querySelectorAll('[role="tab"]:not([disabled])'),
  ];
  const index = tabs.indexOf(globalThis.document.activeElement);
  const step = keys[event.key];
  let next;
  if (step === "first") next = 0;
  else if (step === "last") next = tabs.length - 1;
  else next = (index + step + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}

/**
 * @param {{ label: string, items: { id: string, label: string, icon?: string,
 *   count?: number, href?: string, disabled?: boolean, controls?: string,
 *   focusKey?: string }[],
 *   active: string, onSelect?: (id: string) => void, className?: string }} options
 * @returns {HTMLElement}
 */
export function tabs(options) {
  const { label, items, active, onSelect, className } = options;
  if (items.some((item) => item.href)) return linkTabs(options);
  return h(
    "div",
    {
      class: ["tabs", className],
      role: "tablist",
      "aria-label": label,
      on: { keydown: onTabKeydown },
    },
    items.map((item) => {
      const selected = item.id === active;
      return h(
        "button",
        {
          type: "button",
          role: "tab",
          class: ["tab", selected && "active"],
          "aria-selected": selected ? "true" : "false",
          "aria-controls": item.controls ?? null,
          tabindex: selected ? "0" : "-1",
          disabled: item.disabled ?? false,
          dataset: { tab: item.id, focusKey: item.focusKey },
          on: { click: () => !selected && onSelect?.(item.id) },
        },
        tabContent(item),
      );
    }),
  );
}
