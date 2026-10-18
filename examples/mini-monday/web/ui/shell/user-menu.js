/**
 * User menu: the signed-in user's avatar opens a menu with their name,
 * email and role badge, "Switch user (demo)" listing the demo users with
 * role badges (only when demo sign-in is on), and "Sign out".
 *
 * Switching or signing out reloads the page: every loaded record belongs
 * to the previous session.
 */

import { demoLogin, listDemoUsers, logout } from "../../api.js";
import { h } from "../../dom.js";
import { homeHash } from "../../router.js";
import { avatar } from "../components/avatar.js";
import { roleBadge } from "../components/badge.js";
import { openMenu } from "../components/menu.js";

function identity(me) {
  return h(
    "div",
    { class: "user-menu-identity" },
    avatar(me, { size: "lg", title: null }),
    h(
      "div",
      { class: "user-menu-text" },
      h("span", { class: "user-menu-name" }, me.name),
      h("span", { class: "user-menu-email" }, me.email ?? ""),
      h(
        "span",
        { class: "user-menu-role" },
        roleBadge(me.role),
        me.title ? h("span", { class: "user-menu-title" }, me.title) : null,
      ),
    ),
  );
}

function reloadHome() {
  // replaceState fires no hashchange, so the old session's page does not
  // mount Home (and start requests the reload would abort) first.
  globalThis.history.replaceState(null, "", homeHash());
  globalThis.location.reload();
}

/**
 * Creates the avatar button. `getMe()` returns the current user record.
 * @param {{ getMe(): object, toast: object }} options
 * @returns {{ element: HTMLElement, update(): void }}
 */
export function createUserMenu({ getMe, toast }) {
  let demoUsers;

  async function switchTo(user) {
    try {
      await demoLogin(user.id);
      reloadHome();
    } catch (error) {
      toast.error(error, "Couldn’t switch user");
    }
  }

  async function signOut() {
    try {
      await logout();
    } catch (error) {
      toast.error(error, "Couldn’t sign out");
      return;
    }
    globalThis.location.replace("/");
  }

  function demoItems(me) {
    if (!Array.isArray(demoUsers) || demoUsers.length === 0) return [];
    return [
      { type: "separator" },
      { type: "heading", label: "Switch user (demo)" },
      ...demoUsers.map((user) => ({
        label: user.name,
        hint: user.title ?? undefined,
        badge: roleBadge(user.role),
        checked: String(user.id) === String(me.id),
        disabledReason:
          user.status === "deactivated" ? "This user is deactivated" : null,
        onSelect: () => String(user.id) !== String(me.id) && switchTo(user),
      })),
    ];
  }

  async function open() {
    if (demoUsers === undefined) {
      try {
        demoUsers = await listDemoUsers();
      } catch {
        demoUsers = null;
      }
    }
    const me = getMe();
    openMenu({
      anchor: button,
      label: "Account",
      placement: "bottom-end",
      className: "user-menu",
      items: [
        identity(me),
        ...demoItems(me),
        { type: "separator" },
        { label: "Sign out", icon: "logout", onSelect: signOut },
      ],
    });
  }

  const button = h("button", {
    type: "button",
    class: "user-menu-button",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    on: { click: open },
  });

  function update() {
    const me = getMe();
    button.setAttribute("aria-label", `Account: ${me.name}`);
    button.title = me.name;
    button.replaceChildren(avatar(me, { size: "sm", title: null }));
  }

  update();
  return { element: button, update };
}
