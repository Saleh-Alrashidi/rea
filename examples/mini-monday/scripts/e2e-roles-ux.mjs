/**
 * Browser checks of interaction details that only a real browser shows
 * (`e2e-roles.mjs` runs them after the tour): the Status summary note is
 * read-only for viewers, a mistyped number keeps its value, note edits
 * survive a reload, undo in a doc follows the doc's own history, focus
 * returns to what opened the task view, readable danger buttons in dark
 * mode, the modal navigation drawer, keyboard popovers and menus, the skip
 * link, headings of error pages, unsaved settings, Home notifications,
 * last-owner and last-group hints, a demotion reaching the shell and a
 * board that stops being accessible while open.
 *
 * Steps that change shared seed data (the roadmap's kind, Sam's role) put
 * it back before they end.
 */
import { check, dataAs, screenshot, signedIn, waitUntil } from "./e2e-lib.mjs";
import { UX_STEPS_2 } from "./e2e-roles-ux2.mjs";

const itemsOf = (run, boardId) =>
  run.store.listItems({ boardId, limit: 500 }).items;
const itemNamed = (run, boardId, name) =>
  itemsOf(run, boardId).find((item) => item.name === name);
const focusedKey = (page) =>
  page.evaluate(() => document.activeElement?.dataset?.focusKey ?? null);

async function appNoteReadOnly(run) {
  const { roadmap, install } = run.seed;
  const hash = `#/boards/${roadmap}/views/app-${install}`;
  const jordan = await signedIn(run, run.users.jordan, { hash });
  const frame = jordan.page.frameLocator("iframe.app-frame");
  await frame.locator("#note-access").waitFor();
  const note = frame.locator("#note");
  check(await note.evaluate((el) => el.readOnly), "the viewer's note");
  check(
    !(await frame.locator("#save-note").isVisible()),
    "no Save for viewers",
  );
  await jordan.context.close();
  const alex = await signedIn(run, run.users.alex, { hash });
  const editable = alex.page.frameLocator("iframe.app-frame");
  await editable.locator("#save-note").waitFor();
  check(
    !(await editable.locator("#note").evaluate((el) => el.readOnly)),
    "editors write the note",
  );
  check(!(await editable.locator("#note-access").isVisible()), "no notice");
  await alex.context.close();
}

async function numberTypoKeepsValue(run) {
  const { roadmap } = run.seed;
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/boards/${roadmap}/views/table`,
  });
  const name = "Set up CI pipeline";
  const before = itemNamed(run, roadmap, name).values.estimate;
  check(before !== undefined && before !== null, "a seeded estimate");
  const input = page.locator(`input[aria-label='Estimate for ${name}']`);
  await input.click();
  await page.keyboard.press("End");
  await page.keyboard.type("e");
  await input.press("Enter");
  await page.waitForTimeout(300);
  check(
    itemNamed(run, roadmap, name).values.estimate === before,
    "Enter on '3e' keeps the value",
  );
  check((await input.getAttribute("aria-invalid")) === "true", "flagged");
  await input.press("Tab");
  await page.locator(".toast", { hasText: "isn’t a number" }).waitFor();
  await page.waitForTimeout(300);
  check(
    itemNamed(run, roadmap, name).values.estimate === before,
    "leaving keeps the value",
  );
  check((await input.inputValue()) === String(before), "the value is shown");
  await context.close();
}

async function noteSurvivesReload(run) {
  const { ideas } = run.seed;
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/notes/${ideas}`,
  });
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.accept();
  });
  await page.locator(".note-body-input").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Saved before reload");
  // Within the autosave delay: the page saves and asks before unloading.
  await page.reload();
  await waitUntil(
    () => run.store.getNote(ideas).body.includes("Saved before reload"),
    "the note edit to reach the server",
  );
  check(dialogs.includes("beforeunload"), `dialogs: ${dialogs}`);
  await context.close();
}

const blockTexts = (page) =>
  page
    .locator(".doc-block")
    .evaluateAll((blocks) =>
      blocks.map(
        (block) =>
          `${[...block.classList].find((name) => name.startsWith("block-"))}:` +
          (block.querySelector(".block-content")?.textContent ?? ""),
      ),
    );

async function docUndoAndSlashMenu(run) {
  const { create_doc: doc } = await dataAs(
    run,
    run.users.sam,
    `mutation($w: ID!) { create_doc(title: "Undo check", workspace_id: $w) { id } }`,
    { w: run.seed.workspace },
  );
  const { context, page } = await signedIn(run, run.users.sam, {
    hash: `#/docs/${doc.id}`,
  });
  await page.locator(".doc-block .block-content").first().click();
  await page.keyboard.type("Groceries for the offsite");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- ");
  const converted = ["block-paragraph:Groceries for the offsite"];
  check(
    (await blockTexts(page)).join("|") ===
      [...converted, "block-bulleted:"].join("|"),
    "the shortcut made a bullet",
  );
  // Undo reverts the conversion only; the paragraph above stays whole.
  await page.keyboard.press("Control+z");
  const undone = [...converted, "block-paragraph:- "].join("|");
  check((await blockTexts(page)).join("|") === undone, "undo the shortcut");
  await waitUntil(
    () =>
      run.store
        .getDoc(doc.id)
        .blocks.map((b) => `${b.type}:${b.text}`)
        .join() === "paragraph:Groceries for the offsite,paragraph:- ",
    "the undone doc to save",
  );
  await page.keyboard.press("Control+Shift+z");
  check(
    (await blockTexts(page)).join("|") ===
      [...converted, "block-bulleted:"].join("|"),
    "redo",
  );
  await slashMenuFilters(run, page);
  await context.close();
}

/** The active option of the "/" menu's combobox (aria-activedescendant). */
const activeSlashOption = (page) =>
  page.evaluate(() => {
    const input = document.querySelector(".slash-menu .slash-input");
    const id = input?.getAttribute("aria-activedescendant");
    const option = id ? document.getElementById(id) : null;
    return {
      focused: document.activeElement === input,
      label: option?.querySelector(".menu-label")?.textContent ?? null,
      selected: option?.getAttribute("aria-selected") ?? null,
    };
  });

/**
 * "/" in an empty block opens a combobox that filters block types as you
 * type; Enter picks the active one; Escape gives the block back what was
 * typed with the caret after it.
 */
async function slashMenuFilters(run, page) {
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const options = page.locator(".slash-menu [role=option]");
  await options.first().waitFor();
  check((await options.count()) === 10, "every block type at first");
  await page.keyboard.type("quo");
  await waitUntil(async () => (await options.count()) === 1, "one match");
  const quote = await activeSlashOption(page);
  check(quote.focused, "typing stays in the filter");
  check(quote.label === "Quote" && quote.selected === "true", quote.label);
  await page.keyboard.press("Enter");
  await waitUntil(
    async () => (await blockTexts(page)).at(-1) === "block-quote:",
    "a quote block",
  );
  await page.keyboard.type("/");
  await options.first().waitFor();
  await page.keyboard.type("hea");
  await waitUntil(async () => (await options.count()) === 2, "two headings");
  await page.keyboard.press("ArrowDown");
  const second = await activeSlashOption(page);
  check(second.label === "Heading 2", `arrow down: ${second.label}`);
  await screenshot(run, page, "doc-slash-menu.png");
  await page.keyboard.press("Escape");
  await waitUntil(
    async () => (await options.count()) === 0,
    "the menu to close",
  );
  check(
    (await blockTexts(page)).at(-1) === "block-quote:/hea",
    "Escape keeps the typed text",
  );
  await page.keyboard.type("d");
  check(
    (await blockTexts(page)).at(-1) === "block-quote:/head",
    "the caret is back after the text",
  );
}

/** The Main table's "Open" shows the task view; closing it refocuses "Open". */
async function taskFocusReturns(run) {
  const { roadmap } = run.seed;
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/boards/${roadmap}/views/table`,
  });
  const item = itemNamed(run, roadmap, "Set up CI pipeline");
  const key = `open:${item.id}`;
  await page.locator(`[data-focus-key="${key}"]`).focus();
  await page.keyboard.press("Enter");
  await page.locator("dialog.task-view[open] .task-title").waitFor();
  await page.keyboard.press("Escape");
  await waitUntil(async () => (await focusedKey(page)) === key, "focus back");
  await page.keyboard.press("Enter");
  await page.locator("dialog.task-view[open] .task-close").click();
  await waitUntil(async () => (await focusedKey(page)) === key, "after ×");
  await context.close();
}

function contrastOf(colors) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (text) => {
    const [r, g, b] = text.match(/[\d.]+/g).map(Number);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [a, b] = [luminance(colors.color), luminance(colors.background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const colorsOf = (locator) =>
  locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, background: style.backgroundColor };
  });

async function darkDangerContrast(run) {
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/boards/${run.seed.roadmap}/views/table`,
    colorScheme: "dark",
  });
  await page.locator("button.row-delete").first().click();
  const danger = page.locator("dialog.modal[open] .btn-danger");
  await danger.waitFor();
  const ratio = contrastOf(await colorsOf(danger));
  check(ratio >= 4.5, `dark danger button contrast ${ratio.toFixed(2)}`);
  await page.keyboard.press("Escape");
  await context.close();
}

export const UX_STEPS = [
  ["the Status summary note is read-only for viewers", appNoteReadOnly],
  ["a mistyped number keeps the saved value", numberTypoKeepsValue],
  ["note edits survive an immediate reload", noteSurvivesReload],
  ["doc undo follows the doc; the / menu filters", docUndoAndSlashMenu],
  ["closing the task view returns focus", taskFocusReturns],
  ["danger buttons stay readable in dark mode", darkDangerContrast],
  ...UX_STEPS_2,
];
