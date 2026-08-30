import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';

function kebab(value) { return value.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`); }

class FakeElement {
  constructor(tagName, document) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.scrollTop = 0;
    this.open = false;
    this._textContent = '';
    this.dataset = new Proxy({}, {
      set: (target, property, value) => {
        const string = String(value);
        target[property] = string;
        this.attributes.set(`data-${kebab(String(property))}`, string);
        return true;
      },
      get: (target, property) => target[property],
    });
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  async click() {
    for (const listener of this.listeners.get('click') ?? []) {
      await listener({ currentTarget: this, preventDefault() {} });
    }
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const output = [];
    const tag = selector.match(/^[a-z]+/iu)?.[0]?.toUpperCase();
    const attributes = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/gu)];
    const visit = node => {
      if (node !== this && (!tag || node.tagName === tag) && attributes.every(match => {
        const [, name, expected] = match;
        return node.hasAttribute(name) && (expected === undefined || node.getAttribute(name) === expected);
      })) output.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this);
    return output;
  }
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

async function resultBundle(auditId) {
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.0.1', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/147.0.0.0',
  });
  const checkpoint = {
    version: 1, auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [],
    })),
  };
  return createPanelResultBundleV1({
    reportRevision: {
      version: 1, auditId, modelRevision: 1,
      modelHash: model.integrity.canonicalModelHash, model, checkpoint,
    },
    inventory,
  });
}

test('panel runtime never reads speech voices or Chrome target IDs and connects only audita-panel-v1', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalSpeech = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalSpeech === undefined) delete globalThis.speechSynthesis;
    else Object.defineProperty(globalThis, 'speechSynthesis', originalSpeech);
  });

  const document = {
    activeElement: null,
    createElement(tagName) { return new FakeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new FakeElement('main', document);
  document.root.scrollTop = 37;

  let speechReads = 0;
  Object.defineProperty(globalThis, 'speechSynthesis', {
    configurable: true,
    get() { speechReads += 1; throw new Error('PRIVATE_VOICE_INVENTORY'); },
  });

  let chromeTargetReads = 0;
  const ports = [];
  const sent = [];
  const capabilityId = 'C'.repeat(24);
  const chrome = {
    runtime: {
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: event(), onDisconnect: event(),
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
      sendMessage(message, callback) {
        const copy = structuredClone(message);
        sent.push(copy);
        const response = message.type === 'PREPARE_PANEL_CAPABILITY'
          ? { ok: true, requestId: message.requestId, capabilityId, expiresAt: 999999 }
          : { ok: true, auditId: 'audit-panel-1', state: 'running' };
        callback?.(response);
        return Promise.resolve(response);
      },
    },
    tabs: new Proxy({}, { get() { chromeTargetReads += 1; throw new Error('PRIVATE_CHROME_TARGET'); } }),
  };
  globalThis.document = document;
  globalThis.chrome = chrome;

  await import(`../../src/panel/panel.js?privacy=${Date.now()}`);

  assert.equal(speechReads, 0);
  assert.equal(chromeTargetReads, 0);
  assert.deepEqual(ports.map(port => port.name), ['audita-panel-v1']);
  assert.deepEqual(ports[0].posted, [{ protocol: 'audita-panel', version: 1, type: 'bootstrap' }]);
  assert.doesNotMatch(document.root.textContent, /persona|voz|simulação/iu);
  assert.equal(document.root.querySelector('[data-persona-mode]'), null);

  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  const start = document.root.querySelector('button[data-intent="START_ATTACHED"]');
  assert.ok(start);
  await start.click();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(sent[0].type, 'PREPARE_PANEL_CAPABILITY');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['requestId', 'type']);
  assert.deepEqual(sent[1], {
    type: 'PANEL_START_ATTACHED_AUDIT', capabilityId,
    captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
  });
  assert.doesNotMatch(document.root.textContent, new RegExp(capabilityId, 'u'));
  assert.doesNotMatch(JSON.stringify(document.root.dataset), /capability|session|tab|window|document|frame/iu);
  assert.equal(chromeTargetReads, 0);

  const sessionCapabilityId = 'S'.repeat(22);
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-panel-1', sessionCapabilityId, result: null,
  });
  assert.equal(document.activeElement, document.root.querySelector('[data-focus-id="cancel-audit"]'));

  const bundle = await resultBundle('audit-panel-1');
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'result',
    auditId: 'audit-panel-1', sessionCapabilityId, result: bundle,
  });
  const resultSummary = document.root.querySelector('[data-focus-id="result-summary"]');
  assert.ok(resultSummary);
  assert.equal(document.activeElement, resultSummary, 'replaceChildren restores focus to a result semantic target');

  document.root.scrollTop = 211;
  const filter = document.root.querySelector('button[data-filter-dimension][data-filter-value]');
  assert.ok(filter);
  filter.focus();
  const filterFocusId = filter.dataset.focusId;
  await filter.click();
  assert.equal(document.root.scrollTop, 211, 'the effective panel scroll position survives the re-render');
  assert.equal(document.activeElement?.dataset?.focusId, filterFocusId, 'focus returns to the exact chip, not its dimension peer');
});
