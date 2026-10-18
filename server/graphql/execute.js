/**
 * GraphQL executor: operation selection, whole-operation validation before
 * any resolver runs, variable/argument coercion, then serial execution with
 * null propagation, resolver error masking and depth/field budgets.
 */
import { ComplexityError, GraphQLError, locatedError } from "./errors.js";
import {
  DIRECTIVE_ARGS,
  DIRECTIVE_NAMES,
  checkVariableDefinitions,
  coerceArgumentValues,
  coerceDirectiveConditions,
  coerceVariableValues,
  isFieldVisible,
  isInputTypeName,
  namedTypeName,
  serializeLeaf,
  typeToString,
} from "./schema.js";

const INVALID = "GRAPHQL_VALIDATION_FAILED";
const MAX_VALIDATION_ERRORS = 100;
const NONE = new Map();
const SITES = new Set(["Field", "FragmentSpread", "InlineFragment"]);
// Result of a position that is null because an error was already recorded.
// The nearest nullable position turns it into null; a non-null position
// passes it to its parent, and at the root it makes `data` null.
const BUBBLE = Symbol("null propagation");
const isOperation = (node) => node.kind === "OperationDefinition";

// Fragment expansion may collect this many field nodes per allowed resolved
// field (validation and execution combined) before a query is too complex.
const EXPANSION_FACTOR = 10;

const locate = (nodes) => [nodes].flat().map((node) => ({ ...node.loc }));
const withoutLoc = (key, value) => (key === "loc" ? undefined : value);
const byName = (a, b) => (a.name < b.name ? -1 : 1);
const argumentsKey = ({ arguments: args }) =>
  args.length === 0 ? "" : JSON.stringify(args.toSorted(byName), withoutLoc);

function report(ctx, nodes, message, code = INVALID) {
  ctx.truncated ||= ctx.errors.length >= MAX_VALIDATION_ERRORS;
  if (ctx.truncated) return;
  const locations = locate(nodes);
  ctx.errors.push(new GraphQLError(message, { code, locations }));
}

/**
 * Yields the Field nodes of `selectionSets` in document order, expanding
 * fragments whose type condition is absent or equals `typeName`. Each named
 * fragment expands at most once (as GraphQL's CollectFields does), an
 * explicit stack keeps long fragment chains off the call stack, and every
 * yielded node spends `budget.left` so repeated expansion stays bounded.
 */
function* fieldsOf(selectionSets, { fragments, budget, typeName, include }) {
  const visited = new Set();
  const stack = selectionSets.map((set) => set.selections.values()).reverse();
  while (stack.length > 0) {
    const next = stack.at(-1).next();
    if (next.done) stack.pop();
    if (next.done || (include && !include(next.value))) continue;
    const selection = next.value;
    if (selection.kind === "Field") {
      budget.left -= 1;
      if (budget.left < 0) throw expansionError(selection);
      yield selection;
    }
    let target = selection.kind === "InlineFragment" ? selection : null;
    if (selection.kind === "FragmentSpread" && !visited.has(selection.name)) {
      visited.add(selection.name);
      target = fragments.get(selection.name);
    }
    if (target && (target.typeCondition ?? typeName) === typeName) {
      stack.push(target.selectionSet.selections.values());
    }
  }
}

function expansionError(node) {
  const message = "Query is too complex: fragments expand to too many fields.";
  return new ComplexityError(message, { locations: locate(node) });
}

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

function checkDefinitions(ctx, document) {
  const operations = new Map();
  for (const definition of document.definitions) {
    const { kind, name } = definition;
    const named = kind === "FragmentDefinition" ? ctx.fragments : operations;
    const label = named === operations ? "operation" : "fragment";
    const message = `There can be only one ${label} named "${name}".`;
    if (name !== null && named.has(name)) report(ctx, definition, message);
    else if (name !== null) named.set(name, definition);
  }
}

function checkVariableUsages(ctx, value) {
  if (value.kind === "Variable" && !ctx.variables.has(value.name)) {
    report(ctx, value, `Variable "$${value.name}" is not defined.`);
  }
  const nested = value.values ?? value.fields?.map((field) => field.value);
  for (const item of nested ?? []) checkVariableUsages(ctx, item);
}

function checkArguments(ctx, definitions, node, owner) {
  const seen = new Set();
  for (const argument of node.arguments) {
    const { name } = argument;
    if (seen.has(name)) {
      report(ctx, argument, `There can be only one argument named "${name}".`);
    } else if (!definitions.has(name)) {
      report(ctx, argument, `Unknown argument "${name}" on ${owner}.`);
    }
    seen.add(name);
    checkVariableUsages(ctx, argument.value);
  }
  for (const { name, type, hasDefault } of definitions.values()) {
    if (type.kind === "NonNullType" && !hasDefault && !seen.has(name)) {
      const message = `Argument "${name}" of type "${typeToString(type)}" is required on ${owner}, but it was not provided.`;
      report(ctx, node, message);
    }
  }
}

function checkDirectives(ctx, node) {
  const seen = new Set();
  for (const directive of node.directives) {
    const label = `"@${directive.name}"`;
    let problem = null;
    if (!DIRECTIVE_NAMES.includes(directive.name)) {
      problem = `Unknown directive ${label}.`;
    } else if (!SITES.has(node.kind)) {
      const site = node.typeCondition ? "fragments" : "operations";
      problem = `Directive ${label} may not be used on ${site}.`;
    } else if (seen.has(directive.name)) {
      problem = `The directive ${label} can only be used once at this location.`;
    }
    seen.add(directive.name);
    if (problem) {
      report(ctx, directive, problem);
      continue;
    }
    checkArguments(ctx, DIRECTIVE_ARGS, directive, `directive ${label}`);
    ctx.directives.push(directive);
  }
}

function conditionType(ctx, node) {
  const name = node.typeCondition;
  const type = ctx.schema.types.get(name);
  if (type) return type;
  const message = isInputTypeName(ctx.schema, name)
    ? `Fragment cannot condition on non composite type "${name}".`
    : `Unknown type "${name}".`;
  report(ctx, node, message);
  return null;
}

function checkField(ctx, parentType, node) {
  const owner = `field "${parentType.name}.${node.name}"`;
  const isTypename = node.name === "__typename";
  const field = isTypename ? null : parentType.fields.get(node.name);
  if (!isTypename && !(field && isFieldVisible(field, ctx.apiVersion))) {
    const message = `Cannot query field "${node.name}" on type "${parentType.name}".`;
    report(ctx, node, message);
    return;
  }
  checkArguments(ctx, field?.args ?? NONE, node, owner);
  const label = field ? typeToString(field.type) : "String!";
  const type = field && ctx.schema.types.get(namedTypeName(field.type));
  if (!type && node.selectionSet) {
    const message = `Field "${node.name}" must not have a selection since type "${label}" has no subfields.`;
    report(ctx, node, message);
  } else if (type && !node.selectionSet) {
    const message = `Field "${node.name}" of type "${label}" must have a selection of subfields.`;
    report(ctx, node, message);
  } else if (type) {
    checkSelectionSet(ctx, type, node.selectionSet, true);
  }
}

/** Fields sharing a response key must be the same field with the same args. */
function checkFieldConflicts(ctx, type, selectionSet) {
  const seen = new Map();
  const options = { ...ctx.walk, typeName: type.name };
  for (const field of fieldsOf([selectionSet], options)) {
    const key = field.alias ?? field.name;
    const first = seen.get(key) ?? field;
    seen.set(key, first);
    let reason = null;
    if (first.name !== field.name) {
      reason = `"${first.name}" and "${field.name}" are different fields`;
    } else if (argumentsKey(first) !== argumentsKey(field)) {
      reason = "they have differing arguments";
    }
    if (reason === null) continue;
    const pair = JSON.stringify([first.loc, field.loc]);
    if (ctx.conflicts.has(pair)) continue;
    ctx.conflicts.add(pair);
    const message = `Fields "${key}" conflict because ${reason}. Use different aliases on the fields to fetch both if this was intentional.`;
    report(ctx, [first, field], message);
  }
}

/**
 * Validates a selection set. Field conflicts are checked where fields merge:
 * at field and root selection sets, which expand the fragments they spread,
 * so fragment bodies are not re-expanded on their own.
 */
function checkSelectionSet(ctx, type, selectionSet, mergesFields = false) {
  for (const selection of selectionSet.selections) {
    const { kind, name, typeCondition } = selection;
    checkDirectives(ctx, selection);
    if (kind === "Field") {
      checkField(ctx, type, selection);
    } else if (kind === "InlineFragment") {
      const target = typeCondition ? conditionType(ctx, selection) : type;
      if (target) checkSelectionSet(ctx, target, selection.selectionSet);
    } else if (!ctx.fragments.has(name)) {
      report(ctx, selection, `Unknown fragment "${name}".`);
    } else if (!ctx.queued.has(name)) {
      ctx.queued.add(name);
      ctx.queue.push(ctx.fragments.get(name));
    }
  }
  if (mergesFields) checkFieldConflicts(ctx, type, selectionSet);
}

/** Field depth of a definition, excluding fragment spreads it contains. */
function summarize(selectionSet) {
  const summary = { depth: 0, node: null, spreads: [] };
  const walk = (set, offset) => {
    for (const selection of set.selections) {
      const { kind, name } = selection;
      const depth = offset + (kind === "Field" ? 1 : 0);
      if (kind === "FragmentSpread") {
        summary.spreads.push({ name, offset, node: selection });
      } else if (kind === "Field" && depth > summary.depth) {
        Object.assign(summary, { depth, node: selection });
      }
      if (selection.selectionSet) walk(selection.selectionSet, depth);
    }
  };
  walk(selectionSet, 0);
  return summary;
}

function combineDepth(summary, totals) {
  let best = { depth: summary.depth, node: summary.node };
  for (const { name, offset } of summary.spreads) {
    const total = totals.get(name);
    if (total && offset + total.depth > best.depth) {
      best = { depth: offset + total.depth, node: total.node };
    }
  }
  return best;
}

/** Names the fragments on a cycle; `path` is the DFS path in order. */
function cycleMessage(path, name) {
  const via = path.slice(path.indexOf(name) + 1);
  const listed = via.slice(0, 5).map((entry) => `"${entry}"`);
  if (via.length > 5) listed.push("...");
  const suffix = listed.length > 0 ? ` via ${listed.join(", ")}` : "";
  return `Cannot spread fragment "${name}" within itself${suffix}.`;
}

/**
 * Detects fragment cycles and computes each fragment's expanded field depth
 * with an iterative post-order walk. Returns null when a cycle exists.
 */
function fragmentDepths(ctx, summaries) {
  const totals = new Map();
  const active = [];
  const onPath = new Set();
  let cyclic = false;
  for (const root of summaries.keys()) {
    if (totals.has(root)) continue;
    active.push({ name: root, index: 0 });
    onPath.add(root);
    while (active.length > 0) {
      const frame = active.at(-1);
      const summary = summaries.get(frame.name);
      const spread = summary.spreads[frame.index];
      frame.index += 1;
      if (!spread) {
        active.pop();
        onPath.delete(frame.name);
        totals.set(frame.name, combineDepth(summary, totals));
        continue;
      }
      if (onPath.has(spread.name)) {
        cyclic = true;
        report(ctx, spread.node, cycleMessage([...onPath], spread.name));
      } else if (summaries.has(spread.name) && !totals.has(spread.name)) {
        active.push({ name: spread.name, index: 0 });
        onPath.add(spread.name);
      }
    }
  }
  return cyclic ? null : totals;
}

function checkDepth(ctx, operation, maxDepth) {
  const summaries = new Map();
  for (const f of ctx.queue) summaries.set(f.name, summarize(f.selectionSet));
  const totals = fragmentDepths(ctx, summaries);
  if (totals === null) return;
  const deepest = combineDepth(summarize(operation.selectionSet), totals);
  if (deepest.depth > maxDepth) {
    const message = `Query depth ${deepest.depth} exceeds the maximum depth of ${maxDepth}.`;
    report(ctx, deepest.node, message, "MAX_DEPTH_EXCEEDED");
  }
}

/** Checks the operation and each fragment it reaches, once per fragment. */
function checkReachable(ctx, root, operation) {
  checkSelectionSet(ctx, root, operation.selectionSet, true);
  for (let index = 0; index < ctx.queue.length; index += 1) {
    const fragment = ctx.queue[index];
    checkDirectives(ctx, fragment);
    const type = conditionType(ctx, fragment);
    if (type) checkSelectionSet(ctx, type, fragment.selectionSet);
  }
}

/** Runs every validation rule over `operation` and the fragments it uses. */
function validate(schema, document, operation, options) {
  const { apiVersion, maxDepth, maxFields } = options;
  const fragments = new Map();
  const walk = { fragments, budget: { left: maxFields * EXPANSION_FACTOR } };
  const ctx = { schema, apiVersion, errors: [], truncated: false, walk };
  Object.assign(ctx, { fragments, variables: new Set(), conflicts: new Set() });
  Object.assign(ctx, { directives: [], queued: new Set(), queue: [] });
  checkDefinitions(ctx, document);
  const definitions = operation.variableDefinitions;
  for (const problem of checkVariableDefinitions(schema, definitions)) {
    report(ctx, problem.node, problem.message);
  }
  for (const { name } of definitions) ctx.variables.add(name);
  checkDirectives(ctx, operation);
  const isMutation = operation.operation === "mutation";
  const rootName = isMutation ? schema.mutation : schema.query;
  if (rootName === null) {
    report(ctx, operation, "Schema does not support mutations.");
    return ctx;
  }
  try {
    checkReachable(ctx, schema.types.get(rootName), operation);
  } catch (error) {
    if (!(error instanceof ComplexityError)) throw error;
    ctx.errors.push(error);
    return ctx;
  }
  checkDepth(ctx, operation, maxDepth);
  if (ctx.truncated) {
    const message = "Too many validation errors; validation aborted.";
    ctx.errors.push(new GraphQLError(message, { code: INVALID }));
  }
  return ctx;
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

async function executeField(state, { type, parent, nodes, path }) {
  const [node] = nodes;
  state.fieldCount += 1;
  if (state.fieldCount > state.maxFields) {
    const message = `Query exceeded the budget of ${state.maxFields} resolved fields.`;
    throw new ComplexityError(message, { locations: locate(node), path });
  }
  if (node.name === "__typename") return type.name;
  const field = type.fields.get(node.name);
  const { schema, variables } = state;
  const args = coerceArgumentValues(schema, field.args, node, variables);
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
  state.errors = [];
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
