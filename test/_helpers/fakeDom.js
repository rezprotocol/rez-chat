export class FakeNode {
  constructor() {
    this.children = [];
    this.parentNode = null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
}

class FakeTextNode extends FakeNode {
  constructor(text) {
    super();
    this.textContent = text;
  }
}

export class FakeElement extends FakeNode {
  constructor(tagName = "div") {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.className = "";
    this.style = {};
    this.value = "";
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type) || [];
    for (const handler of handlers) handler(event);
    return true;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child instanceof FakeElement && child.#matches(selector)) return child;
      if (child instanceof FakeElement) {
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
    }
    return null;
  }

  #matches(selector) {
    const match = /^\[([^=]+)=['"]([^'"]+)['"]\]$/.exec(selector);
    if (!match) return false;
    return this.attributes.get(match[1]) === match[2];
  }
}

export function fakeEvent(type) {
  return { type, preventDefault() {} };
}

export function installFakeDom() {
  globalThis.Node = FakeNode;
  globalThis.Element = FakeElement;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeTextNode(String(text)),
  };
}
