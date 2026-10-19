/**
 * Live steps of `e2e-sidebar.mjs`: what one user changes reaches another
 * user's open browser without a reload.
 *
 * - Sidebar (SPEC-6 §3.3): Alex creates, renames and deletes a folder,
 *   moves a doc into it and reorders the Spaces; Sam's tree follows.
 * - Task view (SPEC-6 §3.2): Sam's open task moves to a board Sam can
 *   open, and the task view follows it there; moved on to a board Sam
 *   cannot open, the task view closes with a note.
 */
import { check, dataAs, openHash, waitUntil } from "./e2e-lib.mjs";
import { apiSidebar, treeRows, treeShows } from "./e2e-sidebar-lib.mjs";
import { TASK, openTask, taskHash } from "./e2e-updates-lib.mjs";

const MAIN = "Main space";
const SAMS = "Sam's space";
const Q = Object.freeze({
  addDoc: `mutation ($w: ID, $t: String!) { create_doc(title: $t, workspace_id: $w) { id } }`,
  addFolder: `mutation ($w: ID!, $n: String!) { create_folder(workspace_id: $w, name: $n) { id } }`,
  renameFolder: `mutation ($f: ID!, $n: String) { update_folder(folder_id: $f, name: $n) { id } }`,
  deleteFolder: `mutation ($f: ID!) { delete_folder(folder_id: $f) { id } }`,
  moveDoc: `mutation ($d: ID!, $f: ID) { move_doc(doc_id: $d, folder_id: $f) { id } }`,
  moveSpace: `mutation ($w: ID!, $b: ID) { move_workspace(workspace_id: $w, before_id: $b) { id } }`,
  addBoard: `mutation ($w: ID, $n: String!) { create_board(board_name: $n, workspace_id: $w) { id } }`,
  addItem: `mutation ($b: ID!, $n: String!) { create_item(board_id: $b, item_name: $n) { id } }`,
  moveToBoard: `mutation ($i: ID!, $b: ID!) { move_item_to_board(item_id: $i, board_id: $b) { item { id } } }`,
});

/**
 * Records the event streams `page` opens: "me" for the user stream, else
 * the board's ID.
 */
function openedStreams(page) {
  const opened = new Set();
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname !== "/v2/events") return;
    opened.add(url.searchParams.get("board_id") ?? "me");
  });
  return opened;
}

/** Sam's browser on `hash`, once the streams `waitFor` are open. */
async function samAt(run, { hash, open, waitFor }) {
  const context = await run.newContext({ userId: run.ids.users.sam });
  const page = await context.newPage();
  run.page = page;
  const streams = openedStreams(page);
  await open(page, run, hash);
  for (const key of waitFor) {
    await waitUntil(() => streams.has(key), `Sam's stream ${key}`);
  }
  return { context, page, streams };
}

const lacks = (page, row, label) =>
  waitUntil(async () => !(await treeRows(page)).includes(row), label);

export async function liveSidebar(run) {
  const { alex } = run.ids.users;
  const main = run.ids.workspace;
  const as = (query, variables) => dataAs(run, alex, query, variables);
  const doc = (await as(Q.addDoc, { w: main, t: "Live doc" })).create_doc.id;
  const sam = await samAt(run, {
    hash: "#/home",
    open: openHash,
    waitFor: ["me"],
  });
  const { page } = sam;
  await treeShows(page, [`1:${MAIN}`, "2:Live doc"], "Sam's tree");
  await page.evaluate(() => (globalThis.liveMarker = true));
  const made = await as(Q.addFolder, { w: main, n: "Live folder" });
  const folder = made.create_folder.id;
  await treeShows(page, [`1:${MAIN}`, "2:Live folder"], "Alex's new folder");
  await as(Q.renameFolder, { f: folder, n: "Live notes" });
  await treeShows(page, [`1:${MAIN}`, "2:Live notes"], "the rename");
  await as(Q.moveDoc, { d: doc, f: folder });
  await lacks(page, "2:Live doc", "the doc goes into the closed folder");
  await as(Q.deleteFolder, { f: folder });
  await lacks(page, "2:Live notes", "the deleted folder goes");
  await treeShows(page, [`1:${MAIN}`, "2:Live doc"], "its doc is back");
  const { ids } = await apiSidebar(run);
  await as(Q.moveSpace, { w: ids[SAMS], b: main });
  await treeShows(page, [`1:${SAMS}`, `1:${MAIN}`], "the Spaces reorder");
  await as(Q.moveSpace, { w: main, b: ids[SAMS] });
  await treeShows(page, [`1:${MAIN}`, `1:${SAMS}`], "and back");
  check(await page.evaluate(() => globalThis.liveMarker === true), "no reload");
  await sam.context.close();
  run.page = run.alex;
}

export async function taskFollowsMoves(run) {
  const { alex } = run.ids.users;
  const as = (query, variables) => dataAs(run, alex, query, variables);
  const { roadmap } = run.ids;
  const hiring = run.store
    .listBoards({ limit: 500 })
    .find((board) => board.name === "Hiring plan").id;
  const target = (await as(Q.addBoard, { w: run.ids.workspace, n: "Follow" }))
    .create_board.id;
  const item = (await as(Q.addItem, { b: roadmap, n: "Follow me" })).create_item
    .id;
  const sam = await samAt(run, {
    hash: taskHash(roadmap, item),
    open: openTask,
    waitFor: ["me", roadmap],
  });
  const { page, streams } = sam;
  // To a board Sam can open: the task view follows.
  await as(Q.moveToBoard, { i: item, b: target });
  await waitUntil(
    () => page.url().endsWith(taskHash(target, item)),
    "the task view follows the task",
  );
  const title = page.locator(`${TASK} .task-title`);
  await waitUntil(
    async () => (await title.inputValue().catch(() => "")) === "Follow me",
    "the task view shows the moved task",
  );
  await waitUntil(() => streams.has(target), "the new board's stream");
  // To the private Hiring plan, which Sam cannot open: it closes.
  await as(Q.moveToBoard, { i: item, b: hiring });
  await page
    .locator(".toast", { hasText: "This task was moved to another board" })
    .waitFor();
  await page.locator(TASK).waitFor({ state: "detached" });
  check(page.url().endsWith(`#/boards/${target}`), `closed: ${page.url()}`);
  await sam.context.close();
  run.page = run.alex;
}
