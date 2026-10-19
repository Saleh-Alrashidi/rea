/**
 * Docs (`#/docs`): every doc the user can open across workspaces, with
 * All / Mine / Shared with me filters, a workspace filter and a title
 * search. Rows show the visibility badge, the workspace, who edited last
 * and when, and "View only" for read-only docs. "New doc" opens the shared
 * create dialog (title, workspace, visibility).
 *
 * The list comes from the access-filtered `docs` query and "Shared with
 * me" from `shared_with_me`; nothing here decides access.
 */

import { h } from "../dom.js";
import { docHash } from "../router.js";
import { avatar } from "../ui/components/avatar.js";
import { accessBadge, docVisibilityBadge } from "../ui/components/badge.js";
import { button } from "../ui/components/button.js";
import { emptyState } from "../ui/components/empty-state.js";
import { plural, timeAgo } from "../ui/components/format.js";
import { icon } from "../ui/components/icon.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { REASONS, can } from "../ui/components/permissions.js";
import { skeletonList } from "../ui/components/skeleton.js";
import { tabs } from "../ui/components/tabs.js";
import {
  DOC_FILTERS,
  docWorkspaces,
  docsView,
  loadDocsList,
  personLabel,
} from "../ui/docs/doc-data.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { createFlows } from "../ui/shell/create.js";

const EMPTY_FILTER_TEXT = {
  mine: "Docs you create show up here.",
  shared: "When someone shares a doc with you, it shows up here.",
  all: "Nothing matches these filters.",
};

/** The doc's last edit; never attributed to its creator instead. */
function editedBy(ctx, doc) {
  const who = personLabel(doc.updated_by, ctx.me.id);
  return {
    person: doc.updated_by,
    text: `${timeAgo(doc.updated_at)} by ${who}`,
  };
}

function docRow(ctx, doc) {
  const edit = editedBy(ctx, doc);
  return h(
    "li",
    { class: "doc-row" },
    h(
      "a",
      { class: "doc-row-main", href: docHash(doc.id) },
      h("span", { class: "doc-row-icon" }, icon("docs", { size: 18 })),
      h(
        "span",
        { class: "doc-row-text" },
        h("span", { class: "doc-row-title" }, doc.title),
        h("span", { class: "doc-row-workspace" }, doc.workspace?.name ?? ""),
      ),
    ),
    h(
      "span",
      { class: "doc-row-badges" },
      docVisibilityBadge(doc.visibility),
      accessBadge(doc.my_access === "viewer" ? "viewer" : null),
    ),
    h(
      "span",
      {
        class: "doc-row-edited",
        title: new Date(doc.updated_at).toLocaleString(),
      },
      edit.person ? avatar(edit.person, { size: "xs", title: null }) : null,
      h("span", null, edit.text),
    ),
  );
}

function workspaceSelect(state, render) {
  const workspaces = docWorkspaces(state.docs);
  if (workspaces.length < 2) return null;
  return h(
    "label",
    { class: "docs-workspace" },
    h("span", { class: "visually-hidden" }, "Space"),
    h(
      "select",
      {
        class: "input input-small",
        value: state.workspaceId ?? "",
        on: {
          change(event) {
            state.workspaceId = event.target.value || null;
            render({ keepToolbar: true });
          },
        },
      },
      h("option", { value: "" }, "All Spaces"),
      workspaces.map((workspace) =>
        h("option", { value: workspace.id }, workspace.name),
      ),
    ),
  );
}

function searchBox(state, render) {
  return h(
    "label",
    { class: "docs-search" },
    h("span", { class: "visually-hidden" }, "Search docs"),
    h("input", {
      class: "input input-small",
      type: "search",
      placeholder: "Search docs",
      autocomplete: "off",
      value: state.query,
      on: {
        input(event) {
          state.query = event.target.value;
          render({ keepToolbar: true });
        },
      },
    }),
  );
}

function emptyList(ctx, state, flows) {
  if (state.docs.length === 0) {
    const allowed = can(ctx.me, "create_content");
    return emptyState({
      icon: "docs",
      title: "No docs yet",
      text: "Docs hold specs, briefs and meeting notes your team can read together.",
      action: allowed
        ? { label: "New doc", icon: "plus", onClick: () => flows.doc() }
        : null,
    });
  }
  const query = state.query.trim();
  return emptyState({
    icon: query ? "search" : "docs",
    compact: true,
    title: query ? `No docs match “${query}”` : "No docs here yet",
    text: query
      ? "Try another word, or clear the filters."
      : EMPTY_FILTER_TEXT[state.filter],
  });
}

function filterTabs(state, counts, render) {
  return tabs({
    label: "Filter docs",
    items: DOC_FILTERS.map((entry) => ({ ...entry, count: counts[entry.id] })),
    active: state.filter,
    onSelect(id) {
      state.filter = id;
      render({ keepToolbar: true });
    },
  });
}

function renderList(page, { keepToolbar = false } = {}) {
  const { ctx, state, dom, flows } = page;
  if (!state.docs) return;
  const render = (options) => renderList(page, options);
  const { rows, counts } = docsView(state.docs, {
    ...state,
    meId: String(ctx.me.id),
  });
  const tabFocused = dom.filters.contains(globalThis.document.activeElement);
  dom.filters.replaceChildren(filterTabs(state, counts, render));
  // Keep keyboard focus on the selected tab across the re-render.
  if (tabFocused) dom.filters.querySelector(".tab.active")?.focus();
  if (!keepToolbar) {
    dom.toolbar.replaceChildren(
      dom.filters,
      h(
        "div",
        { class: "docs-tools" },
        workspaceSelect(state, render),
        searchBox(state, render),
      ),
    );
  }
  dom.subtitle.textContent = `${plural(state.docs.length, "doc")} you can open`;
  dom.body.replaceChildren(
    rows.length === 0
      ? emptyList(ctx, state, flows)
      : h(
          "section",
          { class: "panel docs-panel", "aria-label": "Docs" },
          h(
            "ul",
            { class: "doc-list" },
            rows.map((doc) => docRow(ctx, doc)),
          ),
        ),
  );
}

async function reloadList(page) {
  const { ctx, state, dom } = page;
  try {
    const { docs, sharedIds } = await loadDocsList(ctx.api);
    if (!state.active) return;
    Object.assign(state, { docs, sharedIds });
    renderList(page);
  } catch (error) {
    if (!state.active) return;
    dom.body.replaceChildren(
      emptyState({
        icon: "alert",
        title: "Couldn’t load docs",
        text: error.message,
        action: {
          label: "Try again",
          icon: "refresh",
          onClick: () => reloadList(page),
        },
      }),
    );
  }
}

function newDocButton(page) {
  const allowed = can(page.ctx.me, "create_content");
  return button({
    label: "New doc",
    icon: "plus",
    variant: "primary",
    disabledReason: allowed ? null : REASONS.noCreate,
    onClick: () => page.flows.doc(),
  });
}

/** Page contract. */
export async function mount(container, ctx) {
  setDocumentTitle("Docs");
  const page = {
    ctx,
    flows: createFlows(ctx),
    state: {
      docs: null,
      sharedIds: new Set(),
      filter: "all",
      workspaceId: null,
      query: "",
      active: true,
    },
    dom: {
      subtitle: h("span", null, "Specs, briefs and notes across your Spaces"),
      toolbar: h("div", { class: "page-toolbar docs-toolbar" }),
      filters: h("div", { class: "docs-filters" }),
      body: h(
        "div",
        { class: "page-body" },
        skeletonList({ rows: 5, label: "Loading docs" }),
      ),
    },
  };
  const { dom } = page;
  container.append(
    h(
      "div",
      { class: "page-container docs-page" },
      pageHeader({
        title: "Docs",
        icon: "docs",
        subtitle: dom.subtitle,
        actions: [newDocButton(page)],
      }),
      dom.toolbar,
      dom.body,
    ),
  );
  const reload = () => reloadList(page);
  const offs = [
    ctx.bus.on(BUS_EVENTS.notification, reload),
    ctx.bus.on(BUS_EVENTS.shell, reload),
  ];
  reload();
  return () => {
    page.state.active = false;
    for (const off of offs) off();
  };
}
