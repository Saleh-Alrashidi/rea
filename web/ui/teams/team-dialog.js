/**
 * "New team" dialog: name, description and first members (a people
 * picker over the account directory; teams can't contain teams). The
 * creator becomes the team's owner on the server. Resolves with the new
 * team's ID, or null when cancelled.
 */

import { h } from "../../dom.js";
import { loadDirectory } from "../components/directory.js";
import { peoplePicker } from "../components/people-picker.js";
import { TEAM_MUTATIONS } from "./teams-data.js";

let nextId = 0;

function footer(handle) {
  return h(
    "div",
    { class: "dialog-actions" },
    h(
      "button",
      {
        type: "button",
        class: "btn btn-secondary",
        on: { click: () => handle.close(null) },
      },
      "Cancel",
    ),
    h("button", { type: "submit", class: "btn btn-primary" }, "Create team"),
  );
}

function body({ id, picker }) {
  return h(
    "div",
    { class: "dialog-body" },
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", for: `${id}-name` }, "Team name"),
      h("input", {
        id: `${id}-name`,
        name: "name",
        class: "input",
        required: true,
        maxlength: 255,
        autocomplete: "off",
        autofocus: true,
      }),
    ),
    h(
      "div",
      { class: "field" },
      h(
        "label",
        { class: "field-label", for: `${id}-description` },
        "Description (optional)",
      ),
      h("textarea", {
        id: `${id}-description`,
        name: "description",
        class: "input",
        rows: 2,
        maxlength: 2000,
      }),
    ),
    h(
      "div",
      { class: "field" },
      h("span", { class: "field-label" }, "Members (optional)"),
      picker.element,
      h(
        "p",
        { class: "field-hint" },
        "You’re added as the team’s owner. You can add people later too.",
      ),
    ),
  );
}

/**
 * Opens the dialog and creates the team.
 * @param {object} ctx the page context
 * @param {{ me: object }} options
 * @returns {Promise<string | null>}
 */
export async function createTeamDialog(ctx, { me }) {
  const directory = await loadDirectory();
  const id = `team-dialog-${(nextId += 1)}`;
  const picker = peoplePicker({
    users: directory.userList,
    allowTeams: false,
    excluded: new Set([`user:${me.id}`]),
    label: "Add people to the team",
    placeholder: "Add people",
  });
  let busy = false;
  const dialog = ctx.dialog.open({
    title: "New team",
    description:
      "Teams let you share boards, docs and notes with a group at once.",
    size: "md",
    content: body({ id, picker }),
    footer,
    async onSubmit(event, handle) {
      event.preventDefault();
      const form = event.currentTarget;
      if (busy || !form.reportValidity()) return;
      const name = form.elements.namedItem("name").value.trim();
      if (!name) return;
      const description = form.elements.namedItem("description").value.trim();
      busy = true;
      try {
        const data = await ctx.api.request(TEAM_MUTATIONS.create, {
          name,
          description: description || null,
          memberIds: picker.selection().map((subject) => subject.id),
        });
        handle.close(String(data.create_team.id));
      } catch (error) {
        busy = false;
        ctx.toast.error(error, "Couldn’t create the team");
      }
    },
  });
  return dialog.closed;
}
