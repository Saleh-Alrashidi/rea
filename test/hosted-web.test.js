/**
 * The browser side of the site gate (SPEC-3 §2): the sign-in page script
 * (`web/signin.js`: outcomes, `next` with the hash, the form's error and
 * busy states) and the API client (`web/api.js`), which opens the sign-in
 * page when the gate answers SITE_LOCKED and treats a sign-out the gate
 * already made as done.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { graphql, listDemoUsers, logout, request } from "../web/api.js";
import { requestedNext, signinOutcome, wireSignin } from "../web/signin.js";
import { fire, installFakeDom } from "./fake-dom.js";

const LOCKED = {
  errors: [{ message: "Sign in", extensions: { code: "SITE_LOCKED" } }],
};

function jsonResponse(status, body, headers = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** Replaces `globalThis[name]` for one test. */
function stubGlobal(t, name, value) {
  const had = Object.hasOwn(globalThis, name);
  const original = globalThis[name];
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (had) globalThis[name] = original;
    else delete globalThis[name];
  });
}

/** A location double that records navigations. */
function fakeLocation({ pathname = "/", search = "", hash = "" } = {}) {
  const visits = [];
  return {
    pathname,
    search,
    hash,
    visits,
    assign: (url) => visits.push(["assign", url]),
    replace: (url) => visits.push(["replace", url]),
  };
}

test("signinOutcome turns each answer into next or the message to show", () => {
  assert.deepEqual(signinOutcome(200, { next: "/#/home" }), {
    ok: true,
    next: "/#/home",
  });
  const invalid = signinOutcome(401, {
    errors: [{ message: "x", extensions: { code: "SITE_PASSWORD_INVALID" } }],
  });
  assert.match(invalid.message, /isn’t right/);
  const limited = { errors: [{ extensions: { code: "RATE_LIMITED" } }] };
  assert.equal(
    signinOutcome(429, limited, "900").message,
    "Too many attempts. Try again in 15 minutes.",
  );
  assert.match(signinOutcome(429, limited, "30").message, /in 1 minute\.$/);
  assert.match(signinOutcome(429, undefined, null).message, /15 minutes/);
  const refused = { errors: [{ message: "Cross-origin request refused" }] };
  assert.equal(
    signinOutcome(403, refused).message,
    "Cross-origin request refused",
  );
  assert.equal(
    signinOutcome(502, undefined).message,
    "Couldn’t sign in (HTTP 502). Try again.",
  );
  assert.equal(signinOutcome(200, {}).ok, false, "200 without next");
});

test("requestedNext is the ?next= path plus the hash the redirect kept", () => {
  const next = (search, hash) => requestedNext({ search, hash });
  assert.equal(next("?next=%2F", "#/boards/4"), "/#/boards/4");
  assert.equal(next("", "#/my-work"), "/#/my-work");
  assert.equal(next("?next=%2Fv2%2Fget_schema", ""), "/v2/get_schema");
});

test("signin.html cannot send the password itself before signin.js runs", () => {
  const html = readFileSync(
    new URL("../web/signin.html", import.meta.url),
    "utf8",
  );
  const [form] = html.match(/<form\b[^>]*>[^]*<\/form>/);
  const [open] = form.match(/^<form\b[^>]*>/);
  // A native submission POSTs to /signin (never a GET with the password
  // in the URL) and carries no field: nothing in the form has a name.
  assert.match(open, /\smethod="post"/);
  assert.match(open, /\saction="\/signin"/);
  assert.doesNotMatch(form, /<(?:input|button|select|textarea)\b[^>]*\sname=/);
  assert.match(form, /<input\b[^>]*\sid="signin-password"/);
  // The default button is disabled, so Enter submits nothing until wired.
  const [button] = form.match(/<button\b[^>]*\sid="signin-submit"[^>]*>/);
  assert.match(button, /\sdisabled[\s>]/);
});

function signinPage(t) {
  const document = installFakeDom(t);
  const make = (tag) => document.createElement(tag);
  const elements = {
    form: make("form"),
    input: make("input"),
    error: make("p"),
    button: make("button"),
  };
  elements.error.hidden = true;
  elements.button.disabled = true; // as signin.html ships it
  elements.input.select = () => (elements.selected = true);
  document.body.append(elements.form, elements.input, elements.error);
  return elements;
}

test("the sign-in form posts the password with next and follows the answer", async (t) => {
  const elements = signinPage(t);
  const { form, input, error, button } = elements;
  const location = fakeLocation({ search: "?next=%2F", hash: "#/my-work" });
  const calls = [];
  const answers = [
    jsonResponse(401, {
      errors: [{ extensions: { code: "SITE_PASSWORD_INVALID" } }],
    }),
    jsonResponse(200, { next: "/#/my-work" }),
  ];
  const fetch = async (url, init) => {
    calls.push({ url, init, busy: button.disabled });
    return answers.shift();
  };
  wireSignin(elements, { fetch, location });
  assert.equal(button.disabled, false, "wiring enables the button");
  // Empty: a message, no request.
  const empty = fire(form, "submit");
  assert.equal(empty.defaultPrevented, true);
  await Promise.resolve();
  assert.equal(calls.length, 0);
  assert.equal(error.textContent, "Enter the site password.");
  assert.equal(error.hidden, false);
  // Typing hides the message again.
  fire(input, "input");
  assert.equal(error.hidden, true);
  assert.equal(input.getAttribute("aria-invalid"), null);
  input.value = "wrong password";
  fire(form, "submit");
  fire(form, "submit"); // a second submit while busy sends nothing
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/signin");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].busy, true, "busy while the request runs");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    password: "wrong password",
    next: "/#/my-work",
  });
  assert.match(error.textContent, /isn’t right/);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(globalThis.document.activeElement, input);
  assert.equal(elements.selected, true);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Sign in");
  input.value = "the right password";
  fire(form, "submit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(location.visits, [["replace", "/#/my-work"]]);
});

test("the sign-in form explains a network failure", async (t) => {
  const elements = signinPage(t);
  const fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  wireSignin(elements, { fetch, location: fakeLocation() });
  elements.input.value = "anything at all";
  fire(elements.form, "submit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.error.textContent, /Can’t reach Worklane/);
  assert.equal(elements.button.disabled, false);
});

test("api.js opens the sign-in page when the site gate answers SITE_LOCKED", async (t) => {
  const location = fakeLocation({
    pathname: "/",
    search: "?view=1",
    hash: "#/boards/4",
  });
  stubGlobal(t, "location", location);
  const responses = [];
  stubGlobal(t, "fetch", async () => responses.shift());
  responses.push(jsonResponse(401, LOCKED));
  await assert.rejects(request("{ me { id } }"), (error) => {
    assert.equal(error.code, "SITE_LOCKED");
    return true;
  });
  assert.deepEqual(location.visits, [
    ["assign", "/signin?next=%2F%3Fview%3D1#/boards/4"],
  ]);
  responses.push(jsonResponse(401, LOCKED));
  await assert.rejects(listDemoUsers(), /Sign in/);
  assert.equal(location.visits.length, 2);
  // Other failures stay where they are.
  const expired = {
    errors: [{ message: "x", extensions: { code: "UNAUTHENTICATED" } }],
  };
  responses.push(jsonResponse(401, expired));
  await assert.rejects(graphql("{ me { id } }"), /x/);
  responses.push(jsonResponse(403, { errors: [{ message: "No" }] }));
  await assert.rejects(graphql("{ me { id } }"), /No/);
  assert.equal(location.visits.length, 2);
});

test("logout: a session the gate already ended counts as signed out", async (t) => {
  const location = fakeLocation();
  stubGlobal(t, "location", location);
  const responses = [];
  stubGlobal(t, "fetch", async () => responses.shift());
  responses.push(jsonResponse(401, LOCKED));
  await logout();
  assert.deepEqual(location.visits, [], "the caller decides where to go");
  responses.push(jsonResponse(204, {}));
  await logout();
  responses.push(jsonResponse(403, { errors: [{ message: "Refused" }] }));
  await assert.rejects(logout(), /Refused/);
});
