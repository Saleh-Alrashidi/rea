/**
 * Error type shared by the GraphQL parser, schema builder and executor.
 *
 * Every error that reaches a GraphQL response is a GraphQLError so that the
 * response shape (`message`, `locations`, `path`, `extensions.code`) is
 * produced in exactly one place.
 */
export class GraphQLError extends Error {
  /**
   * @param {string} message Human-readable message returned to clients.
   * @param {{ code?: string, locations?: { line: number, column: number }[],
   *   path?: (string | number)[] }} [options]
   */
  constructor(
    message,
    { code = "INTERNAL_SERVER_ERROR", locations, path } = {},
  ) {
    super(message);
    this.name = "GraphQLError";
    this.code = code;
    this.locations = locations;
    this.path = path;
  }

  /**
   * Serializes the error in the GraphQL response format.
   * @returns {{ message: string, locations?: { line: number, column: number }[],
   *   path?: (string | number)[], extensions: { code: string } }}
   */
  toJSON() {
    const json = { message: this.message };
    if (Array.isArray(this.locations) && this.locations.length > 0) {
      json.locations = this.locations.map(({ line, column }) => ({
        line,
        column,
      }));
    }
    if (Array.isArray(this.path)) json.path = [...this.path];
    json.extensions = { code: this.code };
    return json;
  }
}

/**
 * Stops validation or execution once a complexity budget (resolved fields
 * or fragment expansion) is spent. Always uses COMPLEXITY_BUDGET_EXHAUSTED.
 */
export class ComplexityError extends GraphQLError {
  constructor(message, { locations, path } = {}) {
    super(message, { code: "COMPLEXITY_BUDGET_EXHAUSTED", locations, path });
    this.name = "ComplexityError";
  }
}

/**
 * Returns `error` as a GraphQLError at `locations` and `path`. A GraphQLError
 * keeps its message and code; anything else is masked as "Internal server
 * error" and the original is passed to `log.error` when a logger is given.
 */
export function locatedError(error, { locations, path, log } = {}) {
  if (error instanceof GraphQLError) {
    const { message, code } = error;
    return new GraphQLError(message, { code, locations, path });
  }
  log?.error?.(`GraphQL resolver failed at ${path?.join(".")}:`, error);
  return new GraphQLError("Internal server error", { locations, path });
}
