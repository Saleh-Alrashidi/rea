/**
 * Helpers of `e2e-updates.mjs`: the task view's Updates pane (SPEC-6
 * §2.3) and its composers' mention picker (§2.2) in Chromium, and the
 * API reads that check what the server stored.
 */
import {
  check,
  dataAs,
  openHash,
  screenshot,
  sidewaysOverflow,
  waitUntil,
  DESKTOP,
  MOBILE,
} from "./e2e-lib.mjs";

export const TASK = "dialog.task-view[open]";
export const PANE = `${TASK} .task-updates`;
export const PICKER = `${TASK} .mention-picker:not([hidden])`;

const UPDATES = `query ($ids: [ID!]!) {
  items(ids: $ids) {
    updates_count
    updates(limit: 50) {
      id body pinned edited_at likes_count
      replies { id body likes_count }
    }
  }
}`;

const NOTIFICATIONS = `query ($kinds: [NotificationKind!]) {
  notifications(kinds: $kinds, limit: 50) { id kind text url read }
}`;

/** The item's updates as `userId` reads them (server order). */
export async function updatesOf(run, userId, itemId) {
  const data = await dataAs(run, userId, UPDATES, { ids: [itemId] });
  return data.items[0];
}

/** `userId`'s notifications of `kinds` (null: all), newest first. */
export async function notificationsOf(run, userId, kinds = null) {
  return (await dataAs(run, userId, NOTIFICATIONS, { kinds })).notifications;
}

/** The hash of item `itemId` on board `boardId` (optionally an update). */
export const taskHash = (boardId, itemId, updateId) =>
  `#/boards/${boardId}/items/${itemId}${updateId ? `/updates/${updateId}` : ""}`;

/** Opens the task view of `hash` on `page` and waits for its updates. */
export async function openTask(page, run, hash) {
  await openHash(page, run, hash);
  await page.locator(`${PANE} .updates-scroll`).waitFor();
  await waitUntil(
    async () => (await page.locator(`${PANE} .skeleton-list`).count()) === 0,
    "the updates to load",
  );
}

/** The card (or reply) element of update `id`. */
export const cardOf = (page, id) => page.locator(`${TASK} #update-${id}`);

/** The IDs of the top-level cards, in the order shown. */
export const shownIds = (page) =>
  page
    .locator(`${PANE} .update-card`)
    .evaluateAll((cards) => cards.map((card) => card.dataset.updateId));

/** The names the open picker lists. */
export const pickerNames = (page) =>
  page
    .locator(`${PICKER} .mention-option-name`)
    .evaluateAll((rows) => rows.map((row) => row.textContent));

/** Types `text` key by key into `box` (input events, as a person types). */
export async function typeInto(box, text) {
  await box.pressSequentially(text, { delay: 15 });
}

/**
 * Types `query` after "@" (or "@@") in `box` and waits for the picker to
 * list `name`; returns the picker's names.
 */
export async function openPicker(page, box, { query, name }) {
  await typeInto(box, query);
  await page.locator(PICKER).waitFor();
  return waitUntil(async () => {
    const names = await pickerNames(page);
    return names.includes(name) ? names : null;
  }, `the picker to list ${name}`);
}

/** Opens the "…" menu of update `id` and picks `label`. */
export async function cardMenu(page, id, label) {
  await cardOf(page, id).locator(".update-menu").first().click();
  const item = page.locator(".popover-menu [role^=menuitem]", {
    hasText: label,
  });
  await item.first().click();
}

/** Waits until the card of update `id` shows (or lost) class `name`. */
export function waitForClass(page, id, name, present = true) {
  return waitUntil(
    async () =>
      (await cardOf(page, id).evaluate(
        (node, cls) => node.classList.contains(cls),
        name,
      )) === present,
    `#update-${id} ${present ? "to get" : "to lose"} .${name}`,
  );
}

/** Whether the element of `locator` lies within the viewport. */
export const inView = (locator) =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= globalThis.innerHeight + 1;
  });

/**
 * Screenshots of the open task view in light, dark and at 360 px wide
 * (`<name>.png`, `-dark`, `-360`); `prepare(page)` runs before each (to
 * open the picker again, which a resize closes); the page must not
 * scroll sideways at 360 px.
 */
export async function threeShots(run, page, { name, prepare }) {
  await prepare?.(page);
  await screenshot(run, page, `${name}.png`);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(150);
  await screenshot(run, page, `${name}-dark.png`);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(200);
  await prepare?.(page);
  const overflow = await sidewaysOverflow(page);
  check(overflow <= 0, `${name} at 360 px scrolls sideways by ${overflow}px`);
  const dialog = await page
    .locator(TASK)
    .evaluate((node) => node.scrollWidth - node.clientWidth);
  check(dialog <= 0, `the task view at 360 px scrolls sideways by ${dialog}px`);
  await screenshot(run, page, `${name}-360.png`);
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(200);
}
