/**
 * Docs of the ClickUp connector (SPEC-4 §3.2), best effort: v3
 * `GET /workspaces/{team}/docs` (`limit` + `next_cursor` pages, with
 * `deleted=false&archived=false`) and, per doc, `GET …/docs/{doc}/pages`
 * (every page with its markdown content, nested pages inside their
 * parent). A failure is a `read_failed` warning only; after three failed
 * requests in a row the scan stops reading docs.
 *
 * Each ClickUp doc becomes one Worklane doc: its pages in order, each
 * introduced by its name as a heading (heading1 for top-level pages,
 * heading2 below) unless the name repeats the doc's title, with the
 * page's markdown as blocks (`markdownBlocks`). A doc goes to the
 * workspace of its parent space, folder or list; docs of the whole
 * ClickUp workspace (or of a parent this scan did not list) go to a
 * closed "<Team> / Workspace docs" workspace. Public docs are open to
 * their workspace (`visibility: "workspace"`), others stay private.
 */
import { LIMITS } from "../../input.js";
import { UpstreamError } from "../upstream.js";
import { MAX_FAILURES, get, pathId } from "./clickup-common.js";
import {
  idOf,
  isObject,
  limitHit,
  listOf,
  scopeAt,
  str,
} from "./monday-common.js";

const DOC_PAGE = 50;
/** ClickUp's doc parent types (`parent.type`). */
const PARENT = Object.freeze({ space: 4, folder: 5, list: 6 });
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const TODO = /^[-*+]\s+\[([ xX])\](?:\s+(.*))?$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;

// ----------------------------------------------------------- markdown

/** A heading's text without its optional closing `#`s ("Title ##"). */
function headingText(text) {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "#") end -= 1;
  const closed =
    end < trimmed.length && (end === 0 || /\s/.test(trimmed[end - 1]));
  return closed ? trimmed.slice(0, end).trimEnd() : trimmed;
}

const isRule = (text) =>
  "-*_".includes(text[0]) && RULE.test(text.replace(/\s+/g, ""));

function lineBlock(line) {
  const text = line.trim();
  if (text === "") return null;
  if (isRule(text)) return { type: "divider", text: "" };
  let match = HEADING.exec(text);
  if (match) {
    const type = match[1].length === 1 ? "heading1" : "heading2";
    return { type, text: headingText(match[2]) };
  }
  match = TODO.exec(text);
  if (match) {
    return { type: "todo", text: match[2] ?? "", checked: match[1] !== " " };
  }
  match = BULLET.exec(text);
  if (match) return { type: "bulleted", text: match[1] };
  match = NUMBERED.exec(text);
  if (match) return { type: "numbered", text: match[1] };
  if (text.startsWith(">")) {
    return { type: "quote", text: text.replace(/^>\s?/, "") };
  }
  return { type: "paragraph", text };
}

/** Whether `line` closes a code block opened with `fence`. */
function closesFence(line, fence) {
  const match = FENCE.exec(line);
  return (
    match !== null &&
    match[1][0] === fence[0] &&
    match[1].length >= fence.length &&
    line.trim() === match[1]
  );
}

/**
 * Markdown text → SPEC-2 blocks, one per line: `#` heading1, `##`…`######`
 * heading2, `- [ ]` / `- [x]` todo, `- ` / `* ` / `+ ` bulleted, `1. `
 * numbered, `> ` quote, `---` divider, fenced code (``` or ~~~) one code
 * block, other lines paragraphs; blank lines separate blocks. Inline
 * markdown (emphasis, links) is kept as written. `onBlock(block)` gets
 * each block in order.
 */
export function markdownBlocks(markdown, onBlock) {
  let code = null;
  for (const line of str(markdown).split(/\r\n|\n|\r/)) {
    if (code === null) {
      const open = FENCE.exec(line);
      if (open) code = { fence: open[1], lines: [] };
      else {
        const block = lineBlock(line);
        if (block) onBlock(block);
      }
    } else if (closesFence(line, code.fence)) {
      onBlock({ type: "code", text: code.lines.join("\n") });
      code = null;
    } else {
      code.lines.push(line);
    }
  }
  if (code !== null) onBlock({ type: "code", text: code.lines.join("\n") });
}

/**
 * The blocks of a doc's page tree (depth first, in order), at most
 * LIMITS.blocks of them; `total` counts every block the pages hold.
 */
function docBlocks(pages, title) {
  const blocks = [];
  let total = 0;
  const add = (block) => {
    total += 1;
    if (blocks.length < LIMITS.blocks) blocks.push(block);
  };
  const stack = listOf(pages)
    .map((page) => ({ page, depth: 0 }))
    .reverse();
  const repeated = title.trim().toLowerCase();
  while (stack.length > 0) {
    const { page, depth } = stack.pop();
    const name = str(page.name).trim();
    if (name !== "" && name.toLowerCase() !== repeated) {
      add({ type: depth === 0 ? "heading1" : "heading2", text: name });
    }
    markdownBlocks(page.content, add);
    const children = listOf(page.pages).map((child) => ({
      page: child,
      depth: depth + 1,
    }));
    stack.push(...children.reverse());
  }
  return { blocks, total };
}

// --------------------------------------------------------------- reads

/** Runs one docs read: any upstream failure but ABORTED is a warning. */
async function softly(ctx, docs, { path, what }, run) {
  if (docs.stopped) return null;
  try {
    const result = await run();
    docs.failures = 0;
    return result;
  } catch (error) {
    if (!(error instanceof UpstreamError) || error.code === "ABORTED") {
      throw error;
    }
    ctx.report.add(
      "read_failed",
      `${what} could not be read: ${error.message}`,
      path,
    );
    docs.failures += 1;
    if (docs.failures >= MAX_FAILURES) {
      docs.stopped = true;
      const message = `Docs were not read further after ${MAX_FAILURES} failed requests in a row`;
      ctx.report.add("read_failed", message, "workspaces");
    }
    return null;
  }
}

/** The closed workspace for docs of the whole ClickUp workspace `team`. */
function teamDocs(ctx, team) {
  const key = `team-${team.id}`;
  const known = ctx.spaces.get(key);
  if (known) return known;
  return ctx.addWorkspace(key, {
    name: `${team.name} / Workspace docs`,
    kind: "closed",
    team,
  });
}

function docWorkspace(ctx, team, parent, title) {
  const type = Number(isObject(parent) ? parent.type : Number.NaN);
  const id = idOf(isObject(parent) ? parent.id : null);
  const spaceOf = {
    [PARENT.space]: () => id,
    [PARENT.folder]: () => ctx.folders.get(id),
    [PARENT.list]: () => ctx.lists.get(id),
  };
  const spaceId = spaceOf[type]?.() ?? null;
  const entry = spaceId === null ? undefined : ctx.spaces.get(spaceId);
  if (entry) return entry;
  const target = teamDocs(ctx, team);
  if (Object.values(PARENT).includes(type)) {
    const message = `The parent of doc "${title}" (${id ?? "unknown"}) was not among the spaces, folders and lists read; the doc went to "${target.ws.name}"`;
    ctx.report.add("unknown_workspace", message, target.path);
  }
  return target;
}

async function addDoc(ctx, docs, team, raw) {
  const id = pathId(raw.id);
  if (id === null) return;
  const title = str(raw.name);
  const target = docWorkspace(ctx, team, raw.parent, title);
  const path = `${target.path}.docs[${target.ws.docs.length}]`;
  const where = { path, what: `Pages of doc "${title}"` };
  const query = { max_page_depth: "-1", content_format: "text/md" };
  const url = `/v3/workspaces/${team.id}/docs/${id}/pages`;
  const json = await softly(ctx, docs, where, () => get(ctx, url, query));
  const pages = Array.isArray(json) ? json : listOf(json?.pages);
  const { blocks, total } = docBlocks(pages, title);
  if (total > blocks.length) {
    const message = `Only the first ${blocks.length} of ${total} blocks were kept`;
    scopeAt(ctx.report, `${path}.blocks`).add("truncated", message);
  }
  const visibility = raw.public === true ? "workspace" : "private";
  target.ws.docs.push({ source_id: id, title, visibility, blocks });
  ctx.counts.docs += 1;
}

/** Reads the docs of `team` until done, failed or at the doc limit. */
async function readTeamDocs(ctx, docs, team) {
  let cursor = null;
  const where = { path: "workspaces", what: `Docs of "${team.name}"` };
  const maxPages = Math.ceil(ctx.limits.docs / DOC_PAGE) + 1;
  for (let page = 0; page < maxPages; page += 1) {
    const query = {
      limit: String(DOC_PAGE),
      deleted: "false",
      archived: "false",
    };
    if (cursor !== null) query.next_cursor = cursor;
    const url = `/v3/workspaces/${team.id}/docs`;
    const json = await softly(ctx, docs, where, () => get(ctx, url, query));
    const rows = listOf(json?.docs);
    for (const raw of rows) {
      if (docs.stopped) return;
      if (ctx.counts.docs >= ctx.limits.docs) {
        limitHit(ctx, "docs", "workspaces");
        return;
      }
      await addDoc(ctx, docs, team, raw);
    }
    ctx.progress("docs", ctx.counts.docs, null, `Read ${ctx.counts.docs} docs`);
    cursor = idOf(json?.next_cursor);
    if (cursor === null) return;
  }
}

/** Reads the docs of every team (SPEC-4 §3.2 "Docs"). */
export async function readDocs(ctx, teams) {
  ctx.progress("docs", 0, null, "Reading docs");
  const docs = { failures: 0, stopped: false };
  for (const team of teams) {
    if (ctx.stopped.has("docs")) return;
    await readTeamDocs(ctx, docs, team);
  }
}
