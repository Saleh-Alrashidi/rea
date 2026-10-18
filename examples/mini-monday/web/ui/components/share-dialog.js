/**
 * The share dialog, one component for workspaces, boards, docs and notes
 * (SPEC-2 §5.2): the visibility control (board kind, doc visibility,
 * workspace kind; notes stay private until shared), the members with role
 * dropdowns and remove buttons (the last owner is protected), a people and
 * team picker with a role to invite subjects, guest-eligibility hints and
 * "Copy link". Changes go through `share`, `unshare`, `set_board_kind`,
 * `set_doc_visibility` and `update_workspace`.
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
import { loadDirectory } from "./directory.js";
import { BOARD_KINDS, resourceKind as kindInfo } from "./labels.js";
import {
  SHARE_MUTATIONS,
  SHARE_QUERIES,
  SHARE_SETTINGS,
  normalizeMember,
  normalizeResource,
} from "./share-model.js";
import { renderShareBody } from "./share-sections.js";

async function load(state) {
  const variables =
    state.kind === "workspace" || state.kind === "note" ? {} : { id: state.id };
  const [data, directory] = await Promise.all([
    request(SHARE_QUERIES[state.kind], variables),
    loadDirectory(),
  ]);
  state.resource = normalizeResource(state.kind, data, state.id);
  state.directory = directory;
}

async function run(state, work) {
  state.busy = true;
  state.error = null;
  renderShareBody(state);
  try {
    await work();
    state.result.changed = true;
  } catch (error) {
    state.error =
      error instanceof Error && error.message
        ? error.message
        : "Something went wrong";
  } finally {
    state.busy = false;
  }
  renderShareBody(state);
}

function setMembers(state, members) {
  state.resource.members = members.map(normalizeMember);
  state.picker = null;
}

function variables(state, member) {
  return { kind: state.kind, id: state.id, subjectKind: member.kind };
}

function changeRole(state, member, role) {
  run(state, async () => {
    const data = await request(SHARE_MUTATIONS.share, {
      ...variables(state, member),
      subjectIds: [member.id],
      role,
    });
    setMembers(state, data.share);
  });
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
  await run(state, async () => {
    const data = await request(SHARE_MUTATIONS.unshare, {
      ...variables(state, member),
      subjectId: member.id,
    });
    setMembers(state, data.unshare);
  });
  if (self && !state.error) {
    state.result.lostAccess = true;
    state.dialog.close();
  }
}

function invite(state, role) {
  const selection = state.picker?.selection() ?? [];
  if (selection.length === 0) return;
  run(state, async () => {
    let members = null;
    for (const subjectKind of ["user", "team"]) {
      const subjectIds = selection
        .filter((entry) => entry.kind === subjectKind)
        .map((entry) => entry.id);
      if (subjectIds.length === 0) continue;
      const data = await request(SHARE_MUTATIONS.share, {
        kind: state.kind,
        id: state.id,
        subjectKind,
        subjectIds,
        role,
      });
      members = data.share;
    }
    if (members) setMembers(state, members);
  });
}

async function changeSetting(state, value) {
  const setting = SHARE_SETTINGS[state.kind];
  const { resource } = state;
  const losingGuests =
    state.kind === "board" &&
    resource.setting === "share" &&
    value !== "share" &&
    resource.members.some((member) => member.accountRole === "guest");
  if (losingGuests) {
    const confirmed = await state.ctx.dialog.confirm({
      title: `Make this board ${BOARD_KINDS[value].label}?`,
      message: "Guests lose access to boards that are not Shareable.",
      confirmButton: "Change board type",
      danger: true,
    });
    if (!confirmed) {
      renderShareBody(state);
      return;
    }
  }
  run(state, async () => {
    await request(SHARE_MUTATIONS[setting.mutation], {
      id: state.id,
      [setting.variable]: value,
    });
    await load(state);
    state.picker = null;
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
    directory: null,
    loading: true,
    busy: false,
    error: null,
    picker: null,
    result: { changed: false, lostAccess: false },
  };
  state.actions = {
    changeSetting: (value) => changeSetting(state, value),
    invite: (role) => invite(state, role),
    changeRole: (member, role) => changeRole(state, member, role),
    removeMember: (member) => removeMember(state, member),
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
