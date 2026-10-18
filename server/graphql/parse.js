/**
 * Tokenizer and recursive-descent parser for the executable GraphQL subset
 * mini-monday supports: query and mutation operations, fragments, variables,
 * directives and every value literal. Locations are 1-based.
 *
 * Besides the node shapes in SPEC.md, Directive, argument, variable
 * definition and Variable value nodes also carry `loc` so that validation
 * errors can point at them.
 */
import { GraphQLError } from "./errors.js";

const PARSE_FAILED = "GRAPHQL_PARSE_FAILED";
// Bounds list/object literal and list-type nesting, which `maxDepth` (a
// selection-set limit) does not cover, so recursion stays shallow.
const MAX_VALUE_DEPTH = 64;
const PUNCTUATORS = new Set("!$&():=@[]{}|");
const NAME_START = /[A-Z_a-z]/;
const NAME_TAIL = /[0-9A-Z_a-z]*/y;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const LITERALS = {
  Int: "IntValue",
  Float: "FloatValue",
  String: "StringValue",
};
const ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const isDigit = (char) => char !== undefined && char >= "0" && char <= "9";
const isNameStart = (char) => char !== undefined && NAME_START.test(char);
const isBlank = (line) => /^[\t ]*$/.test(line);

function depthError(message, start) {
  const locations = [{ ...start }];
  return new GraphQLError(message, { code: "MAX_DEPTH_EXCEEDED", locations });
}

/** Describes a source character for error messages. */
function describeChar(char) {
  if (char === undefined) return "<EOF>";
  const code = char.codePointAt(0);
  if (code >= 0x20 && code !== 0x7f) return JSON.stringify(char);
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Removes the common indentation and blank edge lines of a block string. */
function blockStringValue(raw) {
  const lines = raw.split(/\r\n|[\n\r]/);
  let common = null;
  for (const line of lines.slice(1)) {
    const indent = /^[\t ]*/.exec(line)[0].length;
    if (indent < line.length && (common === null || indent < common)) {
      common = indent;
    }
  }
  const dedented = lines.map((line, index) =>
    index === 0 || common === null ? line : line.slice(common),
  );
  while (dedented.length > 0 && isBlank(dedented[0])) dedented.shift();
  while (dedented.length > 0 && isBlank(dedented.at(-1))) dedented.pop();
  return dedented.join("\n");
}

class Lexer {
  constructor(source) {
    this.source = source;
    this.pos = 0;
    this.line = 1;
    this.lineStart = 0;
    this.token = this.read();
  }

  advance() {
    const previous = this.token;
    this.token = this.read();
    return previous;
  }

  fail(message, pos = this.pos) {
    const column = pos - this.lineStart + 1;
    return new GraphQLError(`Syntax Error: ${message}`, {
      code: PARSE_FAILED,
      locations: [{ line: this.line, column }],
    });
  }

  newline(pos) {
    this.line += 1;
    this.lineStart = pos;
  }

  skipIgnored() {
    const { source } = this;
    while (this.pos < source.length) {
      const char = source[this.pos];
      if (char === "\n" || char === "\r") {
        this.pos += source.startsWith("\r\n", this.pos) ? 2 : 1;
        this.newline(this.pos);
      } else if (char === "#") {
        while (this.pos < source.length && !"\n\r".includes(source[this.pos])) {
          this.pos += 1;
        }
      } else if (" \t,﻿".includes(char)) {
        this.pos += 1;
      } else {
        return;
      }
    }
  }

  read() {
    this.skipIgnored();
    const { source, pos } = this;
    const start = { line: this.line, column: pos - this.lineStart + 1 };
    const char = source[pos];
    if (char === undefined) return { kind: "<EOF>", value: undefined, start };
    if (PUNCTUATORS.has(char)) {
      this.pos += 1;
      return { kind: char, value: char, start };
    }
    if (source.startsWith("...", pos)) {
      this.pos += 3;
      return { kind: "...", value: "...", start };
    }
    if (isNameStart(char)) {
      NAME_TAIL.lastIndex = pos + 1;
      NAME_TAIL.exec(source);
      this.pos = NAME_TAIL.lastIndex;
      return { kind: "Name", value: source.slice(pos, this.pos), start };
    }
    if (char === "-" || isDigit(char)) return this.readNumber(start);
    if (char === '"') return this.readString(start);
    throw this.fail(`Unexpected character: ${describeChar(char)}.`);
  }

  readDigits(pos) {
    const { source } = this;
    let end = pos;
    while (isDigit(source[end])) end += 1;
    if (end > pos) return end;
    const found = describeChar(source[pos]);
    throw this.fail(`Invalid number, expected digit but got: ${found}.`, pos);
  }

  readNumber(start) {
    const { source } = this;
    let pos = source[this.pos] === "-" ? this.pos + 1 : this.pos;
    let isFloat = false;
    if (source[pos] === "0" && isDigit(source[pos + 1])) {
      const digit = describeChar(source[pos + 1]);
      const message = `Invalid number, unexpected digit after 0: ${digit}.`;
      throw this.fail(message, pos + 1);
    }
    pos = source[pos] === "0" ? pos + 1 : this.readDigits(pos);
    if (source[pos] === ".") {
      isFloat = true;
      pos = this.readDigits(pos + 1);
    }
    if (source[pos] === "e" || source[pos] === "E") {
      isFloat = true;
      pos += "+-".includes(source[pos + 1] ?? "?") ? 2 : 1;
      pos = this.readDigits(pos);
    }
    if (source[pos] === "." || isNameStart(source[pos])) {
      const found = describeChar(source[pos]);
      throw this.fail(`Invalid number, expected digit but got: ${found}.`, pos);
    }
    const value = Number(source.slice(this.pos, pos));
    this.pos = pos;
    return { kind: isFloat ? "Float" : "Int", value, start };
  }

  readEscape(pos) {
    const { source } = this;
    const char = source[pos + 1];
    if (char !== "u") {
      if (Object.hasOwn(ESCAPES, char)) return { text: ESCAPES[char], skip: 2 };
      const sequence = JSON.stringify(`\\${char ?? ""}`);
      throw this.fail(`Invalid character escape sequence: ${sequence}.`, pos);
    }
    const unit = (at) => {
      const hex = source.slice(at, at + 4);
      return HEX4.test(hex) ? Number.parseInt(hex, 16) : -1;
    };
    const first = unit(pos + 2);
    const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;
    const sequence = JSON.stringify(source.slice(pos, pos + 6));
    const invalid = this.fail(
      `Invalid Unicode escape sequence: ${sequence}.`,
      pos,
    );
    if (first < 0 || isLow(first)) throw invalid;
    if (first < 0xd800 || first > 0xdbff) {
      return { text: String.fromCharCode(first), skip: 6 };
    }
    // A leading surrogate must be followed by an escaped trailing one.
    const second = source.startsWith("\\u", pos + 6) ? unit(pos + 8) : -1;
    if (!isLow(second)) throw invalid;
    return { text: String.fromCharCode(first, second), skip: 12 };
  }

  /** Reads a `"…"` string or a `"""…"""` block string. */
  readString(start) {
    const { source } = this;
    const block = source.startsWith('"""', this.pos);
    const quote = block ? '"""' : '"';
    let pos = this.pos + quote.length;
    let chunkStart = pos;
    let value = "";
    while (pos < source.length) {
      const char = source[pos];
      if (source.startsWith(quote, pos)) {
        value += source.slice(chunkStart, pos);
        this.pos = pos + quote.length;
        const text = block ? blockStringValue(value) : value;
        return { kind: "String", value: text, start };
      }
      let step = { text: null, skip: 1 };
      if (block && source.startsWith('\\"""', pos)) {
        step = { text: '"""', skip: 4 };
      } else if (!block && char === "\\") {
        step = this.readEscape(pos);
      } else if (char === "\n" || char === "\r") {
        if (!block) break;
        step.skip = source.startsWith("\r\n", pos) ? 2 : 1;
        this.newline(pos + step.skip);
      } else if (char < " " && char !== "\t") {
        const found = describeChar(char);
        throw this.fail(`Invalid character within String: ${found}.`, pos);
      }
      if (step.text !== null) {
        value += source.slice(chunkStart, pos) + step.text;
        chunkStart = pos + step.skip;
      }
      pos += step.skip;
    }
    throw this.fail("Unterminated string.", pos);
  }
}

/** Describes a token for "Expected X, found Y" messages. */
function describeToken(token) {
  if (token.kind === "<EOF>") return "<EOF>";
  if (token.kind === token.value) return JSON.stringify(token.kind);
  return `${token.kind} ${JSON.stringify(String(token.value))}`;
}

class Parser {
  constructor(source, maxDepth) {
    this.lexer = new Lexer(source);
    this.maxDepth = maxDepth;
    this.depth = 0;
    this.valueDepth = 0;
  }

  get token() {
    return this.lexer.token;
  }

  fail(message, token = this.token) {
    return new GraphQLError(`Syntax Error: ${message}`, {
      code: PARSE_FAILED,
      locations: [{ ...token.start }],
    });
  }

  unexpected(expected) {
    const found = describeToken(this.token);
    if (!expected) return this.fail(`Unexpected ${found}.`);
    return this.fail(`Expected ${expected}, found ${found}.`);
  }

  peek(kind) {
    return this.token.kind === kind;
  }

  peekName(value) {
    return this.token.kind === "Name" && this.token.value === value;
  }

  skip(kind) {
    if (!this.peek(kind)) return false;
    this.lexer.advance();
    return true;
  }

  expect(kind) {
    if (!this.peek(kind)) {
      throw this.unexpected(kind.length > 3 ? kind : JSON.stringify(kind));
    }
    return this.lexer.advance();
  }

  many(open, parseItem, close) {
    this.expect(open);
    const items = [];
    do items.push(parseItem());
    while (!this.skip(close));
    return items;
  }

  nest(parseNested) {
    this.valueDepth += 1;
    if (this.valueDepth > MAX_VALUE_DEPTH) {
      const message = `Value nesting exceeds the maximum depth of ${MAX_VALUE_DEPTH}.`;
      throw depthError(message, this.token.start);
    }
    const result = parseNested();
    this.valueDepth -= 1;
    return result;
  }

  parseDocument() {
    const definitions = [];
    do definitions.push(this.parseDefinition());
    while (!this.peek("<EOF>"));
    return { kind: "Document", definitions };
  }

  parseDefinition() {
    if (this.peek("{") || this.peekName("query") || this.peekName("mutation")) {
      return this.parseOperation();
    }
    if (this.peekName("fragment")) return this.parseFragmentDefinition();
    if (this.peekName("subscription")) {
      throw this.fail("Subscription operations are not supported.");
    }
    throw this.unexpected();
  }

  parseOperation() {
    const start = this.token.start;
    const operation = this.peek("{") ? "query" : this.lexer.advance().value;
    const name = this.peek("Name") ? this.lexer.advance().value : null;
    const variableDefinitions = this.peek("(")
      ? this.many("(", () => this.parseVariableDefinition(), ")")
      : [];
    return {
      kind: "OperationDefinition",
      operation,
      name,
      variableDefinitions,
      directives: this.parseDirectives(false),
      selectionSet: this.parseSelectionSet(),
      loc: { ...start },
    };
  }

  parseVariableDefinition() {
    const start = this.expect("$").start;
    const name = this.expect("Name").value;
    this.expect(":");
    const definition = { name, type: this.parseType() };
    if (this.skip("=")) definition.defaultValue = this.parseValue(true);
    definition.loc = { ...start };
    return definition;
  }

  parseType() {
    return this.nest(() => {
      let type;
      if (this.skip("[")) {
        type = { kind: "ListType", ofType: this.parseType() };
        this.expect("]");
      } else {
        type = { kind: "NamedType", name: this.expect("Name").value };
      }
      return this.skip("!") ? { kind: "NonNullType", ofType: type } : type;
    });
  }

  parseFragmentDefinition() {
    const start = this.lexer.advance().start;
    if (this.peekName("on")) throw this.unexpected("fragment name");
    const name = this.expect("Name").value;
    if (!this.peekName("on")) throw this.unexpected('"on"');
    this.lexer.advance();
    return {
      kind: "FragmentDefinition",
      name,
      typeCondition: this.expect("Name").value,
      directives: this.parseDirectives(false),
      selectionSet: this.parseSelectionSet(),
      loc: { ...start },
    };
  }

  parseSelectionSet() {
    const { start } = this.expect("{");
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      const message = `Selection set nesting exceeds the maximum depth of ${this.maxDepth}.`;
      throw depthError(message, start);
    }
    const selections = [];
    do selections.push(this.parseSelection());
    while (!this.skip("}"));
    this.depth -= 1;
    return { kind: "SelectionSet", selections };
  }

  parseSelection() {
    return this.peek("...") ? this.parseFragment() : this.parseField();
  }

  parseField() {
    const start = this.token.start;
    let name = this.expect("Name").value;
    let alias = null;
    if (this.skip(":")) {
      alias = name;
      name = this.expect("Name").value;
    }
    return {
      kind: "Field",
      alias,
      name,
      arguments: this.parseArguments(false),
      directives: this.parseDirectives(false),
      selectionSet: this.peek("{") ? this.parseSelectionSet() : null,
      loc: { ...start },
    };
  }

  parseFragment() {
    const loc = { ...this.expect("...").start };
    if (this.peek("Name") && !this.peekName("on")) {
      const name = this.lexer.advance().value;
      const directives = this.parseDirectives(false);
      return { kind: "FragmentSpread", name, directives, loc };
    }
    let typeCondition = null;
    // Any Name token left here is `on`; the spread case returned above.
    if (this.skip("Name")) typeCondition = this.expect("Name").value;
    return {
      kind: "InlineFragment",
      typeCondition,
      directives: this.parseDirectives(false),
      selectionSet: this.parseSelectionSet(),
      loc,
    };
  }

  parseArgument(isConst) {
    const { value: name, start } = this.expect("Name");
    this.expect(":");
    return { name, value: this.parseValue(isConst), loc: { ...start } };
  }

  parseArguments(isConst) {
    if (!this.peek("(")) return [];
    return this.many("(", () => this.parseArgument(isConst), ")");
  }

  parseDirectives(isConst) {
    const directives = [];
    while (this.peek("@")) {
      const start = this.lexer.advance().start;
      const name = this.expect("Name").value;
      const args = this.parseArguments(isConst);
      directives.push({ name, arguments: args, loc: { ...start } });
    }
    return directives;
  }

  parseValue(isConst) {
    const token = this.token;
    if (token.kind === "[") return this.nest(() => this.parseList(isConst));
    if (token.kind === "{") return this.nest(() => this.parseObject(isConst));
    if (token.kind === "$" && isConst) {
      throw this.fail("Unexpected variable in constant value.");
    }
    if (token.kind !== "$" && token.kind !== "Name") {
      if (!Object.hasOwn(LITERALS, token.kind)) throw this.unexpected();
      this.lexer.advance();
      return { kind: LITERALS[token.kind], value: token.value };
    }
    this.lexer.advance();
    if (token.kind === "Name") return this.nameValue(token.value);
    const name = this.expect("Name").value;
    return { kind: "Variable", name, loc: { ...token.start } };
  }

  nameValue(name) {
    if (name === "true" || name === "false") {
      return { kind: "BooleanValue", value: name === "true" };
    }
    if (name === "null") return { kind: "NullValue" };
    return { kind: "EnumValue", value: name };
  }

  parseList(isConst) {
    this.expect("[");
    const values = [];
    while (!this.skip("]")) values.push(this.parseValue(isConst));
    return { kind: "ListValue", values };
  }

  parseObject(isConst) {
    this.expect("{");
    const fields = [];
    while (!this.skip("}")) {
      const { name, value } = this.parseArgument(isConst);
      fields.push({ name, value });
    }
    return { kind: "ObjectValue", fields };
  }
}

/**
 * Parses a GraphQL executable document.
 * @param {string} source GraphQL source text.
 * @param {{ maxLength?: number, maxDepth?: number }} [options]
 * @returns {object} Document AST (see SPEC.md).
 * @throws {GraphQLError} GRAPHQL_PARSE_FAILED, QUERY_TOO_LARGE or
 *   MAX_DEPTH_EXCEEDED.
 */
export function parse(source, { maxLength = 100_000, maxDepth = 12 } = {}) {
  if (typeof source !== "string") {
    const message = "Syntax Error: GraphQL source must be a string.";
    throw new GraphQLError(message, { code: PARSE_FAILED });
  }
  if (source.length > maxLength) {
    const message = `Query is too large: ${source.length} characters exceeds the limit of ${maxLength}.`;
    throw new GraphQLError(message, { code: "QUERY_TOO_LARGE" });
  }
  return new Parser(source, maxDepth).parseDocument();
}
