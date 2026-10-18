/**
 * Public form page (`/f/<token>`, loaded by `form.html`): reads the token
 * from the path, loads `GET /f/<token>/definition` and renders it with the
 * shared form renderer (`ui/forms/renderer.js`, the same one the builder's
 * preview uses). Submissions go to `POST /f/<token>/submit`; the renderer
 * shows the confirmation, answer problems and the friendly closed /
 * unknown / sign-in / rate-limited messages.
 *
 * The page follows the theme chosen in the app on this browser (or the
 * system theme) and never shows anything about the board behind the form.
 */

import { h } from "./dom.js";
import { brandMark } from "./ui/components/icon.js";
import {
  fetchDefinition,
  submitAnswers,
  tokenFromPath,
} from "./ui/forms/public-api.js";
import { formMessage, renderForm } from "./ui/forms/renderer.js";
import { initTheme } from "./ui/shell/theme.js";

const doc = () => globalThis.document;

function brand() {
  return h(
    "p",
    { class: "form-brand" },
    brandMark({ size: 22 }),
    h("span", { class: "brand-word" }, "Worklane"),
  );
}

function footer() {
  return h(
    "p",
    { class: "fr-footer" },
    "Your answers go to the team that shared this form. Never submit passwords.",
  );
}

function loading() {
  return h(
    "div",
    { class: "fr fr-loading", role: "status", "aria-busy": "true" },
    h("div", { class: "fr-header" }),
    h("p", { class: "visually-hidden" }, "Loading form…"),
  );
}

function show(root, ...content) {
  root.replaceChildren(h("div", { class: "form-shell" }, brand(), ...content));
}

function retryButton(onClick) {
  return h(
    "button",
    { type: "button", class: "btn btn-secondary", on: { click: onClick } },
    "Try again",
  );
}

async function load(root, token) {
  show(root, loading());
  const result = await fetchDefinition(token);
  if (!result.ok) {
    doc().title = "Form · Worklane";
    const action =
      result.reason === "unavailable"
        ? retryButton(() => load(root, token))
        : null;
    show(root, formMessage(result.reason, { action }));
    return;
  }
  const { definition } = result;
  doc().title = `${definition.title} · Worklane`;
  const view = renderForm(definition, {
    submit: (body) => submitAnswers(token, body),
  });
  show(root, view.element, footer());
}

function start() {
  initTheme();
  const root = doc().getElementById("form-root");
  const token = tokenFromPath(globalThis.location.pathname);
  if (!token) {
    show(root, formMessage("unknown"));
    return;
  }
  load(root, token);
}

start();
