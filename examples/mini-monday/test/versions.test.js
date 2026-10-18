import assert from "node:assert/strict";
import test from "node:test";
import { GraphQLError } from "../server/graphql/errors.js";
import {
  API_VERSIONS,
  CURRENT_API_VERSION,
  resolveApiVersion,
} from "../server/versions.js";

test("the version table matches the spec", () => {
  assert.deepEqual(API_VERSIONS, [
    { value: "2025-10", kind: "maintenance" },
    { value: "2026-01", kind: "current" },
    { value: "2026-04", kind: "release_candidate" },
  ]);
  assert.equal(CURRENT_API_VERSION, "2026-01");
  assert.ok(Object.isFrozen(API_VERSIONS) && Object.isFrozen(API_VERSIONS[0]));
});

test("a missing or blank header selects the current version", () => {
  const current = { ok: true, value: "2026-01", kind: "current" };
  for (const header of [undefined, null, "", "   "]) {
    assert.deepEqual(resolveApiVersion(header), current);
  }
});

test("every listed version resolves, trimmed", () => {
  for (const { value, kind } of API_VERSIONS) {
    assert.deepEqual(resolveApiVersion(value), { ok: true, value, kind });
    assert.deepEqual(resolveApiVersion(` ${value}\t`), {
      ok: true,
      value,
      kind,
    });
  }
});

test("other values fail with UNSUPPORTED_API_VERSION", () => {
  const unsupported = ["2026-02", "2026-1", "2026-01-01", "latest", "2026_01"];
  for (const header of [...unsupported, ["2026-01"], 202601]) {
    const result = resolveApiVersion(header);
    assert.equal(result.ok, false, String(header));
    assert.ok(result.error instanceof GraphQLError);
    assert.equal(result.error.code, "UNSUPPORTED_API_VERSION");
    assert.equal(
      result.error.toJSON().extensions.code,
      "UNSUPPORTED_API_VERSION",
    );
  }
  assert.match(
    resolveApiVersion("2026-02").error.message,
    /"2026-02".*2025-10, 2026-01, 2026-04/,
  );
});

test("long header values are truncated in the error message", () => {
  const result = resolveApiVersion("9".repeat(10_000));
  assert.equal(result.ok, false);
  assert.ok(result.error.message.length < 200);
});
