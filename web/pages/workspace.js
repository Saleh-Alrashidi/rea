/**
 * Workspace page (`#/workspaces/<id>`): a header with the workspace's
 * color, kind badge and members' avatars, and Boards / Docs / Forms tabs
 * with their create buttons. Owners get "Share" (the shared share dialog
 * for workspace members) and "Settings". Only what the user can open is
 * listed; an inaccessible workspace reads like a missing one.
 */

import { h } from "../dom.js";
import { workspaceSettingsHash } from "../router.js";
import { avatarStack } from "../ui/components/avatar.js";
import { accessBadge, workspaceKindBadge } from "../ui/components/badge.js";
import { button, linkButton } from "../ui/components/button.js";
import { emptyState } from "../ui/components/empty-state.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { REASONS, hasRole } from "../ui/components/permissions.js";
import { skeletonCards } from "../ui/components/skeleton.js";
import { tabs } from "../ui/components/tabs.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { createFlows } from "../ui/shell/create.js";
import { loadWorkspace } from "../ui/workspaces/workspace-data.js";
import { createReasons, tabContent } from "../ui/workspaces/workspace-tabs.js";
import { notFoundView } from "./not-found.js";

const TAB_IDS = ["boards", "docs", "forms"];
const TAB_LABELS = { boards: "Boards", docs: "Docs", forms: "Forms" };

function membersControl(w) {
  const { workspace } = w;
  const stack = avatarStack(workspace.members, { max: 5, size: "sm" });
  // The people and teams with an explicit role; open workspaces also let
  // every non-guest member in (the kind badge says so).
  const label = "Members";
  if (!workspace.canManage) {
    return h("span", { class: "ws-members" }, stack, h("span", null, label));
  }
  return h(
    "button",
    {
      type: "button",
      class: "ws-members ws-members-button",
      title: "Manage members",
      on: { click: () => share(w) },
    },
    stack,
    h("span", null, label),
  );
}

/** Opens the share dialog; a change refreshes the shell, then this page. */
function share(w) {
  return w.ctx.openShare({
    resourceKind: "workspace",
    resourceId: w.workspace.id,
  });
}

function header(w) {
  const { workspace } = w;
  const manage = workspace.canManage ? null : REASONS.notOwner;
  return pageHeader({
    title: workspace.name,
    icon: "workspace",
    iconColor: workspace.color,
    eyebrow: "Workspace",
    subtitle: workspace.description || null,
    badges: [
      workspaceKindBadge(workspace.kind),
      hasRole(workspace.myAccess, "editor") ? null : accessBadge("viewer"),
    ],
    actions: [
      membersControl(w),
      button({
        label: "Share",
        icon: "userPlus",
        disabledReason: manage,
        onClick: () => share(w),
      }),
      manage
        ? button({
            label: "Settings",
            icon: "settings",
            disabledReason: manage,
          })
        : linkButton({
            label: "Settings",
            icon: "settings",
            href: workspaceSettingsHash(workspace.id),
          }),
    ].filter(Boolean),
    className: "ws-header",
  });
}

function create(w, tab) {
  const flows = createFlows(w.ctx);
  const { workspace } = w;
  if (tab === "boards") return flows.board({ workspaceId: workspace.id });
  if (tab === "docs") return flows.doc({ workspaceId: workspace.id });
  const board = workspace.boards.find((entry) =>
    hasRole(entry.my_access, "editor"),
  );
  return flows.form({ boardId: board?.id });
}

function renderTab(w) {
  const reasons = createReasons(w.ctx.me, w.workspace);
  const hadFocus = w.tabsSlot.contains(globalThis.document.activeElement);
  w.tabsSlot.replaceChildren(
    tabs({
      label: "Workspace content",
      active: w.tab,
      items: TAB_IDS.map((id) => ({
        id,
        label: TAB_LABELS[id],
        count: w.workspace[id].length,
        controls: "workspace-tab-panel",
      })),
      onSelect(id) {
        w.tab = id;
        renderTab(w);
      },
    }),
  );
  if (hadFocus) w.tabsSlot.querySelector('[aria-selected="true"]')?.focus();
  w.panel.replaceChildren(
    tabContent({
      tab: w.tab,
      workspace: w.workspace,
      reason: reasons[w.tab],
      onCreate: () => create(w, w.tab),
    }),
  );
}

function render(w) {
  setDocumentTitle(w.workspace.name);
  w.tabsSlot = h("div", { class: "page-toolbar" });
  w.panel = h("div", {
    id: "workspace-tab-panel",
    class: "page-body ws-panel",
    role: "tabpanel",
  });
  w.container.replaceChildren(
    h(
      "div",
      { class: "page-container ws-page" },
      header(w),
      w.tabsSlot,
      w.panel,
    ),
  );
  renderTab(w);
}

async function refresh(w) {
  try {
    const workspace = await loadWorkspace(w.ctx.api, w.workspaceId);
    if (!w.active) return;
    if (!workspace) {
      setDocumentTitle("Not found");
      w.container.replaceChildren(notFoundView({ what: "workspace" }));
      return;
    }
    w.workspace = workspace;
    render(w);
  } catch (error) {
    if (!w.active) return;
    w.container.replaceChildren(
      h(
        "div",
        { class: "page-container" },
        emptyState({
          icon: "alert",
          title: "Couldn’t load this workspace",
          text: error?.message || "Something went wrong.",
          action: {
            label: "Try again",
            icon: "refresh",
            onClick: () => refresh(w),
          },
        }),
      ),
    );
  }
}

/** Page contract. */
export async function mount(container, ctx, params) {
  setDocumentTitle("Workspace");
  const w = {
    ctx,
    container,
    workspaceId: params.workspaceId,
    workspace: null,
    tab: "boards",
    active: true,
  };
  container.replaceChildren(
    h(
      "div",
      { class: "page-container" },
      skeletonCards({ count: 6, label: "Loading workspace" }),
    ),
  );
  ctx.bus.emit(BUS_EVENTS.workspace, params.workspaceId);
  // The sidebar's create flows and the share dialog refresh the shell.
  const off = ctx.bus.on(BUS_EVENTS.shell, () => {
    if (w.workspace) refresh(w);
  });
  await refresh(w);
  return () => {
    w.active = false;
    off();
  };
}
