/**
 * Browser test of the ClickUp-style sidebar (SPEC-6 §3.3) with real
 * pointer drags and keys, on the seeded data:
 *
 * - the Spaces tree lists Spaces, folders, Lists, docs and forms in the
 *   server's order, with the current List highlighted;
 * - expanded and collapsed nodes persist across reloads;
 * - "+" creates a folder in a Space and a List in that folder; "…"
 *   renames;
 * - Lists drag into a folder and reorder there (with Undo), and to
 *   another Space (allowed for the owner, refused by the server for an
 *   editor, with its error toast); a folder dragged to another Space is
 *   "not allowed"; folders and Spaces (admins) reorder;
 * - Favorites appear, persist and go away; keyboard tree navigation;
 * - a task row dragged from the List view onto a List in the sidebar
 *   asks about the columns it would drop, then moves there; "Move to…"
 *   in a task's menu does the same through a board picker;
 * - another user's sidebar and open task view follow live changes
 *   (`e2e-sidebar-live.mjs`);
 * - the 360 px drawer; screenshots in light, dark and at 360 px.
 */
import { listRow } from "./e2e-clickup-lib.mjs";
import { liveSidebar, taskFollowsMoves } from "./e2e-sidebar-live.mjs";
import { dragRow, viewSettled } from "./e2e-dnd-lib.mjs";
import {
  MOBILE,
  check,
  dataAs,
  openHash,
  runE2E,
  screenshot,
  seedIds,
  sidewaysOverflow,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";
import {
  apiSidebar,
  dragTree,
  pick,
  rowMenu,
  treeItem,
  treePaint,
  treeRow,
  treeRows,
  treeShows,
  waitForSidebar,
} from "./e2e-sidebar-lib.mjs";

const MAIN = "Main space";
const LEAD = "Leadership";
const ADD_DOC = `mutation ($w: ID, $t: String!) {
  create_doc(title: $t, workspace_id: $w) { id }
}`;
const ADD_FOLDER = `mutation ($w: ID!, $n: String!) {
  create_folder(workspace_id: $w, name: $n) { id }
}`;
const MOVE_DOC = `mutation ($d: ID!, $f: ID) { move_doc(doc_id: $d, folder_id: $f) { id } }`;

async function treeInOrder(run) {
  const { alex } = run.ids.users;
  const { ids } = await apiSidebar(run);
  const folder = await dataAs(run, alex, ADD_FOLDER, {
    w: ids[MAIN],
    n: "Archive",
  });
  const doc = await dataAs(run, alex, ADD_DOC, {
    w: ids[MAIN],
    t: "Old brief",
  });
  await dataAs(run, alex, MOVE_DOC, {
    d: doc.create_doc.id,
    f: folder.create_folder.id,
  });
  const { page } = await signedIn(run, alex, {
    hash: `#/boards/${run.ids.roadmap}`,
  });
  run.alex = page;
  const rows = await treeRows(page);
  const want = [
    `1:${MAIN}`,
    "2:Archive",
    "2:Product roadmap",
    "2:Product vision",
    "2:Feature request",
    `1:${LEAD}`,
    "2:Hiring plan",
    "2:Budget 2027",
    "2:Leadership offsite",
  ];
  check(rows.join("|") === want.join("|"), `the tree: ${rows}`);
  const tree = page.locator("#sidebar [role=tree]");
  check((await tree.count()) === 1, "one tree");
  const current = treeRow(page, "Product roadmap");
  check(
    (await current.locator(".tree-link").getAttribute("aria-current")) ===
      "page",
    "the open List is the current item",
  );
  check(await current.evaluate((row) => row.matches(".active")), "highlighted");
  const tile = await treeRow(page, MAIN).locator(".space-tile").textContent();
  check(tile === "M", `the Space tile reads ${tile}`);
  await screenshot(run, page, "sidebar-light.png");
}

async function expandPersists(run) {
  const page = run.alex;
  const archive = treeRow(page, "Archive");
  await archive.hover();
  await archive.locator(".tree-toggle").click();
  await treeShows(page, ["2:Archive", "3:Old brief"], "the folder opens");
  const lead = treeRow(page, LEAD);
  await lead.hover();
  await lead.locator(".tree-toggle").click();
  await waitUntil(
    async () => !(await treeRows(page)).includes("2:Hiring plan"),
    "the Space collapses",
  );
  await openHash(page, run, `#/boards/${run.ids.roadmap}`);
  const rows = await treeRows(page);
  check(rows.includes("3:Old brief"), `the folder stays open: ${rows}`);
  check(!rows.includes("2:Hiring plan"), "the Space stays collapsed");
  const item = await treeItem(page, LEAD);
  check((await item.getAttribute("aria-expanded")) === "false", "collapsed");
  await treeRow(page, LEAD).hover();
  await treeRow(page, LEAD).locator(".tree-toggle").click();
  await treeShows(page, [`1:${LEAD}`, "2:Hiring plan"], "open again");
}

async function createFolderAndList(run) {
  const page = run.alex;
  await rowMenu(page, MAIN, "add");
  await pick(page, "Folder");
  const dialog = page.locator("dialog.modal[open]");
  await dialog.locator("input[name=name]").fill("Q4 plans");
  await dialog.locator("button[type=submit]").click();
  await treeShows(page, [`1:${MAIN}`, "2:Q4 plans"], "the new folder");
  await rowMenu(page, "Q4 plans", "add");
  const labels = await page
    .locator(".popover-menu .menu-label")
    .allTextContents();
  check(labels.join("|") === "List|Doc", `the folder's + menu: ${labels}`);
  await pick(page, "List");
  await dialog.locator("input[name=name]").fill("Sprint board");
  check(
    (await dialog.locator("select[name=workspaceId]").count()) === 0,
    "no Space",
  );
  await dialog.locator("button[type=submit]").click();
  await waitUntil(() => /#\/boards\/\d+$/.test(page.url()), "the new List");
  await treeShows(page, ["2:Q4 plans", "3:Sprint board"], "in the folder");
  const sprint = await waitForSidebar(
    run,
    (state) =>
      state.byName[MAIN].folders.find((f) => f.name === "Q4 plans")?.boards
        .length === 1 && state,
    "the List in its folder",
  );
  run.sprint = sprint.ids["Sprint board"];
  check(page.url().endsWith(`#/boards/${run.sprint}`), "opened");
}

async function renameFolder(run) {
  const page = run.alex;
  await rowMenu(page, "Q4 plans");
  await pick(page, "Rename");
  const field = page.locator("#sidebar .tree-rename");
  await field.fill("Q4 programs");
  await field.press("Enter");
  await waitForSidebar(
    run,
    (state) => state.byName[MAIN].folders.some((f) => f.name === "Q4 programs"),
    "the rename",
  );
  await treeShows(page, ["2:Q4 programs", "3:Sprint board"], "renamed");
  check(
    await page.evaluate(() =>
      document.activeElement?.matches("[role=treeitem]"),
    ),
    "focus is back on the tree",
  );
}

async function dragIntoFolderAndReorder(run) {
  const page = run.alex;
  const folder = treeRow(page, "Q4 programs");
  await dragTree(page, treeRow(page, "Product roadmap"), folder, {
    zone: "inside",
    during: async () => {
      const paint = await treePaint(page);
      check(
        paint.marks.join() === "Q4 programs:tree-drop-inside",
        `${paint.marks}`,
      );
    },
  });
  const into = (names) => (state) =>
    state.byName[MAIN].folders
      .find((f) => f.name === "Q4 programs")
      ?.boards.join() === names.join();
  await waitForSidebar(
    run,
    into(["Sprint board", "Product roadmap"]),
    "moved in",
  );
  await treeShows(
    page,
    ["2:Q4 programs", "3:Sprint board", "3:Product roadmap"],
    "shown",
  );
  await dragTree(
    page,
    treeRow(page, "Product roadmap"),
    treeRow(page, "Sprint board"),
    {
      zone: "before",
      during: async () => {
        const paint = await treePaint(page);
        check(
          paint.marks.join() === "Sprint board:tree-drop-before",
          `${paint.marks}`,
        );
        await screenshot(run, page, "sidebar-drag.png");
      },
    },
  );
  await waitForSidebar(
    run,
    into(["Product roadmap", "Sprint board"]),
    "reordered",
  );
  const undo = page.locator(".toast", { hasText: "Moved “Product roadmap”" });
  await undo.locator(".toast-action").click();
  await waitForSidebar(
    run,
    into(["Sprint board", "Product roadmap"]),
    "undone",
  );
  await treeShows(
    page,
    ["3:Sprint board", "3:Product roadmap"],
    "undone on screen",
  );
}

async function dragToOtherSpace(run) {
  const page = run.alex;
  // Alex owns Budget 2027 and edits Main space: it moves.
  await dragTree(page, treeRow(page, "Budget 2027"), treeRow(page, MAIN), {
    zone: "inside",
  });
  await waitForSidebar(
    run,
    (state) => state.byName[MAIN].boards.includes("Budget 2027"),
    "Budget 2027 in Main space",
  );
  // A folder stays in its Space: "not allowed".
  await dragTree(page, treeRow(page, "Archive"), treeRow(page, LEAD), {
    zone: "inside",
    during: async () => {
      const paint = await treePaint(page);
      check(paint.notAllowed, "the not-allowed cursor");
      check(
        paint.marks.join() === `${LEAD}:tree-drop-inside,tree-drop-invalid`,
        `${paint.marks}`,
      );
    },
  });
  const { byName } = await apiSidebar(run);
  check(
    byName[MAIN].folders.some((f) => f.name === "Archive"),
    "stays",
  );
  // Sam edits the roadmap but does not own it: the server refuses.
  const { sam } = run.ids.users;
  await dataAs(
    run,
    sam,
    `mutation { create_workspace(name: "Sam's space") { id } }`,
  );
  const { context, page: samPage } = await signedIn(run, sam);
  run.page = samPage;
  await treeRow(samPage, "Q4 programs").locator(".tree-toggle").click();
  await treeShows(
    samPage,
    ["2:Q4 programs", "3:Product roadmap"],
    "Sam's tree",
  );
  await dragTree(
    samPage,
    treeRow(samPage, "Product roadmap"),
    treeRow(samPage, "Sam's space"),
    {
      zone: "inside",
    },
  );
  await samPage.locator(".toast-error", { hasText: "owner access" }).waitFor();
  const after = await apiSidebar(run);
  const inFolder = after.byName[MAIN].folders.find(
    (f) => f.name === "Q4 programs",
  );
  check(inFolder.boards.includes("Product roadmap"), "the roadmap stayed");
  await context.close();
  run.page = page;
}

async function reorderFoldersAndSpaces(run) {
  const page = run.alex;
  await dragTree(page, treeRow(page, "Q4 programs"), treeRow(page, "Archive"), {
    zone: "before",
  });
  await waitForSidebar(
    run,
    (state) =>
      state.byName[MAIN].folders.map((f) => f.name).join() ===
      "Q4 programs,Archive",
    "folders reordered",
  );
  await dragTree(page, treeRow(page, LEAD), treeRow(page, MAIN), {
    zone: "before",
  });
  await waitForSidebar(
    run,
    (state) => state.spaces.slice(0, 2).join() === `${LEAD},${MAIN}`,
    "Spaces reordered",
  );
  await waitUntil(
    async () => (await treeRows(page))[0] === `1:${LEAD}`,
    "Leadership first in the tree",
  );
}

async function favorites(run) {
  const page = run.alex;
  const section = page.locator("#sidebar .sidebar-favorites");
  check((await section.count()) === 0, "no Favorites while empty");
  await rowMenu(page, "Product vision");
  await pick(page, "Add to favorites");
  await section.waitFor();
  const links = () => section.locator(".nav-link").allTextContents();
  check((await links()).join() === "Product vision", "listed");
  await openHash(page, run, "#/home");
  check((await links()).join() === "Product vision", "kept after a reload");
  await section.locator(".favorite-row").hover();
  await section.locator(".favorite-remove").click();
  await section.waitFor({ state: "detached" });
}

async function keyboard(run) {
  const page = run.alex;
  const focused = () =>
    page.evaluate(() => {
      const item = document.activeElement?.closest("[role=treeitem]");
      return (
        item?.querySelector(":scope > .tree-row .tree-link")?.title ?? null
      );
    });
  await (await treeItem(page, LEAD)).focus();
  await page.keyboard.press("ArrowDown");
  check((await focused()) === "Hiring plan", `down: ${await focused()}`);
  await page.keyboard.press("ArrowLeft");
  check((await focused()) === LEAD, "left goes to the parent");
  await page.keyboard.press("ArrowLeft");
  const lead = await treeItem(page, LEAD);
  await waitUntil(
    async () => (await lead.getAttribute("aria-expanded")) === "false",
    "left collapses",
  );
  check((await focused()) === LEAD, "focus stays on the Space");
  await page.keyboard.press("ArrowRight");
  await waitUntil(
    async () => (await lead.getAttribute("aria-expanded")) === "true",
    "right expands",
  );
  await page.keyboard.press("ArrowRight");
  check((await focused()) === "Hiring plan", "right enters");
  await page.keyboard.press("Enter");
  await waitUntil(() => /#\/boards\/\d+/.test(page.url()), "Enter opens it");
  check((await focused()) === "Hiring plan", "focus stays in the tree");
}

async function dragTaskToList(run) {
  const page = run.alex;
  await openHash(page, run, `#/boards/${run.ids.roadmap}`);
  await viewSettled(page);
  const task = listRow(page.locator("#board-view"), "Dark mode polish");
  await dragRow(page, task, treeRow(page, "Sprint board"), {
    zone: "inside",
    during: async () => {
      const paint = await treePaint(page);
      check(
        paint.marks.join() === "Sprint board:tree-drop-task",
        `${paint.marks}`,
      );
    },
  });
  const dialog = page.locator("dialog.modal[open]");
  const message = await dialog.locator(".dialog-message").textContent();
  check(message.includes("Owner, Estimate, Notes"), `the confirm: ${message}`);
  await screenshot(run, page, "sidebar-move-confirm.png");
  await dialog.locator("button[type=submit]").click();
  await page
    .locator(".toast", {
      hasText: "Moved “Dark mode polish” to “Sprint board”",
    })
    .waitFor();
  const moved = run.store.listItems({ boardId: run.sprint, limit: 50 }).items;
  check(
    moved.some((item) => item.name === "Dark mode polish"),
    "on Sprint board",
  );
  // "Move to…" in a task's menu picks the board in a dialog. (The toasts
  // sit over the last rows.)
  const closes = page.locator(".toast .toast-close");
  while ((await closes.count()) > 0) await closes.first().click();
  const other = listRow(page.locator("#board-view"), "API rate limits");
  await other.hover();
  await other.locator(".list-row-menu").click();
  await pick(page, "Move to…");
  const picker = page.locator("dialog.modal[open] select[name=boardId]");
  await picker.selectOption({ label: `Sprint board · ${MAIN}` });
  await page.locator("dialog.modal[open] button[type=submit]").click();
  await page.locator("dialog.modal[open] button[type=submit]").click();
  await waitUntil(
    () =>
      run.store
        .listItems({ boardId: run.sprint, limit: 50 })
        .items.some((item) => item.name === "API rate limits"),
    "the second task moved",
  );
}

async function darkAndDrawer(run) {
  const { alex } = run.ids.users;
  const { context, page } = await signedIn(run, alex, {
    hash: `#/boards/${run.sprint}`,
    colorScheme: "dark",
  });
  run.page = page;
  await treeRow(page, "Q4 programs").hover();
  await screenshot(run, page, "sidebar-dark.png");
  await context.close();
  const mobile = await signedIn(run, alex, {
    hash: `#/boards/${run.sprint}`,
    viewport: MOBILE,
  });
  run.page = mobile.page;
  await mobile.page.locator(".sidebar-toggle").click();
  await mobile.page.locator("#sidebar[role=dialog]").waitFor();
  await mobile.page.waitForTimeout(400);
  check((await sidewaysOverflow(mobile.page)) === 0, "no sideways scroll");
  await screenshot(run, mobile.page, "sidebar-360.png");
  await treeRow(mobile.page, "Product vision").locator(".tree-link").click();
  await mobile.page.locator("#app.sidebar-open").waitFor({ state: "detached" });
  check(/#\/docs\/\d+$/.test(mobile.page.url()), "the doc opened");
  await mobile.context.close();
  run.page = run.alex;
}

runE2E({
  name: "e2e-sidebar",
  prefix: "sidebar-",
  totalMs: 240_000,
  setup(run) {
    run.ids = seedIds(run.store);
  },
  steps: [
    ["the tree lists Spaces, folders and Lists in order", treeInOrder],
    ["expanded and collapsed nodes persist", expandPersists],
    ["+ creates a folder and a List in it", createFolderAndList],
    ["… renames a folder", renameFolder],
    [
      "a List drags into a folder and reorders (Undo)",
      dragIntoFolderAndReorder,
    ],
    ["Lists move to another Space; refusals", dragToOtherSpace],
    ["folders and Spaces reorder", reorderFoldersAndSpaces],
    ["Favorites", favorites],
    ["keyboard tree navigation", keyboard],
    ["a task row dropped on a List moves there", dragTaskToList],
    ["another user's sidebar follows live", liveSidebar],
    ["an open task view follows its task to another board", taskFollowsMoves],
    ["dark theme and the 360 px drawer", darkAndDrawer],
  ],
});
