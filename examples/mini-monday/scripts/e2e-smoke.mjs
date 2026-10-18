#!/usr/bin/env node
/**
 * Browser smoke test: starts the host and apps servers over an in-memory
 * store, drives the boards app and the Status summary app in headless
 * Chromium (steps in `e2e-steps.mjs`), checks each change through the public
 * GraphQL API, and fails on console errors, page errors, CSP violations,
 * failed or rejected requests and server-logged errors. Screenshots go to
 * `e2e-output/`.
 *
 * Usage: `node scripts/e2e-smoke.mjs` (or `npm run e2e`). The harness,
 * environment variables and skip rules are described in `e2e-lib.mjs`.
 */
import { runE2E } from "./e2e-lib.mjs";
import { STEPS } from "./e2e-steps.mjs";

runE2E({
  name: "e2e smoke",
  steps: STEPS,
  async setup(run) {
    // One anonymous browser: `GET /` signs it in as user 1 (demo mode).
    const context = await run.newContext({ label: "smoke" });
    run.page = await context.newPage();
  },
});
