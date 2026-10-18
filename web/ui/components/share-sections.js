/**
 * Sections of the share dialog (`share-dialog.js` owns its state and
 * actions): the visibility control, the invite row with the people picker
 * and the member list with role dropdowns and remove buttons.
 */

import { h } from "../../dom.js";
import { subjectAvatar } from "./avatar.js";
import { roleBadge } from "./badge.js";
import { button, iconButton } from "./button.js";
import { choiceCards } from "./choice.js";
import { emptyState } from "./empty-state.js";
import { icon } from "./icon.js";
import { accessRole, resourceKind as kindInfo } from "./labels.js";
import { peoplePicker } from "./people-picker.js";
import { REASONS } from "./permissions.js";
import {
  SHARE_SETTINGS,
  defaultRole,
  guestHint,
  lastOwnerReason,
  roleOptions,
  subjectEligibility,
} from "./share-model.js";
import { skeletonList } from "./skeleton.js";

function settingSection(state) {
  const { resource } = state;
  if (state.kind === "note") {
    return h(
      "p",
      { class: "share-note-hint" },
      icon("lock", { size: 14 }),
      "Notes are private to their owner until shared.",
    );
  }
  const setting = SHARE_SETTINGS[state.kind];
  const legendId = `share-setting-${state.kind}-label`;
  return h(
    "section",
    { class: "share-setting" },
    h("h3", { class: "field-label", id: legendId }, setting.label),
    choiceCards({
      name: `share-setting-${state.kind}`,
      value: resource.setting,
      labelledBy: legendId,
      options: Object.entries(setting.table).map(([value, info]) => ({
        value,
        ...info,
      })),
      disabled: !resource.canManage || state.busy,
      disabledReason: resource.canManage ? null : REASONS.notOwner,
      onChange: (value) => state.actions.changeSetting(value),
    }),
  );
}

function inviteSection(state) {
  const { resource, directory } = state;
  if (!resource.canManage) {
    return h(
      "p",
      { class: "share-readonly" },
      icon("info", { size: 14 }),
      `Only owners can change who has access to this ${kindInfo(state.kind).label.toLowerCase()}.`,
    );
  }
  const excluded = new Set(
    resource.members.map((member) => `${member.kind}:${member.id}`),
  );
  if (resource.owner) excluded.add(`user:${resource.owner.id}`);
  const hint = h("p", { class: "field-hint share-hint" });
  const roleSelect = h(
    "select",
    {
      class: "input input-small share-role",
      "aria-label": "Role for new members",
      value: defaultRole(state.kind),
    },
    roleOptions(state.kind).map((role) =>
      h("option", { value: role }, accessRole(role).label),
    ),
  );
  const updateHint = () => {
    const viewers = (state.picker?.selection() ?? []).some(
      (entry) => entry.kind === "user" && entry.role === "viewer",
    );
    hint.textContent =
      viewers && roleSelect.value !== "viewer"
        ? "Viewer accounts can only view, whatever role they get."
        : guestHint(resource);
  };
  roleSelect.addEventListener("change", updateHint);
  state.picker ??= peoplePicker({
    users: directory.userList,
    teams: directory.teams,
    excluded,
    label: "Add people or teams",
    eligibility: (subject) => subjectEligibility(resource, subject),
    onChange: updateHint,
  });
  updateHint();
  return h(
    "div",
    { class: "share-invite" },
    h(
      "div",
      { class: "share-invite-row" },
      state.picker.element,
      roleSelect,
      button({
        label: "Invite",
        variant: "primary",
        disabled: state.busy,
        onClick: () => state.actions.invite(roleSelect.value),
      }),
    ),
    hint,
  );
}

function memberRow(state, member) {
  const { resource } = state;
  const ownerReason = lastOwnerReason(resource, member);
  const self = member.kind === "user" && member.id === String(state.ctx.me.id);
  const detail =
    member.kind === "team"
      ? `Team · ${member.memberCount ?? 0} members`
      : member.email;
  const control = resource.canManage
    ? h(
        "select",
        {
          class: "input input-small",
          "aria-label": `Role of ${member.name}`,
          title: ownerReason,
          disabled: state.busy,
          value: member.role,
          on: {
            change: (event) =>
              state.actions.changeRole(member, event.currentTarget.value),
          },
        },
        roleOptions(state.kind).map((role) =>
          h(
            "option",
            { value: role, disabled: Boolean(ownerReason) && role !== "owner" },
            accessRole(role).label,
          ),
        ),
      )
    : h("span", { class: "share-role-text" }, accessRole(member.role).label);
  return h(
    "li",
    { class: "share-member" },
    subjectAvatar(member, { size: "md" }),
    h(
      "span",
      { class: "share-member-text" },
      h(
        "span",
        { class: "share-member-name" },
        member.name,
        self ? h("span", { class: "share-you" }, " (you)") : null,
      ),
      detail ? h("span", { class: "share-member-detail" }, detail) : null,
    ),
    member.accountRole === "guest" || member.accountRole === "viewer"
      ? roleBadge(member.accountRole)
      : null,
    control,
    resource.canManage
      ? iconButton({
          icon: "trash",
          label: `Remove ${member.name}`,
          size: "sm",
          disabledReason: ownerReason ?? (state.busy ? "Saving…" : null),
          onClick: () => state.actions.removeMember(member),
        })
      : null,
  );
}

function membersSection(state) {
  const { resource } = state;
  const ownerRow = resource.owner
    ? h(
        "li",
        { class: "share-member" },
        subjectAvatar(resource.owner, { size: "md" }),
        h(
          "span",
          { class: "share-member-text" },
          h("span", { class: "share-member-name" }, resource.owner.name),
          h(
            "span",
            { class: "share-member-detail" },
            resource.owner.email ?? "",
          ),
        ),
        h("span", { class: "share-role-text" }, "Owner"),
      )
    : null;
  return h(
    "section",
    { class: "share-members", "aria-labelledby": "share-members-heading" },
    h(
      "h3",
      { class: "share-heading", id: "share-members-heading" },
      "People with access",
    ),
    resource.members.length === 0 && !ownerRow
      ? h("p", { class: "muted" }, "Nobody has been invited yet.")
      : h(
          "ul",
          { class: "share-member-list" },
          ownerRow,
          resource.members.map((member) => memberRow(state, member)),
        ),
  );
}

/**
 * Renders the dialog body for `state` (see `share-dialog.js`): loading,
 * unavailable, or the error banner, visibility, invite and member sections.
 * Changes go through `state.actions`.
 */
export function renderShareBody(state) {
  const { body } = state.dialog;
  if (state.loading) {
    body.replaceChildren(
      skeletonList({ rows: 3, label: "Loading sharing settings" }),
    );
    return;
  }
  if (!state.resource) {
    body.replaceChildren(
      emptyState({
        icon: "lock",
        title: "This item isn’t available",
        text: "It may have been deleted, or you no longer have access.",
        compact: true,
      }),
    );
    return;
  }
  body.replaceChildren(
    state.error
      ? h(
          "p",
          { class: "banner banner-danger", role: "alert" },
          icon("alert", { size: 14 }),
          state.error,
        )
      : "",
    settingSection(state),
    inviteSection(state),
    membersSection(state),
  );
}
