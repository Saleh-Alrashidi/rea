/**
 * Sections of the share dialog (`share-dialog.js` owns its state and
 * actions): the visibility control, the invite row with the people picker
 * and the member list with role menus and remove buttons. Which controls
 * are on, and every explanation shown, come only from the server's
 * verdicts: the picker's `share_candidates` (eligibility, reason, roles,
 * note) and each Member's `can_remove`, `can_change_role`, `role_options`
 * and `reason`.
 *
 * Controls carry `data-focus-key`s so the dialog can put focus back after
 * a change re-renders the body (`renderShareBody` with `state.focusKey`).
 * A role changes only when picked from its menu, never on a stray arrow
 * key as a native select would.
 */

import { h } from "../../dom.js";
import { findByFocusKey } from "./focus.js";
import { subjectAvatar } from "./avatar.js";
import { roleBadge } from "./badge.js";
import { button, iconButton } from "./button.js";
import { choiceCards } from "./choice.js";
import { emptyState } from "./empty-state.js";
import { icon } from "./icon.js";
import { accessRole, resourceKind as kindInfo } from "./labels.js";
import { openMenu } from "./menu.js";
import { peoplePicker, teamDetail } from "./people-picker.js";
import { REASONS } from "./permissions.js";
import {
  SHARE_SETTINGS,
  ineligibleReasons,
  inviteRoles,
  preferredRole,
  selectionNotes,
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
      focusKey: "share-setting",
      onChange: (value) => state.actions.changeSetting(value),
    }),
  );
}

function roleOption(role) {
  return h("option", { value: role }, accessRole(role).label);
}

/** Refills the invite role select and hint from the picker's state. */
function syncInvite(state, { roleSelect, hint }) {
  // A new picker reports its first suggestions before it is stored.
  if (!state.picker) return;
  const selection = state.picker.selection();
  // Before a selection: the roles the server accepts for anyone offered so
  // far (the first page and the current search).
  const known = [...state.candidates, ...state.suggestions];
  const roles = inviteRoles(selection, known);
  const role = preferredRole(state.kind, roles, state.inviteRole);
  roleSelect.replaceChildren(
    ...(roles.length > 0
      ? roles.map(roleOption)
      : [h("option", { value: "" }, "No role")]),
  );
  roleSelect.disabled = roles.length === 0 || state.busy;
  if (role) roleSelect.value = role;
  // Before a selection: why some suggestions on offer can't be added; with
  // one: the server's notes on it (viewer accounts only view).
  const reasons =
    selection.length > 0 ? [] : ineligibleReasons(state.suggestions);
  hint.textContent =
    reasons.length > 0
      ? `Some people can’t be added: ${reasons.join(" · ")}`
      : selectionNotes(selection).join(" ");
  hint.hidden = hint.textContent === "";
}

function invitePicker(state) {
  return peoplePicker({
    label: "Add people or teams",
    focusKey: "share-picker",
    describedBy: "share-invite-hint",
    search: (query) => state.actions.searchCandidates(query),
    initial: state.candidates,
    emptyText: "Nobody else can be added",
    onChange: () => state.syncInvite?.(),
    onSuggestions: (shown) => {
      state.suggestions = shown;
      state.syncInvite?.();
    },
  });
}

function inviteSection(state) {
  const { resource } = state;
  if (!resource.canManage) {
    return h(
      "p",
      { class: "share-readonly" },
      icon("info", { size: 14 }),
      `Only owners can change who has access to this ${kindInfo(state.kind).label.toLowerCase()}.`,
    );
  }
  const hint = h("p", {
    class: "field-hint share-hint",
    id: "share-invite-hint",
    hidden: true,
  });
  const roleSelect = h("select", {
    class: "input input-small share-role",
    "aria-label": "Role for new members",
    dataset: { focusKey: "share-invite-role" },
    on: {
      change: (event) => (state.inviteRole = event.currentTarget.value),
    },
  });
  state.picker ??= invitePicker(state);
  // The picker outlives re-renders; its callbacks reach the current row.
  state.syncInvite = () => syncInvite(state, { roleSelect, hint });
  state.syncInvite();
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

const memberKey = (member) => `${member.kind}:${member.id}`;

/**
 * The role control of a member row, from its server verdicts: a button
 * opening a menu of the roles the server offers (current one checked).
 */
function roleControl(state, member) {
  const { resource } = state;
  const label = accessRole(member.role).label;
  if (!resource.canManage || member.roleOptions.length === 0) {
    return h("span", { class: "share-role-text" }, label);
  }
  const roles = member.roleOptions.includes(member.role)
    ? member.roleOptions
    : [member.role, ...member.roleOptions];
  let disabledReason = state.busy ? "Saving…" : null;
  if (!member.canChangeRole) {
    disabledReason = member.reason ?? "This role can’t be changed";
  }
  const trigger = button({
    label,
    iconEnd: "chevronDown",
    variant: "ghost",
    size: "sm",
    className: "share-role-button",
    ariaLabel: `Role of ${member.name}: ${label}`,
    dataset: { focusKey: `share-role:${memberKey(member)}` },
    disabledReason,
    onClick: () =>
      openMenu({
        anchor: trigger,
        label: `Role of ${member.name}`,
        items: roles.map((role) => ({
          label: accessRole(role).label,
          hint: accessRole(role).description,
          checked: role === member.role,
          onSelect: () => state.actions.changeRole(member, role),
        })),
      }),
  });
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  return trigger;
}

function memberRow(state, member) {
  const { resource } = state;
  // The server's explanation (last owner, viewer account, deactivated…).
  const note = member.reason;
  const self = member.kind === "user" && member.id === String(state.ctx.me.id);
  const detail =
    member.kind === "team" ? teamDetail(member.memberCount) : member.email;
  let removeReason = state.busy ? "Saving…" : null;
  if (!member.canRemove) removeReason = note ?? "This member can’t be removed";
  return h(
    "li",
    { class: "share-member", dataset: { member: memberKey(member) } },
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
      note
        ? h("span", { class: "share-member-detail share-owner-note" }, note)
        : null,
    ),
    h(
      "span",
      { class: "share-member-controls" },
      member.accountRole === "guest" || member.accountRole === "viewer"
        ? roleBadge(member.accountRole)
        : null,
      roleControl(state, member),
      resource.canManage
        ? iconButton({
            icon: "trash",
            label: `Remove ${member.name}`,
            size: "sm",
            disabledReason: removeReason,
            dataset: { focusKey: `share-remove:${memberKey(member)}` },
            onClick: () => state.actions.removeMember(member),
          })
        : null,
    ),
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
      {
        class: "share-heading",
        id: "share-members-heading",
        tabindex: "-1",
        dataset: { focusKey: "share-members-heading" },
      },
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

/** Focuses `state.focusKey`'s control once it is usable again. */
function restoreFocus(state) {
  if (!state.focusKey || state.busy) return;
  const target = findByFocusKey(state.dialog.body, state.focusKey);
  if (!target || target.disabled) return;
  state.focusKey = null;
  // The picker's list stays closed, so the new members stay in view.
  if (state.picker?.element.contains(target))
    state.picker.focus({ open: false });
  else target.focus();
}

/**
 * Renders the dialog body for `state` (see `share-dialog.js`): loading,
 * unavailable, or the error banner, visibility, invite and member sections.
 * Changes go through `state.actions`; after one, focus returns to the
 * control `state.focusKey` names.
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
  restoreFocus(state);
}
