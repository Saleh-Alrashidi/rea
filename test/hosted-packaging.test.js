/**
 * What README.md tells operators to run and what the Dockerfile builds
 * (SPEC-3 §6): the documented local hosted-mode command listens on
 * loopback and ignores `X-Forwarded-For` (no proxy sets it there), and the
 * image has the `/data` mount point README.md names, owned by the user
 * the app runs as (a new Docker volume takes that owner).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readConfig } from "../server/main.js";

const read = (name) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/** The `NAME=value` settings of the first `sh` block after `marker`. */
function commandEnv(markdown, marker) {
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, marker);
  const [, block] = /```sh\n([^]*?)```/.exec(markdown.slice(start));
  const env = {};
  const settings = /\b([A-Z][A-Z\d_]*)=(?:'([^']*)'|(\S+))/g;
  for (const [, name, quoted, plain] of block.matchAll(settings)) {
    env[name] = quoted ?? plain;
  }
  return env;
}

test("README's local hosted-mode command stays on loopback and ignores X-Forwarded-For", () => {
  const env = commandEnv(read("README.md"), "**Try hosted mode locally**");
  const config = readConfig(env);
  assert.equal(config.mode, "hosted");
  assert.equal(config.bind, "127.0.0.1");
  assert.equal(config.trustProxy, false);
  assert.ok(config.sitePassword, "the gate is on");
});

test("the Dockerfile makes /data, README's volume mount point, the app user's", () => {
  const lines = read("Dockerfile").split("\n");
  const user = lines.indexOf("USER node");
  assert.notEqual(user, -1);
  const asRoot = lines.slice(0, user).filter((line) => line.startsWith("RUN "));
  assert.match(asRoot.join("\n"), /mkdir -p \/data && chown node:node \/data/);
  const readme = read("README.md");
  assert.match(readme, /mount a volume at `\/data`/);
  assert.match(readme, /`MM_DATA_FILE=\/data\/worklane\.json`/);
});
