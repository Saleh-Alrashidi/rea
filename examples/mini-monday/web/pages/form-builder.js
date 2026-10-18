/**
 * Form builder (`#/forms/<id>`): the question list and settings on the
 * left, a live preview on the right drawn by the same renderer as the
 * public form page (`ui/forms/renderer.js`), the public link with copy and
 * "Regenerate link", and the response count. Every edit autosaves through
 * `update_form` (debounced for text, at once for choices) with a
 * saved/saving indicator; edits the server would refuse (an empty title or
 * question label) are shown in place and wait until they are fixed.
 *
 * Editing needs editor access to the form's board (`access.formAccess`);
 * board viewers see the same page read-only. Forms the user cannot reach
 * show the shared "not available" view, exactly like deleted ones. The
 * page follows the board's change events for new responses and for the
 * form being deleted elsewhere.
 */

import { h } from "../dom.js";
import { viewHash } from "../router.js";
import { formAccess } from "../ui/components/labels.js";
import { badge } from "../ui/components/badge.js";
import { button } from "../ui/components/button.js";
import { emptyState } from "../ui/components/empty-state.js";
import { icon } from "../ui/components/icon.js";
import { guardUnsaved } from "../ui/components/leave-guard.js";
import { menuButton } from "../ui/components/menu.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { REASONS, hasRole } from "../ui/components/permissions.js";
import { skeletonCards, skeletonLine } from "../ui/components/skeleton.js";
import { createAutosave } from "../ui/docs/autosave.js";
import { normalizeDefinition } from "../ui/forms/answers.js";
import {
  FORM_MUTATIONS,
  loadFormBuilder,
  loadResponseCount,
  updateVariables,
} from "../ui/forms/builder-data.js";
import { createQuestionList } from "../ui/forms/question-list.js";
import { definitionFromForm, questionsProblem } from "../ui/forms/questions.js";
import { renderForm } from "../ui/forms/renderer.js";
import { createSettingsPanel } from "../ui/forms/settings-panel.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { notFoundView } from "./not-found.js";

const PREVIEW_DELAY = 150;
const COUNT_DELAY = 400;

const SAVE_STATES = Object.freeze({
  saved: { icon: "check", text: "All changes saved" },
  pending: { icon: "clock", text: "Unsaved changes" },
  saving: { icon: "refresh", text: "Saving…" },
  failed: { icon: "alert", text: "Couldn’t save" },
  blocked: { icon: "alert", text: "Not saved yet" },
});

function loadingView() {
  return h(
    "div",
    { class: "page-container fb-page" },
    skeletonLine({ variant: "title", width: "min(320px, 60%)" }),
    skeletonCards({ count: 2, label: "Loading form" }),
  );
}

// ------------------------------------------------------------ save state

function renderSaveState(b) {
  const snapshot = b.autosave?.snapshot() ?? { status: "saved" };
  const blocked = b.blocked.title ?? b.blocked.questions;
  const key =
    blocked && snapshot.status !== "saving" ? "blocked" : snapshot.status;
  const info = SAVE_STATES[key] ?? SAVE_STATES.saved;
  b.saveState.className = `fb-save-state is-${key}`;
  const text =
    blocked && key === "blocked" ? `${info.text}: ${blocked}` : info.text;
  b.saveState.replaceChildren(
    icon(info.icon, { size: 14 }),
    h("span", null, text),
    ...(key === "failed"
      ? [
          button({
            label: "Retry",
            size: "sm",
            variant: "ghost",
            onClick: () => b.autosave.retry(),
          }),
        ]
      : []),
  );
}

function onSaveState(b, snapshot) {
  if (snapshot.status === "failed" && b.lastStatus !== "failed") {
    b.ctx.toast.error(snapshot.error, "Couldn’t save the form");
  }
  b.lastStatus = snapshot.status;
  renderSaveState(b);
}

function createSaver(b) {
  const { ctx, form } = b;
  return createAutosave({
    // Forms have no version; `expected_version` does not apply.
    version: 0,
    save: async (changes) =>
      (
        await ctx.api.request(
          FORM_MUTATIONS.update,
          updateVariables(form.id, changes),
        )
      ).update_form,
    onState: (snapshot) => onSaveState(b, snapshot),
    onSaved(result, changes) {
      if (Number.isSafeInteger(result?.response_count)) {
        setCount(b, result.response_count);
      }
      // The sidebar lists forms by title.
      if (Object.hasOwn(changes, "title")) ctx.refreshShell();
    },
  });
}

// --------------------------------------------------------------- preview

function renderPreview(b) {
  globalThis.clearTimeout(b.previewTimer);
  b.previewTimer = null;
  const parsed = normalizeDefinition(
    definitionFromForm(b.form, b.board.columns),
  );
  if (!parsed.ok) return;
  const values = b.preview?.values() ?? {};
  b.preview = renderForm(parsed.value, {
    mode: "preview",
    headingLevel: 2,
    values,
  });
  b.previewSlot.replaceChildren(b.preview.element);
}

function schedulePreview(b) {
  globalThis.clearTimeout(b.previewTimer);
  b.previewTimer = globalThis.setTimeout(() => renderPreview(b), PREVIEW_DELAY);
}

// ----------------------------------------------------------------- edits

function setCount(b, count) {
  if (b.form.response_count === count) return;
  b.form = { ...b.form, response_count: count };
  b.settings.update(b.form);
}

function accessBadgeOf(access) {
  const info = formAccess(access);
  return badge(info.label, {
    tone: info.tone,
    icon: info.icon,
    title: info.description,
  });
}

function onQuestions(b, questions) {
  b.form = { ...b.form, questions };
  const problem = questionsProblem(questions, b.board.columns);
  b.list.showProblem(problem);
  b.blocked.questions = problem
    ? `question ${problem.index + 1} needs attention`
    : null;
  if (!problem) b.autosave.change({ questions });
  renderSaveState(b);
  schedulePreview(b);
}

function onSettings(b, patch, { immediate = false } = {}) {
  b.form = { ...b.form, ...patch };
  if (Object.hasOwn(patch, "title")) {
    const title = patch.title.trim();
    b.blocked.title = title ? null : "give the form a title";
    b.settings.showProblem("title", title ? null : "A form needs a title");
    if (title) {
      b.titleText.textContent = title;
      setDocumentTitle(title);
    }
  }
  if (Object.hasOwn(patch, "access")) {
    b.accessSlot.replaceChildren(accessBadgeOf(patch.access));
    b.settings.update(b.form);
  }
  const savable = { ...patch };
  if (b.blocked.title) delete savable.title;
  if (Object.keys(savable).length > 0)
    b.autosave.change(savable, { immediate });
  renderSaveState(b);
  schedulePreview(b);
}

async function regenerate(b) {
  const { ctx } = b;
  const confirmed = await ctx.dialog.confirm({
    title: "Regenerate the form link?",
    message:
      "Anyone using the current link will see “form not available”. Share the new link instead.",
    confirmButton: "Regenerate link",
    danger: true,
  });
  if (!confirmed || !b.active) return;
  try {
    const data = await ctx.api.request(FORM_MUTATIONS.regenerate, {
      formId: b.form.id,
    });
    b.form = { ...b.form, public_url: data.regenerate_form_link.public_url };
    b.settings.update(b.form);
    ctx.toast.success("New link ready; the old one no longer works");
  } catch (error) {
    ctx.toast.error(error, "Couldn’t regenerate the link");
  }
}

async function removeForm(b) {
  const { ctx } = b;
  const confirmed = await ctx.dialog.confirm({
    title: `Delete “${b.form.title}”?`,
    message: `The form and its link go away. The ${b.form.response_count} items it created stay on the board.`,
    confirmButton: "Delete form",
    danger: true,
  });
  if (!confirmed || !b.active) return;
  b.deleting = true;
  await b.autosave.flush();
  try {
    await ctx.api.request(FORM_MUTATIONS.remove, { formId: b.form.id });
  } catch (error) {
    b.deleting = false;
    ctx.toast.error(error, "Couldn’t delete the form");
    return;
  }
  b.autosave.dispose();
  ctx.toast.success("Form deleted");
  await ctx.refreshShell();
  ctx.router.navigate(viewHash(b.board.id, { view: "forms" }));
}

// ----------------------------------------------------------------- layout

function header(b) {
  const { form, board } = b;
  b.titleText = h("span", null, form.title);
  b.accessSlot = h("span", { class: "fb-access" }, accessBadgeOf(form.access));
  b.saveState = h("span", { class: "fb-save-state", role: "status" });
  const eyebrow = h(
    "a",
    { class: "page-back", href: viewHash(board.id, { view: "forms" }) },
    icon("chevronLeft", { size: 14 }),
    `Forms on ${board.name}`,
  );
  return pageHeader({
    eyebrow,
    title: b.titleText,
    icon: "forms",
    iconColor: form.accent_color,
    badges: [
      b.accessSlot,
      b.readOnly ? badge("View only", { tone: "warning", icon: "eye" }) : null,
    ],
    actions: [
      b.readOnly ? null : b.saveState,
      menuButton({
        label: "Form actions",
        items: () => [
          {
            label: "Open the board",
            icon: "grid",
            href: viewHash(board.id, {}),
          },
          { type: "separator" },
          {
            label: "Delete form",
            icon: "trash",
            danger: true,
            disabledReason: b.readOnly ? REASONS.viewOnly : null,
            onSelect: () => removeForm(b),
          },
        ],
      }),
    ],
  });
}

function questionsPanel(b) {
  b.list = createQuestionList({
    questions: b.form.questions,
    columns: b.board.columns,
    readOnly: b.readOnly,
    onChange: (questions) => onQuestions(b, questions),
  });
  return h(
    "section",
    { class: "panel fb-panel" },
    h(
      "div",
      { class: "panel-header" },
      h("h2", { class: "panel-title" }, icon("forms"), "Questions"),
      h(
        "p",
        { class: "fb-panel-hint" },
        "Each answer fills the item’s column.",
      ),
    ),
    h("div", { class: "panel-body fb-panel-body" }, b.list.element),
  );
}

function viewOnlyBanner() {
  return h(
    "p",
    { class: "banner banner-info" },
    icon("eye"),
    h(
      "span",
      null,
      "You can view this board, so you see its form, but only editors can change it.",
    ),
  );
}

function layout(b) {
  b.settings = createSettingsPanel({
    form: b.form,
    board: b.board,
    readOnly: b.readOnly,
    toast: b.ctx.toast,
    onChange: (patch, options) => onSettings(b, patch, options),
    onRegenerate: () => regenerate(b),
  });
  b.previewSlot = h("div", { class: "fb-preview-frame" });
  return h(
    "div",
    { class: "page-container fb-page" },
    header(b),
    h(
      "div",
      { class: "fb-layout" },
      h(
        "div",
        { class: "fb-editor" },
        b.readOnly ? viewOnlyBanner() : null,
        questionsPanel(b),
        b.settings.element,
      ),
      h(
        "aside",
        { class: "fb-preview", "aria-label": "Live preview" },
        h(
          "div",
          { class: "fb-preview-header" },
          icon("eye", { size: 14 }),
          h("span", null, "Live preview"),
          h("span", { class: "fb-preview-hint" }, "What respondents see"),
        ),
        b.previewSlot,
      ),
    ),
  );
}

// ----------------------------------------------------------- live updates

function watch(b) {
  const { ctx, board, form } = b;
  const refreshCount = () => {
    globalThis.clearTimeout(b.countTimer);
    b.countTimer = globalThis.setTimeout(async () => {
      try {
        const count = await loadResponseCount(ctx.api, {
          boardId: board.id,
          formId: form.id,
        });
        if (b.active && count !== null) setCount(b, count);
      } catch {
        // The next change event tries again.
      }
    }, COUNT_DELAY);
  };
  return ctx.bus.watchBoard(board.id, (change) => {
    if (!b.active || b.deleting) return;
    const mine =
      change.resource_kind === "form" && String(change.resource_id) === form.id;
    if (
      change.type === "board_deleted" ||
      (mine && change.type === "form_deleted")
    ) {
      b.active = false;
      b.autosave.dispose();
      b.container.replaceChildren(notFoundView({ what: "form" }));
    } else if (mine && change.type === "form_submitted") {
      refreshCount();
    }
  });
}

function failedView(ctx, error) {
  return h(
    "div",
    { class: "page-container" },
    emptyState({
      icon: "alert",
      title: "Couldn’t open this form",
      text: error?.message || "Something went wrong while loading it.",
      action: {
        label: "Try again",
        icon: "refresh",
        onClick: () => ctx.router.reload(),
      },
    }),
  );
}

/** Page contract. */
export async function mount(container, ctx, params) {
  setDocumentTitle("Form");
  container.replaceChildren(loadingView());
  let data;
  try {
    data = await loadFormBuilder(ctx.api, params.formId);
  } catch (error) {
    container.replaceChildren(failedView(ctx, error));
    return undefined;
  }
  if (!data) {
    setDocumentTitle("Not found");
    container.replaceChildren(notFoundView({ what: "form" }));
    return undefined;
  }
  const b = {
    ctx,
    container,
    form: data.form,
    board: data.board,
    readOnly: !hasRole(data.board.myAccess, "editor"),
    blocked: { title: null, questions: null },
    active: true,
    preview: null,
  };
  setDocumentTitle(b.form.title);
  if (data.board.workspace)
    ctx.bus.emit(BUS_EVENTS.workspace, data.board.workspace.id);
  b.autosave = createSaver(b);
  container.replaceChildren(layout(b));
  renderSaveState(b);
  renderPreview(b);
  const unwatch = watch(b);
  const unguard = guardUnsaved({
    unsaved: () => b.autosave.snapshot().unsaved,
    flush: () => b.autosave.flush(),
  });
  return () => {
    b.active = false;
    unwatch();
    unguard();
    globalThis.clearTimeout(b.previewTimer);
    globalThis.clearTimeout(b.countTimer);
    // Edits made just before leaving still reach the server.
    b.autosave.flush().finally(() => b.autosave.dispose());
  };
}
