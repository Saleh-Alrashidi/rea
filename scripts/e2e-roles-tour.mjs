/**
 * Screenshot tour of `e2e-roles.mjs`: every page of SPEC-2 §5.1 in light
 * mode (`page-<name>.png`), and the main pages (home, board, doc, notes,
 * form builder, public form, admin) in dark mode (`dark-<name>.png`) and
 * at 360 px (`mobile-<name>.png`), where none may scroll sideways. Runs
 * after the other steps, so the pages show the content they created.
 * Record IDs come from `run.seed` (`seedIds` in `e2e-lib.mjs`).
 */
import {
  DESKTOP,
  MOBILE,
  check,
  openHash,
  pageReady,
  screenshot,
  sidewaysOverflow,
} from "./e2e-lib.mjs";

/** `[name, hash, readySelector?]` for every page, seen by Alex. */
function tourPages(ids) {
  const board = `#/boards/${ids.roadmap}`;
  return [
    ["home", "#/home"],
    ["my-work", "#/my-work"],
    ["shared", "#/shared"],
    ["workspace", `#/workspaces/${ids.workspace}`],
    ["workspace-settings", `#/workspaces/${ids.workspace}/settings`],
    ["board", board, "tr.item-row"],
    ["board-kanban", `${board}/views/kanban`, ".kanban-card"],
    ["board-activity", `${board}/views/activity`, ".activity-entry"],
    ["board-forms", `${board}/views/forms`, ".form-card"],
    ["board-app", `${board}/views/app-${ids.install}`, "iframe.app-frame"],
    ["item-card", `${board}/items/${ids.item}`, "dialog.item-card[open]"],
    ["docs", "#/docs", ".doc-row"],
    ["doc", `#/docs/${ids.vision}`, ".doc-block"],
    ["notes", "#/notes", ".note-card"],
    ["note", `#/notes/${ids.ideas}`, ".note-panel"],
    ["form-builder", `#/forms/${ids.featureForm}`, ".fb-question"],
    ["teams", "#/teams"],
    ["team", `#/teams/${ids.productTeam}`, ".team-page"],
    ["admin", "#/admin", ".admin-table"],
    ["admin-content", "#/admin/content", ".admin-content .admin-table"],
    ["not-found", "#/no-such-page", ".empty-state"],
  ];
}

const MAIN_PAGES = new Set(["home", "board", "doc", "notes", "form-builder"]);
MAIN_PAGES.add("admin");

async function visit(run, page, [name, hash, ready]) {
  await openHash(page, run, hash);
  if (ready) await page.locator(ready).first().waitFor();
  if (name === "board-app") {
    await page
      .frameLocator("iframe.app-frame")
      .locator(".bar")
      .first()
      .waitFor();
  }
  await pageReady(page);
}

async function publicForm(run, page) {
  const form = run.store.getForm(run.seed.featureForm);
  await page.goto(`${run.hostOrigin}/f/${form.token}`);
  await page.locator(".fr-form").waitFor();
}

async function lightTour(run) {
  const context = await run.newContext({ userId: run.users.alex });
  const page = await context.newPage();
  run.page = page;
  for (const entry of tourPages(run.seed)) {
    await visit(run, page, entry);
    await screenshot(run, page, `page-${entry[0]}.png`);
  }
  await context.close();
  const visitor = await run.newContext({ label: "visitor" });
  const form = await visitor.newPage();
  run.page = form;
  await publicForm(run, form);
  await screenshot(run, form, "page-public-form.png");
  await visitor.close();
}

/** The main pages in one theme and viewport, named `<prefix>-<page>`. */
async function mainPages(run, { prefix, viewport, colorScheme }) {
  const options = { viewport, colorScheme, label: prefix };
  const context = await run.newContext({ userId: run.users.alex, ...options });
  const page = await context.newPage();
  run.page = page;
  const pages = tourPages(run.seed).filter(([name]) => MAIN_PAGES.has(name));
  for (const entry of pages) {
    await visit(run, page, entry);
    await screenshot(run, page, `${prefix}-${entry[0]}.png`);
    const overflow = await sidewaysOverflow(page);
    check(
      overflow <= 0,
      `${prefix} ${entry[0]} scrolls sideways ${overflow}px`,
    );
  }
  await context.close();
  const visitor = await run.newContext(options);
  const form = await visitor.newPage();
  run.page = form;
  await publicForm(run, form);
  await screenshot(run, form, `${prefix}-public-form.png`);
  check((await sidewaysOverflow(form)) <= 0, `${prefix} public form`);
  await visitor.close();
}

export const TOUR_STEPS = [
  ["screenshot tour: every page in light mode", lightTour],
  [
    "screenshot tour: main pages in dark mode",
    (run) =>
      mainPages(run, {
        prefix: "dark",
        viewport: DESKTOP,
        colorScheme: "dark",
      }),
  ],
  [
    "screenshot tour: main pages at 360 px",
    (run) =>
      mainPages(run, {
        prefix: "mobile",
        viewport: MOBILE,
        colorScheme: "light",
      }),
  ],
];
