/**
 * Admin overview pieces: the account stats tiles and the role legend that
 * explains what each account role can do (SPEC-2 §1.1).
 *
 * The account-level rows of the legend are read from `permissions.can()`,
 * the client's one table of account capabilities, so the legend can never
 * disagree with the controls the app offers. The access rows describe the
 * resource rules the server applies (`server/access.js`).
 */

import { h } from "../../dom.js";
import { roleBadge } from "../components/badge.js";
import { icon } from "../components/icon.js";
import { ACCOUNT_ROLES } from "../components/labels.js";
import { can } from "../components/permissions.js";
import { ROLE_ORDER } from "./admin-data.js";

const CAPABILITY_ROWS = Object.freeze([
  ["manage_users", "Manage users and account roles"],
  ["admin_directory", "See the content directory (titles and owners only)"],
  ["create_workspace", "Create workspaces and teams"],
  ["create_content", "Create boards, docs and forms where they can edit"],
  ["create_note", "Write personal notes"],
]);

const ACCESS_ROWS = Object.freeze([
  {
    label: "Main boards and workspace docs in their workspaces",
    cells: { admin: "Edit", member: "Edit", viewer: "View", guest: false },
  },
  {
    label: "Can be added to private boards",
    cells: { admin: true, member: true, viewer: true, guest: false },
  },
  {
    label: "Can be added to shareable boards, docs and notes",
    cells: { admin: true, member: true, viewer: true, guest: true },
  },
  {
    label: "Edits what they can open",
    cells: {
      admin: "Per resource",
      member: "Per resource",
      viewer: "Never",
      guest: "Per resource",
    },
  },
]);

/**
 * The legend's rows: `{ label, cells: { [role]: true | false | string } }`,
 * account capabilities first (from `can()`), then access rules.
 */
export function legendRows() {
  const capabilityRows = CAPABILITY_ROWS.map(([capability, label]) => ({
    label,
    cells: Object.fromEntries(
      ROLE_ORDER.map((role) => [
        role,
        can({ id: "0", role, status: "active" }, capability),
      ]),
    ),
  }));
  return [...capabilityRows, ...ACCESS_ROWS];
}

function cell(value) {
  if (value === true) {
    return h(
      "td",
      { class: "role-cell yes" },
      icon("check", { size: 16 }),
      h("span", { class: "visually-hidden" }, "Yes"),
    );
  }
  if (value === false) {
    return h(
      "td",
      { class: "role-cell no" },
      h("span", { "aria-hidden": "true" }, "—"),
      h("span", { class: "visually-hidden" }, "No"),
    );
  }
  return h("td", { class: "role-cell text" }, value);
}

function roleCards() {
  return h(
    "ul",
    { class: "role-cards" },
    ROLE_ORDER.map((role) =>
      h(
        "li",
        { class: "role-card" },
        roleBadge(role),
        h("p", { class: "role-card-text" }, ACCOUNT_ROLES[role].description),
      ),
    ),
  );
}

/** The role legend panel: one card per role and a capability table. */
export function roleLegend() {
  return h(
    "section",
    { class: "panel admin-legend", "aria-labelledby": "role-legend-title" },
    h(
      "div",
      { class: "panel-header" },
      h(
        "h2",
        { class: "panel-title", id: "role-legend-title" },
        icon("admin"),
        "What each role can do",
      ),
    ),
    h(
      "div",
      { class: "panel-body" },
      roleCards(),
      h(
        "div",
        { class: "admin-table-scroll" },
        h(
          "table",
          { class: "admin-table role-table" },
          h("caption", { class: "visually-hidden" }, "Capabilities by role"),
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, "Capability"),
              ROLE_ORDER.map((role) =>
                h("th", { scope: "col" }, ACCOUNT_ROLES[role].label),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            legendRows().map((row) =>
              h(
                "tr",
                null,
                h("th", { scope: "row" }, row.label),
                ROLE_ORDER.map((role) => cell(row.cells[role])),
              ),
            ),
          ),
        ),
      ),
      h(
        "p",
        { class: "admin-note" },
        icon("info", { size: 14 }),
        "Admins have no automatic access to private or shareable boards, private docs or anyone’s notes. Taking ownership from the content directory is recorded and visible to the owners.",
      ),
    ),
  );
}

function tile({ label, value, detail, iconName }) {
  return h(
    "div",
    { class: "stat-tile" },
    h("span", { class: "stat-icon" }, icon(iconName, { size: 18 })),
    h(
      "div",
      { class: "stat-text" },
      h("span", { class: "stat-value" }, value),
      h("span", { class: "stat-label" }, label),
      detail ? h("span", { class: "stat-detail" }, detail) : null,
    ),
  );
}

/**
 * Account stats tiles.
 * @param {{ account: object, users: object[], roleCounts: object,
 *   teamCount: number }} data
 */
export function accountStats({ account, users, roleCounts, teamCount }) {
  const deactivated = users.filter(
    (user) => user.status === "deactivated",
  ).length;
  const roles = ROLE_ORDER.filter((role) => roleCounts[role] > 0)
    .map(
      (role) =>
        `${roleCounts[role]} ${ACCOUNT_ROLES[role].label.toLowerCase()}${roleCounts[role] === 1 ? "" : "s"}`,
    )
    .join(" · ");
  return h(
    "div",
    { class: "stat-tiles", role: "list", "aria-label": "Account stats" },
    [
      tile({
        label: "People",
        value: String(account.user_count),
        detail: roles,
        iconName: "users",
      }),
      tile({
        label: "Active",
        value: String(users.length - deactivated),
        detail:
          deactivated > 0 ? `${deactivated} deactivated` : "No one deactivated",
        iconName: "person",
      }),
      tile({
        label: "Guests",
        value: String(roleCounts.guest),
        detail: "See only what is shared with them",
        iconName: "shared",
      }),
      tile({
        label: "Teams",
        value: String(teamCount),
        detail: "Share with a whole group at once",
        iconName: "team",
      }),
    ].map((node) => {
      node.setAttribute("role", "listitem");
      return node;
    }),
  );
}
