/**
 * Content and administration steps of `e2e-roles.mjs`: doc autosave with
 * a version conflict, notes and their privacy, the form builder with a
 * public submission, admin user management (a deactivated user's session
 * stops working), teams and workspaces. `run.users` holds the seeded user
 * IDs by first name and `run.seed` the other seeded IDs (`seedIds`).
 */
import {
  check,
  dataAs,
  openHash,
  screenshot,
  signedIn,
  waitUntil,
} from "./e2e-lib.mjs";

const DOC = `query Doc($id: ID!) {
  docs(ids: [$id]) { id title version blocks_json }
}`;
const NOTES = `{ notes { id title pinned shares { id role } } }`;
const FORMS = `query Forms($board: ID!) {
  forms(board_id: $board) {
    id title accent_color questions_json response_count public_url
  }
}`;
const ITEM_NAMES = `query Items($board: ID!) {
  boards(ids: [$board]) { items_page(limit: 500) { items { name } } }
}`;

/** Waits until a save-state element reads "Saved". */
const saved = (locator, label) =>
  waitUntil(
    async () => /^\s*Saved/.test((await locator.textContent()) ?? ""),
    label,
  );

async function docAutosaveConflict(run) {
  const docId = run.seed.vision;
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/docs/${docId}`,
  });
  const last = page.locator(".doc-block .block-content").last();
  await last.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Autosaved from the browser.");
  await saved(page.locator(".save-status"), "the doc autosave");
  const stored = (await dataAs(run, run.users.alex, DOC, { id: docId }))
    .docs[0];
  check(stored.blocks_json.includes("Autosaved from the browser."), "saved");
  // Noa edits the doc through the API meanwhile.
  await dataAs(
    run,
    run.users.noa,
    `mutation Edit($id: ID!, $v: Int!) {
      update_doc(doc_id: $id, expected_version: $v,
        title: "Product vision (edited by Noa)") { version }
    }`,
    { id: docId, v: stored.version },
  );
  await page.keyboard.type(" One more sentence.");
  const banner = page.locator(".editor-banner");
  await banner.waitFor();
  await screenshot(run, page, "doc-version-conflict.png");
  await banner.locator("button", { hasText: "Reload" }).click();
  await waitUntil(
    async () =>
      (await page.locator(".doc-title").inputValue()) ===
      "Product vision (edited by Noa)",
    "the reloaded title",
  );
  check((await banner.count()) === 0, "the banner is gone after reload");
  await context.close();
}

async function notesPrivacy(run) {
  const alex = await signedIn(run, run.users.alex, { hash: "#/notes" });
  const { page } = alex;
  await page
    .locator(".page-header .btn-primary", { hasText: "New note" })
    .click();
  await page.locator(".note-panel .note-title-input").waitFor();
  await page.keyboard.type("Offsite agenda");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Roadmap review\nTeam dinner");
  const panel = page.locator(".note-panel");
  await waitUntil(async () => {
    const { notes } = await dataAs(run, run.users.alex, NOTES);
    return notes.find((note) => note.title === "Offsite agenda");
  }, "the new note in the API");
  await panel.locator(".note-pin-button").click();
  await waitUntil(async () => {
    const { notes } = await dataAs(run, run.users.alex, NOTES);
    return notes.find((note) => note.title === "Offsite agenda")?.pinned;
  }, "the pin");
  await panel.locator("[aria-label='Share note']").click();
  const dialog = page.locator("dialog.share-dialog[open]");
  await dialog.locator(".picker-input").fill("Sam");
  await dialog.locator(".picker-option", { hasText: "Sam Lee" }).click();
  await dialog
    .locator(".share-invite-row button", { hasText: "Invite" })
    .click();
  await dialog.locator(".share-member", { hasText: "Sam Lee" }).waitFor();
  await dialog.locator("button", { hasText: "Done" }).click();
  await screenshot(run, page, "notes-editor.png");
  await alex.context.close();
  // Sam sees the shared note, never Alex's private "Ideas for Q1".
  const sam = await signedIn(run, run.users.sam, { hash: "#/notes" });
  const titles = await sam.page.locator(".note-card-title").allTextContents();
  check(titles.includes("Offsite agenda"), `Sam's notes ${titles}`);
  check(!titles.includes("Ideas for Q1"), "Alex's private note is hidden");
  const ideas = run.seed.ideas;
  await openHash(sam.page, run, `#/notes/${ideas}`);
  await sam.page.locator(".note-missing").waitFor();
  const { notes } = await dataAs(run, run.users.sam, NOTES);
  check(!notes.some((note) => note.id === ideas), "API hides it too");
  await sam.context.close();
}

async function formBuilderPublic(run) {
  const form = run.store.getForm(run.seed.featureForm);
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: `#/forms/${form.id}`,
  });
  const questions = page.locator(".fb-question");
  await waitUntil(async () => (await questions.count()) === 4, "4 questions");
  await questions.nth(1).locator("input").first().fill("What should it do?");
  await page.locator(".color-swatch").nth(3).click();
  const read = async () =>
    (await dataAs(run, run.users.alex, FORMS, { board: form.board_id }))
      .forms[0];
  const before = await waitUntil(async () => {
    const current = await read();
    const labels = JSON.parse(current.questions_json).map((q) => q.label);
    const done =
      labels[1] === "What should it do?" &&
      current.accent_color !== form.accent_color;
    return done && current;
  }, "the label and accent color to autosave");
  await page.locator(".fb-save-state.is-saved").waitFor();
  await screenshot(run, page, "form-builder-edited.png");
  // A fresh browser with no session answers the public form.
  const visitor = await run.newContext({ label: "visitor" });
  const pub = await visitor.newPage();
  await pub.goto(before.public_url);
  await pub.locator(".fr-form").waitFor();
  await pub.locator(".fr-submit").click();
  await pub.locator(".fr-error:not([hidden])").first().waitFor();
  await pub.locator(".fr-question input[type=text]").first().fill("Bulk edit");
  await pub.locator(".fr-submit").click();
  await pub.locator(".fr-success").waitFor();
  await screenshot(run, pub, "public-form-success.png");
  const { boards } = await dataAs(run, run.users.alex, ITEM_NAMES, {
    board: form.board_id,
  });
  const names = boards[0].items_page.items.map((item) => item.name);
  check(names.includes("Bulk edit"), "the response created an item");
  check((await read()).response_count === before.response_count + 1, "count");
  await waitUntil(
    async () =>
      Number(await page.locator(".fb-responses-count").textContent()) ===
      before.response_count + 1,
    "the builder's live response count",
  );
  await visitor.close();
  await context.close();
}

async function adminUsers(run) {
  const sam = await signedIn(run, run.users.sam, { label: "sam" });
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: "#/admin",
  });
  await page.getByRole("button", { name: "Invite user" }).click();
  const dialog = page.locator("dialog.modal[open]");
  await dialog.locator("input[name=name]").fill("Riley Park");
  await dialog.locator("input[name=email]").fill("riley@example.test");
  await dialog.locator("button[type=submit]").click();
  await page.locator("tr", { hasText: "Riley Park" }).waitFor();
  const riley = run.store.findUserByEmail("riley@example.test");
  check(riley?.role === "member" && riley.status === "active", "invited");
  await page.getByLabel("Account role of Riley Park").selectOption("viewer");
  await waitUntil(
    () => run.store.getUser(riley.id).role === "viewer",
    "the role change",
  );
  await screenshot(run, page, "admin-users.png");
  // Deactivating Sam ends his session at once: his open page's next
  // requests are refused.
  await page.getByRole("button", { name: "Deactivate Sam Lee" }).click();
  await page.locator("dialog.modal[open] button[type=submit]").click();
  await waitUntil(
    () => run.store.getUser(run.users.sam).status === "deactivated",
    "deactivation",
  );
  run.expectHttp(401, "/v2", { repeat: true });
  // The notification stream ends too; whether its reconnect (refused)
  // happens before the page closes depends on EventSource's retry timer.
  run.allowHttp(401, "/v2/events");
  await sam.page.evaluate(() => {
    location.hash = "#/my-work";
  });
  await sam.page.locator("#page", { hasText: "session has expired" }).waitFor();
  await screenshot(run, sam.page, "deactivated-session.png");
  await sam.context.close();
  await page.getByRole("button", { name: "Activate Sam Lee" }).click();
  await page.locator("dialog.modal[open] button[type=submit]").click();
  await waitUntil(
    () => run.store.getUser(run.users.sam).status === "active",
    "reactivation",
  );
  await context.close();
}

async function teamsCreate(run) {
  const { context, page } = await signedIn(run, run.users.alex, {
    hash: "#/teams",
  });
  await page.getByRole("button", { name: "New team" }).click();
  const dialog = page.locator("dialog.modal[open]");
  await dialog.locator("input[name=name]").fill("Design guild");
  await dialog.locator(".picker-input").fill("Priya");
  await dialog.locator(".picker-option", { hasText: "Priya Nair" }).click();
  await dialog.locator("button[type=submit]").click();
  await page.locator(".team-page").waitFor();
  const add = page.locator(".team-add-row");
  await add.locator(".picker-input").fill("Jordan");
  await page.locator(".picker-option", { hasText: "Jordan Blake" }).click();
  await add.locator("button", { hasText: "Add" }).click();
  await page.locator(".team-page", { hasText: "Jordan Blake" }).waitFor();
  const team = run.store
    .listTeams()
    .find((entry) => entry.name === "Design guild");
  const members = team.members.map((m) => `${m.user_id}:${m.role}`).sort();
  const { alex, priya, jordan } = run.users;
  const want = [`${alex}:owner`, `${jordan}:member`, `${priya}:member`];
  check(members.join() === want.sort().join(), `members ${members}`);
  await screenshot(run, page, "team-created.png");
  await context.close();
}

async function workspaceClosed(run) {
  const { context, page } = await signedIn(run, run.users.alex);
  await page.locator(".workspace-switcher").click();
  await page.locator(".menu-item", { hasText: "New workspace" }).click();
  const dialog = page.locator("dialog.modal[open]");
  await dialog.locator("input[name=name]").fill("Skunkworks");
  await dialog.locator("label.choice", { hasText: "Closed" }).click();
  await dialog.locator("button[type=submit]").click();
  await waitUntil(() => /#\/workspaces\/\d+$/.test(page.url()), "the page");
  const id = /workspaces\/(\d+)$/.exec(page.url())[1];
  check(run.store.getWorkspace(id).kind === "closed", "closed workspace");
  await openHash(page, run, `#/workspaces/${id}/settings`);
  await page.getByLabel("Description").fill("Experiments in progress");
  await page.getByRole("button", { name: "Save changes" }).click();
  await waitUntil(
    () => run.store.getWorkspace(id).description === "Experiments in progress",
    "the settings save",
  );
  await screenshot(run, page, "workspace-settings-saved.png");
  const { workspaces } = await dataAs(
    run,
    run.users.sam,
    `{ workspaces { id } }`,
  );
  check(!workspaces.some((entry) => entry.id === id), "closed to Sam");
  await context.close();
}

export const CONTENT_STEPS = [
  ["doc autosave and a forced version conflict", docAutosaveConflict],
  ["notes: create, pin, share; private notes stay private", notesPrivacy],
  ["form builder edits and a public submission", formBuilderPublic],
  ["admin invites, changes a role, deactivates a user", adminUsers],
  ["teams: create a team and add a member", teamsCreate],
  ["workspaces: create a closed one and edit its settings", workspaceClosed],
];
