/**
 * Helpers of the ClickUp List and task view browser test
 * (`e2e-clickup.mjs`): the meetings import done in code (a scan of the
 * fake ClickUp server with a fake clock, so ClickUp's request budget
 * needs no waiting, then an engine run), the groups the List view should
 * show for the fixture, rows by task name and text contrast as the page
 * paints it.
 */
import { scan } from "../server/import/connectors/clickup.js";
import { run as runImport } from "../server/import/engine.js";
import { meetingsFixture } from "../test/fixtures/import/clickup-meetings-data.js";
import { fakeClock } from "../test/fixtures/import/clickup-scan.js";
import { startClickUpServer } from "../test/fixtures/import/clickup-server.js";
import { check } from "./e2e-lib.mjs";

/** ClickUp users matched to seeded Worklane users; the rest are skipped. */
const MATCHED = Object.freeze({ 301: "alex", 302: "sam", 303: "noa" });
/** Requests a full scan of the fixture may send (about one per task). */
const MAX_REQUESTS = 130;

/**
 * Scans the meetings fixture (dates around now) and imports it as Alex.
 * Returns `{ data, report, boardId }`; `data` is the fixture as served.
 */
export async function importMeetings(run) {
  const now = Date.now();
  const data = meetingsFixture({ now });
  const clock = fakeClock(now);
  const upstream = await startClickUpServer({ data, now: clock.now });
  try {
    const snapshot = await scan({
      token: upstream.token,
      transport: { env: { MM_IMPORT_CLICKUP_URL: upstream.endpoint }, clock },
    });
    const errors = JSON.stringify(upstream.errors);
    check(upstream.errors.length === 0, `the fake ClickUp refused: ${errors}`);
    const sent = upstream.requests.length;
    check(sent <= MAX_REQUESTS, `the scan sent ${sent} requests`);
    const users = Object.fromEntries(
      Object.entries(MATCHED).map(([id, name]) => [
        id,
        `match:${run.ids.users[name]}`,
      ]),
    );
    const report = await runImport(
      snapshot,
      { users },
      { store: run.store, importerId: run.ids.users.alex },
    );
    const board = report.links.find((link) => link.kind === "board");
    check(board, `no board imported: ${JSON.stringify(report.skipped)}`);
    return { data, report, boardId: String(board.id) };
  } finally {
    await upstream.close();
  }
}

/**
 * The status groups the List view shows for `data` by default: one per
 * status with top-level tasks, in ClickUp order with closed types last,
 * as `{ label, color, count, done }`.
 */
export function expectedGroups(data) {
  const [list] = data.lists;
  const tops = data.tasks.filter((task) => task.parent === null);
  const groups = list.statuses
    .toSorted((a, b) => a.orderindex - b.orderindex)
    .map((status) => ({
      label: status.status,
      color: status.color.toLowerCase(),
      count: tops.filter((task) => task.status.status === status.status).length,
      done: status.type === "closed" || status.type === "done",
    }))
    .filter((group) => group.count > 0);
  return [
    ...groups.filter((group) => !group.done),
    ...groups.filter((group) => group.done),
  ];
}

const isClosed = (task) => ["closed", "done"].includes(task.status.type);

/**
 * The subtask names of top-level task `name` in `data`, in board order:
 * ClickUp's closed tasks go to the board's Closed group, which follows
 * the Open one, so closed subtasks come after the others.
 */
export function subtaskNames(data, name) {
  const parent = data.tasks.find((task) => task.name === name);
  const subtasks = data.tasks.filter((task) => task.parent === parent.id);
  return [
    ...subtasks.filter((task) => !isClosed(task)),
    ...subtasks.filter(isClosed),
  ].map((task) => task.name);
}

/** The List view group whose pill reads `label`. */
export function listGroup(page, label) {
  const pill = page.locator(".list-group-pill", { hasText: label });
  return page.locator("section.list-group", {
    has: page.locator(".list-group-header", { has: pill }),
  });
}

/** List view rows of task `name` (in `scope`, the whole page by default). */
export function listRow(scope, name) {
  return scope.locator(`.list-row:has(.list-name[title="${name}"])`);
}

/**
 * The lowest contrast ratio of the text of `selector` (at most `limit`
 * elements) against the background painted under it, composited through
 * semi-transparent layers: `{ ratio, text, color, background }`, or null
 * when nothing matches.
 */
export function lowestContrast(page, selector, limit = 40) {
  return page.locator(selector).evaluateAll((nodes, max) => {
    const parse = (value) => {
      const srgb = /color\(srgb ([^)]+)\)/.exec(value);
      const rgb = /rgba?\(([^)]+)\)/.exec(value);
      const parts = (srgb ?? rgb)?.[1].split(/[\s,/]+/).filter(Boolean);
      if (!parts) return null;
      const scale = srgb ? 255 : 1;
      const [r, g, b] = parts.slice(0, 3).map((n) => Number(n) * scale);
      return { r, g, b, a: parts[3] === undefined ? 1 : Number(parts[3]) };
    };
    const over = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const backdrop = (node) => {
      const layers = [];
      for (let el = node; el; el = el.parentElement) {
        const color = parse(getComputedStyle(el).backgroundColor);
        if (color && color.a > 0) layers.push(color);
        if (color?.a === 1) break;
      }
      const base = { r: 255, g: 255, b: 255, a: 1 };
      return layers.reduceRight((under, top) => over(top, under), base);
    };
    const luminance = ({ r, g, b }) => {
      const [lr, lg, lb] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    let worst = null;
    for (const node of nodes.slice(0, max)) {
      if (!node.textContent.trim() || node.getClientRects().length === 0)
        continue;
      const background = backdrop(node);
      const color = over(parse(getComputedStyle(node).color), background);
      const [hi, lo] = [luminance(color), luminance(background)].sort(
        (a, b) => b - a,
      );
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (!worst || ratio < worst.ratio) {
        const text = node.textContent.trim().slice(0, 40);
        worst = { ratio, text, color, background };
      }
    }
    return worst;
  }, limit);
}

/** Fails unless every text of `selector` reaches 4.5:1 (`label` names it). */
export async function checkContrast(page, selector, label) {
  const worst = await lowestContrast(page, selector);
  check(worst, `${label}: nothing matches ${selector}`);
  const ratio = worst.ratio.toFixed(2);
  check(worst.ratio >= 4.5, `${label} "${worst.text}" has contrast ${ratio}`);
}

/** `#rrggbb` as the `rgb(r, g, b)` computed styles report. */
export function rgbOf(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
}
