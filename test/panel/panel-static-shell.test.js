import assert from 'node:assert/strict';
import test from 'node:test';

function kebab(value) { return value.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`); }

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this._textContent = '';
    this.dataset = new Proxy({}, {
      set: (target, property, value) => {
        const string = String(value);
        target[property] = string;
        this.attributes.set(`data-${kebab(String(property))}`, string);
        return true;
      },
    });
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener() {}
  focus() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const output = [];
    const tag = selector.match(/^[a-z]+/iu)?.[0]?.toUpperCase();
    const attributes = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/gu)];
    const visit = node => {
      if (node !== this && (!tag || node.tagName === tag) && attributes.every(match => {
        const [, name, expected] = match;
        const value = name.startsWith('data-')
          ? node.attributes.get(name)
          : node.attributes.get(name);
        return value !== undefined && (expected === undefined || value === expected);
      })) output.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this);
    return output;
  }
}

test('a static or malformed Side Panel stays on a stable reconnecting shell and never opens a privileged Port', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
  });

  const invalidUrls = [
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html?launch=short',
    `chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html?launch=${'A'.repeat(43)}&launch=${'B'.repeat(43)}`,
    `chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html?launch=${'A'.repeat(43)}&extra=1`,
    `chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html?launch=${'A'.repeat(43)}#fragment`,
    `chrome-extension://otherextensionidotherextensionid/src/panel/index.html?launch=${'A'.repeat(43)}`,
  ];

  for (const [index, href] of invalidUrls.entries()) {
    const document = {
      createElement(tagName) { return new FakeElement(tagName); },
      querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
    };
    document.root = new FakeElement('main');
    let connections = 0;
    globalThis.document = document;
    globalThis.location = { href };
    globalThis.chrome = {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        connect() { connections += 1; throw new Error('UNPREPARED_PANEL_CONNECTED'); },
      },
    };

    await import(`../../src/panel/panel.js?static-shell=${Date.now()}-${index}`);

    assert.equal(connections, 0, href);
    assert.equal(document.root.querySelector('[data-screen="reconnecting"]')?.dataset.screen, 'reconnecting', href);
    assert.match(document.root.textContent, /Reconectando o painel/iu, href);
    assert.doesNotMatch(document.root.textContent, /Não foi possível preparar as ações locais/iu, href);
    assert.equal(document.root.querySelectorAll('button').length, 0, href);
  }
});
