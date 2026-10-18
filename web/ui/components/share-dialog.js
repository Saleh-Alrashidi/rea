/**
 * The share dialog, one component for workspaces, boards, docs and notes
 * (SPEC-2 §5.2): the visibility control (board kind, doc visibility,
 * workspace kind; notes stay private until shared), the members with role
 * dropdowns and remove buttons, a people and team picker with a role to
 * invite subjects, eligibility hints and "Copy link". Every verdict is the
 * server's (SPEC-2 §6): candidates come from `share_candidates` and each
 * member says whether it can be removed and which roles it can take.
 * Changes go through `share`, `unshare`, `set_board_kind`,
 * `set_doc_visibility` and `update_workspace`. Making someone an owner
 * asks first. After each change focus returns to the control that made it
 * (the next member after a removal) and a status line announces the
 * result.
 *
 * ```js
 * const { changed, lostAccess } = await openShareDialog({ ctx,
 *   resourceKind: "board", resourceId: "12" });
 * ```
 * Pages call it through `ctx.openShare({ resourceKind, resourceId })`.
 */

import { request } from "../../api.js";
import { h } from "../../dom.js";
import { button } from "./button.js";
import { openDialog } from "./dialog.js";
import { accessRole, resourceKind as kindInfo } from "./labels.js";
import {
  CANDIDATE_LIMIT,
  SHARE_CANDIDATES_QUERY,
  SHARE_MUTATIONS,
  SHARE_QUERIES,
  SHARE_SETTINGS,
  boardKindConfirmation,
  normalizeCandidate,
  normalizeResource,
} from "./share-model.js";
import { renderShareBody } from "./share-sections.js";

/** Who could be added for `query`, with the server's verdicts. */
async function searchCandidates(state, query) {
  const data = await request(SHARE_CANDIDATES_QUERY, {
    kind: state.kind,
    id: state.id,
    query,
    limit: CANDIDATE_LIMIT,
  });
  return data.share_candidates.map(normalizeCandidate);
}

/**
 * Starts a fresh picker over the current candidates (owners only; the
 * server refuses the list to everyone else).
 */
async function loadCandidates(state) {
  state.picker = null;
  state.suggestions = [];
  state.candidates = state.resource?.canManage
    ? await searchCandidates(state, "")
    : [];
}

async function load(state) {
  const variables =
    state.kind === "workspace" || state.kind === "note" ? {} : { id: state.id };
  const data = await request(SHARE_QUERIES[state.kind], variables);
  state.resource = normalizeResource(state.kind, data, state.id);
  await loadCandidates(state);
}

/**
 * Runs a change: busy while it runs, then the reloaded body with focus on
 * `focusKey` and `done` (or the error) announced.
 */
async function run(state, { work, focusKey, done }) {
  state.busy = true;
  state.error = null;
  state.focusKey = focusKey;
  announce(state, "");
  renderShareBody(state);
  try {
    await work();
    announce(state, done);
  } catch (error) {
    state.error =
      error instanceof Error && error.message
        ? error.message
        : "Something went wrong";
    announce(state, state.error);
  } finally {
    state.busy = false;
  }
  renderShareBody(state);
}

function announce(state, text) {
  if (state.status) state.status.textContent = text;
}

function variables(state, member) {
  return { kind: state.kind, id: state.id, subjectKind: member.kind };
}

const memberKey = (member) => `${member.kind}:${member.id}`;

async function changeRole(state, member, role) {
  if (role === member.role) return;
  if (role === "owner") {
    const confirmed = await state.ctx.dialog.confirm({
      title: `Make ${member.name} an owner?`,
      message: `${member.name} will be able to edit, share, change the settings of and delete this ${kindInfo(state.kind).label.toLowerCase()}, and remove other owners.`,
      confirmButton: "Make owner",
    });
    if (!confirmed) return;
  }
  await run(state, {
    focusKey: `share-role:${memberKey(member)}`,
    done: `${member.name} is now ${accessRole(role).label.toLowerCase()}`,
    async work() {
      await request(SHARE_MUTATIONS.share, {
        ...variables(state, member),
        subjectIds: [member.id],
        role,
      });
      state.result.changed = true;
      // The caller's own access may have changed too: reload every verdict.
      await load(state);
    },
  });
}

/** Where focus goes after `member` is removed: the next row, else the heading. */
function afterRemoval(state, member) {
  const rows = state.resource.members;
  const index = rows.findIndex(
    (entry) => memberKey(entry) === memberKey(member),
  );
  const next = rows[index + 1] ?? rows[index - 1] ?? null;
  return next ? `share-remove:${memberKey(next)}` : "share-members-heading";
}

async function removeMember(state, member) {
  const self = member.kind === "user" && member.id === String(state.ctx.me.id);
  if (self) {
    const confirmed = await state.ctx.dialog.confirm({
      title: "Remove your access?",
      message: `You will no longer be able to open “${state.resource.title}” unless someone shares it again.`,
      confirmButton: "Remove my access",
      danger: true,
    });
    if (!confirmed) return;
  }
  await run(state, {
    focusKey: afterRemoval(state, member),
    done: `Removed ${member.name}`,
    async work() {
      await request(SHARE_MUTATIONS.unshare, {
        ...variables(state, member),
        subjectId: member.id,
      });
      state.result.changed = true;
      if (!self) await load(state);
    },
  });
  if (self && !state.error) {
    state.result.lostAccess = true;
    state.dialog.close();
  }
}

function invite(state, role) {
  const selection = state.picker?.selection() ?? [];
  if (selection.length === 0 || !role) return;
  const names = selection.map((entry) => entry.name).join(", ");
  run(state, {
    focusKey: "share-picker",
    done: `Invited ${names} as ${accessRole(role).label.toLowerCase()}`,
    async work() {
      for (const subjectKind of ["user", "team"]) {
        const subjectIds = selection
          .filter((entry) => entry.kind === subjectKind)
          .map((entry) => entry.id);
        if (subjectIds.length === 0) continue;
        await request(SHARE_MUTATIONS.share, {
          kind: state.kind,
          id: state.id,
          subjectKind,
          subjectIds,
          role,
        });
        state.result.changed = true;
      }
      await load(state);
    },
  });
}

async function changeSetting(state, value) {
  const setting = SHARE_SETTINGS[state.kind];
  const { resource } = state;
  if (state.kind === "board") {
    // The same confirmation as the board header's "Board type" menu.
    const board = {
      name: resource.title,
      kind: resource.setting,
      members: resource.members,
    };
    const confirmed = await state.ctx.dialog.confirm(
      boardKindConfirmation(board, value),
    );
    if (!confirmed) {
      // Back to the current kind, with focus on its card.
      state.focusKey = `share-setting:${resource.setting}`;
      renderShareBody(state);
      return;
    }
  }
  run(state, {
    focusKey: `share-setting:${value}`,
    done: `${setting.label}: ${setting.table[value]?.label ?? value}`,
    async work() {
      await request(SHARE_MUTATIONS[setting.mutation], {
        id: state.id,
        [setting.variable]: value,
      });
      state.result.changed = true;
      await load(state);
    },
  });
}

async function copyLink(state) {
  const url = new URL(
    state.resource?.hash ?? "",
    `${globalThis.location.origin}/`,
  ).href;
  try {
    await globalThis.navigator.clipboard.writeText(url);
    state.ctx.toast.success("Link copied");
  } catch {
    state.ctx.toast.show({ message: url, type: "info", timeout: 15_000 });
  }
}

/**
 * Opens the share dialog and resolves when it closes with
 * `{ changed, lostAccess }` (`lostAccess` when the user removed themself).
 *
 * @param {{ ctx: object, resourceKind: "workspace" | "board" | "doc" | "note",
 *   resourceId: string }} options
 * @returns {Promise<{ changed: boolean, lostAccess: boolean }>}
 */
export async function openShareDialog({ ctx, resourceKind, resourceId }) {
  if (!Object.hasOwn(SHARE_QUERIES, resourceKind)) {
    throw new TypeError(`Unknown resource kind ${resourceKind}`);
  }
  const state = {
    ctx,
    kind: resourceKind,
    id: String(resourceId),
    resource: null,
    candidates: [],
    suggestions: [],
    inviteRole: null,
    loading: true,
    busy: false,
    error: null,
    picker: null,
    focusKey: null,
    status: h("p", { class: "visually-hidden", role: "status" }),
    result: { changed: false, lostAccess: false },
  };
  state.actions = {
    changeSetting: (value) => changeSetting(state, value),
    invite: (role) => invite(state, role),
    changeRole: (member, role) => changeRole(state, member, role),
    removeMember: (member) => removeMember(state, member),
    searchCandidates: (query) => searchCandidates(state, query),
  };
  state.dialog = openDialog({
    title: `Share ${kindInfo(resourceKind).label.toLowerCase()}`,
    size: "lg",
    className: "share-dialog",
    content: h("div"),
    footer: () =>
      h(
        "div",
        { class: "dialog-actions spread" },
        // Announces each change; it outlives the body's re-renders.
        state.status,
        button({
          label: "Copy link",
          icon: "link",
          variant: "ghost",
          onClick: () => copyLink(state),
        }),
        button({
          label: "Done",
          variant: "primary",
          onClick: () => state.dialog.close(),
        }),
      ),
  });
  renderShareBody(state);
  try {
    await load(state);
  } catch (error) {
    state.error =
      error instanceof Error ? error.message : "Couldn’t load sharing";
  }
  state.loading = false;
  if (state.resource) {
    state.dialog.element.querySelector(".modal-title").textContent =
      `Share “${state.resource.title}”`;
  }
  renderShareBody(state);
  await state.dialog.closed;
  return state.result;
}
