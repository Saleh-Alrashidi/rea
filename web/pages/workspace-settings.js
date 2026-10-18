/**
 * Workspace settings (`#/workspaces/<id>/settings`): rename, description,
 * color and kind (Open / Closed) saved together with "Save changes";
 * members through the shared share dialog; and deleting the workspace once
 * it holds no boards or docs. Owners only (`can_manage`); other members
 * see the settings read-only. An inaccessible workspace reads like a
 * missing one. Unsaved changes are confirmed before leaving the page,
 * reloading or closing the tab.
 */

import { h } from "../dom.js";
import { homeHash, workspaceHash } from "../router.js";
import { subjectAvatar } from "../ui/components/avatar.js";
import { button } from "../ui/components/button.js";
import { choiceCards } from "../ui/components/choice.js";
import { emptyState } from "../ui/components/empty-state.js";
import { icon } from "../ui/components/icon.js";
import { guardUnsaved } from "../ui/components/leave-guard.js";
import { WORKSPACE_KINDS, accessRole } from "../ui/components/labels.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { skeletonCards } from "../ui/components/skeleton.js";
import { colorField } from "../ui/forms/color-field.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import {
  WORKSPACE_MUTATIONS,
  deleteReason,
  loadWorkspace,
  settingsChanges,
} from "../ui/workspaces/workspace-data.js";
import { notFoundView } from "./not-found.js";

function panel(title, iconName, ...children) {
  return h(
    "section",
    { class: "panel ws-settings-panel" },
    h(
      "div",
      { class: "panel-header" },
      h("h2", { class: "panel-title" }, icon(iconName), title),
    ),
    h("div", { class: "panel-body ws-settings-body" }, children),
  );
}

function textField({ id, label, value, multiline, disabled, onInput }) {
  return h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", for: id }, label),
    h(multiline ? "textarea" : "input", {
      id,
      class: "input",
      type: multiline ? null : "text",
      rows: multiline ? 3 : null,
      maxlength: multiline ? 2000 : 255,
      required: !multiline,
      value,
      disabled,
      on: { input: (event) => onInput(event.currentTarget.value) },
    }),
  );
}

/** Whether the form holds changes that are not saved. */
const isDirty = (s) =>
  Boolean(s.workspace?.canManage && s.values) &&
  Object.keys(settingsChanges(s.workspace, s.values)).length > 0;

function updateSaveBar(s) {
  const dirty = isDirty(s);
  const invalid = s.values.name.trim() === "";
  s.save.disabled = !dirty || invalid || s.busy;
  s.reset.disabled = !dirty || s.busy;
  s.status.textContent = invalid
    ? "A workspace needs a name"
    : dirty
      ? "Unsaved changes"
      : "";
}

function generalPanel(s) {
  const { workspace } = s;
  const disabled = !workspace.canManage;
  const set = (key) => (value) => {
    s.values[key] = value;
    updateSaveBar(s);
  };
  s.save = button({
    label: "Save changes",
    variant: "primary",
    type: "submit",
  });
  s.reset = button({
    label: "Discard",
    variant: "ghost",
    onClick: () => render(s),
  });
  s.status = h("span", { class: "ws-save-status", role: "status" });
  return h(
    "form",
    { class: "ws-settings-form", on: { submit: (event) => save(s, event) } },
    panel(
      "General",
      "settings",
      textField({
        id: "ws-name",
        label: "Name",
        value: workspace.name,
        disabled,
        onInput: set("name"),
      }),
      textField({
        id: "ws-description",
        label: "Description",
        value: workspace.description,
        multiline: true,
        disabled,
        onInput: set("description"),
      }),
      colorField({
        label: "Color",
        value: workspace.color,
        disabled,
        onChange: set("color"),
      }),
      h(
        "div",
        { class: "field" },
        h(
          "span",
          { class: "field-label", id: "ws-kind-label" },
          "Who can join",
        ),
        choiceCards({
          name: "ws-kind",
          value: workspace.kind,
          labelledBy: "ws-kind-label",
          disabled,
          options: Object.entries(WORKSPACE_KINDS).map(([value, info]) => ({
            value,
            label: info.label,
            description: info.description,
            icon: info.icon,
          })),
          onChange: set("kind"),
        }),
      ),
      disabled
        ? null
        : h("div", { class: "ws-save-bar" }, s.status, s.reset, s.save),
    ),
  );
}

async function save(s, event) {
  event.preventDefault();
  const changes = settingsChanges(s.workspace, s.values);
  if (s.busy || Object.keys(changes).length === 0) return;
  s.busy = true;
  updateSaveBar(s);
  try {
    await s.ctx.api.request(WORKSPACE_MUTATIONS.update, {
      id: s.workspace.id,
      ...changes,
    });
    s.ctx.toast.success("Workspace settings saved");
    await s.ctx.refreshShell();
    await load(s);
  } catch (error) {
    s.ctx.toast.error(error, "Couldn’t save the settings");
  } finally {
    s.busy = false;
    if (s.save?.isConnected) updateSaveBar(s);
  }
}

function membersPanel(s) {
  const { workspace } = s;
  return panel(
    "Members",
    "users",
    h(
      "p",
      { class: "field-hint" },
      workspace.kind === "open"
        ? "Everyone in the account except guests can join an open workspace; these people and teams have explicit roles."
        : "Only these people and teams can see this closed workspace.",
    ),
    h(
      "ul",
      { class: "preview-list" },
      workspace.members.map((member) =>
        h(
          "li",
          { class: "preview-row" },
          subjectAvatar(member, { size: "sm" }),
          h(
            "div",
            { class: "preview-main" },
            h("span", { class: "preview-title" }, member.name),
            h(
              "span",
              { class: "preview-subtitle" },
              member.kind === "team"
                ? `Team · ${accessRole(member.role).label}`
                : accessRole(member.role).label,
            ),
          ),
        ),
      ),
    ),
    button({
      label: "Manage members",
      icon: "userPlus",
      disabledReason: workspace.canManage
        ? null
        : "Only workspace owners can do this",
      onClick: async () => {
        const result = await s.ctx.openShare({
          resourceKind: "workspace",
          resourceId: workspace.id,
        });
        if (result?.changed && !result.lostAccess && s.active) await load(s);
      },
    }),
  );
}

async function remove(s) {
  const { ctx, workspace } = s;
  const confirmed = await ctx.dialog.confirm({
    title: `Delete ${workspace.name}?`,
    message:
      "The empty workspace and its member list are removed. This can’t be undone.",
    confirmButton: "Delete workspace",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await ctx.api.request(WORKSPACE_MUTATIONS.remove, { id: workspace.id });
  } catch (error) {
    ctx.toast.error(error, "Couldn’t delete the workspace");
    return;
  }
  ctx.toast.success(`${workspace.name} was deleted`);
  s.values = null; // nothing is left to save
  await ctx.refreshShell();
  ctx.router.navigate(homeHash(), { replace: true });
}

function dangerPanel(s) {
  const reason = deleteReason(s.workspace);
  return h(
    "section",
    { class: "panel ws-settings-panel ws-danger" },
    h(
      "div",
      { class: "panel-header" },
      h("h2", { class: "panel-title" }, icon("alert"), "Delete workspace"),
    ),
    h(
      "div",
      { class: "panel-body ws-settings-body ws-danger-body" },
      h(
        "p",
        null,
        reason && s.workspace.canManage
          ? `${reason}. A workspace can be deleted only when it is empty.`
          : "Deleting removes the workspace for everyone. It must be empty.",
      ),
      button({
        label: "Delete workspace",
        icon: "trash",
        variant: "danger",
        disabledReason: reason,
        onClick: () => remove(s),
      }),
    ),
  );
}

function render(s) {
  const { workspace } = s;
  s.values = {
    name: workspace.name,
    description: workspace.description,
    color: workspace.color,
    kind: workspace.kind,
  };
  setDocumentTitle(`${workspace.name} settings`);
  s.container.replaceChildren(
    h(
      "div",
      { class: "page-container ws-settings" },
      pageHeader({
        eyebrow: h(
          "a",
          { class: "page-back", href: workspaceHash(workspace.id) },
          icon("chevronLeft", { size: 14 }),
          workspace.name,
        ),
        title: "Workspace settings",
        icon: "settings",
        iconColor: workspace.color,
      }),
      workspace.canManage
        ? null
        : h(
            "p",
            { class: "banner banner-info" },
            icon("lock"),
            h("span", null, "Only workspace owners can change these settings."),
          ),
      generalPanel(s),
      membersPanel(s),
      dangerPanel(s),
    ),
  );
  if (s.save) updateSaveBar(s);
}

async function load(s) {
  try {
    const workspace = await loadWorkspace(s.ctx.api, s.workspaceId);
    if (!s.active) return;
    if (!workspace) {
      setDocumentTitle("Not found");
      s.container.replaceChildren(notFoundView({ what: "workspace" }));
      return;
    }
    s.workspace = workspace;
    render(s);
  } catch (error) {
    if (!s.active) return;
    s.container.replaceChildren(
      h(
        "div",
        { class: "page-container" },
        emptyState({
          icon: "alert",
          title: "Couldn’t load the settings",
          text: error?.message || "Something went wrong.",
          action: {
            label: "Try again",
            icon: "refresh",
            onClick: () => load(s),
          },
        }),
      ),
    );
  }
}

/** Page contract. */
export async function mount(container, ctx, params) {
  setDocumentTitle("Workspace settings");
  const s = {
    ctx,
    container,
    workspaceId: params.workspaceId,
    active: true,
    busy: false,
  };
  container.replaceChildren(
    h(
      "div",
      { class: "page-container" },
      skeletonCards({ count: 3, label: "Loading settings" }),
    ),
  );
  ctx.bus.emit(BUS_EVENTS.workspace, params.workspaceId);
  const offs = [
    ctx.router.guard(() =>
      isDirty(s) ? "Discard your unsaved workspace settings?" : null,
    ),
    guardUnsaved({ unsaved: () => isDirty(s) }),
  ];
  await load(s);
  return () => {
    s.active = false;
    for (const off of offs) off();
  };
}
