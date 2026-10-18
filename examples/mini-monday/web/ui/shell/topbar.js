/**
 * Top bar: the navigation toggle, the Worklane wordmark, the search button
 * that opens the command palette (Ctrl/⌘+K), notifications, the theme
 * toggle (System / Light / Dark) and the user menu.
 */

import { h } from "../../dom.js";
import { homeHash } from "../../router.js";
import { brandMark, icon } from "../components/icon.js";
import { openMenu } from "../components/menu.js";
import { THEME_MODES, setThemeMode, themeMode } from "./theme.js";

const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");
export const SHORTCUT_LABEL = IS_MAC ? "⌘K" : "Ctrl K";

function themeButton() {
  const modeInfo = () =>
    THEME_MODES.find((entry) => entry.mode === themeMode()) ?? THEME_MODES[0];
  const button = h("button", {
    type: "button",
    class: "icon-btn topbar-btn theme-toggle",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    on: {
      click: () =>
        openMenu({
          anchor: button,
          label: "Theme",
          placement: "bottom-end",
          items: [
            { type: "heading", label: "Theme" },
            ...THEME_MODES.map((entry) => ({
              label: entry.label,
              icon: entry.icon,
              checked: entry.mode === themeMode(),
              onSelect: () => setThemeMode(entry.mode),
            })),
          ],
        }),
    },
  });
  function update() {
    const info = modeInfo();
    button.setAttribute("aria-label", `Theme: ${info.label}`);
    button.title = `Theme: ${info.label}`;
    button.replaceChildren(icon(info.icon, { size: 18 }));
  }
  update();
  return { element: button, update };
}

/**
 * Builds the top bar once; `update({ sidebarOpen })` refreshes the toggle.
 * @param {{ onToggleSidebar(): void, onSearch(): void,
 *   notifications: { element: HTMLElement },
 *   userMenu: { element: HTMLElement } }} options
 * @returns {{ element: HTMLElement, update(state: { sidebarOpen: boolean }): void,
 *   updateTheme(): void }}
 */
export function createTopbar({
  onToggleSidebar,
  onSearch,
  notifications,
  userMenu,
}) {
  const toggle = h(
    "button",
    {
      type: "button",
      class: "icon-btn topbar-btn sidebar-toggle",
      "aria-label": "Show navigation",
      "aria-controls": "sidebar",
      "aria-expanded": "false",
      title: "Navigation",
      on: { click: onToggleSidebar },
    },
    icon("sidebar", { size: 18 }),
  );
  const theme = themeButton();
  const element = h(
    "div",
    { class: "topbar-inner" },
    h(
      "div",
      { class: "topbar-start" },
      toggle,
      h(
        "a",
        { class: "brand", href: homeHash(), "aria-label": "Worklane home" },
        brandMark({ size: 28 }),
        h("span", { class: "brand-word" }, "Worklane"),
      ),
    ),
    h(
      "button",
      {
        type: "button",
        class: "topbar-search",
        "aria-label": `Search or jump to (${SHORTCUT_LABEL})`,
        "aria-keyshortcuts": IS_MAC ? "Meta+K" : "Control+K",
        on: { click: onSearch },
      },
      icon("search"),
      h("span", { class: "topbar-search-text" }, "Search or jump to…"),
      h("kbd", { class: "kbd" }, SHORTCUT_LABEL),
    ),
    h(
      "div",
      { class: "topbar-end" },
      notifications.element,
      theme.element,
      userMenu.element,
    ),
  );
  return {
    element,
    update({ sidebarOpen }) {
      toggle.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
      toggle.setAttribute(
        "aria-label",
        sidebarOpen ? "Hide navigation" : "Show navigation",
      );
    },
    updateTheme: theme.update,
  };
}
