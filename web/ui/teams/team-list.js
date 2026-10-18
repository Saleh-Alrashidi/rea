/**
 * The Teams list (`#/teams`): one card per visible team with its members,
 * member count and the user's role in it.
 */

import { h } from "../../dom.js";
import { teamHash } from "../../router.js";
import { avatarStack, teamAvatar } from "../components/avatar.js";
import { badge } from "../components/badge.js";
import { plural } from "../components/format.js";

function roleTag(team) {
  if (team.myRole === "owner") return badge("Owner", { tone: "primary" });
  if (team.myRole === "member") return badge("Member", { tone: "neutral" });
  return null;
}

/** A card linking to the team page (the "Shared with me" card look). */
export function teamCard(team) {
  return h(
    "a",
    { class: ["panel", "shared-card"], href: teamHash(team.id) },
    h(
      "div",
      { class: "shared-card-top" },
      teamAvatar(team, { size: "md" }),
      h("span", { class: "shared-card-kind" }, "Team"),
      roleTag(team),
    ),
    h("h2", { class: "shared-card-title" }, team.name),
    h(
      "p",
      { class: "shared-card-subtitle ws-clamp" },
      team.description || "No description yet.",
    ),
    h(
      "div",
      { class: "shared-card-footer" },
      team.members.length > 0
        ? avatarStack(team.members, { max: 5, size: "xs" })
        : null,
      h(
        "span",
        { class: "shared-card-by" },
        plural(team.memberCount, "member"),
      ),
    ),
  );
}

/** The grid of team cards. */
export function teamGrid(teams) {
  return h("div", { class: "panel-grid" }, teams.map(teamCard));
}
