/**
 * Safe DOM builder for the host app.
 *
 * `h()` never parses markup: strings become text nodes, attributes are set
 * with `setAttribute`, event handlers are attached with `addEventListener`
 * and styles go through the CSSOM. Event-handler attributes, `srcdoc` and
 * script-capable URLs are rejected, so data can never become HTML or code.
 *
 * The module reads `globalThis.document` only when an element is built, so it
 * can be imported (and tested) outside a browser.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const TAG_PATTERN = /^[a-z][a-z0-9-]*$/i;
const ATTRIBUTE_PATTERN = /^[a-z_:][a-z0-9_.:-]*$/i;
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction"]);
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
/** Live DOM properties, assigned after children so `<select>` values work. */
const PROPERTIES = new Set(["value", "checked", "selected", "indeterminate"]);
const BLOCKED_ATTRIBUTES = new Set(["srcdoc", "innerhtml", "outerhtml"]);
/** Base for resolving relative URLs; only the scheme of the result matters. */
const URL_BASE = "https://relative.invalid/";

function getDocument() {
  const doc = globalThis.document;
  if (!doc) throw new Error("dom.js needs a document");
  return doc;
}

/**
 * Returns `value` when it is a relative URL or uses http:, https: or mailto:.
 * Throws a TypeError for `javascript:`, `data:` and other schemes.
 */
export function safeUrl(value) {
  const text = String(value);
  let url;
  try {
    url = new URL(text, URL_BASE);
  } catch {
    throw new TypeError("Invalid URL");
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) {
    throw new TypeError(`Blocked URL scheme ${url.protocol}`);
  }
  return text;
}

function classValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" ");
  return String(value);
}

function applyStyle(element, style) {
  if (typeof style !== "object" || style === null) {
    // Inline style attributes are blocked by the page CSP anyway.
    throw new TypeError("style must be an object of CSS properties");
  }
  for (const [name, value] of Object.entries(style)) {
    if (value === null || value === undefined || value === false) continue;
    element.style.setProperty(name, String(value));
  }
}

function applyListeners(element, listeners) {
  for (const [type, listener] of Object.entries(listeners)) {
    if (typeof listener !== "function") {
      throw new TypeError(`on.${type} must be a function`);
    }
    element.addEventListener(type, listener);
  }
}

function applyDataset(element, dataset) {
  for (const [key, value] of Object.entries(dataset)) {
    if (value === null || value === undefined) continue;
    element.dataset[key] = String(value);
  }
}

function checkAttributeName(name) {
  const lower = name.toLowerCase();
  if (!ATTRIBUTE_PATTERN.test(name) || BLOCKED_ATTRIBUTES.has(lower)) {
    throw new TypeError(`Attribute ${JSON.stringify(name)} is not allowed`);
  }
  if (lower.startsWith("on")) {
    throw new TypeError(`Use on: { ... } instead of the ${name} attribute`);
  }
  return lower;
}

function applyAttribute(element, name, value) {
  if (value === null || value === undefined || value === false) return;
  const lower = checkAttributeName(name);
  if (value === true) {
    element.setAttribute(name, "");
    return;
  }
  const text = URL_ATTRIBUTES.has(lower) ? safeUrl(value) : String(value);
  element.setAttribute(name, text);
}

/** Applies props except live properties; returns those for later. */
function applyProps(element, props) {
  const later = [];
  for (const [name, value] of Object.entries(props)) {
    // An absent prop (for example an optional `dataset`) sets nothing.
    if ((value === null || value === undefined) && !PROPERTIES.has(name)) {
      continue;
    }
    if (name === "class") {
      if (value) element.setAttribute("class", classValue(value));
    } else if (name === "style") {
      applyStyle(element, value);
    } else if (name === "on") {
      applyListeners(element, value);
    } else if (name === "dataset") {
      applyDataset(element, value);
    } else if (PROPERTIES.has(name)) {
      later.push([name, value]);
    } else {
      applyAttribute(element, name, value);
    }
  }
  return later;
}

function isNode(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.nodeType === "number"
  );
}

function appendChildren(doc, element, children) {
  for (const child of children) {
    if (child === null || child === undefined || typeof child === "boolean") {
      continue;
    }
    if (Array.isArray(child)) {
      appendChildren(doc, element, child);
    } else if (isNode(child)) {
      element.appendChild(child);
    } else if (typeof child === "string" || typeof child === "number") {
      element.appendChild(doc.createTextNode(String(child)));
    } else {
      throw new TypeError("Children must be nodes, strings or numbers");
    }
  }
}

function build(namespace, tag, props, children) {
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw new TypeError(`Invalid tag ${JSON.stringify(tag)}`);
  }
  const doc = getDocument();
  const element = namespace
    ? doc.createElementNS(namespace, tag)
    : doc.createElement(tag);
  const later = props ? applyProps(element, props) : [];
  appendChildren(doc, element, children);
  for (const [name, value] of later) {
    if (value === undefined) continue;
    // Keep `defaultValue` in step so callers can tell edited text apart.
    if (name === "value" && "defaultValue" in element && tag !== "select") {
      element.defaultValue = String(value);
    }
    element[name] = value;
  }
  return element;
}

/**
 * Builds an HTML element. `props` may hold `class` (string or array),
 * `dataset`, `style` (object), `on: { event: listener }`, the live
 * properties `value`/`checked`/`selected`/`indeterminate` and any other
 * attribute (`true` sets an empty attribute; `false`/`null` skips it).
 * Children may be nodes, strings, numbers, arrays or empty values; text is
 * always inserted as text.
 *
 * @param {string} tag
 * @param {object | null} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  return build(null, tag, props, children);
}

/** Builds an SVG element with the same rules as `h()`. */
export function svg(tag, props, ...children) {
  return build(SVG_NS, tag, props, children);
}

/** Removes every child of `element` and returns it. */
export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}
