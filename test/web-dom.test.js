import assert from "node:assert/strict";
import test from "node:test";

// dom.js must not read browser globals at import time.
assert.equal(globalThis.document, undefined);
const { clear, h, safeUrl, svg } = await import("../web/dom.js");

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const PAYLOAD = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function refuseMarkup() {
  throw new Error("markup parsing must never be used");
}

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  appendChild(child) {
    assert.ok(child instanceof FakeNode, "only fake nodes are appended");
    child.parentNode = this;
    this.childNodes.push(child);
    this.log?.push(["append", child]);
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = data;
  }

  get textContent() {
    return this.data;
  }
}

class FakeElement extends FakeNode {
  constructor(tag, namespaceURI = HTML_NS) {
    super(1);
    this.localName = tag;
    this.tagName = namespaceURI === HTML_NS ? tag.toUpperCase() : tag;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = [];
    this.log = [];
    const styles = new Map();
    this.style = {
      styles,
      setProperty: (name, value) => styles.set(name, value),
    };
    // Form controls with text expose defaultValue, like the DOM.
    if (tag === "input" || tag === "textarea") this.defaultValue = "";
  }

  setAttribute(name, value) {
    assert.equal(typeof value, "string", "attribute values are strings");
    this.attributes.set(name, value);
  }

  addEventListener(type, listener) {
    this.listeners.push([type, listener]);
  }

  set value(next) {
    this.log.push(["value", next]);
    this.currentValue = next;
  }

  get value() {
    return this.currentValue;
  }

  set innerHTML(_html) {
    refuseMarkup();
  }

  set outerHTML(_html) {
    refuseMarkup();
  }

  insertAdjacentHTML() {
    refuseMarkup();
  }
}

/** A document that records nodes and fails on any markup parsing. */
function installDocument(t) {
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (namespace, tag) => new FakeElement(tag, namespace),
    createTextNode: (data) => new FakeText(data),
    write: refuseMarkup,
    writeln: refuseMarkup,
    createRange: refuseMarkup,
  };
  t.after(() => {
    delete globalThis.document;
  });
}

test("h() needs a document only when it builds an element", () => {
  assert.throws(() => h("div"), /needs a document/);
});

test("h() inserts text children as text nodes, never as markup", (t) => {
  installDocument(t);
  const element = h("div", null, PAYLOAD, 42, ["<b>", ["</b>"]], null, false);
  assert.equal(element.childNodes.length, 4);
  assert.ok(element.childNodes.every((node) => node.nodeType === 3));
  assert.equal(element.textContent, `${PAYLOAD}42<b></b>`);
  assert.equal(element.childNodes[0].data, PAYLOAD);
});

test("h() appends element children and rejects other objects", (t) => {
  installDocument(t);
  const child = h("span", null, "inner");
  const parent = h("p", null, child, true);
  assert.deepEqual(parent.childNodes, [child]);
  const sneaky = { toString: () => PAYLOAD };
  assert.throws(() => h("p", null, sneaky), TypeError);
});

test("h() sets attribute values literally", (t) => {
  installDocument(t);
  const element = h("button", {
    title: PAYLOAD,
    "aria-label": '"><svg onload=alert(1)>',
    disabled: true,
    hidden: false,
    tabindex: 0,
  });
  assert.equal(element.attributes.get("title"), PAYLOAD);
  assert.equal(element.attributes.get("aria-label"), '"><svg onload=alert(1)>');
  assert.equal(element.attributes.get("disabled"), "");
  assert.equal(element.attributes.has("hidden"), false);
  assert.equal(element.attributes.get("tabindex"), "0");
});

test("h() handles class, dataset, style and listeners", (t) => {
  installDocument(t);
  const onClick = () => {};
  const element = h("div", {
    class: ["cell", false, "active"],
    dataset: { focusKey: "cell:1:status", empty: null },
    style: { "--group-color": "#579bfc", color: null },
    on: { click: onClick },
  });
  assert.equal(element.attributes.get("class"), "cell active");
  assert.deepEqual(element.dataset, { focusKey: "cell:1:status" });
  assert.deepEqual([...element.style.styles], [["--group-color", "#579bfc"]]);
  assert.deepEqual(element.listeners, [["click", onClick]]);
  assert.throws(() => h("div", { style: "color: red" }), TypeError);
  assert.throws(() => h("div", { on: { click: "alert(1)" } }), TypeError);
});

test("h() rejects event-handler attributes, srcdoc and markup properties", (t) => {
  installDocument(t);
  for (const name of ["onclick", "onClick", "ONLOAD", "onerror"]) {
    assert.throws(() => h("img", { [name]: "alert(1)" }), TypeError, name);
  }
  for (const name of ["srcdoc", "innerHTML", "outerHTML"]) {
    assert.throws(() => h("iframe", { [name]: PAYLOAD }), TypeError, name);
  }
  assert.throws(() => h("div", { 'x"><b': "1" }), TypeError);
});

test("h() rejects script-capable URLs in URL attributes", (t) => {
  installDocument(t);
  const blocked = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
  ];
  for (const url of blocked) {
    assert.throws(() => h("a", { href: url }), TypeError, url);
    assert.throws(() => h("iframe", { src: url }), TypeError, url);
    assert.throws(() => h("form", { action: url }), TypeError, url);
  }
  const allowed = [
    "#/boards/1/views/kanban",
    "/v2",
    "https://example.test/a?b=c",
    "http://127.0.0.1:4101/apps/status-summary/index.html?install_id=7",
  ];
  for (const url of allowed) {
    assert.equal(h("a", { href: url }).attributes.get("href"), url);
    assert.equal(safeUrl(url), url);
  }
});

test("h() rejects invalid tag names", (t) => {
  installDocument(t);
  for (const tag of ["img src=x", "<div>", "", "1a", 7]) {
    assert.throws(() => h(tag), TypeError, String(tag));
  }
});

test("h() assigns live properties after the children", (t) => {
  installDocument(t);
  const select = h(
    "select",
    { value: "2" },
    h("option", { value: "1" }, "One"),
    h("option", { value: "2" }, "Two"),
  );
  const order = select.log.map(([kind]) => kind);
  assert.deepEqual(order, ["append", "append", "value"]);
  assert.equal(select.value, "2");
  assert.equal(select.defaultValue, undefined);

  const input = h("input", { value: PAYLOAD });
  assert.equal(input.value, PAYLOAD);
  // defaultValue tracks the rendered value so edits can be detected.
  assert.equal(input.defaultValue, PAYLOAD);
  assert.equal(input.attributes.has("value"), false);
});

test("svg() builds namespaced elements and clear() empties them", (t) => {
  installDocument(t);
  const icon = svg("svg", { viewBox: "0 0 24 24" }, svg("path", { d: "M1 1" }));
  assert.equal(icon.namespaceURI, SVG_NS);
  assert.equal(icon.attributes.get("viewBox"), "0 0 24 24");
  assert.equal(icon.childNodes[0].namespaceURI, SVG_NS);
  assert.equal(clear(icon), icon);
  assert.equal(icon.childNodes.length, 0);
});
