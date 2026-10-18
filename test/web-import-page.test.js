/**
 * The import page (`#/import`, SPEC-4 §6, `web/pages/import.js`) mounted
 * over the fake DOM against the real host server (stub connectors, no
 * EventSource: jobs are followed by polling): non-admins get a message,
 * an admin walks every step with focus moving to each step's heading,
 * the wizard is kept while the page is away and dropped once it is back
 * at the source step, and the shell is refreshed once at the end.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mount } from "../web/pages/import.js";
import { fire } from "./fake-dom.js";
import { $, $$, installImportDom, label, recorder } from "./web-import-dom.js";
import { liveServer } from "./web-import-fixtures.js";

const ADMIN = {
  capabilities: ["manage_users", "admin_directory", "import_data"],
};

function context(me = ADMIN) {
  const refreshShell = recorder();
  return { me, toast: { error: recorder() }, refreshShell };
}

async function mounted(doc, ctx) {
  const container = doc.createElement("div");
  doc.body.append(container);
  const cleanup = await mount(container, ctx);
  return { container, cleanup };
}

const titleOf = (container) =>
  $(container, "h2.import-step-title")?.textContent ?? null;

async function untilStep(container, title) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (titleOf(container) === title) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`step "${title}" not shown (shows "${titleOf(container)}")`);
}

const buttonNamed = (root, text) =>
  $$(root, "button").find((button) => label(button) === text);

test("users without import_data see a message instead of the wizard", async (t) => {
  const doc = installImportDom(t);
  const { container, cleanup } = await mounted(
    doc,
    context({ capabilities: ["create_content"] }),
  );
  assert.equal(cleanup, undefined);
  assert.equal($(container, "h1").textContent, "Only admins can import");
  assert.equal($(container, "form"), null);
});

test("an admin imports through every step and the wizard outlives a visit elsewhere", async (t) => {
  const doc = installImportDom(t);
  const { servers } = await liveServer(t);
  const ctx = context();
  const first = await mounted(doc, ctx);
  const page = first.container;
  assert.equal(titleOf(page), "Choose what to import");
  assert.equal(doc.title, "Import · Worklane");
  const tabs = $$(page, "a.tab").map((tab) => tab.getAttribute("href"));
  assert.deepEqual(tabs, ["#/admin", "#/admin/content", "#/import"]);
  const monday = $$(page, "input.import-source-input")[0];
  monday.checked = true;
  fire(monday, "change");
  const token = $(page, "input.import-token");
  token.value = "tok-0123456789abcdef";
  fire($(page, "form"), "submit");
  assert.equal(token.value, "", "the field is cleared at once");
  await untilStep(page, "Review what to import");
  assert.equal(doc.activeElement, $(page, "h2.import-step-title"));
  assert.equal(
    $(page, "ol.import-steps li[aria-current]").textContent,
    "3Review",
  );
  const sam = $$(page, "select.import-person-action")[0];
  assert.equal(sam.value, `match:${servers.ids.users.sam}`, "matched by email");
  // Away and back: the review and its choices are still there.
  first.cleanup();
  const second = await mounted(doc, ctx);
  assert.equal(titleOf(second.container), "Review what to import");
  buttonNamed(second.container, "Import").click();
  await untilStep(second.container, "Import finished");
  assert.equal(ctx.refreshShell.calls.length, 1);
  assert.ok($$(second.container, "a.import-link").length > 0);
  second.cleanup();
  const third = await mounted(doc, ctx);
  assert.equal(
    titleOf(third.container),
    "Import finished",
    "the done step stays",
  );
  assert.equal(ctx.refreshShell.calls.length, 1, "no refresh on coming back");
  buttonNamed(third.container, "Import more").click();
  assert.equal(titleOf(third.container), "Choose what to import");
  assert.equal(doc.activeElement, $(third.container, "h2.import-step-title"));
  third.cleanup();
  // Back at the source step, the wizard was dropped: nothing is chosen.
  const fourth = await mounted(doc, ctx);
  const chosen = $$(fourth.container, "input.import-source-input").filter(
    (input) => input.checked,
  );
  assert.deepEqual(chosen, []);
  fourth.cleanup();
});
