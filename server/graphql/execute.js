/**
 * GraphQL executor: operation selection, whole-operation validation before
 * any resolver runs (`validate.js`), variable/argument coercion (once per
 * field node), then serial execution with null propagation, resolver
 * error masking and depth/field budgets.
 */
import { ComplexityError, GraphQLError, locatedError } from "./errors.js";
import {
  coerceArgumentValues,
  coerceDirectiveConditions,
  coerceVariableValues,
  serializeLeaf,
} from "./schema.js";
import { fieldsOf, locate, validate } from "./validate.js";

const INVALID = "GRAPHQL_VALIDATION_FAILED";

// Result of a position that is null because an error was already recorded.
// The nearest nullable position turns it into null; a non-null position
// passes it to its parent, and at the root it makes `data` null.
const BUBBLE = Symbol("null propagation");
const isOperation = (node) => node.kind === "OperationDefinition";

function selectOperation(document, operationName) {
  const operations = document.definitions.filter(isOperation);
  let message =
    "Must provide operation name if query contains multiple operations.";
  if (operationName !== null && operationName !== undefined) {
    const operation = operations.find((op) => op.name === operationName);
    if (operation) return { operation };
    message = `Unknown operation named "${String(operationName)}".`;
  } else if (operations.length === 1) {
    return { operation: operations[0] };
  } else if (operations.length === 0) {
    message = "Must provide an operation.";
  }
  return { error: new GraphQLError(message, { code: INVALID }) };
}

const isIncluded = (values, { directives }) =>
  directives.every((node) => values.get(node) === (node.name === "include"));

function collectFields(state, type, selectionSets) {
  const fields = new Map();
  const include = (selection) => isIncluded(state.directiveValues, selection);
  const options = { ...state.walk, typeName: type.name, include };
  for (const field of fieldsOf(selectionSets, options)) {
    const key = field.alias ?? field.name;
    if (fields.has(key)) fields.get(key).push(field);
    else fields.set(key, [field]);
  }
  return fields;
}

const atPosition = (type, value) =>
  value === BUBBLE && type.kind !== "NonNullType" ? null : value;

function recordError(state, message, { node, path, code }) {
  const locations = locate(node);
  state.errors.push(new GraphQLError(message, { code, locations, path }));
  return BUBBLE;
}

async function executeSelectionSet(state, { type, parent, sets, path }) {
  const entries = [];
  for (const [key, nodes] of collectFields(state, type, sets)) {
    const request = { type, parent, nodes, path: [...path, key] };
    const value = await executeField(state, request);
    if (value === BUBBLE) return BUBBLE;
    entries.push([key, value]);
  }
  // fromEntries keeps an alias such as "__proto__" an ordinary own key.
  return Object.fromEntries(entries);
}

async function completeList(state, request) {
  const { type, value, path } = request;
  if (typeof value === "string" || !value?.[Symbol.iterator]) {
    return recordError(state, `Expected a list for ${request.label}.`, request);
  }
  const items = [];
  for (const item of value) {
    const itemRequest = { ...request, type: type.ofType, value: item };
    itemRequest.path = [...path, items.length];
    const completed = await completeValue(state, itemRequest);
    const positioned = atPosition(type.ofType, completed);
    if (positioned === BUBBLE) return BUBBLE;
    items.push(positioned);
  }
  return items;
}

async function completeValue(state, request) {
  const { type, value, label } = request;
  if (type.kind === "NonNullType") {
    const inner = { ...request, type: type.ofType };
    const completed = await completeValue(state, inner);
    if (completed !== null) return completed;
    const message = `Cannot return null for non-nullable field ${label}.`;
    return recordError(state, message, request);
  }
  if (value === null || value === undefined) return null;
  if (type.kind === "ListType") return completeList(state, request);
  const objectType = state.schema.types.get(type.name);
  if (objectType) {
    const sets = request.nodes.map((node) => node.selectionSet);
    const object = { type: objectType, parent: value, sets };
    return executeSelectionSet(state, { ...object, path: request.path });
  }
  const leaf = serializeLeaf(state.schema, type.name, value);
  if (leaf.ok) return leaf.value;
  const message = `${type.name} cannot represent the value resolved for ${label}.`;
  return recordError(state, message, request);
}

async function resolveField(state, { field, parent, args, node, path }) {
  const { apiVersion, context } = state;
  const info = { fieldName: node.name, path: [...path], apiVersion };
  const { resolve } = field;
  const pending = resolve
    ? resolve(parent, args, context, info)
    : parent?.[node.name];
  const value = await pending;
  if (value instanceof Error) throw value;
  return value;
}

const freeze = (value) => {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

/**
 * The coerced arguments of a field node, once per operation: a fragment
 * puts one node under many parents, and coercing its literals each time
 * would cost far more than the document's size. Frozen, as they are shared.
 */
function coercedArguments(state, field, node) {
  let args = state.coerced.get(node);
  if (args === undefined) {
    const { schema, variables } = state;
    args = coerceArgumentValues(schema, field.args, node, variables);
    if (args.ok) freeze(args.value);
    state.coerced.set(node, args);
  }
  return args;
}

async function executeField(state, { type, parent, nodes, path }) {
  const [node] = nodes;
  state.fieldCount += 1;
  if (state.fieldCount > state.maxFields) {
    const message = `Query exceeded the budget of ${state.maxFields} resolved fields.`;
    throw new ComplexityError(message, { locations: locate(node), path });
  }
  if (node.name === "__typename") return type.name;
  const field = type.fields.get(node.name);
  const args = coercedArguments(state, field, node);
  if (!args.ok) {
    recordError(state, args.message, { node, path, code: "BAD_USER_INPUT" });
    return atPosition(field.type, BUBBLE);
  }
  let value;
  try {
    const request = { field, parent, args: args.value, node, path };
    value = await resolveField(state, request);
  } catch (error) {
    const log = state.context?.log;
    state.errors.push(
      locatedError(error, { locations: locate(node), path, log }),
    );
    return atPosition(field.type, BUBBLE);
  }
  const label = `${type.name}.${node.name}`;
  const request = { type: field.type, nodes, node, value, path, label };
  return atPosition(field.type, await completeValue(state, request));
}

/** Validates, then coerces variables and directives; returns errors or state. */
function prepare(schema, document, operation, options) {
  const validation = validate(schema, document, operation, options);
  if (validation.errors.length > 0) return { errors: validation.errors };
  const defs = operation.variableDefinitions;
  const variables = coerceVariableValues(schema, defs, options.variables);
  if (variables.errors.length > 0) return { errors: variables.errors };
  const { values } = variables;
  const { directives: nodes } = validation;
  const directives = coerceDirectiveConditions(schema, nodes, values);
  if (directives.errors.length > 0) return { errors: directives.errors };
  const state = { schema, walk: validation.walk, variables: values };
  return { ...state, directiveValues: directives.values };
}

/**
 * Validates and executes a parsed document against a built schema.
 * Validation and variable failures return `{ errors }` without `data`.
 * @returns {Promise<{ data?: object | null, errors?: GraphQLError[] }>}
 */
export async function execute({
  schema,
  document,
  variables = {},
  operationName = null,
  context = {},
  apiVersion,
  maxDepth = 12,
  maxFields = 5000,
}) {
  if (schema?.kind !== "Schema" || document?.kind !== "Document") {
    throw new TypeError("execute() needs a schema and a document.");
  }
  const selected = selectOperation(document, operationName);
  if (selected.error) return { errors: [selected.error] };
  const { operation } = selected;
  const options = {
    variables: variables ?? {},
    apiVersion,
    maxDepth,
    maxFields,
  };
  const prepared = prepare(schema, document, operation, options);
  if (prepared.errors) return { errors: prepared.errors };
  const state = { ...prepared, context, apiVersion, maxFields, fieldCount: 0 };
  Object.assign(state, { errors: [], coerced: new Map() });
  const isMutation = operation.operation === "mutation";
  const type = schema.types.get(isMutation ? schema.mutation : schema.query);
  const root = { type, parent: null, sets: [operation.selectionSet], path: [] };
  try {
    const data = await executeSelectionSet(state, root);
    const result = { data: data === BUBBLE ? null : data };
    if (state.errors.length > 0) result.errors = state.errors;
    return result;
  } catch (error) {
    if (!(error instanceof ComplexityError)) throw error;
    return { data: null, errors: [error] };
  }
}
