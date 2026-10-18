/**
 * Teams (`#/teams`) and a team page (`#/teams/<id>`). The list shows every
 * team the user may see with member counts and "New team" (members and
 * admins, `can(me, "create_team")`); the team page shows owners and
 * members, and lets team owners and admins manage them
 * (`ui/teams/team-detail.js`). A team the user can't see reads exactly
 * like a missing one.
 */

import { h } from "../dom.js";
import { teamHash, teamsHash } from "../router.js";
import { button } from "../ui/components/button.js";
import { emptyState } from "../ui/components/empty-state.js";
import { plural } from "../ui/components/format.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { can } from "../ui/components/permissions.js";
import { skeletonCards } from "../ui/components/skeleton.js";
import { teamDetail } from "../ui/teams/team-detail.js";
import { createTeamDialog } from "../ui/teams/team-dialog.js";
import { teamGrid } from "../ui/teams/team-list.js";
import {
  TEAMS_QUERY,
  createTeamReason,
  normalizeTeam,
  sortTeams,
} from "../ui/teams/teams-data.js";
import { notFoundView } from "./not-found.js";

async function loadTeams(api) {
  const data = await api.request(TEAMS_QUERY);
  return data.teams.map(normalizeTeam);
}

function failure(error, retry) {
  return h(
    "div",
    { class: "page-container" },
    emptyState({
      icon: "alert",
      title: "Couldn’t load teams",
      text: error?.message || "Something went wrong.",
      action: { label: "Try again", icon: "refresh", onClick: retry },
    }),
  );
}

async function newTeam(ctx) {
  try {
    const id = await createTeamDialog(ctx, { me: ctx.me });
    if (!id) return;
    ctx.toast.success("Team created");
    await ctx.refreshShell();
    ctx.router.navigate(teamHash(id));
  } catch (error) {
    ctx.toast.error(error, "Couldn’t open the team dialog");
  }
}

function listView(ctx, teams) {
  const reason = createTeamReason(can(ctx.me, "create_team"));
  const create = button({
    label: "New team",
    icon: "plus",
    variant: "primary",
    disabledReason: reason,
    onClick: () => newTeam(ctx),
  });
  return h(
    "div",
    { class: "page-container teams-page" },
    pageHeader({
      title: "Teams",
      icon: "team",
      subtitle: teams.length
        ? `${plural(teams.length, "team")} · share boards, docs and notes with everyone in a team at once`
        : "Share boards, docs and notes with everyone in a team at once",
      actions: [create],
    }),
    teams.length > 0
      ? teamGrid(sortTeams(teams))
      : emptyState({
          icon: "team",
          title: "No teams yet",
          text: "Create a team to share with a group of people in one step.",
          action: reason
            ? null
            : { label: "New team", icon: "plus", onClick: () => newTeam(ctx) },
        }),
  );
}

async function showList(container, ctx) {
  setDocumentTitle("Teams");
  try {
    const teams = await loadTeams(ctx.api);
    container.replaceChildren(listView(ctx, teams));
  } catch (error) {
    container.replaceChildren(failure(error, () => showList(container, ctx)));
  }
}

async function showTeam(container, ctx, teamId) {
  let teams;
  try {
    teams = await loadTeams(ctx.api);
  } catch (error) {
    container.replaceChildren(
      failure(error, () => showTeam(container, ctx, teamId)),
    );
    return;
  }
  const team = teams.find((entry) => entry.id === teamId);
  if (!team) {
    setDocumentTitle("Not found");
    container.replaceChildren(notFoundView({ what: "team" }));
    return;
  }
  setDocumentTitle(team.name);
  try {
    const view = await teamDetail(ctx, {
      team,
      onChanged: () => showTeam(container, ctx, teamId),
      onDeleted: () => ctx.router.navigate(teamsHash(), { replace: true }),
    });
    container.replaceChildren(view);
  } catch (error) {
    container.replaceChildren(
      failure(error, () => showTeam(container, ctx, teamId)),
    );
  }
}

/** Page contract. */
export async function mount(container, ctx, params) {
  container.replaceChildren(
    h(
      "div",
      { class: "page-container" },
      skeletonCards({ count: 6, label: "Loading teams" }),
    ),
  );
  if (params.teamId) await showTeam(container, ctx, params.teamId);
  else await showList(container, ctx);
}
