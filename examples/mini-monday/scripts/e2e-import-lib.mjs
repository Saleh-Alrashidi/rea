/**
 * Helpers of the importer's browser test (`e2e-import.mjs`): the wizard's
 * steps by their headings, the source form, three screenshots per step,
 * and the imported board as the board page shows it.
 */
import {
  DESKTOP,
  MOBILE,
  check,
  pageReady,
  screenshot,
  sidewaysOverflow,
  waitUntil,
} from "./e2e-lib.mjs";

/** How long a scan or an import may take in the browser test. */
export const JOB_WAIT_MS = 30_000;
const STEP_TITLE = "#import-step-title";

export const stepTitle = (page) => page.locator(STEP_TITLE).textContent();

/** Waits until the wizard shows the step whose heading has `text`. */
export async function waitStep(page, text) {
  await waitUntil(
    async () => (await stepTitle(page))?.includes(text),
    `the import step "${text}"`,
    JOB_WAIT_MS,
  );
}

/** Picks the source card whose label is exactly `label`. */
export async function chooseSource(page, label) {
  const card = page
    .locator(".import-source")
    .filter({ has: page.getByText(label, { exact: true }) });
  await card.click();
  await page.locator(".import-scan").waitFor();
}

/** The JSON answer of the next `POST /import/<route>` the page sends. */
export function nextJobAnswer(page, route) {
  return page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/import/${route}` &&
        response.request().method() === "POST",
    )
    .then(async (response) => ({
      status: response.status(),
      body: await response.json(),
    }));
}

/**
 * Pastes `token` and submits the scan form. Checks that the field is
 * empty right after the request left and returns the scan job's ID.
 */
export async function scanWithToken(page, token) {
  await page.locator(".import-token").fill(token);
  const answer = nextJobAnswer(page, "scan");
  const after = await page.evaluate(() => {
    document.querySelector("form.import-form").requestSubmit();
    return document.querySelector(".import-token")?.value;
  });
  check(after === "", "the token field is cleared as the scan starts");
  const { status, body } = await answer;
  check(status === 202, `the scan answered ${status}`);
  return body.job_id;
}

/** Picks `file` (`{ name, mimeType, buffer }`) and starts its scan. */
export async function scanFile(page, file) {
  await page.locator(".import-file-input").setInputFiles(file);
  const answer = nextJobAnswer(page, "scan");
  await page.locator(".import-scan").click();
  const { status, body } = await answer;
  check(status === 202, `the file scan answered ${status}`);
  return body.job_id;
}

/** Starts the reviewed import and returns the import job's ID. */
export async function startImport(page) {
  const answer = nextJobAnswer(page, "run");
  await page.locator(".import-run").click();
  const { status, body } = await answer;
  check(status === 202, `the import answered ${status}: ${body.error ?? ""}`);
  return body.job_id;
}

/** The job as its creator reads it, through the page's own session. */
export function jobOf(page, id) {
  return page.evaluate(async (jobId) => {
    const response = await fetch(`/import/jobs/${jobId}`);
    return response.json();
  }, id);
}

/** Waits until the sidebar has left (360 px) or entered (desktop) view. */
async function sidebarSettled(page, mobile) {
  await waitUntil(
    async () => {
      const box = await page.locator("#sidebar").boundingBox();
      if (!box) return false;
      return mobile ? box.x + box.width <= 0 : box.x >= 0;
    },
    `the sidebar to ${mobile ? "close" : "return"}`,
  );
}

/**
 * Screenshots of the page from its top: `import-<name>.png` (light, desktop),
 * `-dark.png` and `-360.png` (light, 360 px wide, which must not scroll
 * sideways). The page is back at desktop size in light mode afterwards.
 */
export async function shots(run, page, name) {
  // Each picture starts at the top of the page, with the step's heading.
  const toTop = () =>
    page.evaluate(() => document.getElementById("page").scrollTo(0, 0));
  await toTop();
  await screenshot(run, page, `import-${name}.png`);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(100);
  await screenshot(run, page, `import-${name}-dark.png`);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(MOBILE);
  await sidebarSettled(page, true);
  await toTop();
  const overflow = await sidewaysOverflow(page);
  check(overflow <= 0, `${name} at 360 px scrolls sideways by ${overflow}px`);
  await screenshot(run, page, `import-${name}-360.png`);
  await page.setViewportSize(DESKTOP);
  await sidebarSettled(page, false);
}

/** The table row of item `name` on the board page. */
export function itemRow(page, name) {
  const open = page.locator(`button.open-item[aria-label="Open ${name}"]`);
  return page.locator("tr.item-row", { has: open });
}

/**
 * Opens done-step link `title` (an imported board) and checks the board
 * header's badge: `badge` text, and for a source URL an external link
 * that opens a new tab without referrer.
 */
export async function openImportedBoard(page, { title, badge, href = null }) {
  const name = page.getByText(title, { exact: true });
  await page.locator("a.import-link", { has: name }).first().click();
  await page.locator(".board-header").waitFor();
  await pageReady(page);
  const element = page.locator(".board-header .import-badge");
  const text = await element.textContent();
  check(text.includes(badge), `badge "${text}"`);
  const tag = await element.evaluate((node) => node.tagName);
  if (href === null) {
    check(tag === "SPAN", "a badge without a source URL is no link");
    return;
  }
  check(tag === "A", "the badge links to the source");
  check((await element.getAttribute("href")) === href, "the badge's link");
  const rel = await element.getAttribute("rel");
  check(rel === "noopener noreferrer", `badge rel "${rel}"`);
  check((await element.getAttribute("target")) === "_blank", "new tab");
}

/**
 * Checks row `name` of the open board: its first status pill reads
 * `status`, its first people cell names `person`, and (when `update` is
 * given) the item card lists an update containing it, then `onCard()`
 * runs and the card is closed again.
 */
export async function checkItem(page, options) {
  const { name, status, person, update, onCard } = options;
  const row = itemRow(page, name);
  await row.waitFor();
  const pill = (await row.locator(".status-pill").first().textContent()) ?? "";
  check(pill.trim() === status, `${name}: status "${pill}"`);
  if (person) {
    const people = row.locator(".people-button").first();
    const label = (await people.getAttribute("aria-label")) ?? "";
    check(label.includes(person), `${name}: people "${label}"`);
  }
  if (!update) return;
  const kept = await row.elementHandle();
  await row.locator("button.open-item").click();
  await page.locator("dialog.item-card[open] .card-title").waitFor();
  await waitUntil(async () => {
    const bodies = await page.locator(".update-body").allTextContents();
    return bodies.some((body) => body.includes(update));
  }, `the update "${update}" on ${name}`);
  // The card opens over the table, which is not rebuilt: on a wide board
  // that would freeze the page for seconds.
  const stays = await kept.evaluate((node) => node.isConnected);
  check(stays, "opening the item card keeps the table as it is");
  await onCard?.();
  await page.keyboard.press("Escape");
  await page.locator("dialog.item-card").waitFor({ state: "detached" });
  const still = await kept.evaluate((node) => node.isConnected);
  check(still, "closing the item card keeps the table as it is");
}

/**
 * A workspace with more boards than fit scrolls inside the sidebar: the
 * list ends above Teams and Admin instead of running under them.
 */
export async function checkSidebarFits(page) {
  const fit = await page.evaluate(() => {
    const nav = document.querySelector(".sidebar-workspace-nav");
    const bottom = document.querySelector(".sidebar-bottom");
    const navBox = nav.getBoundingClientRect();
    return {
      scrolls: nav.scrollHeight > nav.clientHeight,
      gap: bottom.getBoundingClientRect().top - navBox.bottom,
    };
  });
  check(fit.scrolls, "the long workspace scrolls in the sidebar");
  check(fit.gap >= 0, `the board list runs ${-fit.gap}px under Admin`);
}
