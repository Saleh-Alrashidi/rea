/**
 * Helpers of the drag and drop browser test (`e2e-dnd.mjs`): real mouse
 * drags in steps of a List row by its handle (to a row's before, inside
 * or after band, or to a group's header) and of a kanban card, a board's
 * items as the API has them, the names of a List group's rows in order
 * and the drop indicator painted while a drag is held.
 */
import { listGroup, listRow } from "./e2e-clickup-lib.mjs";
import { check, dataAs, waitUntil } from "./e2e-lib.mjs";

export { listGroup, listRow };

/** Seeded Product roadmap tasks the test moves. */
export const N = Object.freeze({
  design: "Design onboarding flow",
  dark: "Dark mode polish",
  fix: "Fix login timeout bug",
  kanban: "Kanban drag and drop",
  api: "API rate limits",
  ci: "Set up CI pipeline",
  sharing: "Board sharing",
  comments: "Item card comments",
});
export const WORKING = "Working on it";

/** Whether `a` comes before `b` in the board's manual order. */
export const ahead = (items, a, b) =>
  items.get(a).position < items.get(b).position;

const ITEMS = `query ($ids: [ID!]) {
  boards(ids: $ids, limit: 1) {
    items_page(limit: 500) {
      items {
        id name position parent_item_id group { id }
        column_values { id text }
      }
    }
  }
}`;

/** Where in a box each band is pointed at (share of its height). */
const BANDS = Object.freeze({ before: 0.12, inside: 0.5, after: 0.88 });

/**
 * The items of `boardId` as `userId` (Alex) reads them, by name:
 * `{ id, name, position, parentId, groupId, texts }` (`texts` by column).
 */
export async function itemsByName(run, boardId, userId = run.ids.users.alex) {
  const data = await dataAs(run, userId, ITEMS, { ids: [boardId] });
  const items = data.boards[0].items_page.items.map((item) => ({
    id: item.id,
    name: item.name,
    position: item.position,
    parentId: item.parent_item_id,
    groupId: item.group.id,
    texts: Object.fromEntries(
      item.column_values.map((value) => [value.id, value.text]),
    ),
  }));
  return new Map(items.map((item) => [item.name, item]));
}

/** Waits until `probe(items by name)` holds for the board's API state. */
export function waitForItems(run, boardId, probe, label) {
  return waitUntil(async () => probe(await itemsByName(run, boardId)), label);
}

/** The names of `group`'s rows in order, indented by level. */
export function rowNames(group) {
  return group.locator(".list-row").evaluateAll((rows) =>
    rows.map((row) => {
      const level = Number(row.getAttribute("aria-level"));
      const name = row.querySelector(".list-name")?.title ?? "";
      return `${"  ".repeat(level - 1)}${name}`;
    }),
  );
}

/**
 * Waits until the board view has not been rebuilt for `quietMs`: change
 * events refresh it 250 ms after they arrive, and a drag measures rows.
 */
export function viewSettled(page, quietMs = 400) {
  return page.evaluate(
    ({ quiet, limit }) =>
      new Promise((resolve, reject) => {
        const view = document.getElementById("board-view");
        let timer = null;
        const observer = new MutationObserver(() => restart());
        const deadline = setTimeout(() => {
          observer.disconnect();
          reject(new Error("the board view kept changing"));
        }, limit);
        const restart = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            clearTimeout(deadline);
            resolve();
          }, quiet);
        };
        observer.observe(view, { childList: true, subtree: true });
        restart();
      }),
    { quiet: quietMs, limit: 10_000 },
  );
}

/**
 * A point in band `zone` of `locator`'s box. For a List row, the point
 * lies in its sticky name cell, which stays in view however far the list
 * scrolls sideways.
 */
export async function bandOf(locator, zone) {
  const box = await locator.boundingBox();
  check(box, "the drop target is on screen");
  const cell = locator.locator(".list-name-cell");
  const across = (await cell.count()) > 0 ? await cell.boundingBox() : box;
  const x = across.x + Math.min(across.width / 2, 200);
  return { x, y: box.y + box.height * BANDS[zone] };
}

/**
 * Drags List row `from` by its 6-dot handle onto band `zone` of `to` (a
 * row, or a group's header for "inside"), with real mouse moves in
 * `steps`. `during()` runs while the button is still down; `release:
 * false` leaves it down.
 */
export async function dragRow(page, from, to, options = {}) {
  const { zone = "before", steps = 10, during, release = true } = options;
  await viewSettled(page);
  const grip = from.locator(".list-drag-handle");
  await grip.scrollIntoViewIfNeeded();
  await from.locator(".list-name-cell").hover();
  const handle = await grip.boundingBox();
  const start = {
    x: handle.x + handle.width / 2,
    y: handle.y + handle.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Past the 4 px threshold, then on to the target.
  await page.mouse.move(start.x + 3, start.y + 5, { steps: 2 });
  const point = await bandOf(to, zone);
  await page.mouse.move(point.x, point.y, { steps });
  await during?.();
  if (release) await page.mouse.up();
}

/**
 * Drags kanban `card` (HTML5 drag and drop, by the card's own padding)
 * onto band `zone` ("before" or "after") of `target` (a card or a lane's
 * card list), in `steps`; `during()` runs before the button goes up.
 */
export async function dragCard(page, card, target, options = {}) {
  const { zone = "before", steps = 10, during } = options;
  await viewSettled(page);
  const box = await card.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 12, box.y + box.height / 2 + 8, { steps: 2 });
  const point = await bandOf(target, zone);
  await page.mouse.move(point.x, point.y, { steps });
  await during?.();
  await page.mouse.up();
}

/**
 * What the List paints while a drag is held: `{ marks }` (the
 * `drop-*` classes of the marked row or group, by row or group name),
 * `{ notAllowed }` (the page's not-allowed cursor), `{ ghost, count }`
 * (the ghost's name and count badge), `{ line }` (the drop line's
 * height, color and inline start, from its pseudo-element).
 */
export function dropPaint(page) {
  return page.evaluate(() => {
    const marked = [
      ...document.querySelectorAll(
        ".drop-before, .drop-after, .drop-inside, .drop-end",
      ),
    ];
    const marks = marked.map((element) => ({
      name:
        element.querySelector(".list-name")?.title ??
        element.querySelector(".list-group-pill")?.textContent ??
        "",
      classes: [...element.classList].filter((name) =>
        name.startsWith("drop-"),
      ),
    }));
    const lined = marked.find((element) =>
      /drop-(before|after)/.test(element.className),
    );
    const pseudo = lined?.classList.contains("drop-before")
      ? "::before"
      : "::after";
    const style = lined && getComputedStyle(lined, pseudo);
    const ghost = document.querySelector(".list-drag-ghost");
    return {
      marks,
      notAllowed:
        document.documentElement.classList.contains("drop-not-allowed"),
      ghost: ghost?.querySelector(".list-drag-name")?.textContent ?? null,
      count: ghost?.querySelector(".list-drag-count")?.textContent ?? null,
      line: style
        ? {
            height: style.height,
            color: style.backgroundColor,
            start: style.insetInlineStart,
          }
        : null,
    };
  });
}
