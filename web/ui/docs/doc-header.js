/**
 * The doc editor's top bar: the breadcrumb (Docs › workspace), the save
 * status, the visibility control (owners) or badge, the "View only"
 * badge, the people with access, Share (owners) and the doc menu (copy
 * link, delete). It stays at the top while the doc scrolls.
 */

import { h } from "../../dom.js";
import { docsHash, workspaceHash } from "../../router.js";
import { avatarStack } from "../components/avatar.js";
import { accessBadge, docVisibilityBadge } from "../components/badge.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import { DOC_VISIBILITIES, docVisibility } from "../components/labels.js";
import { menuButton, openMenu } from "../components/menu.js";
import { REASONS } from "../components/permissions.js";

const MAX_AVATARS = 4;

function breadcrumb(doc) {
  const workspace = doc.workspace;
  return h(
    "nav",
    { class: "doc-breadcrumb", "aria-label": "Breadcrumb" },
    h(
      "a",
      { class: "doc-crumb", href: docsHash() },
      icon("docs", { size: 14 }),
      h("span", null, "Docs"),
    ),
    workspace
      ? [
          h(
            "span",
            { class: "doc-crumb-separator", "aria-hidden": "true" },
            "/",
          ),
          doc.workspaceAccessible
            ? h(
                "a",
                { class: "doc-crumb", href: workspaceHash(workspace.id) },
                workspace.name,
              )
            : h("span", { class: "doc-crumb" }, workspace.name),
        ]
      : null,
  );
}

function visibilityControl(doc, caps, onVisibility) {
  if (!caps.manage) return docVisibilityBadge(doc.visibility);
  const info = docVisibility(doc.visibility);
  const trigger = h(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-sm doc-visibility",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: `Who can read it: ${info.description}`,
      on: {
        click: () =>
          openMenu({
            anchor: trigger,
            label: "Who can read this doc",
            items: [
              { type: "heading", label: "Who can read it" },
              ...Object.entries(DOC_VISIBILITIES).map(([value, entry]) => ({
                label: entry.label,
                hint: entry.description,
                icon: entry.icon,
                checked: value === doc.visibility,
                onSelect: () => value !== doc.visibility && onVisibility(value),
              })),
            ],
          }),
      },
    },
    icon(info.icon, { size: 14 }),
    h("span", { class: "btn-label" }, info.label),
    icon("chevronDown", { size: 12 }),
  );
  return trigger;
}

function membersButton(doc, caps, onShare) {
  const members = doc.members ?? [];
  if (members.length === 0) return null;
  const names = members.map((member) => member.name).join(", ");
  const action = caps.manage ? "Manage access" : "See who has access";
  return h(
    "button",
    {
      type: "button",
      class: "doc-members",
      "aria-label": `People with access: ${names}. ${action}`,
      title: names,
      on: { click: onShare },
    },
    avatarStack(members, { max: MAX_AVATARS, size: "sm" }),
  );
}

function docMenu(caps, props) {
  return menuButton({
    icon: "more",
    label: "Doc actions",
    className: "doc-menu",
    items: () => [
      { label: "Copy link", icon: "link", onSelect: props.onCopyLink },
      { label: "Copy as text", icon: "copy", onSelect: props.onCopyText },
      { type: "separator" },
      {
        label: "Delete doc",
        icon: "trash",
        danger: true,
        disabledReason: caps.manage ? null : REASONS.notOwner,
        onSelect: props.onDelete,
      },
    ],
  });
}

/**
 * Renders the bar into `container`.
 * @param {HTMLElement} container
 * @param {{ doc: object, caps: { edit: boolean, manage: boolean, viewOnly: boolean },
 *   status: HTMLElement, onShare(): void, onVisibility(value: string): void,
 *   onDelete(): void, onCopyLink(): void, onCopyText(): void }} props
 */
export function renderDocHeader(container, props) {
  const { doc, caps } = props;
  container.replaceChildren(
    breadcrumb(doc),
    h(
      "div",
      { class: "doc-bar-actions" },
      caps.edit ? props.status : null,
      visibilityControl(doc, caps, props.onVisibility),
      caps.viewOnly ? accessBadge("viewer") : null,
      membersButton(doc, caps, props.onShare),
      caps.manage
        ? button({
            label: "Share",
            icon: "userPlus",
            size: "sm",
            variant: "primary",
            className: "doc-share",
            onClick: props.onShare,
          })
        : null,
      docMenu(caps, props),
    ),
  );
}
