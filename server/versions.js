/**
 * API version table and `API-Version` header resolution.
 */
import { GraphQLError } from "./graphql/errors.js";
import { describe } from "./input.js";

/** Supported API versions, oldest first. */
export const API_VERSIONS = Object.freeze([
  Object.freeze({ value: "2025-10", kind: "maintenance" }),
  Object.freeze({ value: "2026-01", kind: "current" }),
  Object.freeze({ value: "2026-04", kind: "release_candidate" }),
]);

/** Version used when a request has no `API-Version` header. */
export const CURRENT_API_VERSION = "2026-01";

const describeHeader = (value) =>
  typeof value === "string" ? describe(value) : "(not a single string)";

/**
 * Resolves an `API-Version` header value. Missing or blank values select the
 * current version; other values are trimmed and must match exactly.
 * @returns {{ ok: true, value: string, kind: string }
 *   | { ok: false, error: GraphQLError }}
 */
export function resolveApiVersion(headerValue) {
  const wanted =
    headerValue === undefined || headerValue === null
      ? ""
      : typeof headerValue === "string"
        ? headerValue.trim()
        : null;
  const value = wanted === "" ? CURRENT_API_VERSION : wanted;
  const match = API_VERSIONS.find((version) => version.value === value);
  if (match) return { ok: true, value: match.value, kind: match.kind };
  const supported = API_VERSIONS.map((version) => version.value).join(", ");
  return {
    ok: false,
    error: new GraphQLError(
      `Unsupported API version ${describeHeader(headerValue)}. Supported versions: ${supported}`,
      { code: "UNSUPPORTED_API_VERSION" },
    ),
  };
}
