/**
 * Notes (`#/notes`, `#/notes/<id>`): a masonry grid of colored note cards
 * (pinned first) with All / Mine / Shared with me filters and a search,
 * and the open note in a side editor (`ui/notes/note-editor.js`). Both
 * routes share one mount, so opening and closing notes never reloads the
 * grid; the page follows the route through `ctx.router.onChange`.
 *
 * Notes are private to their owner until shared; the list comes from the
 * access-filtered `notes` query, and a note the user cannot open shows the
 * same "not available" message as a missing one.
 */

import { h } from "../dom.js";
import { notesHash } from "../router.js";
import { button } from "../ui/components/button.js";
import { emptyState } from "../ui/components/empty-state.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { REASONS, can } from "../ui/components/permissions.js";
import { skeletonCards } from "../ui/components/skeleton.js";
import { tabs } from "../ui/components/tabs.js";
import { noteCard } from "../ui/notes/note-card.js";
import { createNoteEditor } from "../ui/notes/note-editor.js";
import {
  NOTE_FILTERS,
  loadNotes,
  notesView,
  saveNote,
} from "../ui/notes/note-model.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { createFlows } from "../ui/shell/create.js";

const EMPTY_TEXT = {
  all: "Nothing matches these filters.",
  mine: "Notes you write show up here. They stay private until you share them.",
  shared: "When someone shares a note with you, it shows up here.",
};

// ---------------------------------------------------------------- grid

function section(page, { title, notes }) {
  const { ctx, state } = page;
  return h(
    "section",
    { class: "notes-section", "aria-label": title ?? "Notes" },
    title ? h("h2", { class: "notes-section-title" }, title) : null,
    h(
      "div",
      { class: "notes-masonry" },
      notes.map((note) =>
        noteCard(note, {
          me: ctx.me,
          selected: note.id === state.openId,
          onPin: (target) => pinFromCard(page, target),
        }),
      ),
    ),
  );
}

function emptyGrid(page) {
  const { state } = page;
  if (state.notes.length === 0) {
    const allowed = can(page.ctx.me, "create_note");
    return emptyState({
      icon: "notes",
      title: "No notes yet",
      text: "Capture ideas, meeting notes and checklists. Notes are private until you share them.",
      action: allowed
        ? { label: "New note", icon: "plus", onClick: () => page.flows.note() }
        : null,
    });
  }
  const query = state.query.trim();
  return emptyState({
    icon: query ? "search" : "notes",
    compact: true,
    title: query ? `No notes match “${query}”` : "No notes here yet",
    text: query
      ? "Try another word, or clear the search."
      : EMPTY_TEXT[state.filter],
  });
}

function renderTabs(page, counts) {
  const { dom, state } = page;
  const focused = dom.tabs.contains(globalThis.document.activeElement);
  dom.tabs.replaceChildren(
    tabs({
      label: "Filter notes",
      items: NOTE_FILTERS.map((entry) => ({
        ...entry,
        count: counts[entry.id],
      })),
      active: state.filter,
      onSelect(id) {
        state.filter = id;
        renderGrid(page);
      },
    }),
  );
  if (focused) dom.tabs.querySelector(".tab.active")?.focus();
}

function renderGrid(page) {
  const { state, dom } = page;
  if (!state.notes) return;
  const view = notesView(state.notes, { ...state, meId: page.ctx.me.id });
  renderTabs(page, view.counts);
  const pinnedFirst = view.pinned.length > 0;
  const sections = [
    pinnedFirst && section(page, { title: "Pinned", notes: view.pinned }),
    view.others.length > 0 &&
      section(page, {
        title: pinnedFirst ? "Others" : null,
        notes: view.others,
      }),
  ].filter(Boolean);
  dom.grid.replaceChildren(
    ...(sections.length > 0 ? sections : [emptyGrid(page)]),
  );
}

// --------------------------------------------------------------- data

async function reloadNotes(page) {
  try {
    const notes = await loadNotes(page.ctx.api);
    if (!page.active) return false;
    page.state.notes = notes;
    renderGrid(page);
    return true;
  } catch (error) {
    if (!page.active) return false;
    page.dom.grid.replaceChildren(
      emptyState({
        icon: "alert",
        title: "Couldn’t load notes",
        text: error.message,
        action: {
          label: "Try again",
          icon: "refresh",
          onClick: () => reloadNotes(page),
        },
      }),
    );
    return false;
  }
}

/** Replaces one note in the list (after a save) and redraws the grid. */
function updateNote(page, note) {
  const { state } = page;
  state.notes = state.notes.map((entry) =>
    entry.id === note.id ? note : entry,
  );
  renderGrid(page);
}

async function pinFromCard(page, note) {
  if (page.editor?.id === note.id) {
    page.editor.togglePin();
    return;
  }
  try {
    await saveNote(page.ctx.api, {
      id: note.id,
      changes: { pinned: !note.pinned },
      expectedVersion: note.version,
    });
  } catch (error) {
    page.ctx.toast.error(error, "Couldn’t pin the note");
  }
  await reloadNotes(page);
}

// ------------------------------------------------------------- editor

function closeEditor(page) {
  const { editor, dom } = page;
  if (!editor) return;
  editor.close();
  page.editor = null;
  dom.panel.replaceChildren();
  dom.layout.classList.remove("has-editor");
}

function missingPanel(page) {
  page.dom.layout.classList.add("has-editor");
  page.dom.panel.replaceChildren(
    h(
      "aside",
      {
        class: "note-panel note-missing",
        "aria-label": "Note",
        tabindex: "-1",
      },
      emptyState({
        icon: "search",
        compact: true,
        title: "This note isn’t available",
        text: "It may have been deleted, or you don’t have access to it.",
        action: { label: "Back to notes", href: notesHash() },
      }),
    ),
  );
}

function editorCallbacks(page) {
  return {
    onSaved(note, changes) {
      if ("pinned" in changes) reloadNotes(page);
      else updateNote(page, note);
    },
    onClose: () => page.ctx.router.navigate(notesHash()),
    async onDeleted(id) {
      closeEditor(page);
      page.state.notes = page.state.notes.filter((note) => note.id !== id);
      page.ctx.router.navigate(notesHash());
      await reloadNotes(page);
    },
    onShared: () => refreshAfterShare(page),
    async onReload() {
      const id = page.editor?.id;
      closeEditor(page);
      await reloadNotes(page);
      if (page.state.openId === id) openNote(page, id, { force: true });
    },
  };
}

/**
 * A notification (for example a note shared with you) reloads the grid.
 * When the open note is gone and nothing is unsaved, its panel says so.
 */
async function onNotification(page) {
  if (!(await reloadNotes(page)) || !page.editor) return;
  const { id } = page.editor;
  const gone = !page.state.notes.some((note) => note.id === id);
  if (gone && !page.editor.unsaved()) {
    closeEditor(page);
    missingPanel(page);
  }
}

async function refreshAfterShare(page) {
  await reloadNotes(page);
  const fresh = page.state.notes?.find((note) => note.id === page.editor?.id);
  if (fresh) page.editor.refreshMeta(fresh);
}

async function findNote(page, id) {
  const known = page.state.notes?.find((note) => note.id === id);
  if (known) return known;
  // A note created or shared since the last load: fetch the list again.
  await reloadNotes(page);
  return page.state.notes?.find((note) => note.id === id) ?? null;
}

/** Shows note `id` in the side editor (null closes it). */
async function openNote(page, id, { force = false } = {}) {
  const { state } = page;
  const previous = state.openId;
  state.openId = id;
  if (!force && page.editor && page.editor.id === id) return;
  closeEditor(page);
  if (previous !== id && state.notes) renderGrid(page);
  if (!id) {
    setDocumentTitle("Notes");
    page.dom.grid
      .querySelector(`[data-note-id="${previous}"] .note-card-link`)
      ?.focus();
    return;
  }
  const note = await findNote(page, id);
  if (!page.active || state.openId !== id) return;
  renderGrid(page);
  if (!note) {
    setDocumentTitle("Note not available");
    missingPanel(page);
    return;
  }
  page.editor = createNoteEditor({
    ctx: page.ctx,
    note,
    ...editorCallbacks(page),
  });
  page.dom.panel.replaceChildren(page.editor.element);
  page.dom.layout.classList.add("has-editor");
  setDocumentTitle(note.title);
  // A note nobody has edited yet: select its placeholder title.
  const fresh = note.version === 1 && note.body === "";
  // After the router's own focus move (initial mount).
  globalThis.setTimeout(
    () => page.editor?.id === id && page.editor.focus({ select: fresh }),
    0,
  );
}

// --------------------------------------------------------------- page

function build(page) {
  const { dom, state, ctx } = page;
  const allowed = can(ctx.me, "create_note");
  dom.tabs = h("div", { class: "notes-tabs" });
  dom.grid = h(
    "div",
    { class: "notes-grid" },
    skeletonCards({ count: 6, label: "Loading notes" }),
  );
  dom.panel = h("div", { class: "notes-panel-slot" });
  dom.layout = h("div", { class: "notes-layout" }, dom.grid, dom.panel);
  const search = h("input", {
    class: "input input-small",
    type: "search",
    placeholder: "Search notes",
    "aria-label": "Search notes",
    autocomplete: "off",
    on: {
      input() {
        state.query = search.value;
        renderGrid(page);
      },
    },
  });
  return h(
    "div",
    { class: "page-container notes-page" },
    pageHeader({
      title: "Notes",
      icon: "notes",
      subtitle: "Private to you until you share them",
      actions: [
        button({
          label: "New note",
          icon: "plus",
          variant: "primary",
          disabledReason: allowed ? null : REASONS.noCreate,
          onClick: () => page.flows.note(),
        }),
      ],
    }),
    h("div", { class: "page-toolbar notes-toolbar" }, dom.tabs, search),
    dom.layout,
  );
}

/** Page contract. */
export async function mount(container, ctx, params) {
  const page = {
    ctx,
    flows: createFlows(ctx),
    state: { notes: null, filter: "all", query: "", openId: null },
    dom: {},
    editor: null,
    active: true,
  };
  const offRoute = ctx.router.onChange((route) => {
    if (route.name === "notes") openNote(page, route.params.noteId ?? null);
  });
  setDocumentTitle("Notes");
  container.append(build(page));
  const offs = [
    offRoute,
    ctx.bus.on(BUS_EVENTS.notification, () => onNotification(page)),
  ];
  await reloadNotes(page);
  if (params.noteId && page.active) openNote(page, params.noteId);
  return () => {
    page.active = false;
    for (const off of offs) off();
    page.editor?.close();
  };
}
