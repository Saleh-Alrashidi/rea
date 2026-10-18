/**
 * The admin users table: avatar, name and email, title, account role (a
 * dropdown), status, teams and a deactivate / activate action, with a
 * search box. Admins never act on themselves and the last active admin
 * keeps the role; those rows show why instead of a control
 * (`admin-data.userActions`). The page runs the mutations
 * (`onRole(user, role)`, `onStatus(user)`).
 */

import { h } from "../../dom.js";
import { teamHash } from "../../router.js";
import { avatar } from "../components/avatar.js";
import { badge, roleBadge } from "../components/badge.js";
import { button } from "../components/button.js";
import { plural } from "../components/format.js";
import { icon } from "../components/icon.js";
import { filterUsers, roleChoices, userActions } from "./admin-data.js";

const MAX_TEAM_CHIPS = 2;

function personCell(user, me) {
  return h(
    "th",
    { scope: "row", class: "admin-sticky" },
    h(
      "div",
      { class: "admin-person" },
      avatar(user, { size: "sm", title: null }),
      h(
        "div",
        { class: "admin-person-text" },
        h(
          "span",
          { class: "admin-person-name" },
          user.name,
          String(user.id) === String(me.id)
            ? h("span", { class: "admin-you" }, " (you)")
            : null,
        ),
        h("span", { class: "admin-person-email" }, user.email),
      ),
    ),
  );
}

function roleCell(t, user, reason) {
  if (reason) {
    return h(
      "td",
      null,
      h(
        "span",
        { class: "admin-role-fixed", title: reason },
        roleBadge(user.role),
        h("span", { class: "visually-hidden" }, `: ${reason}`),
      ),
    );
  }
  const select = h(
    "select",
    {
      class: "input input-small admin-role-select",
      "aria-label": `Account role of ${user.name}`,
      value: user.role,
      on: {
        change: async (event) => {
          const next = event.currentTarget.value;
          const applied = await t.onRole(user, next);
          // A cancelled or failed change shows the current role again.
          if (!applied && select.isConnected) select.value = user.role;
        },
      },
    },
    roleChoices().map((choice) =>
      h("option", { value: choice.value }, choice.label),
    ),
  );
  return h("td", null, select);
}

function statusCell(user) {
  const active = user.status !== "deactivated";
  return h(
    "td",
    null,
    badge(active ? "Active" : "Deactivated", {
      tone: active ? "success" : "neutral",
      icon: active ? "check" : "lock",
    }),
  );
}

function teamsCell(user) {
  const teams = user.teams ?? [];
  if (teams.length === 0) {
    return h("td", { class: "admin-muted" }, "No teams");
  }
  const shown = teams.slice(0, MAX_TEAM_CHIPS);
  const extra = teams.length - shown.length;
  return h(
    "td",
    null,
    h(
      "div",
      { class: "admin-chips" },
      shown.map((team) =>
        h("a", { class: "admin-chip", href: teamHash(team.id) }, team.name),
      ),
      extra > 0
        ? h(
            "span",
            {
              class: "admin-chip more",
              title: teams.map((team) => team.name).join(", "),
            },
            `+${extra}`,
          )
        : null,
    ),
  );
}

function actionCell(t, user, reason) {
  const deactivated = user.status === "deactivated";
  return h(
    "td",
    { class: "admin-actions" },
    button({
      label: deactivated ? "Activate" : "Deactivate",
      icon: deactivated ? "refresh" : "lock",
      size: "sm",
      variant: deactivated ? "secondary" : "ghost",
      disabledReason: reason,
      ariaLabel: `${deactivated ? "Activate" : "Deactivate"} ${user.name}`,
      onClick: () => t.onStatus(user),
    }),
  );
}

function userRow(t, user) {
  const actions = userActions(t.me(), user, t.users);
  return h(
    "tr",
    {
      class: ["admin-row", user.status === "deactivated" && "is-deactivated"],
    },
    personCell(user, t.me()),
    h("td", { class: user.title ? null : "admin-muted" }, user.title || "—"),
    roleCell(t, user, actions.roleReason),
    statusCell(user),
    teamsCell(user),
    actionCell(t, user, actions.statusReason),
  );
}

function renderRows(t) {
  const shown = filterUsers(t.users, t.query);
  t.count.textContent = t.query.trim()
    ? `${shown.length} of ${plural(t.users.length, "person", "people")}`
    : plural(t.users.length, "person", "people");
  t.body.replaceChildren(
    ...(shown.length > 0
      ? shown.map((user) => userRow(t, user))
      : [
          h(
            "tr",
            null,
            h(
              "td",
              { colspan: "6", class: "admin-empty-row" },
              `No one matches “${t.query.trim()}”.`,
            ),
          ),
        ]),
  );
}

/**
 * @param {{ users: object[], me: () => object,
 *   onRole: (user: object, role: string) => Promise<boolean>,
 *   onStatus: (user: object) => void }} options
 * @returns {{ element: HTMLElement, update(users: object[]): void }}
 */
export function usersPanel(options) {
  const t = {
    ...options,
    query: "",
    body: h("tbody"),
    count: h("span", { class: "admin-count", role: "status" }),
  };
  const search = h(
    "label",
    { class: "admin-search" },
    icon("search", { size: 14 }),
    h("input", {
      class: "input input-small",
      type: "search",
      placeholder: "Search people",
      "aria-label": "Search people by name, email or title",
      on: {
        input: (event) => {
          t.query = event.currentTarget.value;
          renderRows(t);
        },
      },
    }),
  );
  const element = h(
    "section",
    { class: "panel admin-users", "aria-labelledby": "admin-users-title" },
    h(
      "div",
      { class: "panel-header admin-toolbar" },
      h(
        "h2",
        { class: "panel-title", id: "admin-users-title" },
        icon("users"),
        "People",
      ),
      t.count,
      search,
    ),
    h(
      "div",
      { class: "admin-table-scroll" },
      h(
        "table",
        { class: "admin-table" },
        h("caption", { class: "visually-hidden" }, "People in this account"),
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["Name", "Title", "Role", "Status", "Teams"].map((label, index) =>
              h(
                "th",
                { scope: "col", class: index === 0 ? "admin-sticky" : null },
                label,
              ),
            ),
            h(
              "th",
              { scope: "col" },
              h("span", { class: "visually-hidden" }, "Actions"),
            ),
          ),
        ),
        t.body,
      ),
    ),
  );
  renderRows(t);
  return {
    element,
    update(users) {
      t.users = users;
      renderRows(t);
    },
  };
}
