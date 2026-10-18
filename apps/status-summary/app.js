/**
 * Status summary: an example mini-monday board-view app.
 *
 * Everything goes through the SDK bridge to the host page (exact origin from
 * /apps/config.js): board data via the host-proxied GraphQL API, the note via
 * instance storage with optimistic versions, notices and item navigation via
 * `execute`, and live refresh via `listen("events")`. The session token is
 * verified by this app's own backend. All data is rendered with DOM APIs and
 * textContent, never as HTML.
 */
import { HOST_ORIGIN } from "/apps/config.js";
import { createClient } from "/sdk/mini-monday-sdk.js";

const PAGE_LIMIT = 100;
const MAX_PAGES = 200;
const REFRESH_DELAY_MS = 400;
const NOTE_KEY = "note";
const MAX_NOTE_LENGTH = 65_536;
const MAX_NOTICE_LENGTH = 200;
const FALLBACK_COLOR = "#c4c4c4";
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const VERIFY_URL = "/apps/status-summary/api/verify";

const BOARD_QUERY = `query StatusSummaryBoard($board: ID!) {
  boards(ids: [$board]) {
    id
    name
    columns { id title type settings_str }
  }
}`;

const ITEMS_QUERY = `query StatusSummaryItems(
  $board: ID!
  $limit: Int!
  $cursor: String
  $columns: [String!]
) {
  boards(ids: [$board]) {
    items_page(limit: $limit, cursor: $cursor) {
      cursor
      items { id column_values(ids: $columns) { id value } }
    }
  }
}`;

const byId = (id) => document.getElementById(id);
const ui = {
  boardName: byId("board-name"),
  itemTotal: byId("item-total"),
  live: byId("live"),
  liveText: byId("live-text"),
  breakdown: byId("breakdown"),
  columnName: byId("column-name"),
  bars: byId("bars"),
  barsEmpty: byId("bars-empty"),
  note: byId("note"),
  noteVersion: byId("note-version"),
  saveNote: byId("save-note"),
  reloadNote: byId("reload-note"),
  noteStatus: byId("note-status"),
  sendNotice: byId("send-notice"),
  verifyToken: byId("verify-token"),
  platformStatus: byId("platform-status"),
  claims: byId("claims"),
  error: byId("error"),
};

const state = {
  client: null,
  boardId: null,
  instanceId: null,
  summary: null,
  noteVersion: null,
  loadSequence: 0,
  refreshTimer: null,
};

// ------------------------------------------------------------------ helpers

/** Creates an element; string children become text nodes (never HTML). */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

const isObject = (value) => typeof value === "object" && value !== null;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function setStatus(node, text, tone = "") {
  node.textContent = text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  ui.error.textContent = message;
  ui.error.hidden = false;
}

const clearError = () => {
  ui.error.hidden = true;
  ui.error.textContent = "";
};

/** Runs `task` with `button` disabled; reports failures in `statusNode`. */
async function withButton(button, statusNode, task) {
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    setStatus(statusNode, error?.message ?? String(error), "error");
  } finally {
    button.disabled = false;
  }
}

function applyContext(context) {
  if (!isObject(context)) return;
  const dark = context.theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

// ------------------------------------------------------------------ summary

/** Status labels of a column, ordered by index, from its settings_str. */
function readLabels(column) {
  const settings = parseJson(column.settings_str);
  const labels = isObject(settings?.labels) ? settings.labels : {};
  const colors = isObject(settings?.labels_colors)
    ? settings.labels_colors
    : {};
  return Object.keys(labels)
    .filter((index) => /^\d{1,4}$/.test(index))
    .sort((a, b) => Number(a) - Number(b))
    .map((index) => ({
      index,
      label: typeof labels[index] === "string" ? labels[index] : "",
      color: COLOR_PATTERN.test(colors[index]) ? colors[index] : FALLBACK_COLOR,
    }));
}

function readIndex(value) {
  const index = parseJson(value)?.index;
  return Number.isInteger(index) ? String(index) : null;
}

/** Fetches every item's status value, following items_page cursors. */
async function fetchStatusValues(client, { boardId, columnId }) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  do {
    if (seen.size >= MAX_PAGES) throw new Error("The board is too large.");
    const variables = {
      board: boardId,
      limit: PAGE_LIMIT,
      cursor,
      columns: [columnId],
    };
    const { data } = await client.api(ITEMS_QUERY, { variables });
    const page = data?.boards?.[0]?.items_page;
    if (!page) throw new Error("The board is no longer available.");
    items.push(...page.items);
    cursor = page.cursor ?? null;
    if (seen.has(cursor)) throw new Error("The API repeated a page cursor.");
    seen.add(cursor);
  } while (cursor !== null);
  return items.map((item) => ({
    id: item.id,
    index: readIndex(item.column_values?.[0]?.value),
  }));
}

/** One bucket per label (zero counts included) plus unknown indexes. */
function summarize(labels, values) {
  const buckets = new Map();
  for (const label of labels) {
    buckets.set(label.index, { ...label, count: 0, firstItemId: null });
  }
  // An item without a value shows under the blank label ("" at index 5).
  const blank = labels.find((label) => label.label === "")?.index ?? "none";
  for (const { id, index } of values) {
    const key = index ?? blank;
    if (!buckets.has(key)) {
      const label = key === "none" ? "" : `Unknown (${key})`;
      buckets.set(key, { index: key, label, color: FALLBACK_COLOR, count: 0 });
    }
    const bucket = buckets.get(key);
    bucket.count += 1;
    bucket.firstItemId ??= id;
  }
  return [...buckets.values()];
}

async function loadSummary(client, boardId) {
  const { data } = await client.api(BOARD_QUERY, {
    variables: { board: boardId },
  });
  const board = data?.boards?.[0];
  if (!board) throw new Error("This board was not found.");
  const column = board.columns.find((c) => c.type === "status") ?? null;
  if (!column) return { board, column, buckets: [], total: 0 };
  const values = await fetchStatusValues(client, {
    boardId,
    columnId: column.id,
  });
  const buckets = summarize(readLabels(column), values);
  return { board, column, buckets, total: values.length };
}

function barItem(bucket, total) {
  const name = bucket.label === "" ? "No status" : bucket.label;
  const percent = total === 0 ? 0 : (bucket.count / total) * 100;
  const fill = el("span", "bar-fill");
  // CSSOM writes are not inline style attributes, so the CSP allows them.
  fill.style.width = `${percent.toFixed(1)}%`;
  fill.style.setProperty("--bar-color", bucket.color);
  const button = el(
    "button",
    "bar",
    el("span", "bar-label", name),
    el("span", "bar-track", fill),
    el("span", "bar-count", String(bucket.count)),
  );
  button.type = "button";
  button.title = `${name}: ${bucket.count} of ${total}`;
  button.disabled = !bucket.firstItemId;
  button.addEventListener("click", () => openFirstItem(bucket));
  return el("li", "", button);
}

function renderSummary({ board, column, buckets, total }) {
  ui.boardName.textContent = board.name;
  ui.itemTotal.textContent = `${total} ${total === 1 ? "item" : "items"}`;
  ui.columnName.textContent = column ? column.title : "";
  ui.bars.replaceChildren(...buckets.map((b) => barItem(b, total)));
  const empty = !column ? "This board has no status column." : "";
  ui.barsEmpty.textContent = empty;
  ui.barsEmpty.hidden = empty === "";
  const time = new Date().toLocaleTimeString();
  ui.liveText.textContent = `Live · updated ${time}`;
}

/** Loads and renders the summary; older overlapping loads are discarded. */
async function refresh() {
  const sequence = ++state.loadSequence;
  ui.breakdown.setAttribute("aria-busy", "true");
  try {
    const summary = await loadSummary(state.client, state.boardId);
    if (sequence !== state.loadSequence) return;
    state.summary = summary;
    renderSummary(summary);
    clearError();
  } catch (error) {
    if (sequence === state.loadSequence) showError(error);
  } finally {
    if (sequence === state.loadSequence) {
      ui.breakdown.removeAttribute("aria-busy");
    }
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refresh, REFRESH_DELAY_MS);
}

function onBoardEvent(change) {
  const boardId = change?.board_id;
  if (boardId !== undefined && String(boardId) !== state.boardId) return;
  scheduleRefresh();
}

async function openFirstItem(bucket) {
  if (!bucket.firstItemId) return;
  try {
    const itemId = bucket.firstItemId;
    await state.client.execute("openItemCard", { itemId });
  } catch (error) {
    showError(error);
  }
}

// --------------------------------------------------------------------- note

function setNoteVersion(version) {
  state.noteVersion = Number.isInteger(version) ? version : null;
  ui.noteVersion.textContent =
    state.noteVersion === null
      ? "Not saved yet"
      : `Version ${state.noteVersion}`;
}

async function loadNote() {
  const result = await state.client.storage.instance.getItem(NOTE_KEY);
  ui.note.value = typeof result?.value === "string" ? result.value : "";
  setNoteVersion(result?.version);
  ui.reloadNote.hidden = true;
}

async function saveNote() {
  const value = ui.note.value;
  if (value.length > MAX_NOTE_LENGTH) {
    const limit = MAX_NOTE_LENGTH.toLocaleString();
    setStatus(
      ui.noteStatus,
      `Notes are limited to ${limit} characters.`,
      "error",
    );
    return;
  }
  setStatus(ui.noteStatus, "Saving…");
  // Without a known version (no note yet) the first save is unconditional.
  const previousVersion = state.noteVersion ?? undefined;
  const result = await state.client.storage.instance.setItem(NOTE_KEY, value, {
    previousVersion,
  });
  if (result?.success) {
    setNoteVersion(result.version);
    ui.reloadNote.hidden = true;
    setStatus(ui.noteStatus, `Saved as version ${result.version}.`, "success");
    return;
  }
  if (result?.reason === "version_conflict") {
    const current = result.version ?? "deleted";
    const message =
      `Not saved: someone else saved version ${current} while you were ` +
      "editing. Load the latest note, then save again.";
    ui.reloadNote.hidden = false;
    setStatus(ui.noteStatus, message, "error");
    return;
  }
  const reason = result?.reason ?? "unknown reason";
  setStatus(ui.noteStatus, `Not saved (${reason}).`, "error");
}

async function reloadNote() {
  await loadNote();
  setStatus(ui.noteStatus, "Loaded the latest note.");
}

// ----------------------------------------------------------------- platform

function noticeMessage() {
  const summary = state.summary;
  if (!summary) return "Status summary is loading.";
  const parts = summary.buckets
    .filter((bucket) => bucket.count > 0)
    .map((b) => `${b.count} ${b.label === "" ? "no status" : b.label}`);
  const counts = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  const message = `${summary.board.name} has ${summary.total} items${counts}`;
  return message.length > MAX_NOTICE_LENGTH
    ? `${message.slice(0, MAX_NOTICE_LENGTH - 1)}…`
    : message;
}

async function sendNotice() {
  const message = noticeMessage();
  await state.client.execute("notice", { message, type: "success" });
  setStatus(ui.platformStatus, "Notice sent to the board.", "success");
}

function renderClaims(claims) {
  const expires = Number.isFinite(claims.exp)
    ? `${new Date(claims.exp * 1000).toLocaleString()} (${claims.exp})`
    : "unknown";
  const rows = [
    ["User", claims.user_id],
    ["Board", claims.board_id],
    ["Install", claims.install_id],
    ["Expires", expires],
  ];
  ui.claims.replaceChildren(
    ...rows.flatMap(([term, value]) => [
      el("dt", "", term),
      el("dd", "", String(value ?? "unknown")),
    ]),
  );
  ui.claims.hidden = false;
}

async function verifyToken() {
  ui.claims.hidden = true;
  setStatus(ui.platformStatus, "Requesting a session token…");
  const { token } = await state.client.get("sessionToken");
  const response = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionToken: token }),
    credentials: "omit",
    cache: "no-store",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true || !isObject(body.claims)) {
    const reason = body?.reason ?? `HTTP ${response.status}`;
    setStatus(ui.platformStatus, `Verification failed (${reason}).`, "error");
    return;
  }
  renderClaims(body.claims);
  const sameInstall = String(body.claims.install_id) === state.instanceId;
  const scope = sameInstall ? "for this view" : "for a different install";
  setStatus(ui.platformStatus, `Token verified ${scope}.`, "success");
}

// --------------------------------------------------------------------- boot

function bindControls() {
  const note = ui.noteStatus;
  const platform = ui.platformStatus;
  ui.saveNote.addEventListener("click", () =>
    withButton(ui.saveNote, note, saveNote),
  );
  ui.reloadNote.addEventListener("click", () =>
    withButton(ui.reloadNote, note, reloadNote),
  );
  ui.sendNotice.addEventListener("click", () =>
    withButton(ui.sendNotice, platform, sendNotice),
  );
  ui.verifyToken.addEventListener("click", () =>
    withButton(ui.verifyToken, platform, verifyToken),
  );
}

async function start() {
  if (window.parent === window) {
    throw new Error("Open this app from a board view in mini-monday.");
  }
  const client = createClient({ hostOrigin: HOST_ORIGIN });
  state.client = client;
  window.addEventListener("pagehide", () => client.destroy(), { once: true });
  const context = await client.get("context");
  applyContext(context);
  state.boardId = String(context?.boardId ?? "");
  state.instanceId = String(context?.instanceId ?? "");
  if (state.boardId === "") throw new Error("The host sent no board.");
  client.listen("context", applyContext);
  client.listen("events", onBoardEvent);
  ui.live.hidden = false;
  bindControls();
  await Promise.all([
    refresh(),
    loadNote().catch((error) => {
      setStatus(ui.noteStatus, `Could not load the note: ${error.message}`);
    }),
  ]);
}

start().catch(showError);
