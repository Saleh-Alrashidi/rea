/**
 * Interaction checks of the share dialog, the people pickers, the "/"
 * menu and the "Live updates paused" banner (`e2e-roles.mjs` runs them
 * last): typing and pressing Enter at once, refused assignees, the
 * server's explanations of member rows, role changes and focus by
 * keyboard, the "/" menu next to its block, the banner at 360 px, member
 * rows and contrast at 360 px.
 *
 * Steps that change shared seed data put it back before they end.
 */
import {
  MOBILE,
  check,
  dataAs,
  openHash,
  screenshot,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";

const SHARE = `mutation($b: ID!, $u: ID!, $r: AccessRole!) {
  share(resource_kind: board, resource_id: $b, subject_kind: user,
    subject_ids: [$u], role: $r) { id } }`;
const UNSHARE = `mutation($b: ID!, $u: ID!) {
  unshare(resource_kind: board, resource_id: $b, subject_kind: user,
    subject_id: $u) { id } }`;
const MEMBERS = `query($b: [ID!]) { boards(ids: $b) { members {
  id name role effective_role reason } } }`;
const CAPPED = "Viewer accounts can only view, whatever role they get.";

const boardNamed = (run, name) =>
  run.store.listBoards({ limit: 500 }).find((board) => board.name === name).id;
const docNamed = (run, title) =>
  run.store.listDocs().find((doc) => doc.title === title).id;
const membersOf = async (run, boardId) =>
  (await dataAs(run, run.users.alex, MEMBERS, { b: [boardId] })).boards[0]
    .members;
const focused = (page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return {
      key: active?.dataset?.focusKey ?? null,
      tag: active?.tagName.toLowerCase() ?? null,
      inDialog: Boolean(active?.closest("dialog.share-dialog")),
    };
  });

async function openShare(page, selector = ".board-share") {
  await page.locator(selector).first().click();
  const dialog = page.locator("dialog.share-dialog[open]");
  await dialog.locator(".share-member").first().waitFor();
  return dialog;
}

/** Typing a name and pressing Enter at once adds that person (UX-1). */
async function enterRightAfterTyping(run) {
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/docs/${run.seed.vision}`,
  });
  const dialog = await openShare(page, ".doc-share");
  await dialog.locator(".picker-input").focus();
  await page.keyboard.type("sam", { delay: 30 });
  await page.keyboard.press("Enter");
  const chips = dialog.locator(".picker-chip-name");
  await chips.first().waitFor();
  const names = await chips.allTextContents();
  check(names.join() === "Sam Lee", `the typed person: ${names}`);
  // The dialog opened without hints about suggestions nobody has seen,
  // and the hint is tied to the field.
  const input = dialog.locator(".picker-input");
  const hintId = await input.getAttribute("aria-describedby");
  check(hintId === "share-invite-hint", `described by ${hintId}`);
  await context.close();
}

/** A refused assignee is undone; later toggles still work (UX-2). */
async function refusedAssigneeIsUndone(run) {
  const hiring = boardNamed(run, "Hiring plan");
  const { alex, priya } = run.users;
  const item = run.store
    .listItems({ boardId: hiring, limit: 500 })
    .items.find((entry) => entry.name === "Senior backend engineer");
  const before = item.values.person ?? [];
  await dataAs(run, alex, SHARE, { b: hiring, u: priya, r: "viewer" });
  const { context, page } = await signedIn(run, alex, {
    hash: `#/boards/${hiring}/views/table`,
  });
  await page
    .locator(`button.people-button[aria-label*=" for ${item.name}: "]`)
    .first()
    .click();
  const picker = page.locator(".popover .people-picker");
  await picker.waitFor();
  // Priya loses access while the list is open: the list is now stale.
  await dataAs(run, alex, UNSHARE, { b: hiring, u: priya });
  const box = (name) =>
    picker.locator(".person-option", { hasText: name }).locator("input");
  await box("Priya Nair").click();
  await page
    .locator(".toast", { hasText: "Priya Nair cannot access this board" })
    .waitFor();
  await waitUntil(
    async () => !(await box("Priya Nair").isChecked()),
    "the refused toggle undone",
  );
  await box("Alex Rivera").click();
  const valueNow = () => run.store.getItem(item.id).values.person?.join() ?? "";
  await waitUntil(
    () => valueNow() === [...before, alex].join(),
    "a later toggle saved without the refused person",
  );
  check(await box("Alex Rivera").isChecked(), "Alex stays checked");
  await page.keyboard.press("Escape");
  const restore = `mutation($b: ID!, $i: ID!, $v: String!) { change_column_value(
    board_id: $b, item_id: $i, column_id: "person", value: $v) { id } }`;
  const value = JSON.stringify({
    personsAndTeams: before.map((id) => ({ id: Number(id), kind: "person" })),
  });
  await dataAs(run, alex, restore, { b: hiring, i: item.id, v: value });
  await context.close();
}

/** A viewer account made Owner: the server explains both rows (UX-3). */
async function viewerOwnerExplained(run) {
  const hiring = boardNamed(run, "Hiring plan");
  const { alex, jordan } = run.users;
  const { context, page } = await signedIn(run, alex, {
    hash: `#/boards/${hiring}`,
  });
  const dialog = await openShare(page);
  await dialog.locator(".picker-input").fill("jor");
  const option = dialog.locator(".picker-option", { hasText: "Jordan Blake" });
  await option.waitFor();
  check(
    (await option.locator(".role-badge").textContent()) === "Viewer",
    "the picker flags viewer accounts",
  );
  await option.click();
  const hint = dialog.locator(".share-hint");
  check((await hint.textContent()) === CAPPED, "the invite notes the cap");
  await dialog.locator(".share-role").selectOption("owner");
  await dialog
    .locator(".share-invite-row button", { hasText: "Invite" })
    .click();
  const row = (name) => dialog.locator(".share-member", { hasText: name });
  await row("Jordan Blake").waitFor();
  const members = await membersOf(run, hiring);
  const server = Object.fromEntries(members.map((m) => [m.name, m]));
  check(server["Jordan Blake"].effective_role === "viewer", "capped");
  const note = (name) => row(name).locator(".share-owner-note").textContent();
  check((await note("Jordan Blake")) === CAPPED, "Jordan's row explains it");
  check(
    (await note("Alex Rivera")) === server["Alex Rivera"].reason,
    "Alex's note is the server's reason",
  );
  await screenshot(run, page, "share-viewer-owner.png");
  await dataAs(run, alex, UNSHARE, { b: hiring, u: jordan });
  await context.close();
}

/** Opens a member's role menu by keyboard; returns its checked label. */
async function openRoleMenu(page, button) {
  await button.focus();
  await page.keyboard.press("Enter");
  const checked = page.locator(
    ".popover [role=menuitemradio][aria-checked=true]",
  );
  await checked.waitFor();
  return checked.locator(".menu-label").textContent();
}

/** Roles change only when picked; focus survives every change (UX-6, UX-9). */
async function shareDialogKeyboard(run) {
  const hiring = boardNamed(run, "Hiring plan");
  const { alex, noa, priya } = run.users;
  const { context, page } = await signedIn(run, alex, {
    hash: `#/boards/${hiring}`,
  });
  const dialog = await openShare(page);
  const row = (name) => dialog.locator(".share-member", { hasText: name });
  const noaRole = row("Noa Cohen").locator(".share-role-button");
  const roleOf = async (name) =>
    (await membersOf(run, hiring)).find((m) => m.name === name)?.role ?? null;
  // A stray arrow key changes nothing.
  await noaRole.focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  check((await roleOf("Noa Cohen")) === "editor", "ArrowUp commits nothing");
  // Owner asks first; cancelling keeps the role.
  check((await openRoleMenu(page, noaRole)) === "Editor", "current role");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  const confirm = page.locator("dialog[open]", { hasText: "an owner?" });
  await confirm.waitFor();
  await page.keyboard.press("Escape");
  await confirm.waitFor({ state: "detached" });
  check((await roleOf("Noa Cohen")) === "editor", "cancelled");
  // Picking Viewer applies it and focus comes back to the role button.
  await openRoleMenu(page, noaRole);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await waitUntil(
    async () => (await roleOf("Noa Cohen")) === "viewer",
    "viewer",
  );
  await waitUntil(
    async () => (await focused(page)).key === `share-role:user:${noa}`,
    "focus back on Noa's role",
  );
  const status = dialog.locator("[role=status]").last();
  check(
    (await status.textContent()) === "Noa Cohen is now viewer",
    "announced",
  );
  await dataAs(run, alex, SHARE, { b: hiring, u: noa, r: "editor" });
  // One Tab from the picker reaches the role select; after the invite
  // focus is back in the picker.
  const input = dialog.locator(".picker-input");
  await input.focus();
  await page.keyboard.type("pri");
  await page.keyboard.press("Enter");
  await dialog.locator(".picker-chip", { hasText: "Priya Nair" }).waitFor();
  await page.keyboard.press("Tab");
  check((await focused(page)).key === "share-invite-role", "one Tab: role");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await row("Priya Nair").waitFor();
  await waitUntil(
    async () => (await focused(page)).key === "share-picker",
    "focus back in the picker after inviting",
  );
  check(await dialog.locator(".picker-list").isHidden(), "its list stays shut");
  // Removing focuses the next member, never the page.
  await row("Priya Nair").locator("button[aria-label^='Remove']").focus();
  await page.keyboard.press("Enter");
  await waitUntil(async () => (await row("Priya Nair").count()) === 0, "gone");
  await waitUntil(async () => (await focused(page)).inDialog, "focus kept");
  check((await roleOf("Priya Nair")) === null, `${priya} removed`);
  await context.close();
}

/** The "/" menu: next to its block, shortcuts, empty state, Tab (UX-5/7/12). */
async function slashMenuNearItsBlock(run) {
  const { create_doc: doc } = await dataAs(
    run,
    run.users.sam,
    `mutation($w: ID!) { create_doc(title: "Slash check", workspace_id: $w) { id } }`,
    { w: run.seed.workspace },
  );
  const { context, page } = await signedIn(run, run.users.sam, {
    hash: `#/docs/${doc.id}`,
  });
  await page.locator(".doc-block .block-content").first().click();
  // Enough blocks that the last one sits near the bottom of the window.
  for (let n = 0; n < 14; n += 1) await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const menu = page.locator(".slash-menu");
  await menu.waitFor();
  const gap = () =>
    page.evaluate(() => {
      const box = document.querySelector(".slash-menu").getBoundingClientRect();
      const block = document
        .querySelector(".block-content[aria-expanded=true]")
        .getBoundingClientRect();
      return Math.max(block.top - box.bottom, box.top - block.bottom);
    });
  check((await gap()) <= 8, `opened next to the block: ${await gap()}`);
  await page.keyboard.type("hea");
  await waitUntil(
    async () => (await menu.locator("[role=option]").count()) === 2,
    "two headings",
  );
  check((await gap()) <= 8, `stays next to the block: ${await gap()}`);
  await page.keyboard.press("Control+a");
  await page.keyboard.type(">");
  const labels = () =>
    menu.locator("[role=option] .menu-label").allTextContents();
  await waitUntil(
    async () => (await labels()).join() === "Quote",
    "Quote's shortcut",
  );
  await page.keyboard.press("Control+a");
  await page.keyboard.type("zzz");
  const status = menu.locator("[role=status]");
  await waitUntil(
    async () => (await status.textContent()) === "No blocks match",
    "the empty state is announced",
  );
  const input = menu.locator(".slash-input");
  check((await input.getAttribute("aria-activedescendant")) === null, "none");
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "detached" });
  const caret = await page.evaluate(() => {
    const active = document.activeElement;
    const range = getSelection().getRangeAt(0);
    return {
      block: active.classList.contains("block-content"),
      text: active.textContent,
      offset: range.startOffset,
    };
  });
  check(
    caret.block && caret.text === "/zzz",
    `Tab keeps the block: ${caret.text}`,
  );
  check(caret.offset === 4, `caret after the text: ${caret.offset}`);
  await context.close();
}

/** Opens `count` notification streams for `userId` outside the browser. */
async function holdStreams(run, userId, count) {
  const session = run.servers.auth.createBrowserSession(String(userId));
  const controllers = Array.from(
    { length: count },
    () => new AbortController(),
  );
  await Promise.all(
    controllers.map(async (controller) => {
      const response = await fetch(`${run.hostOrigin}/v2/events?stream=me`, {
        headers: {
          Accept: "text/event-stream",
          Cookie: `mm_session=${session}`,
          Origin: run.hostOrigin,
        },
        signal: controller.signal,
      });
      check(response.status === 200, `stream ${response.status}`);
    }),
  );
  return () => controllers.forEach((controller) => controller.abort());
}

/** Controls under the banner after scrolling every scroller to its end. */
const coveredByBanner = (page) =>
  page.evaluate(() => {
    for (const node of document.querySelectorAll("*")) {
      const style = getComputedStyle(node);
      const scrolls = /(auto|scroll)/.test(style.overflowY);
      if (scrolls && node.scrollHeight > node.clientHeight) {
        node.scrollTop = node.scrollHeight;
      }
    }
    const box = document
      .querySelector(".live-status-banner")
      .getBoundingClientRect();
    const hits = new Set();
    for (let x = box.x + 2; x < box.right; x += 8) {
      for (let y = box.y + 2; y < box.bottom; y += 8) {
        const under = document
          .elementsFromPoint(x, y)
          .find((node) => !node.closest(".live-status-row"));
        const control = under?.closest("button, a, input, select, textarea");
        if (control) hits.add(control.textContent.trim().slice(0, 30));
      }
    }
    return [...hits];
  });

/** The banner at 360 px: in a landmark, early, covering nothing (UX-8). */
async function livePausedOnMobile(run) {
  const { sam } = run.users;
  // Every stream of the page is refused (the inbox and the board's).
  run.expectHttp(429, "/v2/events", { repeat: true });
  const release = await holdStreams(run, sam, 32);
  try {
    const { context, page } = await signedIn(run, sam, {
      viewport: MOBILE,
      hash: `#/boards/${run.seed.roadmap}`,
    });
    const banner = page.locator(".live-status-banner");
    await banner.waitFor();
    const layout = await page.evaluate(() => {
      const reload = document.querySelector(".live-status-reload");
      const page = document.getElementById("page");
      const precedes = reload.compareDocumentPosition(page) & 4;
      return {
        landmark: reload.closest("section[aria-label]")?.ariaLabel ?? null,
        beforePage: Boolean(precedes),
      };
    });
    check(layout.landmark === "Live updates", `landmark ${layout.landmark}`);
    check(layout.beforePage, "Reload comes before the page in Tab order");
    const covered = await coveredByBanner(page);
    check(covered.length === 0, `covered: ${covered}`);
    await screenshot(run, page, "live-updates-paused-360.png");
    await page.locator(".sidebar-toggle").click();
    await page.locator("#sidebar[role=dialog]").waitFor();
    await page.waitForTimeout(400);
    const onTop = await banner.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + 4, box.y + box.height / 2);
      return top?.closest("#sidebar") ? "drawer" : "banner";
    });
    check(onTop === "drawer", "the open drawer covers the banner");
    await context.close();
  } finally {
    release();
  }
}

/** Contrast of the faded candidate's reason (light and dark). */
const reasonContrast = (page) =>
  page.evaluate(() => {
    const hint = document.querySelector(
      "dialog.share-dialog .picker-option.disabled .picker-option-hint",
    );
    const parse = (color) => color.match(/[\d.]+/g).map(Number);
    let opacity = 1;
    let background = null;
    for (let node = hint; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      const bg = parse(style.backgroundColor);
      if (!background && (bg[3] ?? 1) > 0.99) background = bg.slice(0, 3);
    }
    const color = parse(getComputedStyle(hint).color).slice(0, 3);
    const shown = color.map(
      (c, i) => c * opacity + background[i] * (1 - opacity),
    );
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(shown), lum(background)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });

/** At 360 px: readable member rows, team counts, reason contrast (UX-10/13/14). */
async function shareDialogOnMobile(run) {
  const brief = docNamed(run, "Launch brief");
  for (const scheme of ["light", "dark"]) {
    const { context, page } = await signedIn(run, run.users.priya, {
      viewport: MOBILE,
      colorScheme: scheme,
      hash: `#/docs/${brief}`,
    });
    const dialog = await openShare(page, ".doc-share");
    const names = await dialog
      .locator(".share-member-name")
      .evaluateAll((list) =>
        list.map((node) => ({
          text: node.textContent,
          width: node.clientWidth,
          cut: node.scrollWidth > node.clientWidth,
        })),
      );
    for (const name of names) {
      check(
        name.width >= 150 && !name.cut,
        `readable: ${JSON.stringify(name)}`,
      );
    }
    const team = dialog.locator(".share-member", { hasText: "Marketing" });
    const detail = await team
      .locator(".share-member-detail")
      .first()
      .textContent();
    check(detail === "Team · 2 members", detail);
    await dialog.locator(".picker-input").fill("mor");
    // The answer, not the dimmed rows of the previous query.
    await dialog.locator(".picker-list[aria-busy=false]").waitFor();
    await dialog.locator(".picker-option.disabled:not(.stale)").waitFor();
    const ratio = await reasonContrast(page);
    check(ratio >= 4.5, `${scheme} reason contrast ${ratio.toFixed(2)}:1`);
    await screenshot(run, page, `share-dialog-360-${scheme}.png`);
    await context.close();
  }
  // A guest sees the team without inventing a member count.
  const { context, page } = await signedIn(run, run.users.chris, {
    hash: `#/docs/${brief}`,
  });
  await openHash(page, run, `#/docs/${brief}`);
  await page.locator(".doc-members").click();
  const dialog = page.locator("dialog.share-dialog[open]");
  const team = dialog.locator(".share-member", { hasText: "Marketing" });
  await team.waitFor();
  const detail = await team
    .locator(".share-member-detail")
    .first()
    .textContent();
  check(detail === "Team", `guest team row: ${detail}`);
  await context.close();
}

export const UX_STEPS_3 = [
  [
    "share picker: Enter right after typing adds that person",
    enterRightAfterTyping,
  ],
  ["people cell: a refused assignee is undone", refusedAssigneeIsUndone],
  [
    "share dialog: the server explains a viewer account owner",
    viewerOwnerExplained,
  ],
  [
    "share dialog by keyboard: roles, focus, announcements",
    shareDialogKeyboard,
  ],
  ["the / menu stays by its block; shortcuts; Tab", slashMenuNearItsBlock],
  ["Live updates paused at 360 px covers nothing", livePausedOnMobile],
  ["share dialog at 360 px: rows, team counts, contrast", shareDialogOnMobile],
];
