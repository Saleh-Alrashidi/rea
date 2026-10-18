/**
 * What the signed-in user may do on the open board, as UI flags. The
 * server (`server/access.js`) decides every access question and rejects
 * anything else; the board UI reads only the board's `my_access` and the
 * account role, through `components/permissions.js`, to hide or disable
 * controls the user cannot use (SPEC-2 §1.2 required roles):
 *
 * - viewer: read board, items, updates and activity;
 * - editor: items, groups, column values, updates and forms;
 * - owner: board settings (name, description, kind), columns, members and
 *   deleting the board.
 */

import {
  REASONS,
  can,
  hasRole,
  isViewOnly,
} from "../components/permissions.js";

/**
 * @typedef {object} BoardCapabilities
 * @property {string | null} access  the board's `my_access`
 * @property {boolean} viewOnly      read-only access ("View only" badge)
 * @property {boolean} edit          items, groups, values, updates, forms
 * @property {boolean} manage        settings, kind, columns, members, delete
 * @property {boolean} createForms   editor and an account role that creates
 * @property {{ edit: string | null, manage: string | null,
 *   createForms: string | null }} reasons
 *   why each capability is missing (tooltips), or null when granted
 */

/**
 * Capabilities for `board` (a `loadBoard` record, or null while loading)
 * and the signed-in user `me`.
 * @returns {BoardCapabilities}
 */
export function boardCapabilities(board, me) {
  const access = board?.myAccess ?? null;
  const edit = hasRole(access, "editor");
  const manage = hasRole(access, "owner");
  const creates = can(me, "create_content");
  const createForms = edit && creates;
  let createReason = null;
  if (!edit) createReason = REASONS.viewOnly;
  else if (!creates) createReason = REASONS.noCreate;
  return {
    access,
    viewOnly: isViewOnly(access),
    edit,
    manage,
    createForms,
    reasons: {
      edit: edit ? null : REASONS.viewOnly,
      manage: manage ? null : REASONS.notOwner,
      createForms: createReason,
    },
  };
}
