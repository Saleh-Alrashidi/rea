/**
 * Shared with me (`#/shared`): cards for the boards, docs and notes shared
 * with the user through a user or team grant (`shared_with_me`), with the
 * owners who shared them and the user's role. Filters: All / Boards / Docs
 * / Notes.
 *
 * The API records grants, not who created them, so a card names the
 * resource's owners as the people who shared it.
 */

import { h } from "../dom.js";
import { hashFromUrl } from "../router.js";
import { avatarStack } from "../ui/components/avatar.js";
import {
  accessBadge,
  boardKindBadge,
  docVisibilityBadge,
} from "../ui/components/badge.js";
import { emptyState } from "../ui/components/empty-state.js";
import { plural } from "../ui/components/format.js";
import { icon } from "../ui/components/icon.js";
import { boardKind, resourceKind } from "../ui/components/labels.js";
import { pageHeader, setDocumentTitle } from "../ui/components/page-header.js";
import { skeletonCards } from "../ui/components/skeleton.js";
import { tabs } from "../ui/components/tabs.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";

export const SHARED_QUERY = `query SharedWithMe { shared_with_me { kind id title subtitle url } }`;

export const SHARED_DETAILS_QUERY = `query SharedDetails($boardIds: [ID!], $docIds: [ID!], $withBoards: Boolean!, $withDocs: Boolean!, $withNotes: Boolean!) {
  boards(ids: $boardIds, limit: 100) @include(if: $withBoards) {
    id board_kind my_access workspace { id name }
    members { kind id name role user { id name initials color } }
  }
  docs(ids: $docIds) @include(if: $withDocs) {
    id visibility my_access workspace { id name }
    members { kind id name role user { id name initials color } }
  }
  notes(scope: shared) @include(if: $withNotes) {
    id my_access color owner { id name initials color }
  }
}`;

const FILTERS = [
  { id: "all", label: "All" },
  { id: "board", label: "Boards" },
  { id: "doc", label: "Docs" },
  { id: "note", label: "Notes" },
];
const KINDS = new Set(["board", "doc", "note"]);

function owners(record) {
  if (record?.owner) return [record.owner];
  return (record?.members ?? [])
    .filter((member) => member.role === "owner")
    .map(
      (member) =>
        member.user ?? { id: member.id, name: member.name, kind: member.kind },
    );
}

/** Joins `shared_with_me` entries with their details (exported for tests). */
export function sharedCards(entries, details) {
  const byKind = {
    board: new Map(
      (details.boards ?? []).map((record) => [String(record.id), record]),
    ),
    doc: new Map(
      (details.docs ?? []).map((record) => [String(record.id), record]),
    ),
    note: new Map(
      (details.notes ?? []).map((record) => [String(record.id), record]),
    ),
  };
  return entries
    .filter((entry) => KINDS.has(entry.kind))
    .map((entry) => {
      const record = byKind[entry.kind].get(String(entry.id)) ?? null;
      return {
        ...entry,
        id: String(entry.id),
        hash: hashFromUrl(entry.url),
        record,
        owners: owners(record),
      };
    })
    .filter((card) => card.hash);
}

function kindBadge(card) {
  if (card.kind === "board" && card.record)
    return boardKindBadge(card.record.board_kind);
  if (card.kind === "doc" && card.record)
    return docVisibilityBadge(card.record.visibility);
  return null;
}

function cardIcon(card) {
  if (card.kind === "board") return boardKind(card.record?.board_kind).icon;
  return resourceKind(card.kind).icon;
}

function sharedCard(card) {
  const names = card.owners.map((owner) => owner.name).join(", ");
  const tile = h(
    "a",
    { class: ["panel", "shared-card", `shared-${card.kind}`], href: card.hash },
    h(
      "div",
      { class: "shared-card-top" },
      h(
        "span",
        { class: "shared-card-icon" },
        icon(cardIcon(card), { size: 18 }),
      ),
      h("span", { class: "shared-card-kind" }, resourceKind(card.kind).label),
      kindBadge(card),
    ),
    h("h2", { class: "shared-card-title" }, card.title),
    card.subtitle || card.record?.workspace
      ? h(
          "p",
          { class: "shared-card-subtitle" },
          card.subtitle ?? card.record.workspace.name,
        )
      : null,
    h(
      "div",
      { class: "shared-card-footer" },
      card.owners.length > 0
        ? avatarStack(card.owners, { max: 3, size: "xs" })
        : null,
      h(
        "span",
        { class: "shared-card-by" },
        names ? `Shared by ${names}` : "Shared with you",
      ),
      card.record ? accessBadge(card.record.my_access) : null,
    ),
  );
  if (
    card.kind === "note" &&
    /^#[0-9a-fA-F]{6}$/.test(card.record?.color ?? "")
  ) {
    tile.style.setProperty("--note-color", card.record.color);
  }
  return tile;
}

async function loadShared(api) {
  const { shared_with_me: entries } = await api.request(SHARED_QUERY);
  const idsOf = (kind) =>
    entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => String(entry.id));
  const boardIds = idsOf("board");
  const docIds = idsOf("doc");
  const withNotes = entries.some((entry) => entry.kind === "note");
  const details =
    boardIds.length + docIds.length > 0 || withNotes
      ? await api.request(SHARED_DETAILS_QUERY, {
          boardIds,
          docIds,
          withBoards: boardIds.length > 0,
          withDocs: docIds.length > 0,
          withNotes,
        })
      : {};
  return sharedCards(entries, details);
}

function renderCards(body, cards, filter) {
  const shown =
    filter === "all" ? cards : cards.filter((card) => card.kind === filter);
  if (shown.length === 0) {
    const what =
      filter === "all"
        ? "Nothing"
        : `No ${FILTERS.find((entry) => entry.id === filter).label.toLowerCase()}`;
    body.replaceChildren(
      emptyState({
        icon: "shared",
        title: `${what} shared with you yet`,
        text: "When someone invites you to a board, doc or note, it shows up here.",
      }),
    );
    return;
  }
  body.replaceChildren(
    h("div", { class: "panel-grid" }, shown.map(sharedCard)),
  );
}

/** Page contract. */
export async function mount(container, ctx) {
  setDocumentTitle("Shared with me");
  const state = { cards: null, filter: "all", active: true };
  const subtitle = h(
    "span",
    null,
    "Boards, docs and notes others shared with you",
  );
  const filterSlot = h("div", { class: "page-toolbar" });
  const body = h(
    "div",
    { class: "page-body" },
    skeletonCards({ count: 6, label: "Loading shared items" }),
  );

  function renderFilters() {
    const count = (kind) =>
      (state.cards ?? []).filter((card) => kind === "all" || card.kind === kind)
        .length;
    filterSlot.replaceChildren(
      tabs({
        label: "Filter shared items",
        items: FILTERS.map((entry) => ({
          ...entry,
          count: state.cards ? count(entry.id) : undefined,
        })),
        active: state.filter,
        onSelect(id) {
          state.filter = id;
          renderFilters();
          renderCards(body, state.cards ?? [], state.filter);
        },
      }),
    );
  }

  async function reload() {
    try {
      const cards = await loadShared(ctx.api);
      if (!state.active) return;
      state.cards = cards;
      subtitle.textContent = `${plural(cards.length, "item")} shared with you`;
      renderFilters();
      renderCards(body, cards, state.filter);
    } catch (error) {
      if (!state.active) return;
      body.replaceChildren(
        emptyState({
          icon: "alert",
          title: "Couldn’t load shared items",
          text: error.message,
          action: { label: "Try again", onClick: reload },
        }),
      );
    }
  }

  container.append(
    h(
      "div",
      { class: "page-container" },
      pageHeader({ title: "Shared with me", icon: "shared", subtitle }),
      filterSlot,
      body,
    ),
  );
  renderFilters();
  const off = ctx.bus.on(BUS_EVENTS.notification, reload);
  reload();
  return () => {
    state.active = false;
    off();
  };
}
