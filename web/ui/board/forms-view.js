/**
 * Forms view (`#/boards/<id>/views/forms`): the board's forms with their
 * access, response count and public link (copy, preview), "Open builder"
 * (`#/forms/<id>`) for editors and "New form" (`actions.createForm`: a
 * form on this board, then its builder). It owns its data once mounted
 * (`live-view.js`) and reloads on the board's change events, which include
 * form changes and submissions.
 *
 * Who may do what comes from `caps` (`capabilities.js`): viewers see the
 * list and links; editors also open the builder; creating needs editor
 * access and an account role that creates content.
 */

import { h } from "../../dom.js";
import { formHash } from "../../router.js";
import { badge } from "../components/badge.js";
import { button, linkButton } from "../components/button.js";
import { emptyState } from "../components/empty-state.js";
import { formAccess } from "../components/labels.js";
import { plural, timeAgo } from "../components/format.js";
import { icon } from "../components/icon.js";
import { skeletonCards } from "../components/skeleton.js";
import { loadBoardForms } from "./board-data.js";
import { mountLiveView } from "./live-view.js";
import { safeColor } from "./values.js";

/**
 * The public link of a form when it can be shared: an http(s) URL on the
 * page's own origin (the API builds it from the host origin), else null.
 */
export function shareableFormLink(form, origin = globalThis.location?.origin) {
  if (form.access === "closed" || typeof form.public_url !== "string") {
    return null;
  }
  try {
    const url = new URL(form.public_url);
    const web = url.protocol === "http:" || url.protocol === "https:";
    return web && url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

/** Forms ordered by title (case-insensitive), then ID. */
export function sortForms(forms) {
  return [...forms].sort(
    (a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
      Number(a.id) - Number(b.id),
  );
}

async function copyLink(ctx, url) {
  try {
    await globalThis.navigator.clipboard.writeText(url);
    ctx.toast.success("Form link copied");
  } catch {
    ctx.toast.show({ message: url, type: "info", timeout: 15_000 });
  }
}

function linkActions(ctx, form) {
  const link = shareableFormLink(form);
  const reason = link ? null : "Closed forms don’t accept responses";
  return [
    button({
      label: "Copy link",
      icon: "link",
      size: "sm",
      variant: "ghost",
      disabledReason: reason,
      onClick: () => copyLink(ctx, link),
    }),
    button({
      label: "Preview",
      icon: "open",
      size: "sm",
      variant: "ghost",
      disabledReason: reason,
      onClick: () => globalThis.open(link, "_blank", "noopener,noreferrer"),
    }),
  ];
}

function formCard(ctx, { form, caps }) {
  const access = formAccess(form.access);
  const titleId = `form-card-${form.id}`;
  const card = h(
    "article",
    { class: "form-card", "aria-labelledby": titleId },
    h(
      "div",
      { class: "form-card-top" },
      h("span", { class: "form-card-icon" }, icon("forms", { size: 18 })),
      h(
        "div",
        { class: "form-card-heading" },
        h(
          "h3",
          { class: "form-card-title", id: titleId },
          caps.edit
            ? h("a", { href: formHash(form.id) }, form.title)
            : form.title,
        ),
        h(
          "p",
          { class: "form-card-meta" },
          plural(form.response_count, "response"),
          form.updated_at ? ` · Updated ${timeAgo(form.updated_at)}` : "",
        ),
      ),
      badge(access.label, {
        tone: access.tone,
        icon: access.icon,
        title: access.description,
        className: "form-access",
      }),
    ),
    form.description
      ? h("p", { class: "form-card-description" }, form.description)
      : null,
    h(
      "div",
      { class: "form-card-actions" },
      linkActions(ctx, form),
      caps.edit
        ? linkButton({
            label: "Open builder",
            icon: "edit",
            size: "sm",
            variant: "secondary",
            href: formHash(form.id),
            className: "form-card-open",
          })
        : null,
    ),
  );
  card.style.setProperty("--form-accent", safeColor(form.accent_color));
  return card;
}

function newFormButton({ caps, onCreate }) {
  if (!caps.edit) return null;
  return button({
    label: "New form",
    icon: "plus",
    variant: "primary",
    size: "sm",
    disabledReason: caps.reasons.createForms,
    onClick: onCreate,
  });
}

function formsContent(ctx, { forms, caps, onCreate }) {
  if (forms.length === 0) {
    return emptyState({
      icon: "forms",
      title: "No forms yet",
      text: caps.edit
        ? "A form collects requests from anyone you share it with; each response becomes an item here."
        : "When editors add forms to this board, they will be listed here.",
      action: caps.createForms
        ? { label: "New form", icon: "plus", onClick: onCreate }
        : null,
    });
  }
  return h(
    "div",
    { class: "forms-view" },
    h(
      "div",
      { class: "forms-view-header" },
      h(
        "p",
        { class: "forms-view-count" },
        `${plural(forms.length, "form")} on this board`,
      ),
      newFormButton({ caps, onCreate }),
    ),
    h(
      "div",
      { class: "form-cards" },
      sortForms(forms).map((form) => formCard(ctx, { form, caps })),
    ),
  );
}

/**
 * Mounts the forms list into `root`.
 * @param {HTMLElement} root
 * @param {{ boardId: string, ctx: object, caps: object,
 *   createForm(): Promise<unknown> }} options
 * @returns {{ emit(type: string, data: unknown): boolean, destroy(): void }}
 */
export function mountFormsView(root, { boardId, ctx, caps, createForm }) {
  const view = mountLiveView(root, {
    label: "Forms",
    failure: "We couldn’t load the forms",
    load: async () => (await loadBoardForms(boardId)) ?? [],
    placeholder: () => skeletonCards({ count: 3, label: "Loading forms" }),
    ready: (forms) => formsContent(ctx, { forms, caps, onCreate: createForm }),
  });
  return { emit: view.emit, destroy: view.destroy };
}
