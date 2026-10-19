/**
 * Steps of the drag and drop browser test (`e2e-dnd.mjs`) on other
 * boards and views: the roadmap's Kanban (a card reorders within its
 * lane, moves to another lane through `move_item` and opens the task
 * view) and the imported ClickUp meetings list (a drop on a group
 * header, holding over a collapsed parent to expand it, a subtask landing
 * between two others, auto-scroll near the scroll container's edge).
 */
import { MEETINGS } from "../test/fixtures/import/clickup-meetings-data.js";
import { importMeetings, subtaskNames } from "./e2e-clickup-lib.mjs";
import {
  N,
  WORKING,
  ahead,
  bandOf,
  dragCard,
  dragRow,
  listGroup,
  listRow,
  rowNames,
  waitForItems,
} from "./e2e-dnd-lib.mjs";
import { check, dataAs, openHash, screenshot, waitUntil } from "./e2e-lib.mjs";

const COLUMNS = `query ($ids: [ID!]) {
  boards(ids: $ids, limit: 1) { columns { id role } }
}`;

export async function kanbanMoves(run) {
  const page = run.alex;
  await page.locator(".view-tab", { hasText: "Kanban" }).click();
  const lane = (title) =>
    page.locator(".lane").filter({
      has: page.locator(".lane-title", { hasText: new RegExp(`^${title}$`) }),
    });
  const card = (scope, name) =>
    scope.locator(".kanban-card").filter({
      has: page.locator(".kanban-card-title", { hasText: name }),
    });
  const titles = (scope) =>
    scope.locator(".kanban-card-title").allTextContents();
  const lanes = lane(WORKING);
  await waitUntil(
    async () => (await titles(lanes)).join("|") === `${N.design}|${N.api}`,
    "the lane in manual order",
  );
  const during = async () => {
    const marked = page.locator(".kanban-card.drop-before");
    check((await marked.count()) === 1, "the lane's drop line");
    await screenshot(run, page, "dnd-kanban.png");
  };
  await dragCard(page, card(lanes, N.api), card(lanes, N.design), { during });
  await waitForItems(
    run,
    run.boardId,
    (all) => ahead(all, N.api, N.design),
    "the card reordered in its lane",
  );
  await waitUntil(
    async () => (await titles(lanes)).join("|") === `${N.api}|${N.design}`,
    "the lane's new order",
  );
  const stuck = lane("Stuck");
  await dragCard(page, card(lanes, N.design), card(stuck, N.fix), {
    zone: "after",
  });
  await waitForItems(
    run,
    run.boardId,
    (all) => all.get(N.design).texts.status === "Stuck",
    "the card's new lane through move_item",
  );
  // Cards open the task view.
  await card(lane("Stuck"), N.design).locator(".kanban-card-title").click();
  await page.locator("dialog.task-view[open] .task-title").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("dialog.task-view").waitFor({ state: "detached" });
}

/** The scroll position and box of the list's scroll container. */
const scrollerState = (page) =>
  page.evaluate(() => {
    let at = document.querySelector(".list-view").parentElement;
    for (; at; at = at.parentElement) {
      const { overflowY } = getComputedStyle(at);
      const scrolls = overflowY === "auto" || overflowY === "scroll";
      if (scrolls && at.scrollHeight > at.clientHeight) break;
    }
    const element = at ?? document.scrollingElement;
    const box = element.getBoundingClientRect();
    const bottom = Math.min(box.bottom, innerHeight);
    return { top: element.scrollTop, bottom, left: box.left };
  });

export async function clickupBoard(run) {
  const page = run.alex;
  const { data, boardId } = await importMeetings(run);
  const { boards } = await dataAs(run, run.ids.users.alex, COLUMNS, {
    ids: [boardId],
  });
  const status = boards[0].columns.find(
    (column) => column.role === "status",
  ).id;
  await openHash(page, run, `#/boards/${boardId}`);
  const facility = listGroup(page, "facility");
  const front = listGroup(page, "front desk");
  await listRow(facility, MEETINGS.plain).waitFor();
  const header = front.locator(".list-group-header");
  await dragRow(page, listRow(facility, MEETINGS.plain), header, {
    zone: "inside",
  });
  await waitForItems(
    run,
    boardId,
    (all) => all.get(MEETINGS.plain).texts[status] === "front desk",
    "the header drop's status",
  );
  await waitUntil(
    async () => (await rowNames(front)).at(-1) === MEETINGS.plain,
    "at the end of front desk",
  );
  await nestIntoCollapsed(run, { data, boardId });
  await autoScroll(run);
}

/** Holding over a collapsed parent expands it; the drop lands between subtasks. */
async function nestIntoCollapsed(run, { data, boardId }) {
  const page = run.alex;
  const facility = listGroup(page, "facility");
  const parent = listRow(facility, MEETINGS.parent);
  check((await parent.getAttribute("aria-expanded")) === "false", "collapsed");
  const [first, second] = subtaskNames(data, MEETINGS.parent);
  const moving = (await rowNames(facility)).find(
    (name) => !name.startsWith(" ") && name !== MEETINGS.parent,
  );
  const during = async () => {
    await waitUntil(
      async () => (await parent.getAttribute("aria-expanded")) === "true",
      "the parent to expand after 800 ms",
      3000,
    );
    const point = await bandOf(listRow(facility, second), "before");
    await page.mouse.move(point.x, point.y, { steps: 4 });
  };
  await dragRow(page, listRow(facility, moving), parent, {
    zone: "inside",
    during,
  });
  await waitForItems(
    run,
    boardId,
    (all) =>
      all.get(moving).parentId === all.get(MEETINGS.parent).id &&
      ahead(all, first, moving) &&
      ahead(all, moving, second),
    "the task between the parent's first two subtasks",
  );
}

async function autoScroll(run) {
  const page = run.alex;
  const before = await scrollerState(page);
  const row = page.locator(".list-row").first();
  await dragRow(page, row, row, {
    release: false,
    zone: "inside",
  });
  await page.mouse.move(before.left + 400, before.bottom - 12, { steps: 4 });
  await waitUntil(
    async () => (await scrollerState(page)).top > before.top + 40,
    "the list to scroll near the bottom edge",
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
}
