/**
 * The second half of the interaction checks of `e2e-roles-ux.mjs`:
 * keyboard and focus (drawer, popovers, menus, status picker, skip link),
 * page headings, unsaved settings, Home notifications, owner and group
 * hints, and live access changes (a demotion, a board that turns private
 * while open).
 */
import { check, dataAs, openHash, signedIn, waitUntil } from "./e2e-lib.mjs";

const UNREAD = `{ unread_notifications_count }`;
const BOARD_KIND = `mutation($b: ID!, $k: BoardKind!) {
  set_board_kind(board_id: $b, board_kind: $k) { id }
}`;
const ROLE = `mutation($u: ID!, $r: AccountRole!) {
  update_user(user_id: $u, role: $r) { id }
}`;

const activeId = (page) =>
  page.evaluate(() => document.activeElement?.id ?? "");
const focusedText = (page) =>
  page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
const focusInside = (page, selector) =>
  page.evaluate(
    (inside) => Boolean(document.activeElement?.closest(inside)),
    selector,
  );

async function drawerKeepsFocus(run) {
  const { context, page } = await signedIn(run, run.users.alex, {
    viewport: { width: 768, height: 900 },
  });
  await page.locator(".sidebar-toggle").click();
  await page.locator("#sidebar[role=dialog][aria-modal=true]").waitFor();
  check(await page.locator("#page").evaluate((el) => el.inert), "page inert");
  for (let n = 0; n < 30; n += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      return active === document.body || Boolean(active?.closest("#sidebar"));
    });
    check(inside, `Tab ${n + 1} left the open drawer`);
  }
  await page.keyboard.press("Escape");
  await waitUntil(
    () => page.locator("#page").evaluate((el) => !el.inert),
    "the page to be usable again",
  );
  await context.close();
}

async function keyboardPopovers(run) {
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/boards/${run.seed.roadmap}/views/table`,
  });
  const panel = page.locator(".notifications-panel");
  await page.locator(".notifications-btn").focus();
  await page.keyboard.press("Enter");
  await panel.locator(".notification").first().waitFor();
  await page.waitForTimeout(200);
  check(await focusInside(page, ".notifications-popover"), "focus kept");
  for (let n = 0; n < 30 && (await panel.count()) > 0; n += 1) {
    await page.keyboard.press("Tab");
  }
  check((await panel.count()) === 0, "Tab past the end closes the panel");
  await page.locator(".theme-toggle").focus();
  await page.keyboard.press("Enter");
  await page.locator(".popover-menu [role^=menuitem]").first().waitFor();
  await page.keyboard.press("Tab");
  check((await page.locator(".popover-menu").count()) === 0, "Tab closes");
  // The Main table's status picker opens on the current label and arrows
  // move.
  const pill = page.locator("button.status-pill").first();
  const current = /: (.*)\. Change status$/.exec(
    await pill.getAttribute("aria-label"),
  )[1];
  await pill.focus();
  await page.keyboard.press("Enter");
  const choices = page.locator(".status-picker [role^=menuitem]");
  await choices.first().waitFor();
  const labels = await choices.allTextContents();
  check((await focusedText(page)) === current, `starts on ${current}`);
  await page.keyboard.press("ArrowDown");
  const next = labels[(labels.indexOf(current) + 1) % labels.length];
  check((await focusedText(page)) === next, `ArrowDown moves to ${next}`);
  await page.keyboard.press("Escape");
  await context.close();
}

async function skipLinkAndHeadings(run) {
  const { context, page } = await signedIn(run, run.users.alex);
  await page.keyboard.press("Tab");
  check((await activeId(page)) === "skip-link", "the first Tab stop");
  await page.keyboard.press("Enter");
  check((await activeId(page)) === "page", "the skip link focuses the page");
  check(page.url().endsWith("#/home"), "the route stays");
  for (const [hash, title] of [
    ["#/nope", "Page not found"],
    ["#/docs/999999", "This doc isn’t available"],
  ]) {
    await openHash(page, run, hash);
    const headings = await page.locator("#page h1").allTextContents();
    check(headings.join() === title, `${hash} h1: ${headings}`);
  }
  await context.close();
}

async function unsavedSettingsAsk(run) {
  const { workspace } = run.seed;
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/workspaces/${workspace}/settings`,
  });
  const answers = ["dismiss", "accept"];
  const asked = [];
  page.on("dialog", async (dialog) => {
    asked.push(dialog.type());
    await (answers.shift() === "dismiss" ? dialog.dismiss() : dialog.accept());
  });
  const name = page.locator("#ws-name");
  await name.fill("Main workspace (draft)");
  await page.locator("#sidebar .nav-link", { hasText: "Home" }).click();
  await page.waitForTimeout(300);
  check(page.url().endsWith("/settings"), "staying keeps the page");
  check((await name.inputValue()) === "Main workspace (draft)", "kept");
  await page.reload();
  check(asked.join() === "confirm,beforeunload", `asked: ${asked}`);
  check(run.store.getWorkspace(workspace).name === "Main workspace", "unsaved");
  await context.close();
}

async function homeNotificationRead(run) {
  const { ideas } = run.seed;
  const share = `mutation($n: ID!, $u: ID!) { share(resource_kind: note,
    resource_id: $n, subject_kind: user, subject_ids: [$u], role: viewer) { id } }`;
  await dataAs(run, run.users.alex, share, { n: ideas, u: run.users.sam });
  const { context, page } = await signedIn(run, run.users.sam);
  const before = (await dataAs(run, run.users.sam, UNREAD))
    .unread_notifications_count;
  check(before > 0, "Sam has an unread share");
  const panel = page.locator(
    'section[aria-labelledby="home-unread-notifications"]',
  );
  await panel.locator("a.preview-main").first().click();
  await waitUntil(
    async () =>
      (await dataAs(run, run.users.sam, UNREAD)).unread_notifications_count ===
      before - 1,
    "the opened notification to be read",
  );
  const label = await page
    .locator(".notifications-btn")
    .getAttribute("aria-label");
  check(label.endsWith(`${before - 1} unread`) || before === 1, label);
  await context.close();
}

async function ownerAndGroupHints(run) {
  const created = await dataAs(
    run,
    run.users.alex,
    `mutation($w: ID!) { create_board(board_name: "Solo board",
      board_kind: private, workspace_id: $w) { id groups { id } } }`,
    { w: run.seed.workspace },
  );
  const board = created.create_board;
  const drop = `mutation($b: ID!, $g: String!) { delete_group(board_id: $b, group_id: $g) { id } }`;
  for (const group of board.groups.slice(1)) {
    await dataAs(run, run.users.alex, drop, { b: board.id, g: group.id });
  }
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/boards/${board.id}/views/table`,
  });
  await page.locator("button.group-menu").first().click();
  const item = page.locator(".menu-item", { hasText: "Delete group" });
  check((await item.getAttribute("aria-disabled")) === "true", "last group");
  await page.keyboard.press("Escape");
  await page.locator(".board-share").click();
  const note = page.locator("dialog.share-dialog[open] .share-owner-note");
  await note.waitFor();
  const text = await note.textContent();
  check(text.startsWith("This board needs at least one owner"), text);
  await context.close();
}

async function demotionReachesShell(run) {
  const { sam, alex } = run.users;
  const { context, page } = await signedIn(run, sam);
  const add = page.locator("#sidebar [aria-label='Add to workspace']");
  await add.first().waitFor();
  await dataAs(run, alex, ROLE, { u: sam, r: "viewer" });
  // The notification arrives as a toast, and the shell reloads Sam's role.
  await page
    .locator(".toast", { hasText: "changed your account role to viewer" })
    .waitFor();
  await waitUntil(async () => (await add.count()) === 0, "the new role");
  await dataAs(run, alex, ROLE, { u: sam, r: "member" });
  await context.close();
}

async function boardTurnsPrivateWhileOpen(run) {
  const { roadmap } = run.seed;
  // The closed stream's reconnection is refused: the board is gone for Sam.
  run.expectHttp(404, "/v2/events");
  const { context, page } = await signedIn(run, run.users.sam, {
    hash: `#/boards/${roadmap}`,
  });
  await page.locator(".board-name-heading").first().waitFor();
  // Past the page's one catch-up reload after its stream opened: only the
  // stream's end can tell the page now.
  await page.waitForTimeout(1000);
  await dataAs(run, run.users.alex, BOARD_KIND, { b: roadmap, k: "private" });
  try {
    await page
      .locator(".empty-state", { hasText: "isn’t available" })
      .waitFor({ timeout: 15_000 });
    const links = page.locator("#sidebar .nav-link");
    await waitUntil(
      async () => !(await links.allTextContents()).includes("Product roadmap"),
      "the sidebar to drop the board",
    );
  } finally {
    await dataAs(run, run.users.alex, BOARD_KIND, { b: roadmap, k: "public" });
  }
  await context.close();
}

export const UX_STEPS_2 = [
  ["the open navigation drawer keeps Tab inside", drawerKeepsFocus],
  ["popovers, menus and the status picker by keyboard", keyboardPopovers],
  ["skip link and h1 on error pages", skipLinkAndHeadings],
  ["unsaved workspace settings ask before leaving", unsavedSettingsAsk],
  ["opening a notification from Home reads it", homeNotificationRead],
  ["last-owner and last-group hints", ownerAndGroupHints],
  ["a demotion shows a toast and reaches the shell", demotionReachesShell],
  ["a board that turns private while open", boardTurnsPrivateWhileOpen],
];
