/**
 * Browser checks that the UI shows the server's verdicts (SPEC-2 §6) and
 * keeps none of its own (`e2e-roles.mjs` runs them after the guest
 * steps): the share dialog's member controls and candidates, the people
 * picker's assignable users, "Someone" for people a guest may not see,
 * and the "Live updates paused" banner when a stream is refused.
 *
 * Steps that change shared seed data put it back before they end.
 */
import {
  check,
  dataAs,
  openHash,
  screenshot,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";

const BOARD_ACCESS = `query Board($id: ID!) { boards(ids: [$id]) { my_access } }`;
const SHARE = `mutation($b: ID!, $u: ID!, $r: AccessRole!) {
  share(resource_kind: board, resource_id: $b, subject_kind: user,
    subject_ids: [$u], role: $r) { id } }`;
const UNSHARE = `mutation($b: ID!, $u: ID!) {
  unshare(resource_kind: board, resource_id: $b, subject_kind: user,
    subject_id: $u) { id } }`;
const RENAME = `mutation($b: ID!, $i: ID!, $v: String) {
  change_simple_column_value(board_id: $b, item_id: $i, column_id: "name",
    value: $v) { id } }`;

const boardNamed = (run, name) =>
  run.store.listBoards({ limit: 500 }).find((board) => board.name === name).id;
const itemNamed = (run, boardId, name) =>
  run.store
    .listItems({ boardId, limit: 500 })
    .items.find((item) => item.name === name);
const accessOf = async (run, userId, boardId) =>
  (await dataAs(run, userId, BOARD_ACCESS, { id: boardId })).boards[0]
    ?.my_access ?? null;

/** Counts the page's `share_candidates` requests. */
function countCandidateRequests(page) {
  const seen = { count: 0 };
  page.on("request", (request) => {
    if ((request.postData() ?? "").includes("share_candidates")) {
      seen.count += 1;
    }
  });
  return seen;
}

async function ownerSeesVerdicts(run, hiring) {
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/boards/${hiring}`,
  });
  await page.locator(".board-share").click();
  const dialog = page.locator("dialog.share-dialog[open]");
  const row = (name) => dialog.locator(".share-member", { hasText: name });
  const roleButton = (name) => row(name).locator(".share-role-button");
  /** The roles a member's role menu offers (closed again afterwards). */
  const roles = async (name) => {
    await roleButton(name).click();
    const items = page.locator(".popover [role=menuitemradio] .menu-label");
    await items.first().waitFor();
    const labels = await items.allTextContents();
    await page.keyboard.press("Escape");
    return labels;
  };
  const remove = (name) => row(name).locator("button[aria-label^='Remove']");
  await row("Noa Cohen").waitFor();
  // Alex is the only owner: the role is fixed and kept, and the dialog
  // says why in the server's words.
  const { boards: owned } = await dataAs(
    run,
    run.users.alex,
    `query($b: [ID!]) { boards(ids: $b) { members { name reason } } }`,
    { b: [hiring] },
  );
  const reason = owned[0].members.find((m) => m.name === "Alex Rivera").reason;
  check(/needs at least one owner/.test(reason), `server reason ${reason}`);
  check(
    (await roleButton("Alex Rivera").getAttribute("aria-disabled")) === "true",
    "fixed",
  );
  check(
    (await row("Alex Rivera").locator(".share-owner-note").textContent()) ===
      reason,
    "the note is the server's reason",
  );
  check(
    (await remove("Alex Rivera").getAttribute("aria-disabled")) === "true",
    "kept",
  );
  check((await roles("Noa Cohen")).join() === "Owner,Editor,Viewer", "Noa");
  check(
    (await remove("Noa Cohen").getAttribute("aria-disabled")) === null,
    "removable",
  );
  // Candidates come with the server's verdict: the guest can't join a
  // Private board, and says why.
  const input = dialog.locator(".picker-input");
  await input.fill("Chr");
  const options = dialog.locator(".picker-option");
  await waitUntil(async () => (await options.count()) === 1, "one match");
  const chris = options.filter({ hasText: "Chris Taylor" });
  check((await chris.getAttribute("aria-disabled")) === "true", "ineligible");
  const refusal = await chris.locator(".picker-option-hint").textContent();
  check(/Guests can only join shareable boards/.test(refusal), refusal);
  const hint = await dialog.locator(".share-hint").textContent();
  check(hint.includes(refusal), `hint: ${hint}`);
  await screenshot(run, page, "share-dialog-verdicts.png");
  await chris.click({ force: true });
  check((await dialog.locator(".picker-chip").count()) === 0, "not added");
  // An eligible candidate is invited with a role the server offered.
  check(
    (await dialog.locator(".share-role option").allTextContents()).join() ===
      "Owner,Editor,Viewer",
    "roles the server accepts for anyone offered",
  );
  await input.fill("Pri");
  await waitUntil(async () => (await options.count()) === 1, "Priya only");
  await options.filter({ hasText: "Priya Nair" }).click();
  const roleSelect = dialog.locator(".share-role");
  const offered = await roleSelect.locator("option").allTextContents();
  check(offered.join() === "Owner,Editor,Viewer", `offered ${offered}`);
  await roleSelect.selectOption("viewer");
  await dialog
    .locator(".share-invite-row button", { hasText: "Invite" })
    .click();
  await row("Priya Nair").waitFor();
  check((await accessOf(run, run.users.priya, hiring)) === "viewer", "viewer");
  await remove("Priya Nair").click();
  await waitUntil(
    async () => (await row("Priya Nair").count()) === 0,
    "removed",
  );
  check((await accessOf(run, run.users.priya, hiring)) === null, "no access");
  await context.close();
}

async function editorSeesNoControls(run, hiring) {
  const { context, page } = await signedIn(run, run.users.noa, {
    hash: `#/boards/${hiring}`,
  });
  const requests = countCandidateRequests(page);
  await page.locator(".board-share").click();
  const dialog = page.locator("dialog.share-dialog[open]");
  await dialog.locator(".share-readonly").waitFor();
  check((await dialog.locator(".picker-input").count()) === 0, "no picker");
  check(
    (await dialog.locator(".share-member .share-role-button").count()) === 0,
    "roles",
  );
  check((await dialog.locator(".share-member button").count()) === 0, "remove");
  check(requests.count === 0, "editors never ask for candidates");
  await context.close();
}

async function shareDialogVerdicts(run) {
  const hiring = boardNamed(run, "Hiring plan");
  await ownerSeesVerdicts(run, hiring);
  await editorSeesNoControls(run, hiring);
}

/** Opens the people cell of `itemName`; returns the picker popover. */
async function openPeople(page, itemName) {
  await page
    .locator(`button.people-button[aria-label*=" for ${itemName}: "]`)
    .first()
    .click();
  const picker = page.locator(".popover .people-picker");
  await picker.waitFor();
  return picker;
}

async function peoplePickerEligibility(run) {
  const { roadmap } = run.seed;
  const hiring = boardNamed(run, "Hiring plan");
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/boards/${roadmap}/views/table`,
  });
  const first = run.store.listItems({ boardId: roadmap, limit: 1 }).items[0];
  let picker = await openPeople(page, first.name);
  const names = await picker.locator(".person-name").allTextContents();
  check(names.includes("Jordan Blake"), `viewers can be assigned: ${names}`);
  check(!names.includes("Chris Taylor"), "the guest cannot open the board");
  check(!names.includes("Morgan Diaz"), "deactivated users are not offered");
  const hint = await picker.locator(".people-hint").textContent();
  check(/Only people who can open this board/.test(hint), hint);
  await screenshot(run, page, "people-picker-assignable.png");
  await page.keyboard.press("Escape");
  // Noa stays assigned on the Hiring plan after losing access: listed
  // only to be removed.
  const { alex, noa } = run.users;
  await dataAs(run, alex, UNSHARE, { b: hiring, u: noa });
  try {
    await openHash(page, run, `#/boards/${hiring}/views/table`);
    picker = await openPeople(page, "Senior backend engineer");
    const row = picker.locator(".person-option", { hasText: "Noa Cohen" });
    check(
      (await row.locator(".person-hint").textContent()) ===
        "No access to this board",
      "the stale assignee is explained",
    );
    const box = row.locator("input[type=checkbox]");
    check(await box.isChecked(), "still assigned");
    await screenshot(run, page, "people-picker-stale.png");
    // By keyboard: Space unchecks the focused box, which keeps focus.
    await box.focus();
    await page.keyboard.press("Space");
    await waitUntil(
      () =>
        (itemNamed(run, hiring, "Senior backend engineer").values.person ?? [])
          .length === 0,
      "the assignee removed",
    );
    check(
      (await box.getAttribute("aria-disabled")) === "true",
      "and not offered again",
    );
    const focus = await page.evaluate(() =>
      Boolean(document.activeElement?.closest(".popover")),
    );
    check(focus, "focus stays in the open picker");
    await page.keyboard.press("Space");
    check(!(await box.isChecked()), "Space does not add them back");
  } finally {
    await dataAs(run, alex, SHARE, { b: hiring, u: noa, r: "editor" });
  }
  await context.close();
}

async function guestSeesSomeone(run) {
  const { marketing } = run.seed;
  const { priya, noa, chris } = run.users;
  const item = run.store.listItems({ boardId: marketing, limit: 1 }).items[0];
  // Noa edits the Shareable board and leaves it: Chris may not see Noa.
  await dataAs(run, priya, SHARE, { b: marketing, u: noa, r: "editor" });
  const edit = { b: marketing, i: item.id, v: "Brief agency (edited)" };
  await dataAs(run, noa, RENAME, edit);
  await dataAs(run, priya, UNSHARE, { b: marketing, u: noa });
  const actors = async (userId) => {
    const { context, page } = await signedIn(run, userId, {
      hash: `#/boards/${marketing}/views/activity`,
    });
    const entry = page.locator(".activity-entry", { hasText: "Brief agency" });
    await entry.first().waitFor();
    const names = await entry.locator(".activity-actor").allTextContents();
    await context.close();
    return names;
  };
  const hidden = await actors(chris);
  check(
    hidden.includes("Someone") && !hidden.includes("Noa Cohen"),
    `${hidden}`,
  );
  const shown = await actors(priya);
  check(shown.includes("Noa Cohen"), `members see the name: ${shown}`);
  await dataAs(run, priya, RENAME, { ...edit, v: item.name });
}

/**
 * Opens `count` notification streams for `userId` from outside the
 * browser (which keeps only a few connections per host); returns a
 * function that closes them.
 */
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
  return () => {
    for (const controller of controllers) controller.abort();
  };
}

async function livePausedBanner(run) {
  const { roadmap } = run.seed;
  const { context, page } = await signedIn(run, run.users.sam);
  const banner = page.locator(".live-status-banner");
  check((await banner.count()) === 0, "no banner while streams are live");
  // The page's own stream plus 31 more: Sam's next stream is refused.
  run.expectHttp(429, "/v2/events");
  const release = await holdStreams(run, run.users.sam, 31);
  try {
    await openHash(page, run, `#/boards/${roadmap}`);
    await banner.waitFor();
    const text = await banner.textContent();
    check(text.startsWith("Live updates paused"), text);
    await screenshot(run, page, "live-updates-paused.png");
    // The board itself (its List view) still works; only its live
    // updates stopped.
    await page.locator(".list-row .list-name").first().waitFor();
    await page.locator(".list-add-input").first().waitFor();
  } finally {
    release();
  }
  // Let the server see the closed streams before the page opens new ones.
  await page.waitForTimeout(300);
  await banner.locator("button", { hasText: "Reload" }).click();
  await page.locator(".list-row .list-name").first().waitFor();
  await page.locator(".list-add-input").first().waitFor();
  await page.waitForTimeout(500);
  check((await banner.count()) === 0, "reloading resumes live updates");
  await context.close();
}

export const VERDICT_STEPS = [
  ["the share dialog shows the server's verdicts", shareDialogVerdicts],
  ["the people picker offers who can open the board", peoplePickerEligibility],
  ["a guest sees Someone for people they may not see", guestSeesSomeone],
  ["a refused stream shows Live updates paused", livePausedBanner],
];
