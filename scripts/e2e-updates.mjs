#!/usr/bin/env node
/**
 * Browser test of monday-style updates and mentions in the task view
 * (SPEC-6 §2.2, §2.3) on the seeded Product roadmap:
 *
 * - the Updates pane lists the item's updates in the server's order;
 * - the composer's picker (keyboard and mouse) mentions a person and two
 *   tasks ("@" and "@@"), marks a guest who cannot open the board "No
 *   access", and the post stores tokens;
 * - the mentioned user (a second signed-in browser) finds it under the
 *   inbox's Mentions filter; its link opens the task view scrolled to the
 *   update, highlighted for about 2 s; a task on a board they cannot open
 *   reads "Private task", and a task chip opens that task;
 * - a reply shows live for the author; like and unlike change the count
 *   (the likers on hover); pinning moves an update first; editing shows
 *   "(edited)" and keeps the mentions; deleting asks first;
 * - a viewer reads everything with no way to post, reply or like;
 * - a task with many updates loads 25, "Show older updates" appends the
 *   rest, "Show 2 more replies" loads a thread whole, and a link to the
 *   oldest update pages back to it, highlighted.
 *
 * Screenshots: `e2e-output/updates[-dark|-360].png` (the pane) and
 * `updates-picker[-dark|-360].png` (the picker), plus
 * `updates-inbox.png`; at 360 px nothing scrolls sideways.
 *
 * Usage: `node scripts/e2e-updates.mjs`. The harness, environment
 * variables and skip rules are described in `e2e-lib.mjs`.
 */
import {
  check,
  dataAs,
  runE2E,
  screenshot,
  seedIds,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";
import {
  PANE,
  PICKER,
  TASK,
  cardMenu,
  cardOf,
  inView,
  notificationsOf,
  openPicker,
  openTask,
  shownIds,
  taskHash,
  threeShots,
  typeInto,
  updatesOf,
  waitForClass,
} from "./e2e-updates-lib.mjs";

const POSTED_START = "Kickoff: @Sam Lee please review @Set up CI pipeline";
const LINK = "https://example.com/kickoff";

function itemId(run, boardId, name) {
  const { items } = run.store.listItems({ boardId, limit: 500 });
  return items.find((item) => item.name === name).id;
}

const mainBox = (page) =>
  page.locator(`${PANE} .update-main-composer textarea`);

async function seededUpdates(run) {
  const { users, roadmap, item } = run.ids;
  run.ci = itemId(run, roadmap, "Set up CI pipeline");
  const hiring = run.store
    .listBoards({ limit: 500 })
    .find((board) => board.name === "Hiring plan").id;
  run.senior = itemId(run, hiring, "Senior backend engineer");
  const { context, page } = await signedIn(run, users.alex, {
    hash: taskHash(roadmap, item),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: run.hostOrigin,
  });
  await openTask(page, run, taskHash(roadmap, item));
  run.alex = page;
  const stored = await updatesOf(run, users.alex, item);
  run.seeded = stored.updates.map((update) => update.id);
  check(run.seeded.length === 2, `${run.seeded.length} seeded updates`);
  check(
    (await shownIds(page)).join() === run.seeded.join(),
    "the server's order (newest first)",
  );
  const tab = await page.locator(`${PANE} .updates-tab`).textContent();
  check(tab.startsWith("Updates"), `the tab: ${tab}`);
  const placeholder = await mainBox(page).getAttribute("placeholder");
  check(placeholder === "Write an update…", placeholder);
  const created = await page.locator(`${PANE} .updates-created`).textContent();
  check(created.includes("created this task"), created);
}

async function pickerMentions(run) {
  const page = run.alex;
  const box = mainBox(page);
  await box.click();
  await typeInto(box, "Kickoff: ");
  // Chris is a guest: he cannot open this board, so he comes last, marked.
  await openPicker(page, box, { query: "@chr", name: "Chris Taylor" });
  const chris = page.locator(`${PICKER} .mention-option`, {
    hasText: "Chris Taylor",
  });
  const mark = await chris.locator(".mention-no-access").textContent();
  check(mark.includes("No access"), `Chris is marked: ${mark}`);
  await page.keyboard.press("Escape");
  await page.locator(PICKER).waitFor({ state: "detached" });
  check(await page.locator(TASK).isVisible(), "Escape closed only the picker");
  for (let index = 0; index < 4; index += 1)
    await page.keyboard.press("Backspace");
  // "@" + keyboard.
  await openPicker(page, box, { query: "@sa", name: "Sam Lee" });
  const active = await box.getAttribute("aria-activedescendant");
  check(Boolean(active), "the picker's active row is the textarea's");
  await page.keyboard.press("Enter");
  check(
    (await box.inputValue()) === "Kickoff: @Sam Lee ",
    await box.inputValue(),
  );
  // "@@" + keyboard, then + mouse.
  await typeInto(box, "please review ");
  await openPicker(page, box, {
    query: "@@set up",
    name: "Set up CI pipeline",
  });
  const dot = page.locator(`${PICKER} .mention-status-dot`).first();
  check((await dot.count()) === 1, "tasks show a status dot");
  await page.keyboard.press("Tab");
  await typeInto(box, "and ");
  await openPicker(page, box, {
    query: "@@senior",
    name: "Senior backend engineer",
  });
  await page
    .locator(`${PICKER} .mention-option`, {
      hasText: "Senior backend engineer",
    })
    .click();
  await typeInto(box, `- notes at ${LINK}.`);
  await page.keyboard.press("Control+Enter");
  await waitUntil(async () => (await shownIds(page)).length === 3, "the post");
  check((await box.inputValue()) === "", "the composer clears");
  const stored = await updatesOf(run, run.ids.users.alex, run.ids.item);
  const [posted] = stored.updates;
  run.posted = posted.id;
  const { sam } = run.ids.users;
  for (const token of [
    `@[Sam Lee](user:${sam})`,
    `@[Set up CI pipeline](item:${run.ci})`,
    `@[Senior backend engineer](item:${run.senior})`,
  ]) {
    check(posted.body.includes(token), `stored ${token}: ${posted.body}`);
  }
  const card = cardOf(page, run.posted);
  await waitUntil(
    async () => (await card.locator(".mention-task").count()) === 2,
    "the saved card's task chips",
  );
  check(
    (await card.locator(".mention-user").textContent()) === "@Sam Lee",
    "the person chip",
  );
  const link = card.locator(`.update-body a[href="${LINK}"]`);
  check((await link.getAttribute("rel")) === "noopener noreferrer", "rel");
  check((await link.getAttribute("target")) === "_blank", "target");
}

async function mentionNotification(run) {
  const { users, roadmap, item } = run.ids;
  const { page } = await signedIn(run, users.sam, { hash: "#/home" });
  run.sam = page;
  const [mention] = await notificationsOf(run, users.sam, ["mention"]);
  check(
    mention?.url === taskHash(roadmap, item, run.posted),
    `the mention links the update: ${mention?.url}`,
  );
  await page.locator(".notifications-btn").click();
  const panel = page.locator(".notifications-panel");
  await panel.locator('[role=tab][data-tab="mentions"]').click();
  const entry = panel.locator(".notification").first();
  await waitUntil(
    async () => (await entry.textContent()).includes("mentioned you"),
    "the mention in the inbox",
  );
  check(
    (await panel.locator(".notification").count()) === 1,
    "only mentions under Mentions",
  );
  await page.waitForTimeout(150);
  await screenshot(run, page, "updates-inbox.png");
  const started = Date.now();
  await entry.click();
  await waitUntil(
    () => page.url().endsWith(taskHash(roadmap, item, run.posted)),
    "the update's route",
  );
  const card = cardOf(page, run.posted);
  await card.waitFor();
  await waitForClass(page, run.posted, "highlight", true);
  check(await inView(card), "the update is scrolled into view");
  // Sam cannot open the Hiring plan: that task stays private.
  const text = await card.locator(":scope > .update-body").textContent();
  check(text.includes("Private task"), `Sam reads: ${text}`);
  check(!text.includes("Senior backend engineer"), "no private task name");
  await waitForClass(page, run.posted, "highlight", false);
  const lit = Date.now() - started;
  check(lit >= 1500, `highlighted for ${lit} ms`);
}

async function taskChipOpens(run) {
  const page = run.sam;
  const card = cardOf(page, run.posted);
  // A person chip opens their profile; Escape closes only that.
  await card.locator(".mention-user").click();
  const profile = page.locator(".mention-profile-popover");
  await profile.waitFor();
  const shown = await profile.textContent();
  check(shown.includes("sam@example.test"), `the profile: ${shown}`);
  await page.keyboard.press("Escape");
  await profile.waitFor({ state: "detached" });
  check(await page.locator(TASK).isVisible(), "the task view stays open");
  await card
    .locator(".mention-task", { hasText: "Set up CI pipeline" })
    .click();
  await waitUntil(
    () => page.url().endsWith(`/items/${run.ci}`),
    "the mentioned task's route",
  );
  await waitUntil(
    async () =>
      (await page.locator(`${TASK} .task-title`).inputValue()) ===
      "Set up CI pipeline",
    "the mentioned task's view",
  );
  await page.goBack();
  await cardOf(page, run.posted).waitFor();
}

async function replyLive(run) {
  const page = run.sam;
  const card = cardOf(page, run.posted);
  await card.locator(":scope > .update-footer .update-reply-button").click();
  const box = page.locator(
    `${TASK} [data-focus-key="composer:reply:${run.posted}"]`,
  );
  await box.waitFor();
  check(
    await box.evaluate((node) => node === document.activeElement),
    "the reply box has focus",
  );
  await typeInto(box, "On it, I will review today");
  await page.keyboard.press("Control+Enter");
  await waitUntil(
    async () => (await card.locator(".update-reply").count()) === 1,
    "the reply under the card",
  );
  // The author sees it without reloading (board events).
  const theirs = cardOf(run.alex, run.posted).locator(".update-reply");
  await waitUntil(async () => (await theirs.count()) === 1, "the live reply");
  const replies = await notificationsOf(run, run.ids.users.alex, ["reply"]);
  check(replies.length === 1, `${replies.length} reply notifications`);
}

async function likeAndUnlike(run) {
  const page = run.sam;
  const card = cardOf(page, run.posted);
  const like = card.locator(":scope > .update-footer .update-like");
  await like.click();
  await waitUntil(
    async () => (await like.getAttribute("aria-pressed")) === "true",
    "Liked",
  );
  const count = (scope) =>
    scope.locator(":scope > .update-likes-row .update-like-count");
  const stored = async () =>
    (await updatesOf(run, run.ids.users.alex, run.ids.item)).updates.find(
      (update) => update.id === run.posted,
    ).likes_count;
  await waitUntil(async () => (await stored()) === 1, "the stored like");
  check((await count(card).textContent()) === "1", "the count shows 1");
  const theirs = cardOf(run.alex, run.posted);
  await waitUntil(
    async () => (await count(theirs).count()) === 1,
    "live count",
  );
  await count(theirs).hover();
  const tip = theirs.locator(":scope > .update-likes-row .update-likers");
  await waitUntil(async () => await tip.isVisible(), "the likers on hover");
  check(
    (await tip.textContent()) === "Liked by Sam Lee",
    await tip.textContent(),
  );
  await like.click();
  await waitUntil(async () => (await stored()) === 0, "the like taken back");
  await waitUntil(async () => (await count(card).count()) === 0, "no count");
  check((await like.getAttribute("aria-pressed")) === "false", "Like again");
}

async function pinFirst(run) {
  const page = run.alex;
  const oldest = run.seeded.at(-1);
  await cardMenu(page, oldest, "Pin to top");
  await waitUntil(
    async () => (await shownIds(page))[0] === oldest,
    "pinned first",
  );
  await cardOf(page, oldest).locator(".update-pinned").waitFor();
  const stored = await updatesOf(run, run.ids.users.alex, run.ids.item);
  check(stored.updates[0].id === oldest && stored.updates[0].pinned, "stored");
  await cardMenu(page, run.posted, "Copy link");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const hash = taskHash(run.ids.roadmap, run.ids.item, run.posted);
  check(copied === `${run.hostOrigin}/${hash}`, `copied ${copied}`);
}

async function editShowsEdited(run) {
  const page = run.alex;
  await cardMenu(page, run.posted, "Edit");
  const box = page.locator(
    `${TASK} [data-focus-key="composer:edit:${run.posted}"]`,
  );
  await box.waitFor();
  const text = await box.inputValue();
  check(text.startsWith(POSTED_START), `the edit box: ${text}`);
  check(!text.includes("@["), "tokens read as @Name");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+End");
  await typeInto(box, " Updated.");
  await page.keyboard.press("Control+Enter");
  const card = cardOf(page, run.posted);
  await card.locator(".update-edited").waitFor();
  const body = card.locator(":scope > .update-body");
  await waitUntil(
    async () => (await body.textContent()).endsWith("Updated."),
    "the edited body",
  );
  check((await body.locator(".mention-task").count()) === 2, "chips kept");
  const stored = (await updatesOf(run, run.ids.users.alex, run.ids.item))
    .updates;
  const edited = stored.find((update) => update.id === run.posted);
  check(Boolean(edited.edited_at), "edited_at");
  check(edited.body.includes(`(user:${run.ids.users.sam})`), edited.body);
}

async function deleteAsks(run) {
  const page = run.alex;
  const box = mainBox(page);
  await box.click();
  await typeInto(box, "Temporary note");
  await page
    .locator(`${PANE} .update-main-composer .update-composer-submit`)
    .click();
  await waitUntil(async () => (await shownIds(page)).length === 4, "the note");
  const stored = await updatesOf(run, run.ids.users.alex, run.ids.item);
  const note = stored.updates.find((u) => u.body === "Temporary note").id;
  await waitUntil(async () => (await shownIds(page)).includes(note), "saved");
  await cardMenu(page, note, "Delete");
  const confirm = page.locator("dialog.modal[open]", {
    hasText: "Delete this update?",
  });
  await confirm.waitFor();
  await confirm.locator("button", { hasText: "Cancel" }).click();
  check((await shownIds(page)).includes(note), "Cancel keeps it");
  await cardMenu(page, note, "Delete");
  await confirm.locator("button[type=submit]").click();
  await waitUntil(async () => !(await shownIds(page)).includes(note), "gone");
  const after = await updatesOf(run, run.ids.users.alex, run.ids.item);
  check(!after.updates.some((update) => update.id === note), "deleted");
}

async function viewerReadOnly(run) {
  const { users, roadmap, item } = run.ids;
  const { page } = await signedIn(run, users.jordan, { hash: "#/home" });
  await openTask(page, run, taskHash(roadmap, item));
  const card = cardOf(page, run.posted);
  await card.waitFor();
  check((await shownIds(page)).length === 3, "Jordan reads every update");
  check((await card.locator(".update-reply").count()) === 1, "and replies");
  check(await page.locator(`${PANE} .task-readonly-note`).isVisible(), "note");
  for (const selector of [
    ".update-composer",
    ".update-like",
    ".update-reply-button",
  ]) {
    const count = await page.locator(`${PANE} ${selector}`).count();
    check(count === 0, `a viewer gets no ${selector}`);
  }
  await card.locator(".update-menu").first().click();
  const items = await page
    .locator(".popover-menu [role^=menuitem] .menu-label")
    .allTextContents();
  check(items.join() === "Copy link", `a viewer's menu: ${items}`);
  await page.keyboard.press("Escape");
}

/** Thirty updates (the newest with five replies) on another task. */
async function pagesAndThreads(run) {
  const { users, roadmap } = run.ids;
  const task = itemId(run, roadmap, "API rate limits");
  const post = (body, parentId = null) =>
    run.store.createUpdate({
      itemId: task,
      body,
      creatorId: users.sam,
      parentId,
    });
  const tops = Array.from({ length: 30 }, (_, n) => post(`Older ${n}`));
  const thread = tops.at(-1).id;
  for (let n = 0; n < 5; n += 1) post(`Reply ${n}`, thread);
  const { page } = await signedIn(run, users.alex, { hash: "#/home" });
  await openTask(page, run, taskHash(roadmap, task));
  check((await shownIds(page)).length === 25, "the first 25");
  const card = cardOf(page, thread);
  const replies = card.locator(".update-reply");
  check((await replies.count()) === 3, "the newest three replies");
  const more = card.locator(".update-more-replies");
  check((await more.textContent()) === "Show 2 more replies", "Show 2 more");
  await more.click();
  await waitUntil(async () => (await replies.count()) === 5, "the thread");
  const older = page.locator(`${PANE} .updates-older`);
  await older.click();
  await waitUntil(
    async () => (await shownIds(page)).length === 30,
    "the older page appended",
  );
  check((await older.count()) === 0, "nothing older left");
  check((await replies.count()) === 5, "the thread stays whole");
  const oldest = tops[0].id;
  const link = await signedIn(run, users.noa, {
    hash: taskHash(roadmap, task, oldest),
  });
  await cardOf(link.page, oldest).waitFor();
  await waitForClass(link.page, oldest, "highlight", true);
  check(await inView(cardOf(link.page, oldest)), "scrolled to the oldest");
}

const LIKE = `mutation ($id: ID!) { like_update(update_id: $id) { id } }`;

async function screenshots(run) {
  const page = run.alex;
  // Two likes, so the pictures show the likers' row.
  for (const name of ["sam", "noa"]) {
    await dataAs(run, run.ids.users[name], LIKE, { id: run.posted });
  }
  const count = cardOf(page, run.posted).locator(
    ":scope > .update-likes-row .update-like-count",
  );
  await waitUntil(async () => (await count.count()) === 1, "the live likes");
  await page.mouse.move(0, 0);
  const toPane = (target) =>
    target.locator(`${PANE}`).evaluate((pane) => {
      pane.scrollIntoView({ block: "start" });
      pane.querySelector(".updates-scroll").scrollTop = 0;
    });
  await threeShots(run, page, { name: "updates", prepare: toPane });
  const openOnPeople = async (target) => {
    await toPane(target);
    const box = mainBox(target);
    await box.click();
    await box.fill("");
    await openPicker(target, box, { query: "Ask @", name: "Sam Lee" });
  };
  await threeShots(run, page, {
    name: "updates-picker",
    prepare: openOnPeople,
  });
  await page.keyboard.press("Escape");
  await mainBox(page).fill("");
}

runE2E({
  name: "e2e updates",
  prefix: "updates-",
  totalMs: 240_000,
  async setup(run) {
    run.ids = seedIds(run.store);
  },
  steps: [
    ["the Updates pane lists the item's updates in order", seededUpdates],
    ["the picker mentions a person and tasks, then posts", pickerMentions],
    ["the mention reaches Sam and its link highlights it", mentionNotification],
    ["a person chip shows a profile; a task chip opens it", taskChipOpens],
    ["a reply shows live for the author", replyLive],
    ["like and unlike change the count", likeAndUnlike],
    ["pinning moves an update first; Copy link", pinFirst],
    ["editing shows (edited) and keeps mentions", editShowsEdited],
    ["deleting asks first", deleteAsks],
    ["a viewer reads everything, read-only", viewerReadOnly],
    ["screenshots of the pane and the picker", screenshots],
    ["older updates and long threads load in pages", pagesAndThreads],
  ],
});
