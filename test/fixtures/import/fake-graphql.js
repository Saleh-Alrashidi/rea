/**
 * A small GraphQL validator and executor for fake upstream APIs. Queries
 * are parsed with Worklane's parser, then checked against a type table the
 * way graphql-js does: unknown fields, arguments or types, missing required
 * arguments, selections on leaves (or missing on objects), fragments
 * spread on unrelated types, unknown, unused or cyclic fragments,
 * undefined or unused variables, missing or mistyped variable values, and
 * directives other than @include/@skip. Inline fragments and fragment
 * spreads apply by the object's `__typename`, so interface fields such as
 * `... on MirrorValue { display_value }` behave as on the real API.
 *
 * A type table maps type → field → "Type" or "[Type]", followed by the
 * allowed argument names (`name!` = required). Resolvers are keyed
 * "Type.field" and get `(state, parent, args)`; other fields read
 * `parent[field]`.
 */
import { parse } from "../../../server/graphql/parse.js";

/** A query the fake API rejects (`code` goes to `extensions.code`). */
export class FakeError extends Error {
  constructor(message, code = "GRAPHQL_VALIDATION_FAILED") {
    super(message);
    this.code = code;
  }
}

const VARIABLE_CHECKS = {
  Int: Number.isInteger,
  Boolean: (value) => typeof value === "boolean",
  String: (value) => typeof value === "string",
  ID: (value) => typeof value === "string" || Number.isInteger(value),
};

function fieldSpec(types, typeName, name) {
  const raw = types[typeName]?.[name];
  if (typeof raw !== "string") return null;
  const [type, ...args] = raw.split(" ");
  const list = type.startsWith("[");
  return {
    type: list ? type.slice(1, -1) : type,
    list,
    args: new Set(args.map((arg) => arg.replace("!", ""))),
    required: args
      .filter((arg) => arg.endsWith("!"))
      .map((arg) => arg.slice(0, -1)),
  };
}

/** Interfaces: `XValue` types implement `ColumnValue`-style parents. */
const applies = (cond, parent) =>
  cond === parent || (parent.endsWith("Value") && cond.endsWith("Value"));

function useVariables(ctx, value) {
  if (value?.kind === "Variable") ctx.usedVariables.add(value.name);
  for (const item of value?.values ?? []) useVariables(ctx, item);
  for (const field of value?.fields ?? []) useVariables(ctx, field.value);
}

function checkDirectives(ctx, node) {
  for (const directive of node.directives ?? []) {
    if (directive.name !== "include" && directive.name !== "skip") {
      throw new FakeError(`Unknown directive "@${directive.name}".`);
    }
    for (const arg of directive.arguments) useVariables(ctx, arg.value);
  }
}

function checkArguments(ctx, owner, spec, field) {
  for (const arg of field.arguments) {
    if (!spec.args.has(arg.name)) {
      throw new FakeError(
        `Unknown argument "${arg.name}" on field "${owner}".`,
      );
    }
    useVariables(ctx, arg.value);
  }
  const given = new Set(field.arguments.map((arg) => arg.name));
  const missing = spec.required.find((name) => !given.has(name));
  if (missing) {
    throw new FakeError(`Field "${owner}" argument "${missing}" is required.`);
  }
}

function checkField(ctx, typeName, field) {
  if (field.name === "__typename") return;
  const spec = fieldSpec(ctx.types, typeName, field.name);
  if (!spec) {
    const message = `Cannot query field "${field.name}" on type "${typeName}".`;
    throw new FakeError(message);
  }
  checkArguments(ctx, `${typeName}.${field.name}`, spec, field);
  const composite = Object.hasOwn(ctx.types, spec.type);
  if (composite !== Boolean(field.selectionSet)) {
    const rule = composite ? "needs a selection" : "must not have a selection";
    throw new FakeError(`Field "${field.name}" ${rule}.`);
  }
  if (composite) checkSet(ctx, spec.type, field.selectionSet);
}

function checkFragment(ctx, typeName, selection) {
  const spread = selection.kind === "FragmentSpread";
  const fragment = spread ? ctx.fragments.get(selection.name) : selection;
  if (!fragment) throw new FakeError(`Unknown fragment "${selection.name}".`);
  const cond = fragment.typeCondition ?? typeName;
  if (!Object.hasOwn(ctx.types, cond)) {
    throw new FakeError(`Unknown type "${cond}".`);
  }
  if (!applies(cond, typeName)) {
    throw new FakeError(
      `Fragment on "${cond}" cannot be spread on "${typeName}".`,
    );
  }
  if (spread && ctx.visiting.has(selection.name)) {
    throw new FakeError(`Fragment "${selection.name}" spreads itself.`);
  }
  if (spread) ctx.usedFragments.add(selection.name);
  if (spread) ctx.visiting.add(selection.name);
  checkSet(ctx, cond, fragment.selectionSet);
  if (spread) ctx.visiting.delete(selection.name);
}

function checkSet(ctx, typeName, set) {
  for (const selection of set.selections) {
    checkDirectives(ctx, selection);
    if (selection.kind === "Field") checkField(ctx, typeName, selection);
    else checkFragment(ctx, typeName, selection);
  }
}

function evaluate(node, variables) {
  if (node.kind === "Variable") return variables[node.name] ?? null;
  if (node.kind === "NullValue") return null;
  if (node.kind === "ListValue") {
    return node.values.map((value) => evaluate(value, variables));
  }
  if (node.kind === "ObjectValue") {
    const entries = node.fields.map((f) => [
      f.name,
      evaluate(f.value, variables),
    ]);
    return Object.fromEntries(entries);
  }
  return node.value;
}

function coerceVariable(definition, provided) {
  const { name, type } = definition;
  let value = provided?.[name];
  if (value === undefined && definition.defaultValue) {
    value = evaluate(definition.defaultValue, {});
  }
  if (value === undefined || value === null) {
    if (type.kind !== "NonNullType") return undefined;
    const message = `Variable "$${name}" of required type was not provided.`;
    throw new FakeError(message, "BAD_USER_INPUT");
  }
  const named = type.kind === "NonNullType" ? type.ofType : type;
  const check = named.kind === "NamedType" ? VARIABLE_CHECKS[named.name] : null;
  if (check && !check(value)) {
    const message = `Variable "$${name}" got an invalid value.`;
    throw new FakeError(message, "BAD_USER_INPUT");
  }
  return value;
}

function checkUsage(ctx, operation) {
  for (const name of ctx.fragments.keys()) {
    if (!ctx.usedFragments.has(name)) {
      throw new FakeError(`Fragment "${name}" is never used.`);
    }
  }
  const declared = new Set(operation.variableDefinitions.map((d) => d.name));
  for (const name of ctx.usedVariables) {
    if (!declared.has(name)) {
      throw new FakeError(`Variable "$${name}" is not defined.`);
    }
  }
  for (const name of declared) {
    if (!ctx.usedVariables.has(name)) {
      throw new FakeError(`Variable "$${name}" is never used.`);
    }
  }
}

function prepare(schema, { query, variables, operationName }) {
  const document = parse(query, { maxDepth: 20 });
  const isOperation = (d) => d.kind === "OperationDefinition";
  const operations = document.definitions.filter(isOperation);
  const named = operations.find((op) => op.name === operationName);
  const operation = named ?? (operations.length === 1 ? operations[0] : null);
  if (!operation) throw new FakeError("Unknown or ambiguous operation.");
  const fragments = new Map(
    document.definitions
      .filter((d) => d.kind === "FragmentDefinition")
      .map((d) => [d.name, d]),
  );
  const ctx = {
    types: schema.types,
    fragments,
    usedFragments: new Set(),
    usedVariables: new Set(),
    visiting: new Set(),
  };
  checkSet(ctx, "Query", operation.selectionSet);
  checkUsage(ctx, operation);
  const values = {};
  for (const definition of operation.variableDefinitions) {
    const value = coerceVariable(definition, variables);
    if (value !== undefined) values[definition.name] = value;
  }
  return { operation, fragments, variables: values };
}

const included = (run, node) =>
  (node.directives ?? []).every((directive) => {
    const arg = directive.arguments.find((a) => a.name === "if");
    const condition = evaluate(arg.value, run.variables) === true;
    return directive.name === "include" ? condition : !condition;
  });

function execField(run, typeName, object, field) {
  if (field.name === "__typename") return object.__typename ?? typeName;
  const spec = fieldSpec(run.types, typeName, field.name);
  const args = Object.fromEntries(
    field.arguments.map((a) => [a.name, evaluate(a.value, run.variables)]),
  );
  const resolver = run.resolvers[`${typeName}.${field.name}`];
  const value = resolver
    ? resolver(run.state, object, args)
    : object[field.name];
  const composite = Object.hasOwn(run.types, spec.type);
  const complete = (entry) => {
    if (entry === undefined || entry === null) return null;
    return composite
      ? execSet(run, spec.type, entry, field.selectionSet)
      : entry;
  };
  if (value === undefined || value === null) return null;
  return spec.list ? value.map(complete) : complete(value);
}

function execSet(run, typeName, object, set) {
  const out = {};
  for (const selection of set.selections) {
    if (!included(run, selection)) continue;
    if (selection.kind === "Field") {
      const key = selection.alias ?? selection.name;
      out[key] = execField(run, typeName, object, selection);
      continue;
    }
    const fragment =
      selection.kind === "InlineFragment"
        ? selection
        : run.fragments.get(selection.name);
    const cond = fragment.typeCondition;
    if (!cond || cond === typeName || cond === object.__typename) {
      const type = cond ?? typeName;
      Object.assign(out, execSet(run, type, object, fragment.selectionSet));
    }
  }
  return out;
}

/**
 * Validates and runs request `body` ({ query, variables, operationName })
 * against `schema` ({ types, resolvers }) with resolver state `state`.
 * Returns `{ data }`; throws FakeError (or a parse GraphQLError) when the
 * real API would reject the query.
 */
export function executeFake(schema, state, body) {
  const prepared = prepare(schema, body);
  const run = { ...schema, state, ...prepared };
  return { data: execSet(run, "Query", {}, prepared.operation.selectionSet) };
}
