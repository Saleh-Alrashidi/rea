/**
 * Schema construction and SDL printing, plus the type-system helpers the
 * executor shares: type references, version visibility, input, argument and
 * variable coercion, and leaf serialization. Type references use the
 * parser's TypeRef shape.
 */
import { GraphQLError } from "./errors.js";

const SCALARS = new Set(["ID", "String", "Int", "Float", "Boolean"]);
const NAME = /^[A-Z_a-z][0-9A-Z_a-z]*$/;
const NAME_AT = /[A-Z_a-z][0-9A-Z_a-z]*/y;
const VERSION = /^\d{4}-\d{2}$/;
const MAX_TYPE_NESTING = 8;
// Allowed definition keys, as space-separated names.
const SCHEMA_KEYS = "enums types query mutation";
const TYPE_KEYS = "description fields";
const FIELD_KEYS = "type description args versions deprecationReason resolve";
const ARG_KEYS = "type defaultValue description";
const VERSION_KEYS = "addedIn removedIn";
// Literal kinds each built-in scalar accepts (an Int literal is a valid ID).
const LITERAL_SCALARS = {
  IntValue: ["Int", "Float", "ID"],
  FloatValue: ["Float"],
  StringValue: ["String", "ID"],
  BooleanValue: ["Boolean"],
};
// Values each built-in scalar accepts, both as input and as resolver output.
// Unsafe integers have already lost precision, so they cannot be IDs.
const SCALAR_CHECKS = {
  Int: (value) =>
    Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  Float: (value) => Number.isFinite(value),
  String: (value) => typeof value === "string",
  Boolean: (value) => typeof value === "boolean",
  ID: (value) => typeof value === "string" || Number.isSafeInteger(value),
};

const BAD_INPUT = "BAD_USER_INPUT";
const IF_TYPE = {
  kind: "NonNullType",
  ofType: { kind: "NamedType", name: "Boolean" },
};
/** Names of the built-in directives and the arguments they share. */
export const DIRECTIVE_NAMES = Object.freeze(["include", "skip"]);
export const DIRECTIVE_ARGS = new Map([
  ["if", Object.freeze({ name: "if", type: IF_TYPE, hasDefault: false })],
]);

const ok = (value) => ({ ok: true, value });
const invalid = (message) => ({ ok: false, message });
const badInput = (message, node) =>
  new GraphQLError(message, { code: BAD_INPUT, locations: [{ ...node.loc }] });

function fail(message) {
  throw new Error(`Invalid schema: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkObject(value, allowedKeys, where) {
  if (!isPlainObject(value)) fail(`${where} must be a plain object`);
  const allowed = allowedKeys.split(" ");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where} has unknown key "${key}"`);
  }
}

function checkName(name, where) {
  if (!NAME.test(name) || name.startsWith("__")) {
    fail(`${where} has invalid name ${JSON.stringify(name)}`);
  }
}

function checkStrings(definition, keys, where) {
  for (const key of keys) {
    const value = definition[key];
    if (value !== undefined && typeof value !== "string") {
      fail(`${where} ${key} must be a string`);
    }
  }
}

/** Short, bounded rendering of an input value for error messages. */
function describeValue(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  text ??= String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** Renders a TypeRef as a type expression such as `[ID!]!`. */
export function typeToString(type) {
  if (type.kind === "NonNullType") return `${typeToString(type.ofType)}!`;
  if (type.kind === "ListType") return `[${typeToString(type.ofType)}]`;
  return type.name;
}

/** Returns the innermost named type of a TypeRef. */
export function namedTypeName(type) {
  let current = type;
  while (current.kind !== "NamedType") current = current.ofType;
  return current.name;
}

/** True when `name` is a scalar or enum (the only input types). */
export function isInputTypeName(schema, name) {
  return SCALARS.has(name) || schema.enums.has(name);
}

/** Applies the `versions.addedIn` / `versions.removedIn` window. */
export function isFieldVisible(field, apiVersion) {
  return (
    (!field.addedIn || apiVersion >= field.addedIn) &&
    (!field.removedIn || apiVersion < field.removedIn)
  );
}

function parseTypeExpression(text, where) {
  if (typeof text !== "string") fail(`${where} type must be a string`);
  const malformed = () => fail(`${where} has invalid type "${text}"`);
  let pos = 0;
  const read = (depth) => {
    if (depth > MAX_TYPE_NESTING) malformed();
    let type;
    if (text[pos] === "[") {
      pos += 1;
      type = { kind: "ListType", ofType: read(depth + 1) };
      if (text[pos] !== "]") malformed();
      pos += 1;
    } else {
      NAME_AT.lastIndex = pos;
      const match = NAME_AT.exec(text);
      if (!match) malformed();
      type = { kind: "NamedType", name: match[0] };
      pos = NAME_AT.lastIndex;
    }
    if (text[pos] !== "!") return type;
    pos += 1;
    return { kind: "NonNullType", ofType: type };
  };
  const type = read(0);
  if (pos !== text.length) malformed();
  return type;
}

function requireKnownType(schema, type, { where, input }) {
  const name = namedTypeName(type);
  if (isInputTypeName(schema, name)) return;
  if (!schema.types.has(name)) {
    fail(`${where} references unknown type "${name}"`);
  }
  if (input) fail(`${where} uses object type "${name}" as an input`);
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  return Object.freeze(value);
}

function buildEnums(definitions) {
  if (!isPlainObject(definitions)) fail("enums must be a plain object");
  const enums = new Map();
  for (const [name, values] of Object.entries(definitions)) {
    checkName(name, "enum");
    if (SCALARS.has(name)) fail(`enum "${name}" shadows a built-in scalar`);
    if (!Array.isArray(values) || values.length === 0) {
      fail(`enum ${name} must be a non-empty array of value names`);
    }
    const allowed = new Set();
    for (const value of values) {
      checkName(value, `enum ${name} value`);
      if (["true", "false", "null"].includes(value) || allowed.has(value)) {
        fail(`enum ${name} has invalid or duplicate value "${value}"`);
      }
      allowed.add(value);
    }
    enums.set(name, Object.freeze({ name, values: [...allowed], allowed }));
  }
  return enums;
}

function buildArgs(schema, definitions, fieldWhere) {
  if (!isPlainObject(definitions)) fail(`${fieldWhere} args must be an object`);
  const args = new Map();
  for (const [name, definition] of Object.entries(definitions)) {
    const where = `argument ${fieldWhere}(${name})`;
    checkName(name, where);
    checkObject(definition, ARG_KEYS, where);
    checkStrings(definition, ["description"], where);
    const type = parseTypeExpression(definition.type, where);
    requireKnownType(schema, type, { where, input: true });
    const hasDefault = definition.defaultValue !== undefined;
    let defaultValue;
    if (hasDefault) {
      const coerced = coerceInputValue(schema, definition.defaultValue, type);
      if (!coerced.ok) fail(`${where} default is invalid: ${coerced.message}`);
      defaultValue = deepFreeze(coerced.value);
    }
    const description = definition.description ?? null;
    const arg = { name, description, type, hasDefault, defaultValue };
    args.set(name, Object.freeze(arg));
  }
  return args;
}

function buildVersions(versions, where) {
  checkObject(versions, VERSION_KEYS, `${where} versions`);
  const { addedIn = null, removedIn = null } = versions;
  for (const value of [addedIn, removedIn]) {
    if (value !== null && !(typeof value === "string" && VERSION.test(value))) {
      fail(`${where} versions must be "YYYY-MM" strings`);
    }
  }
  return { addedIn, removedIn };
}

function buildField(schema, { typeName, name, definition }) {
  const where = `field ${typeName}.${name}`;
  checkName(name, where);
  checkObject(definition, FIELD_KEYS, where);
  checkStrings(definition, ["description", "deprecationReason"], where);
  const { resolve = null } = definition;
  if (resolve !== null && typeof resolve !== "function") {
    fail(`${where} resolve must be a function`);
  }
  const type = parseTypeExpression(definition.type, where);
  requireKnownType(schema, type, { where, input: false });
  return Object.freeze({
    name,
    description: definition.description ?? null,
    type,
    args: buildArgs(schema, definition.args ?? {}, where),
    ...buildVersions(definition.versions ?? {}, where),
    deprecationReason: definition.deprecationReason ?? null,
    resolve,
  });
}

/**
 * Validates a schema definition (see SPEC.md) and returns the immutable
 * schema object consumed by `execute` and `printSchema`.
 * @throws {Error} When a name, type expression, default or root is invalid.
 */
export function buildSchema(definition) {
  checkObject(definition, SCHEMA_KEYS, "schema definition");
  const enums = buildEnums(definition.enums ?? {});
  const typeDefinitions = definition.types;
  if (!isPlainObject(typeDefinitions)) fail("types must be a plain object");
  const types = new Map();
  for (const [name, typeDefinition] of Object.entries(typeDefinitions)) {
    checkName(name, "type");
    if (SCALARS.has(name) || enums.has(name))
      fail(`"${name}" is defined twice`);
    checkObject(typeDefinition, TYPE_KEYS, `type ${name}`);
    checkStrings(typeDefinition, ["description"], `type ${name}`);
    types.set(name, { name, description: typeDefinition.description ?? null });
  }
  const query = definition.query ?? "Query";
  const mutation = definition.mutation ?? null;
  const schema = { kind: "Schema", query, mutation, types, enums };
  for (const [typeName, { fields }] of Object.entries(typeDefinitions)) {
    if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
      fail(`type ${typeName} must define at least one field`);
    }
    const built = new Map();
    for (const [name, field] of Object.entries(fields)) {
      const request = { typeName, name, definition: field };
      built.set(name, buildField(schema, request));
    }
    const type = { ...types.get(typeName), fields: built };
    types.set(typeName, Object.freeze(type));
  }
  for (const root of [query, mutation]) {
    if (root !== null && !(typeof root === "string" && types.has(root))) {
      fail(`root type ${JSON.stringify(root)} is not a declared object type`);
    }
  }
  return Object.freeze(schema);
}

/** Coerces `value` to a scalar or enum; IDs become strings. */
function coerceNamed(schema, value, name) {
  if (Object.hasOwn(SCALAR_CHECKS, name)) {
    if (!SCALAR_CHECKS[name](value)) {
      return invalid(`${name} cannot represent value ${describeValue(value)}.`);
    }
    return ok(name === "ID" ? String(value) : value);
  }
  if (schema.enums.get(name)?.allowed.has(value)) return ok(value);
  const message = `Value ${describeValue(value)} does not exist in "${name}" enum.`;
  return invalid(message);
}

/**
 * Coerces a JSON input value (a variable or schema default) to `type`.
 * A single value is wrapped when a list is expected.
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function coerceInputValue(schema, value, type) {
  if (type.kind === "NonNullType") {
    if (value === null || value === undefined) {
      const message = `Expected non-nullable type "${typeToString(type)}" not to be null.`;
      return invalid(message);
    }
    return coerceInputValue(schema, value, type.ofType);
  }
  if (value === null || value === undefined) return ok(null);
  if (type.kind !== "ListType") return coerceNamed(schema, value, type.name);
  if (!Array.isArray(value)) {
    const item = coerceInputValue(schema, value, type.ofType);
    return item.ok ? ok([item.value]) : item;
  }
  const values = [];
  for (const [index, item] of value.entries()) {
    const coerced = coerceInputValue(schema, item, type.ofType);
    if (!coerced.ok) return invalid(`In element #${index}: ${coerced.message}`);
    values.push(coerced.value);
  }
  return ok(values);
}

function describeLiteral(node) {
  if (node.kind === "StringValue") return describeValue(node.value);
  if (node.kind === "ListValue") return "a list";
  if (node.kind === "ObjectValue") return "an object";
  return node.kind === "NullValue" ? "null" : String(node.value);
}

function coerceNamedLiteral(schema, node, name) {
  const enumType = schema.enums.get(name);
  const literal = describeLiteral(node);
  if (enumType) {
    if (node.kind === "EnumValue" && enumType.allowed.has(node.value)) {
      return ok(node.value);
    }
    return invalid(`Enum "${name}" cannot represent value ${literal}.`);
  }
  if (LITERAL_SCALARS[node.kind]?.includes(name)) {
    return coerceNamed(schema, node.value, name);
  }
  return invalid(`${name} cannot represent value ${literal}.`);
}

function coerceListLiteral(schema, node, type, variables) {
  if (node.kind !== "ListValue") {
    const item = coerceLiteral(schema, node, type.ofType, variables);
    return item.ok ? ok([item.value]) : item;
  }
  const values = [];
  for (const [index, itemNode] of node.values.entries()) {
    let item = coerceLiteral(schema, itemNode, type.ofType, variables);
    // A list item naming an unprovided variable is null (GraphQL spec).
    if (item.absent) item = coerceInputValue(schema, null, type.ofType);
    if (!item.ok) return invalid(`In element #${index}: ${item.message}`);
    values.push(item.value);
  }
  return ok(values);
}

/**
 * Coerces an AST value literal to `type`. `variables` is a Map of coerced
 * variable values; a Variable missing from it yields `{ ok: true, absent:
 * true }` so the caller can apply defaults.
 * @returns {{ ok: true, value: unknown, absent?: true } |
 *   { ok: false, message: string }}
 */
export function coerceLiteral(schema, node, type, variables) {
  if (node.kind === "Variable") {
    if (!variables.has(node.name)) return { ok: true, absent: true };
    return coerceInputValue(schema, variables.get(node.name), type);
  }
  if (type.kind === "NonNullType") {
    if (node.kind === "NullValue") {
      const message = `Expected value of non-null type "${typeToString(type)}" not to be null.`;
      return invalid(message);
    }
    return coerceLiteral(schema, node, type.ofType, variables);
  }
  if (node.kind === "NullValue") return ok(null);
  if (type.kind === "ListType") {
    return coerceListLiteral(schema, node, type, variables);
  }
  return coerceNamedLiteral(schema, node, type.name);
}

/**
 * Serializes a resolved leaf value for scalar or enum type `name` with the
 * input rules (ID becomes a string, Int is 32-bit, enums must be allowed).
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function serializeLeaf(schema, name, value) {
  return coerceNamed(schema, value, name);
}

/**
 * Coerces the arguments of a field or directive `node` against
 * `definitions` (a Map of built argument definitions), applying defaults.
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
export function coerceArgumentValues(schema, definitions, node, variables) {
  const args = {};
  const supplied = new Map(node.arguments.map((arg) => [arg.name, arg.value]));
  for (const { name, type, hasDefault, defaultValue } of definitions.values()) {
    const coerced = supplied.has(name)
      ? coerceLiteral(schema, supplied.get(name), type, variables)
      : { ok: true, absent: true };
    if (!coerced.ok) {
      const message = `Argument "${name}" has an invalid value: ${coerced.message}`;
      return invalid(message);
    }
    if (!coerced.absent) args[name] = coerced.value;
    else if (hasDefault) args[name] = defaultValue;
    else if (type.kind === "NonNullType") {
      const message = `Argument "${name}" of required type "${typeToString(type)}" was not provided.`;
      return invalid(message);
    }
  }
  return ok(args);
}

/**
 * Statically checks an operation's variable definitions: unique names, input
 * (scalar or enum) types and valid default values.
 * @returns {{ node: object, message: string }[]} One entry per problem.
 */
export function checkVariableDefinitions(schema, definitions) {
  const seen = new Set();
  const problems = [];
  for (const definition of definitions) {
    const { name, type, defaultValue } = definition;
    const typeName = namedTypeName(type);
    const label = `Variable "$${name}"`;
    let message = null;
    if (seen.has(name)) {
      message = `There can be only one variable named "$${name}".`;
    } else if (!isInputTypeName(schema, typeName)) {
      message = schema.types.has(typeName)
        ? `${label} cannot be non-input type "${typeToString(type)}".`
        : `${label} has unknown type "${typeName}".`;
    } else if (defaultValue) {
      const coerced = coerceLiteral(schema, defaultValue, type, new Map());
      if (!coerced.ok) {
        message = `${label} has an invalid default value: ${coerced.message}`;
      }
    }
    seen.add(name);
    if (message) problems.push({ node: definition, message });
  }
  return problems;
}

/**
 * Coerces request variables against an operation's variable definitions.
 * Variables that are absent and have no default stay out of `values`.
 * @returns {{ values: Map<string, unknown>, errors: GraphQLError[] }}
 */
export function coerceVariableValues(schema, definitions, inputs) {
  const values = new Map();
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    const message = "Variables must be a JSON object.";
    return { values, errors: [new GraphQLError(message, { code: BAD_INPUT })] };
  }
  const errors = [];
  for (const definition of definitions) {
    const { name, type, defaultValue } = definition;
    let problem = null;
    if (Object.hasOwn(inputs, name) && inputs[name] !== undefined) {
      const coerced = coerceInputValue(schema, inputs[name], type);
      if (coerced.ok) values.set(name, coerced.value);
      else problem = `got an invalid value: ${coerced.message}`;
    } else if (defaultValue) {
      const coerced = coerceLiteral(schema, defaultValue, type, new Map());
      values.set(name, coerced.value);
    } else if (type.kind === "NonNullType") {
      problem = `of required type "${typeToString(type)}" was not provided.`;
    }
    if (problem !== null) {
      errors.push(badInput(`Variable "$${name}" ${problem}`, definition));
    }
  }
  return { values, errors };
}

/**
 * Evaluates the `if` argument of each built-in @include/@skip directive.
 * @returns {{ values: Map<object, boolean>, errors: GraphQLError[] }}
 */
export function coerceDirectiveConditions(schema, directives, variables) {
  const values = new Map();
  const errors = [];
  for (const directive of directives) {
    const args = coerceArgumentValues(
      schema,
      DIRECTIVE_ARGS,
      directive,
      variables,
    );
    if (args.ok) values.set(directive, args.value.if);
    else
      errors.push(
        badInput(`Directive "@${directive.name}": ${args.message}`, directive),
      );
  }
  return { values, errors };
}

function printDescription(description, indent) {
  if (!description) return [];
  const lines = description.replaceAll('"""', '\\"""').split(/\r\n|[\n\r]/);
  const last = lines.at(-1);
  if (lines.length === 1 && !last.endsWith('"') && !last.endsWith("\\")) {
    return [`${indent}"""${last}"""`];
  }
  const body = lines.map((line) => (line ? `${indent}${line}` : ""));
  return [`${indent}"""`, ...body, `${indent}"""`];
}

function printDefault(schema, value, type) {
  if (value === null) return "null";
  const inner = type.kind === "NonNullType" ? type.ofType : type;
  if (Array.isArray(value)) {
    const items = value.map((item) => printDefault(schema, item, inner.ofType));
    return `[${items.join(", ")}]`;
  }
  if (schema.enums.has(namedTypeName(type))) return value;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function printArgs(schema, field) {
  const args = [...field.args.values()];
  if (args.length === 0) return "";
  const printed = args.map((arg) => {
    const base = `${arg.name}: ${typeToString(arg.type)}`;
    if (!arg.hasDefault) return base;
    return `${base} = ${printDefault(schema, arg.defaultValue, arg.type)}`;
  });
  if (args.every((arg) => !arg.description)) return `(${printed.join(", ")})`;
  const lines = args.flatMap((arg, index) => [
    ...printDescription(arg.description, "    "),
    `    ${printed[index]}`,
  ]);
  return `(\n${lines.join("\n")}\n  )`;
}

function printField(schema, field) {
  const { deprecationReason: reason } = field;
  const deprecated =
    reason === null ? "" : ` @deprecated(reason: ${JSON.stringify(reason)})`;
  const signature = `${field.name}${printArgs(schema, field)}`;
  return [
    ...printDescription(field.description, "  "),
    `  ${signature}: ${typeToString(field.type)}${deprecated}`,
  ];
}

function printObjectType(schema, type, apiVersion) {
  const lines = printDescription(type.description, "");
  const fields = [...type.fields.values()].filter((field) =>
    isFieldVisible(field, apiVersion),
  );
  // SDL allows a type without a field block; a version may hide every field.
  if (fields.length === 0) return [...lines, `type ${type.name}`].join("\n");
  lines.push(`type ${type.name} {`);
  for (const field of fields) lines.push(...printField(schema, field));
  lines.push("}");
  return lines.join("\n");
}

/**
 * Prints the schema as SDL, keeping only fields visible in `apiVersion`.
 * Object types come first in declaration order, then enums.
 */
export function printSchema(schema, { apiVersion } = {}) {
  const blocks = [];
  const customRoots =
    schema.query !== "Query" ||
    (schema.mutation !== null && schema.mutation !== "Mutation");
  if (customRoots) {
    const roots = [`  query: ${schema.query}`];
    if (schema.mutation !== null) roots.push(`  mutation: ${schema.mutation}`);
    blocks.push(`schema {\n${roots.join("\n")}\n}`);
  }
  for (const type of schema.types.values()) {
    blocks.push(printObjectType(schema, type, apiVersion));
  }
  for (const { name, values } of schema.enums.values()) {
    blocks.push(`enum ${name} {\n${values.map((v) => `  ${v}`).join("\n")}\n}`);
  }
  return `${blocks.join("\n\n")}\n`;
}
