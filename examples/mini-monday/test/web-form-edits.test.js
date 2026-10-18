/**
 * Editing a live form: a respondent may still hold the public definition
 * from before an edit, and the server files answers by question ID alone,
 * so the builder never hands a removed question's ID to a new question.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as B from "../web/ui/forms/builder-data.js";
import * as P from "../web/ui/forms/public-api.js";
import * as Q from "../web/ui/forms/questions.js";
import { startTestServers } from "./helpers.js";

async function servers(t) {
  const started = await startTestServers();
  t.after(() => started.close());
  const { hostOrigin, store } = started;
  const via = () => (path, init) =>
    fetch(new URL(path, hostOrigin), {
      ...init,
      headers: { ...init.headers, Origin: hostOrigin },
    });
  const token = (key) => store.getForm(started.ids.forms[key]).token;
  return { ...started, via, token };
}

test("a stale public page never files answers into a re-added question", async (t) => {
  const { ids, as, via, token } = await servers(t);
  const alex = as(ids.users.alex);
  const formId = ids.forms.feature;
  const boardId = (await alex.data(B.FORM_LOCATE_QUERY)).forms.find(
    (f) => String(f.id) === formId,
  ).board.id;
  const added = `mutation($b: ID!) { create_column(board_id: $b,
    title: "Customer email", column_type: text) { id title type } }`;
  const email = (await alex.data(added, { b: boardId })).create_column;
  const data = await alex.data(B.FORM_BUILDER_QUERY, { ids: [boardId] });
  const raw = data.boards[0].forms.find((f) => String(f.id) === formId);
  const form = B.normalizeForm(raw).value;
  const anonymous = { fetch: via() };
  const stale = (await P.fetchDefinition(token("feature"), anonymous))
    .definition;
  const [name, details] = stale.questions;
  // The builder removes "Details" and asks the new column instead.
  const removed = Q.removeQuestion(form.questions, 1);
  const { questions, question } = Q.addQuestion(removed, email);
  assert.notEqual(question.id, details.id, "a removed question's ID");
  const patch = B.updateVariables(formId, { questions });
  await alex.data(B.FORM_MUTATIONS.update, patch);
  const answers = { [name.id]: "Stale page", [details.id]: "For details" };
  const sent = await P.submitAnswers(token("feature"), { answers }, anonymous);
  assert.equal(sent.ok, true);
  const items = `query($b: ID!) { boards(ids: [$b]) { items_page(limit: 500) {
    items { name column_values(ids: ["${email.id}"]) { text } } } } }`;
  const page = (await alex.data(items, { b: boardId })).boards[0].items_page;
  const item = page.items.find((entry) => entry.name === "Stale page");
  assert.equal(item.column_values[0].text ?? "", "", "not in Customer email");
});
