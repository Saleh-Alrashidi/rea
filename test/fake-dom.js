/**
 * A minimal DOM for unit tests of components built with `web/dom.js`:
 * elements with attributes, children, listeners, focus and the reflected
 * properties the components use (`value`, `checked`, `hidden`,
 * `disabled`). No markup parsing and no layout. `installFakeDom(t)` sets
 * `globalThis.document` for the test; `fire()` dispatches events and
 * `findAll()` / `textOf()` read the tree.
 */

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === globalThis.document?.body;
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }
}

const REFLECTED = ["hidden", "disabled"];

export class FakeElement extends FakeNode {
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.localName = tag;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty: (name, value) => (this.style[name] = value) };
    this.value = "";
    this.checked = false;
    for (const name of REFLECTED) {
      Object.defineProperty(this, name, {
        get: () => this.attributes.has(name),
        set: (on) =>
          on ? this.setAttribute(name, "") : this.removeAttribute(name),
      });
    }
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  get className() {
    return this.getAttribute("class") ?? "";
  }

  set className(value) {
    this.setAttribute("class", value);
  }

  set textContent(text) {
    this.replaceChildren(String(text));
  }

  get textContent() {
    return super.textContent;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(typeof node === "string" ? new FakeText(node) : node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes.slice()) this.removeChild(child);
    this.append(...nodes);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  focus() {
    const doc = globalThis.document;
    if (doc.activeElement === this) return;
    const previous = doc.activeElement;
    doc.activeElement = this;
    if (previous && previous !== doc.body) fire(previous, "blur");
    fire(this, "focus");
  }

  blur() {
    const doc = globalThis.document;
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    fire(this, "blur");
  }
}

/** Dispatches `type` on `element` (no bubbling); returns the event. */
export function fire(element, type, init = {}) {
  const event = {
    type,
    target: element,
    currentTarget: element,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {},
    ...init,
  };
  for (const listener of (element.listeners.get(type) ?? []).slice()) {
    listener(event);
  }
  return event;
}

/** Elements under `root` (itself included) for which `match` is true. */
export function findAll(root, match) {
  const found = [];
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (match(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

/** True when `element` has class `name`. */
export const hasClass = (element, name) =>
  element.className.split(/\s+/).includes(name);

/** Installs a fresh fake document for test `t`. */
export function installFakeDom(t) {
  const body = new FakeElement("body");
  globalThis.document = {
    body,
    activeElement: body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    createTextNode: (data) => new FakeText(data),
  };
  t.after(() => {
    delete globalThis.document;
  });
  return globalThis.document;
}
