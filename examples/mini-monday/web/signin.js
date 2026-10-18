/**
 * Sign-in page of a private Worklane site (SPEC-3 §2, loaded by
 * `signin.html`): posts the site password with `next`, the page the site
 * gate sent the browser here from, and goes there once the server accepts
 * it. `next` is the `?next=` path plus this page's hash: browsers keep a
 * URL's fragment through a redirect, so `/#/boards/4` arrives here as
 * `/signin?next=%2F#/boards/4`. The server checks `next` and answers the
 * path to open; this page only follows it.
 *
 * The site gate lets only this script and the stylesheets the page links
 * through before sign-in, so it imports nothing. Messages are set with
 * `textContent`; the theme follows the system (`styles/tokens.css`).
 */

const SIGNIN_PATH = "/signin";
const MESSAGES = Object.freeze({
  empty: "Enter the site password.",
  invalid: "That password isn’t right. Check it and try again.",
  unavailable: "Can’t reach Worklane. Check your connection and try again.",
});

/** The `next` this page sends (see the module comment). */
export function requestedNext({ search, hash }) {
  const next = new URLSearchParams(search).get("next") ?? "/";
  return `${next}${hash}`;
}

function minutes(retryAfter) {
  const seconds = Number.parseInt(String(retryAfter ?? ""), 10);
  return Number.isSafeInteger(seconds) && seconds > 0
    ? Math.ceil(seconds / 60)
    : 15;
}

/**
 * What a `POST /signin` answer means: `{ ok: true, next }`, or
 * `{ ok: false, message }` with the message to show.
 * @param {number} status
 * @param {unknown} body parsed JSON (undefined when not JSON)
 * @param {string | null} retryAfter the `Retry-After` header
 */
export function signinOutcome(status, body, retryAfter = null) {
  if (status === 200 && typeof body?.next === "string") {
    return { ok: true, next: body.next };
  }
  const error = Array.isArray(body?.errors) ? body.errors[0] : null;
  const code = error?.extensions?.code;
  if (code === "SITE_PASSWORD_INVALID") {
    return { ok: false, message: MESSAGES.invalid };
  }
  if (status === 429) {
    const wait = minutes(retryAfter);
    const unit = wait === 1 ? "minute" : "minutes";
    const message = `Too many attempts. Try again in ${wait} ${unit}.`;
    return { ok: false, message };
  }
  const text = typeof error?.message === "string" ? error.message : "";
  if (status >= 400 && status < 500 && text !== "") {
    return { ok: false, message: text };
  }
  return {
    ok: false,
    message: `Couldn’t sign in (HTTP ${status}). Try again.`,
  };
}

async function readJson(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

async function postPassword(fetchImpl, body) {
  const response = await fetchImpl(SIGNIN_PATH, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const retryAfter = response.headers?.get?.("Retry-After") ?? null;
  return signinOutcome(response.status, await readJson(response), retryAfter);
}

/**
 * Wires the sign-in form. `elements` holds the form, the password input,
 * the error line and the submit button; `env` the `fetch` and `location`
 * to use. The page ships the button disabled, so the browser cannot
 * submit the form itself before this runs; wiring enables it. Returns the
 * submit handler (for tests).
 */
export function wireSignin(elements, { fetch: fetchImpl, location }) {
  const { form, input, error, button } = elements;
  let busy = false;
  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    input.select?.();
  };
  const setBusy = (on) => {
    busy = on;
    button.disabled = on;
    button.setAttribute("aria-busy", String(on));
    button.textContent = on ? "Signing in…" : "Sign in";
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (input.value === "") return showError(MESSAGES.empty);
    setBusy(true);
    let outcome;
    try {
      const next = requestedNext(location);
      outcome = await postPassword(fetchImpl, { password: input.value, next });
    } catch {
      outcome = { ok: false, message: MESSAGES.unavailable };
    }
    if (outcome.ok) return location.replace(outcome.next);
    setBusy(false);
    showError(outcome.message);
  };
  form.addEventListener("submit", submit);
  input.addEventListener("input", () => {
    if (error.hidden) return;
    error.hidden = true;
    input.removeAttribute("aria-invalid");
  });
  button.disabled = false;
  return submit;
}

function start(doc) {
  const elements = {
    form: doc.getElementById("signin-form"),
    input: doc.getElementById("signin-password"),
    error: doc.getElementById("signin-error"),
    button: doc.getElementById("signin-submit"),
  };
  const env = { fetch: (...args) => globalThis.fetch(...args) };
  wireSignin(elements, { ...env, location: globalThis.location });
}

if (typeof globalThis.document?.getElementById === "function") {
  start(globalThis.document);
}
