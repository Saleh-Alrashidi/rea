/**
 * Helpers of the sidebar browser test (`e2e-sidebar.mjs`): tree rows by
 * name, what the tree shows (level and name of every visible row), real
 * mouse drags of tree rows to a band of another row, the "…" and "+"
 * menus, and the sidebar as the API has it (Spaces, folders and their
 * content in sidebar order).
 */
import { check, dataAs, waitUntil } from "./e2e-lib.mjs";

const TREE = "#sidebar .space-tree";

/** The tree row (`.tree-row`) of the node named `name`. */
export const treeRow = (page, name) =>
  page.locator(`${TREE} .tree-row`, {
    has: page.locator(`.tree-link[title="${name}"]`),
  });

/** The tree item (`li[role=treeitem]`) of the node named `name`. */
export async function treeItem(page, name) {
  const key = await treeRow(page, name).getAttribute("data-key");
  return page.locator(`${TREE} [role=treeitem][data-key="${key}"]`);
}

/** "<level>:<name>" of every row the tree shows, in order. */
export const treeRows = (page) =>
  page.locator(`${TREE} [role=treeitem]`).evaluateAll((items) =>
    items.map((item) => {
      const name =
        item.querySelector(":scope > .tree-row .tree-link")?.title ?? "";
      return `${item.getAttribute("aria-level")}:${name}`;
    }),
  );

/** Waits until the tree shows `want` (a list of "<level>:<name>"). */
export function treeShows(page, want, label) {
  return waitUntil(async () => {
    const rows = await treeRows(page);
    return want.every(
      (entry, index) =>
        rows.indexOf(entry) >= 0 &&
        (index === 0 || rows.indexOf(entry) > rows.indexOf(want[index - 1])),
    );
  }, label);
}

/**
 * Waits until the sidebar has not been redrawn for `quietMs`: a change
 * refreshes the shell, which redraws the tree.
 */
export function treeSettled(page, quietMs = 300) {
  return page.evaluate(
    ({ quiet, limit }) =>
      new Promise((resolve, reject) => {
        const sidebar = document.getElementById("sidebar");
        let timer = null;
        const observer = new MutationObserver(() => restart());
        const deadline = setTimeout(() => {
          observer.disconnect();
          reject(new Error("the sidebar kept changing"));
        }, limit);
        const restart = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            clearTimeout(deadline);
            resolve();
          }, quiet);
        };
        observer.observe(sidebar, { childList: true, subtree: true });
        restart();
      }),
    { quiet: quietMs, limit: 10_000 },
  );
}

/** Where in a row each band is pointed at (share of its height). */
const BANDS = Object.freeze({ before: 0.15, inside: 0.5, after: 0.85 });

/**
 * Drags tree row `from` onto band `zone` of tree row `to` with real mouse
 * moves; `during()` runs while the button is still down.
 */
export async function dragTree(page, from, to, options = {}) {
  const { zone = "before", steps = 12, during } = options;
  await treeSettled(page);
  await from.scrollIntoViewIfNeeded();
  const start = await from.locator(".tree-link").boundingBox();
  const x = start.x + 40;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 3, y + 5, { steps: 2 });
  const box = await to.boundingBox();
  check(box, "the drop row is on screen");
  await page.mouse.move(box.x + 60, box.y + box.height * BANDS[zone], {
    steps,
  });
  await during?.();
  await page.mouse.up();
}

/** What the tree paints during a drag: marked rows and the cursor. */
export const treePaint = (page) =>
  page.evaluate(() => ({
    marks: [
      ...document.querySelectorAll(
        ".tree-drop-before, .tree-drop-after, .tree-drop-inside, .tree-drop-task",
      ),
    ].map((element) => {
      const row = element.matches(".tree-row")
        ? element
        : element.querySelector(":scope > .tree-row");
      const name = row?.querySelector(".tree-link")?.title ?? "";
      const marks = [...element.classList].filter((c) =>
        c.startsWith("tree-drop"),
      );
      return `${name}:${marks.join(",")}`;
    }),
    notAllowed: document.documentElement.classList.contains("drop-not-allowed"),
  }));

/** Opens the "…" (or "+", `kind` "add") menu of row `name`; returns it. */
export async function rowMenu(page, name, kind = "more") {
  await treeSettled(page);
  const row = treeRow(page, name);
  await row.hover();
  await row.locator(`.tree-${kind}`).click();
  const menu = page.locator(".popover-menu");
  await menu.waitFor();
  return menu;
}

/** Picks `label` in the open menu. */
export async function pick(page, label) {
  await page
    .locator(".popover-menu .menu-item", { hasText: label })
    .first()
    .click();
}

const SIDEBAR = `{
  workspaces {
    id name
    folders { id name boards { id name } docs { id title } }
    boards { id name folder { id } }
    docs { id title folder { id } }
  }
}`;

/**
 * The sidebar as `userId` reads it from the API: `{ spaces: [names],
 * byName }` where each Space by name has `folders` ({ name, boards,
 * docs } in order), its root `boards` and `docs`, and `ids` of boards,
 * folders and Spaces by name.
 */
export async function apiSidebar(run, userId = run.ids.users.alex) {
  const data = await dataAs(run, userId, SIDEBAR);
  const ids = {};
  const byName = {};
  for (const space of data.workspaces) {
    ids[space.name] = space.id;
    for (const folder of space.folders) ids[folder.name] = folder.id;
    for (const board of space.boards) ids[board.name] = board.id;
    byName[space.name] = {
      folders: space.folders.map((folder) => ({
        name: folder.name,
        boards: folder.boards.map((board) => board.name),
        docs: folder.docs.map((doc) => doc.title),
      })),
      boards: space.boards.filter((b) => !b.folder).map((b) => b.name),
      docs: space.docs.filter((d) => !d.folder).map((d) => d.title),
    };
  }
  return { spaces: data.workspaces.map((space) => space.name), byName, ids };
}

/** Waits until `probe(apiSidebar(run))` holds. */
export function waitForSidebar(run, probe, label) {
  return waitUntil(async () => probe(await apiSidebar(run)), label);
}
