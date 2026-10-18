#!/usr/bin/env node
/**
 * Browser test of Worklane's roles, sharing and privacy (SPEC-2): the
 * shell (sidebar, command palette search, live notifications), the share
 * dialog with a guest on a Shareable board, a private board hidden from a
 * member until shared, a viewer's read-only board, a guest who sees only
 * shared content, doc autosave with a version conflict, notes, the form
 * builder with a public submission, admin user management, teams,
 * workspaces, and a screenshot tour of every page (light; dark and 360 px
 * for the main pages) into `e2e-output/`.
 *
 * Each step signs in the demo users it needs in their own browser
 * contexts and confirms every change through the public GraphQL API as
 * the user concerned, so access rules are checked on both sides.
 *
 * Usage: `node scripts/e2e-roles.mjs`. The harness, environment variables
 * and skip rules are described in `e2e-lib.mjs`.
 */
import {
  check,
  dataAs,
  errorCodeAs,
  openHash,
  runE2E,
  screenshot,
  seedIds,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";
import { CONTENT_STEPS } from "./e2e-roles-content.mjs";
import { TOUR_STEPS } from "./e2e-roles-tour.mjs";

const BOARD_ACCESS = `query Board($id: ID!) {
  boards(ids: [$id]) { id name board_kind my_access }
}`;
const MY_BOARDS = `{ boards(limit: 100) { id name } workspaces { id } }`;
const UNREAD = `{ unread_notifications_count }`;

const bellLabel = (page) =>
  page.locator(".notifications-btn").getAttribute("aria-label");

/** Opens the command palette, searches `text`; returns the option labels. */
async function paletteSearch(page, text) {
  if (!(await page.locator(".palette-input").isVisible())) {
    await page.keyboard.press("Control+k");
  }
  // The palette searches shortly after typing; wait for that answer.
  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v2" &&
      (response.request().postData() ?? "").includes(JSON.stringify(text)),
  );
  await page.locator(".palette-input").fill(text);
  await answered;
  const status = page.locator(".palette-status");
  await waitUntil(
    async () => (await status.textContent()) !== "Searching…",
    `palette results for ${text}`,
  );
  return page.locator(".palette-option-label").allTextContents();
}

const sidebarLinks = (page) =>
  page.locator("#sidebar .nav-link").allTextContents();

/** Invites `name` through the open share dialog with `role`. */
async function inviteInShareDialog(page, { name, role }) {
  const dialog = page.locator("dialog.share-dialog[open]");
  await dialog.locator(".picker-input").fill(name.split(" ")[0]);
  await dialog.locator(".picker-option", { hasText: name }).click();
  if (role) await dialog.locator(".share-role").selectOption(role);
  await dialog
    .locator(".share-invite-row button", { hasText: "Invite" })
    .click();
  await dialog.locator(".share-member", { hasText: name }).waitFor();
}

// -------------------------------------------------------------------- steps

async function shellPaletteNotifications(run) {
  const { context, page } = await signedIn(run, run.users.alex);
  check(
    (await page.locator("#topbar .brand").textContent()).includes("Worklane"),
    "brand",
  );
  const links = await sidebarLinks(page);
  check(links.includes("Product roadmap"), `sidebar ${links}`);
  check(!links.includes("Marketing launch"), "no ungranted Shareable board");
  // Search hides what the admin cannot open: the Shareable board, the
  // private doc and Priya's note all contain "launch".
  check((await paletteSearch(page, "launch")).length === 0, "launch hidden");
  const found = await paletteSearch(page, "roadmap");
  check(found.join() === "Product roadmap", `search results ${found}`);
  await screenshot(run, page, "shell-command-palette.png");
  await page.keyboard.press("Enter");
  const roadmap = `#/boards/${run.seed.roadmap}`;
  await waitUntil(() => page.url().endsWith(roadmap), "the board route");
  check((await bellLabel(page)) === "Notifications, 2 unread", "seed unread");
  await page.locator(".notifications-btn").click();
  const entries = page.locator(".notifications-panel .notification");
  await waitUntil(async () => (await entries.count()) === 2, "2 entries");
  await screenshot(run, page, "shell-notifications.png");
  await entries.first().click();
  await waitUntil(() => /\/items\/\d+$/.test(page.url()), "the item route");
  await page.locator("dialog.item-card[open]").waitFor();
  check((await bellLabel(page)) === "Notifications, 1 unread", "one read");
  await page.keyboard.press("Escape");
  // A share by Sam reaches Alex's bell through the stream=me SSE.
  await dataAs(
    run,
    run.users.sam,
    `mutation { share(resource_kind: note, resource_id: "52",
      subject_kind: user, subject_ids: ["${run.users.alex}"], role: viewer) { id } }`,
  );
  await waitUntil(
    async () => (await bellLabel(page)) === "Notifications, 2 unread",
    "the live notification",
  );
  await page.locator(".notifications-btn").click();
  await page
    .locator(".notifications-panel button", { hasText: "Mark all read" })
    .click();
  await waitUntil(async () => (await bellLabel(page)) === "Notifications", "0");
  const unread = await dataAs(run, run.users.alex, UNREAD);
  check(unread.unread_notifications_count === 0, "API unread count 0");
  await context.close();
}

async function shareDialogGuests(run) {
  const { context, page } = await signedIn(run, run.users.alex);
  await page
    .locator("#page")
    .getByRole("button", { name: /New board/ })
    .click();
  await page.locator("dialog.modal input[name=name]").fill("Agency launch");
  await page
    .locator("dialog.modal label.choice", { hasText: "Shareable" })
    .click();
  await page.locator("dialog.modal button[type=submit]").click();
  await waitUntil(() => /#\/boards\/\d+$/.test(page.url()), "the new board");
  run.agencyId = /boards\/(\d+)$/.exec(page.url())[1];
  await page.locator(".board-badges", { hasText: "Shareable" }).waitFor();
  await page.locator(".board-share").click();
  await inviteInShareDialog(page, { name: "Chris Taylor", role: "editor" });
  const guestRow = page.locator(".share-member", { hasText: "Chris Taylor" });
  check(
    await guestRow.locator(".badge", { hasText: "Guest" }).isVisible(),
    "badge",
  );
  await screenshot(run, page, "share-dialog-guest.png");
  const asChris = await dataAs(run, run.users.chris, BOARD_ACCESS, {
    id: run.agencyId,
  });
  check(asChris.boards[0]?.my_access === "editor", "the guest can edit");
  // Main boards cannot have guests: the dialog warns, then removes them.
  const dialog = page.locator("dialog.share-dialog[open]");
  await dialog.locator("label.choice", { hasText: "Main" }).click();
  const confirm = page.locator("dialog.modal[open]:not(.share-dialog)");
  const message = await confirm.locator(".dialog-message").textContent();
  check(/Guests lose access/.test(message), `confirmation: ${message}`);
  await confirm.locator("button[type=submit]").click();
  await waitUntil(async () => (await guestRow.count()) === 0, "guest removed");
  check(run.store.getBoard(run.agencyId).board_kind === "public", "kind");
  const after = await dataAs(run, run.users.chris, BOARD_ACCESS, {
    id: run.agencyId,
  });
  check(after.boards.length === 0, "the guest lost access");
  await dialog.locator("button", { hasText: "Done" }).click();
  await page.locator(".board-badges", { hasText: "Main" }).waitFor();
  await context.close();
}

async function privateUntilShared(run) {
  const alex = await signedIn(run, run.users.alex, {
    hash: `#/boards/${run.agencyId}`,
  });
  await alex.page.locator(".board-share").click();
  const dialog = alex.page.locator("dialog.share-dialog[open]");
  await dialog.locator("label.choice", { hasText: "Private" }).click();
  await waitUntil(
    () => run.store.getBoard(run.agencyId).board_kind === "private",
    "the board to become private",
  );
  // Sam signs in through the demo switcher of the user menu, from a page
  // other than Home: the switch must not start requests it then aborts.
  const context = await run.newContext({ label: "sam" });
  const page = await context.newPage();
  await openHash(page, run, "#/my-work");
  await page.locator(".user-menu-button").click();
  await page.locator(".menu-item", { hasText: "Sam Lee" }).click();
  await waitUntil(
    async () =>
      (await page.locator(".user-menu-button").getAttribute("title")) ===
      "Sam Lee",
    "the switch to Sam",
  );
  await page.locator("#sidebar .nav-link").first().waitFor();
  check(!(await sidebarLinks(page)).includes("Agency launch"), "sidebar");
  check((await paletteSearch(page, "agency")).length === 0, "search hides it");
  await page.keyboard.press("Escape");
  await openHash(page, run, `#/boards/${run.agencyId}`);
  await page.locator(".empty-state", { hasText: "isn’t available" }).waitFor();
  await screenshot(run, page, "private-board-hidden.png");
  const bellBefore = await bellLabel(page);
  await inviteInShareDialog(alex.page, { name: "Sam Lee", role: "editor" });
  await waitUntil(
    async () => (await bellLabel(page)) !== bellBefore,
    "Sam's share notification",
  );
  await openHash(page, run, `#/boards/${run.agencyId}`);
  await page
    .locator(".board-name-heading", { hasText: "Agency launch" })
    .waitFor();
  check((await page.locator(".add-item-input").count()) > 0, "Sam can edit");
  check((await sidebarLinks(page)).includes("Agency launch"), "now listed");
  await context.close();
  await alex.context.close();
}

async function viewerReadOnly(run) {
  const { context, page } = await signedIn(run, run.users.jordan, {
    hash: `#/boards/${run.seed.roadmap}`,
  });
  await page.locator("tr.item-row").first().waitFor();
  check(await page.locator(".view-only-badge").isVisible(), "View only");
  for (const selector of [
    ".name-input",
    ".add-item-input",
    "button.status-pill",
    ".add-group",
    "input.cell-date",
  ]) {
    check((await page.locator(selector).count()) === 0, `no ${selector}`);
  }
  await screenshot(run, page, "board-viewer-read-only.png");
  await page.locator("tr.item-row .open-item").first().click();
  await page.locator("dialog.item-card[open]").waitFor();
  check((await page.locator(".composer").count()) === 0, "no composer");
  await page.keyboard.press("Escape");
  const code = await errorCodeAs(
    run,
    run.users.jordan,
    `mutation Write($board: ID!, $item: ID!) {
      change_simple_column_value(board_id: $board, item_id: $item,
        column_id: "notes", value: "x") { id }
    }`,
    { board: run.seed.roadmap, item: run.seed.item },
  );
  check(code === "FORBIDDEN", `viewer write: ${code}`);
  await context.close();
}

async function guestSeesSharedOnly(run) {
  const { context, page } = await signedIn(run, run.users.chris, {
    hash: "#/shared",
  });
  const cards = await page.locator("#page").textContent();
  check(/Marketing launch/.test(cards) && /Launch brief/.test(cards), cards);
  check(!/Product roadmap/.test(cards), "nothing from the workspace");
  const links = await sidebarLinks(page);
  check(!links.includes("Product roadmap"), `guest sidebar ${links}`);
  await screenshot(run, page, "guest-shared-with-me.png");
  check((await paletteSearch(page, "roadmap")).length === 0, "search");
  await page.keyboard.press("Escape");
  const { roadmap, workspace, vision } = run.seed;
  const hidden = [
    `#/boards/${roadmap}`,
    `#/workspaces/${workspace}`,
    `#/docs/${vision}`,
  ];
  for (const hash of hidden) {
    await openHash(page, run, hash);
    await page
      .locator(".empty-state", { hasText: "isn’t available" })
      .waitFor();
  }
  await openHash(page, run, `#/boards/${run.seed.marketing}`);
  await page.locator("tr.item-row .name-input").first().waitFor();
  const data = await dataAs(run, run.users.chris, MY_BOARDS);
  const names = data.boards.map((board) => board.name).join();
  check(names === "Marketing launch", `guest boards ${names}`);
  check(data.workspaces.length === 0, "the guest has no workspace");
  await context.close();
}

runE2E({
  name: "e2e roles",
  prefix: "roles-",
  totalMs: 300_000,
  setup(run) {
    run.seed = seedIds(run.store);
    run.users = run.seed.users;
  },
  steps: [
    [
      "shell, command palette search and notifications",
      shellPaletteNotifications,
    ],
    [
      "share dialog: guest on a Shareable board, Main removes it",
      shareDialogGuests,
    ],
    ["private board hidden from Sam until shared", privateUntilShared],
    ["viewer Jordan gets a read-only board", viewerReadOnly],
    ["guest Chris sees only shared content", guestSeesSharedOnly],
    ...CONTENT_STEPS,
    ...TOUR_STEPS,
  ],
});
