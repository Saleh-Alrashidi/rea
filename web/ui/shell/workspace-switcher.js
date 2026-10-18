/**
 * Workspace switcher: a button showing the current workspace (color tile,
 * name, kind icon) that opens a menu of every accessible workspace, with
 * "+ New workspace" when the account role allows it and a link to the
 * current workspace's settings.
 */

import { h } from "../../dom.js";
import { workspaceHash, workspaceSettingsHash } from "../../router.js";
import { icon } from "../components/icon.js";
import { workspaceKind } from "../components/labels.js";
import { openMenu } from "../components/menu.js";
import { REASONS } from "../components/permissions.js";

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** A colored tile with the workspace's first letter. */
export function workspaceTile(workspace, { size = "md" } = {}) {
  const tile = h(
    "span",
    {
      class: ["workspace-tile", `workspace-tile-${size}`],
      "aria-hidden": "true",
    },
    [...(workspace?.name?.trim() || "?")][0].toUpperCase(),
  );
  tile.style.backgroundColor = COLOR_PATTERN.test(workspace?.color ?? "")
    ? workspace.color
    : "var(--color-primary)";
  return tile;
}

function menuItems({ workspaces, current, canCreate, onSelect, onCreate }) {
  return [
    { type: "heading", label: "Workspaces" },
    ...workspaces.map((workspace) => ({
      label: workspace.name,
      hint: workspaceKind(workspace.kind).label,
      icon: workspaceKind(workspace.kind).icon,
      checked: workspace.id === current?.id,
      onSelect: () => onSelect(workspace.id),
    })),
    { type: "separator" },
    {
      label: "New workspace",
      icon: "plus",
      disabledReason: canCreate ? null : REASONS.noCreate,
      onSelect: onCreate,
    },
    current
      ? {
          label: "Open workspace",
          icon: "workspace",
          href: workspaceHash(current.id),
        }
      : null,
    current
      ? {
          label: "Workspace settings",
          icon: "settings",
          href: workspaceSettingsHash(current.id),
        }
      : null,
  ];
}

/**
 * @param {{ workspaces: object[], current: object | null, canCreate: boolean,
 *   onSelect(id: string): void, onCreate(): void }} props
 * @returns {HTMLElement}
 */
export function workspaceSwitcher(props) {
  const { current } = props;
  const trigger = h(
    "button",
    {
      type: "button",
      class: "workspace-switcher",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": current
        ? `Workspace: ${current.name}. Switch workspace`
        : "Choose a workspace",
      on: {
        click: () =>
          openMenu({
            anchor: trigger,
            label: "Switch workspace",
            items: menuItems(props),
          }),
      },
    },
    current
      ? workspaceTile(current)
      : h("span", { class: "workspace-tile" }, icon("workspace")),
    h(
      "span",
      { class: "workspace-switcher-text" },
      h("span", { class: "workspace-switcher-label" }, "Workspace"),
      h(
        "span",
        { class: "workspace-switcher-name" },
        current?.name ?? "No workspace",
      ),
    ),
    icon("chevronDown", { size: 14, className: "workspace-switcher-chevron" }),
  );
  return trigger;
}
