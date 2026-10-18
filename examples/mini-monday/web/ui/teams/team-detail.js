/**
 * A team page (`#/teams/<id>`): owners and members, and for team owners
 * and admins (`can_manage`) adding people (optionally as owners), making
 * someone an owner or a member, removing people, editing the name and
 * description and deleting the team. Rules for disabled controls come from
 * `teams-data.memberActions`; the server enforces them again.
 *
 * Every change runs one mutation and then `onChanged()`, which reloads the
 * team; `onDeleted()` runs after the team is gone.
 */

import { h } from "../../dom.js";
import { teamsHash } from "../../router.js";
import { avatar, teamAvatar } from "../components/avatar.js";
import { badge } from "../components/badge.js";
import { button } from "../components/button.js";
import { loadDirectory } from "../components/directory.js";
import { plural } from "../components/format.js";
import { icon } from "../components/icon.js";
import { menuButton } from "../components/menu.js";
import { pageHeader } from "../components/page-header.js";
import { peoplePicker } from "../components/people-picker.js";
import { TEAM_MUTATIONS, memberActions } from "./teams-data.js";

async function run(t, { query, variables, success, failure }) {
  try {
    await t.ctx.api.request(query, { teamId: t.team.id, ...variables });
  } catch (error) {
    t.ctx.toast.error(error, failure);
    return false;
  }
  if (success) t.ctx.toast.success(success);
  t.ctx.refreshShell();
  await t.onChanged();
  return true;
}

function setRole(t, member, role) {
  const owner = role === "owner";
  return run(t, {
    query: TEAM_MUTATIONS.setRole,
    variables: { userId: member.id, role: owner ? "owner" : "member" },
    success: `${member.name} is now ${owner ? "an owner" : "a member"}`,
    failure: "Couldn’t change the role",
  });
}

async function removeMember(t, member) {
  const self = member.id === t.ctx.me.id;
  const confirmed = await t.ctx.dialog.confirm({
    title: self
      ? `Leave ${t.team.name}?`
      : `Remove ${member.name} from ${t.team.name}?`,
    message: self
      ? "You lose access to anything shared only with this team."
      : "They lose access to anything shared only with this team.",
    confirmButton: self ? "Leave team" : "Remove",
    danger: true,
  });
  if (!confirmed) return;
  await run(t, {
    query: TEAM_MUTATIONS.removeMembers,
    variables: { userIds: [member.id] },
    success: self ? `You left ${t.team.name}` : `${member.name} was removed`,
    failure: "Couldn’t remove this person",
  });
}

function memberMenu(t, member) {
  const actions = memberActions(t.team, member);
  const self = member.id === t.ctx.me.id;
  return menuButton({
    label: `Actions for ${member.name}`,
    size: "sm",
    items: () => [
      member.role === "owner"
        ? {
            label: "Make member",
            icon: "person",
            disabledReason: actions.demote,
            onSelect: () => setRole(t, member, "member"),
          }
        : {
            label: "Make owner",
            icon: "admin",
            disabledReason: actions.promote,
            onSelect: () => setRole(t, member, "owner"),
          },
      { type: "separator" },
      {
        label: self ? "Leave team" : "Remove from team",
        icon: "trash",
        danger: true,
        disabledReason: actions.remove,
        onSelect: () => removeMember(t, member),
      },
    ],
  });
}

function memberRow(t, member) {
  const self = member.id === t.ctx.me.id;
  return h(
    "li",
    {
      class: ["preview-row", member.status === "deactivated" && "is-inactive"],
    },
    avatar(member, { size: "md", title: null }),
    h(
      "div",
      { class: "preview-main" },
      h(
        "span",
        { class: "preview-title" },
        member.name,
        self ? h("span", { class: "admin-you" }, " (you)") : null,
      ),
      h(
        "span",
        { class: "preview-subtitle" },
        member.title || member.email || "",
      ),
    ),
    member.status === "deactivated"
      ? badge("Deactivated", { tone: "neutral", icon: "lock" })
      : null,
    t.team.canManage ? memberMenu(t, member) : null,
  );
}

function memberGroup(t, { title, members, empty }) {
  return h(
    "section",
    { class: "team-group" },
    h(
      "h3",
      { class: "team-group-title" },
      title,
      h("span", { class: "team-group-count" }, String(members.length)),
    ),
    members.length > 0
      ? h(
          "ul",
          { class: "preview-list" },
          members.map((member) => memberRow(t, member)),
        )
      : h("p", { class: "team-group-empty" }, empty),
  );
}

async function addPanel(t) {
  const directory = await loadDirectory();
  const excluded = new Set(t.team.members.map((member) => `user:${member.id}`));
  const ownerBox = h("input", { type: "checkbox", class: "team-owner-box" });
  let add = null;
  const picker = peoplePicker({
    users: directory.userList,
    allowTeams: false,
    excluded,
    label: "Add people to the team",
    placeholder: "Search people to add",
    onChange: (selection) => {
      add.disabled = selection.length === 0;
    },
  });
  add = button({
    label: "Add",
    icon: "userPlus",
    variant: "primary",
    disabled: true,
    onClick: async () => {
      const people = picker.selection();
      if (people.length === 0) return;
      await run(t, {
        query: TEAM_MUTATIONS.addMembers,
        variables: {
          userIds: people.map((person) => person.id),
          asOwner: ownerBox.checked,
        },
        success: `Added ${plural(people.length, "person", "people")}`,
        failure: "Couldn’t add these people",
      });
    },
  });
  return h(
    "section",
    { class: "panel team-add" },
    h(
      "div",
      { class: "panel-header" },
      h("h2", { class: "panel-title" }, icon("userPlus"), "Add people"),
    ),
    h(
      "div",
      { class: "panel-body team-add-body" },
      h("div", { class: "team-add-row" }, picker.element, add),
      h(
        "label",
        { class: "team-owner-option" },
        ownerBox,
        h("span", null, "Add as owners (they can manage the team)"),
      ),
    ),
  );
}

async function editDetails(t) {
  const values = await t.ctx.dialog.form({
    title: "Edit team",
    submitLabel: "Save",
    fields: [
      {
        name: "name",
        label: "Team name",
        required: true,
        autofocus: true,
        value: t.team.name,
      },
      {
        name: "description",
        label: "Description",
        type: "textarea",
        value: t.team.description,
      },
    ],
  });
  if (!values?.name) return;
  await run(t, {
    query: TEAM_MUTATIONS.update,
    variables: values,
    success: "Team updated",
    failure: "Couldn’t update the team",
  });
}

async function deleteTeam(t) {
  const confirmed = await t.ctx.dialog.confirm({
    title: `Delete ${t.team.name}?`,
    message:
      "Everything shared with this team is unshared from it. People keep what was shared with them directly. This can’t be undone.",
    confirmButton: "Delete team",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await t.ctx.api.request(TEAM_MUTATIONS.remove, { teamId: t.team.id });
  } catch (error) {
    t.ctx.toast.error(error, "Couldn’t delete the team");
    return;
  }
  t.ctx.toast.success(`${t.team.name} was deleted`);
  await t.ctx.refreshShell();
  t.onDeleted();
}

function header(t) {
  const { team } = t;
  return pageHeader({
    eyebrow: h(
      "a",
      { class: "page-back", href: teamsHash() },
      icon("chevronLeft", { size: 14 }),
      "Teams",
    ),
    title: team.name,
    subtitle: team.description || null,
    badges: [
      team.myRole === "owner"
        ? badge("You own this team", { tone: "primary" })
        : null,
      team.myRole === "member" ? badge("You’re a member") : null,
    ],
    actions: team.canManage
      ? [
          menuButton({
            label: "Team actions",
            items: [
              {
                label: "Edit name and description",
                icon: "edit",
                onSelect: () => editDetails(t),
              },
              { type: "separator" },
              {
                label: "Delete team",
                icon: "trash",
                danger: true,
                onSelect: () => deleteTeam(t),
              },
            ],
          }),
        ]
      : [],
  });
}

/**
 * Builds the team page content.
 * @param {object} ctx the page context
 * @param {{ team: object, onChanged: () => Promise<void>,
 *   onDeleted: () => void }} options
 * @returns {Promise<HTMLElement>}
 */
export async function teamDetail(ctx, { team, onChanged, onDeleted }) {
  const t = { ctx, team, onChanged, onDeleted };
  const owners = team.members.filter((member) => member.role === "owner");
  const members = team.members.filter((member) => member.role !== "owner");
  const head = header(t);
  head
    .querySelector(".page-heading")
    ?.prepend(teamAvatar(team, { size: "lg" }));
  return h(
    "div",
    { class: "page-container team-page" },
    head,
    h(
      "div",
      { class: "team-layout" },
      h(
        "section",
        { class: "panel team-roster", "aria-label": "Team members" },
        h(
          "div",
          { class: "panel-header" },
          h(
            "h2",
            { class: "panel-title" },
            icon("users"),
            plural(team.members.length, "person", "people"),
          ),
          team.canManage
            ? null
            : h(
                "span",
                { class: "team-hint" },
                "Only owners and admins can change members",
              ),
        ),
        h(
          "div",
          { class: "panel-body" },
          memberGroup(t, {
            title: "Owners",
            members: owners,
            empty: "No owners",
          }),
          memberGroup(t, {
            title: "Members",
            members,
            empty: "No other members yet.",
          }),
        ),
      ),
      team.canManage ? await addPanel(t) : null,
    ),
  );
}
