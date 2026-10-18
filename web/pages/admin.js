/**
 * Admin (`#/admin` users, `#/admin/content` content directory), for
 * admins only (`can(me, "manage_users")`; the server refuses every admin
 * operation to anyone else).
 *
 * Users: account stats, the people table (role dropdown, deactivate /
 * activate with confirmation, never on yourself), "Invite user" and the
 * role legend. Content: every board and doc with privacy, owner and
 * workspace, and "Take ownership" with a confirmation. Both tabs share one
 * mount (the router keeps the page when the tab changes) and keep their
 * data until the page is left; every change reloads from the server.
 */

import { h } from "../dom.js";
import {
  adminContentHash,
  adminHash,
  boardHash,
  docHash,
  homeHash,
} from "../router.js";
import {
  ADMIN_CONTENT_QUERY,
  ADMIN_MUTATIONS,
  ADMIN_USERS_QUERY,
  contentRows,
  parseRoleCounts,
  roleChoices,
} from "../ui/admin/admin-data.js";
import { contentDirectory } from "../ui/admin/content-directory.js";
import { accountStats, roleLegend } from "../ui/admin/overview.js";
import { usersPanel } from "../ui/admin/users-table.js";
import { button } from "../ui/components/button.js";
import { emptyState } from "../ui/components/empty-state.js";
import { accountRole } from "../ui/components/labels.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { can } from "../ui/components/permissions.js";
import { skeletonCards, skeletonList } from "../ui/components/skeleton.js";
import { tabs } from "../ui/components/tabs.js";

const TABS = Object.freeze({
  users: { label: "Users", icon: "users", href: adminHash(), title: "Admin" },
  content: {
    label: "Content",
    icon: "grid",
    href: adminContentHash(),
    title: "Content directory",
  },
});

function adminsOnly() {
  return h(
    "div",
    { class: "page-container" },
    emptyState({
      icon: "admin",
      headingLevel: 1,
      title: "Only admins can open Admin",
      text: "Ask an admin if you need a user, role or ownership change.",
      action: { label: "Go to Home", icon: "home", href: homeHash() },
    }),
  );
}

function failure(error, retry) {
  return emptyState({
    icon: "alert",
    title: "Couldn’t load this section",
    text: error?.message || "Something went wrong.",
    action: { label: "Try again", icon: "refresh", onClick: retry },
  });
}

const roleLabel = (role) => accountRole(role).label;

// ------------------------------------------------------------------ users

async function loadUsers(a) {
  const data = await a.ctx.api.request(ADMIN_USERS_QUERY);
  a.users = {
    account: data.account,
    roleCounts: parseRoleCounts(data.account.role_counts_json),
    teamCount: data.teams.length,
    list: data.users.map((user) => ({ ...user, id: String(user.id) })),
  };
}

function drawUsers(a) {
  const { users } = a;
  a.statsSlot.replaceChildren(
    accountStats({
      account: users.account,
      users: users.list,
      roleCounts: users.roleCounts,
      teamCount: users.teamCount,
    }),
  );
  a.usersPanel.update(users.list);
}

async function reloadUsers(a) {
  try {
    await loadUsers(a);
    if (a.active) drawUsers(a);
  } catch (error) {
    a.ctx.toast.error(error, "Couldn’t refresh the people list");
  }
}

async function changeRole(a, user, role) {
  const { ctx } = a;
  if (role === user.role) return true;
  if (role === "admin" || user.role === "admin") {
    const promote = role === "admin";
    const confirmed = await ctx.dialog.confirm({
      title: promote
        ? `Make ${user.name} an admin?`
        : `Remove ${user.name}’s admin role?`,
      message: promote
        ? "Admins manage users and roles, see every board and doc title, and can take ownership of content."
        : `They become a ${roleLabel(role).toLowerCase()} and lose access to Admin.`,
      confirmButton: promote ? "Make admin" : "Change role",
      danger: !promote,
    });
    if (!confirmed) return false;
  }
  try {
    await ctx.api.request(ADMIN_MUTATIONS.setRole, { userId: user.id, role });
  } catch (error) {
    ctx.toast.error(error, "Couldn’t change the role");
    return false;
  }
  ctx.toast.show({
    message: `${user.name} is now ${role === "admin" ? "an" : "a"} ${roleLabel(role).toLowerCase()}`,
    type: "success",
    action: {
      label: "Undo",
      onClick: () => changeRole(a, { ...user, role }, user.role),
    },
  });
  await reloadUsers(a);
  return true;
}

async function changeStatus(a, user) {
  const { ctx } = a;
  const deactivate = user.status !== "deactivated";
  const confirmed = await ctx.dialog.confirm({
    title: deactivate ? `Deactivate ${user.name}?` : `Activate ${user.name}?`,
    message: deactivate
      ? "They are signed out at once and can’t sign in or use API tokens. Their boards, docs and notes stay, and you can activate them again later."
      : "They can sign in again and get back the access they had.",
    confirmButton: deactivate ? "Deactivate" : "Activate",
    danger: deactivate,
  });
  if (!confirmed) return;
  try {
    await ctx.api.request(
      deactivate ? ADMIN_MUTATIONS.deactivate : ADMIN_MUTATIONS.activate,
      { userId: user.id },
    );
    ctx.toast.success(
      `${user.name} is ${deactivate ? "deactivated" : "active again"}`,
    );
  } catch (error) {
    ctx.toast.error(error, "Couldn’t change the status");
    return;
  }
  await reloadUsers(a);
  ctx.refreshShell();
}

function inviteFields(values) {
  return [
    {
      name: "name",
      label: "Full name",
      required: true,
      autofocus: true,
      value: values.name,
    },
    {
      name: "email",
      label: "Email",
      type: "email",
      required: true,
      value: values.email,
    },
    { name: "title", label: "Job title (optional)", value: values.title },
    {
      name: "role",
      label: "Account role",
      type: "choice",
      value: values.role,
      options: roleChoices(),
    },
  ];
}

async function invite(a) {
  const { ctx } = a;
  let values = { name: "", email: "", title: "", role: "member" };
  for (;;) {
    const result = await ctx.dialog.form({
      title: "Invite user",
      description:
        "They join the account with this role. Emails must be unique.",
      submitLabel: "Invite",
      size: "md",
      fields: inviteFields(values),
    });
    if (!result) return;
    values = result;
    try {
      await ctx.api.request(ADMIN_MUTATIONS.invite, {
        ...values,
        title: values.title || null,
      });
      break;
    } catch (error) {
      // Keep what was typed and ask again (e.g. the email is taken).
      ctx.toast.error(error, "Couldn’t invite this person");
    }
  }
  ctx.toast.success(
    `${values.name} joined as ${roleLabel(values.role).toLowerCase()}`,
  );
  if (a.users) await reloadUsers(a);
  ctx.refreshShell();
}

function usersView(a) {
  a.statsSlot = h("div", { class: "admin-stats" });
  a.usersPanel = usersPanel({
    users: [],
    me: () => a.ctx.me,
    onRole: (user, role) => changeRole(a, user, role),
    onStatus: (user) => changeStatus(a, user),
  });
  drawUsers(a);
  return h(
    "div",
    { class: "admin-section" },
    a.statsSlot,
    a.usersPanel.element,
    roleLegend(),
  );
}

// ---------------------------------------------------------------- content

async function loadContent(a) {
  a.content = contentRows(await a.ctx.api.request(ADMIN_CONTENT_QUERY));
}

async function takeOwnership(a, row) {
  const { ctx } = a;
  const board = row.kind === "board";
  const confirmed = await ctx.dialog.confirm({
    title: `Take ownership of “${row.title}”?`,
    message: board
      ? "You become an owner of this board. The board’s activity log records it, and its members see you in the members list."
      : "You become an owner of this doc. Its members see you in the members list.",
    confirmButton: "Take ownership",
  });
  if (!confirmed) return;
  try {
    await ctx.api.request(ADMIN_MUTATIONS.takeOwnership, {
      kind: row.kind,
      id: row.id,
    });
  } catch (error) {
    ctx.toast.error(error, "Couldn’t take ownership");
    return;
  }
  ctx.toast.show({
    message: `You’re now an owner of “${row.title}”`,
    type: "success",
    action: {
      label: "Open",
      onClick: () =>
        ctx.router.navigate(board ? boardHash(row.id) : docHash(row.id)),
    },
  });
  try {
    await loadContent(a);
    if (a.active) a.contentView.update(a.content);
  } catch (error) {
    ctx.toast.error(error, "Couldn’t refresh the directory");
  }
  ctx.refreshShell();
}

function contentView(a) {
  a.contentView = contentDirectory({
    rows: a.content,
    onTakeOwnership: (row) => takeOwnership(a, row),
  });
  return h("div", { class: "admin-section" }, a.contentView.element);
}

// ------------------------------------------------------------------ tabs

const SECTIONS = {
  users: {
    loaded: (a) => Boolean(a.users),
    load: loadUsers,
    view: usersView,
    placeholder: () => [
      skeletonCards({ count: 4, label: "Loading stats" }),
      skeletonList({ rows: 6 }),
    ],
  },
  content: {
    loaded: (a) => Boolean(a.content),
    load: loadContent,
    view: contentView,
    placeholder: () => [skeletonList({ rows: 8, label: "Loading content" })],
  },
};

async function showTab(a, tab) {
  const name = Object.hasOwn(SECTIONS, tab) ? tab : "users";
  a.tab = name;
  setDocumentTitle(TABS[name].title);
  a.tabsSlot.replaceChildren(
    tabs({
      label: "Admin sections",
      items: Object.entries(TABS).map(([id, info]) => ({ id, ...info })),
      active: name,
    }),
  );
  const section = SECTIONS[name];
  if (!a.views[name]) {
    a.body.replaceChildren(...section.placeholder());
    try {
      if (!section.loaded(a)) await section.load(a);
    } catch (error) {
      if (a.active && a.tab === name) {
        a.body.replaceChildren(failure(error, () => showTab(a, name)));
      }
      return;
    }
    if (!a.active) return;
    a.views[name] = section.view(a);
  }
  if (a.tab === name) a.body.replaceChildren(a.views[name]);
}

/** Page contract. */
export async function mount(container, ctx, params) {
  const a = {
    ctx,
    tab: null,
    active: true,
    views: {},
    users: null,
    content: null,
  };
  setDocumentTitle("Admin");
  if (!can(ctx.me, "manage_users")) {
    // Both tabs show the same message, so tab changes need no handling.
    container.append(adminsOnly());
    return undefined;
  }
  const off = ctx.router.onChange((route) => {
    if (route.name === "admin" && a.active && route.params.tab !== a.tab) {
      showTab(a, route.params.tab);
    }
  });
  a.tabsSlot = h("div", { class: "page-toolbar" });
  a.body = h("div", { class: "page-body" });
  container.append(
    h(
      "div",
      { class: "page-container admin-page" },
      pageHeader({
        title: "Admin",
        icon: "admin",
        subtitle: "People, roles and content across the account",
        actions: [
          button({
            label: "Invite user",
            icon: "userPlus",
            variant: "primary",
            onClick: () => invite(a),
          }),
        ],
      }),
      a.tabsSlot,
      a.body,
    ),
  );
  showTab(a, params.tab);
  return () => {
    a.active = false;
    off();
  };
}
