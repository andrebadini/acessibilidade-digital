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

test('panel runtime sends every privileged intent through its admitted Port without claiming a window', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  const originalSpeech = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
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
  let currentWindowReads = 0;
  let runtimeMessageCalls = 0;
  const ports = [];
  const capabilityId = 'C'.repeat(24);
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: event(), onDisconnect: event(),
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
      sendMessage() {
        runtimeMessageCalls += 1;
        throw new Error('PRIVILEGED_PANEL_MESSAGE_BYPASSED_PORT');
      },
    },
    windows: new Proxy({}, {
      get() {
        currentWindowReads += 1;
        throw new Error('PANEL_WINDOW_CLAIM_ATTEMPTED');
      },
    }),
    tabs: new Proxy({}, { get() { chromeTargetReads += 1; throw new Error('PRIVATE_CHROME_TARGET'); } }),
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = {
    href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}`,
  };

  await import(`../../src/panel/panel.js?privacy=${Date.now()}`);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(speechReads, 0);
  assert.equal(chromeTargetReads, 0);
  assert.deepEqual(ports.map(port => port.name), ['audita-panel-v1']);
  assert.deepEqual(ports[0].posted, [{ protocol: 'audita-panel', version: 1, type: 'bootstrap' }]);
  assert.match(document.root.textContent, /Simular experiência/iu);
  assert.equal(document.root.querySelectorAll('[data-persona-mode]').length, 3);
  assert.doesNotMatch(document.root.textContent, /voz|speechSynthesis/iu);

  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  await new Promise(resolve => setImmediate(resolve));
  const startupPersonaPrepare = ports[0].posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY');
  assert.ok(startupPersonaPrepare, 'a reabertura verifica de modo seguro se existe uma persona ativa');
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: startupPersonaPrepare.requestId,
    response: {
      ok: true, requestId: startupPersonaPrepare.envelope.requestId,
      capabilityId: 'R'.repeat(22),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const startupRehydrate = ports[0].posted.find(packet =>
    packet?.envelope?.type === 'PANEL_REHYDRATE_PERSONA');
  assert.deepEqual(startupRehydrate?.envelope, {
    type: 'PANEL_REHYDRATE_PERSONA', capabilityId: 'R'.repeat(22),
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: startupRehydrate.requestId,
    response: { ok: false, code: 'PERSONA_NOT_FOUND' },
  });
  await new Promise(resolve => setImmediate(resolve));
  const start = document.root.querySelector('button[data-intent="START_ATTACHED"]');
  assert.ok(start);
  await start.click();
  await new Promise(resolve => setImmediate(resolve));

  const preparePacket = ports[0].posted.find(packet => packet?.envelope?.type === 'PREPARE_PANEL_CAPABILITY');
  assert.match(preparePacket.requestId, /^[A-Za-z0-9._:-]{1,160}$/u);
  assert.deepEqual(preparePacket, {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: preparePacket.requestId,
    envelope: { type: 'PREPARE_PANEL_CAPABILITY', requestId: preparePacket.envelope.requestId },
  });
  assert.match(preparePacket.envelope.requestId, /^panel-[0-9]+-[0-9]+$/u);
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: preparePacket.requestId,
    response: { ok: true, requestId: preparePacket.envelope.requestId, capabilityId },
  });
  await new Promise(resolve => setImmediate(resolve));

  const startPacket = ports[0].posted.find(packet => packet?.envelope?.type === 'PANEL_START_ATTACHED_AUDIT');
  assert.match(startPacket.requestId, /^[A-Za-z0-9._:-]{1,160}$/u);
  assert.deepEqual(startPacket, {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: startPacket.requestId,
    envelope: {
      type: 'PANEL_START_ATTACHED_AUDIT', capabilityId,
      captureMode: 'full-evidence', includeQuery: false, deleteAfterCompleteExport: false,
    },
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: startPacket.requestId,
    response: { ok: true, auditId: 'audit-panel-1', state: 'running' },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.doesNotMatch(document.root.textContent, new RegExp(capabilityId, 'u'));
  assert.doesNotMatch(JSON.stringify(document.root.dataset), /capability|session|tab|window|document|frame/iu);
  assert.equal(chromeTargetReads, 0);
  assert.equal(currentWindowReads, 0);
  assert.equal(runtimeMessageCalls, 0);

  const sessionCapabilityId = 'S'.repeat(22);
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-panel-1', sessionCapabilityId, result: null,
  });
  assert.equal(document.activeElement, document.root.querySelector('[data-focus-id="cancel-audit"]'));

  const cancel = document.root.querySelector('button[data-intent="CANCEL_AUDIT"]');
  assert.ok(cancel);
  await cancel.click();
  await new Promise(resolve => setImmediate(resolve));
  const cancelPacket = ports[0].posted.find(packet => packet?.envelope?.type === 'PANEL_CANCEL_AUDIT');
  assert.deepEqual(cancelPacket, {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: cancelPacket.requestId,
    envelope: {
      type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId, auditId: 'audit-panel-1',
    },
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: cancelPacket.requestId,
    response: { ok: true, auditId: 'audit-panel-1', state: 'cancelling' },
  });
  await new Promise(resolve => setImmediate(resolve));

  const bundle = await resultBundle('audit-panel-1');
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'result',
    auditId: 'audit-panel-1', sessionCapabilityId, result: bundle,
  });
  await new Promise(resolve => setImmediate(resolve));
  const highlightStatePacket = ports[0].posted.find(packet => packet?.envelope?.type === 'GET_HIGHLIGHT_STATE');
  assert.ok(highlightStatePacket, 'a result bootstrap requests the durable highlight state through the admitted Port');
  assert.deepEqual(highlightStatePacket.envelope, {
    type: 'GET_HIGHLIGHT_STATE', sessionCapabilityId, auditId: 'audit-panel-1',
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

  const openReport = document.root.querySelector('button[data-intent="OPEN_REPORT"]');
  assert.ok(openReport);
  await openReport.click();
  await new Promise(resolve => setImmediate(resolve));
  const reportPacket = ports[0].posted.find(packet => packet?.envelope?.type === 'PANEL_OPEN_REPORT');
  assert.ok(reportPacket, 'opening the report is sent through the admitted panel Port');
  assert.deepEqual(reportPacket, {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: reportPacket.requestId,
    envelope: {
      type: 'PANEL_OPEN_REPORT', sessionCapabilityId, auditId: 'audit-panel-1',
    },
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: reportPacket.requestId,
    response: { ok: false, code: 'REPORT_OPEN_DENIED' },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(document.root.querySelector('[data-focus-id="result-summary"]'),
    'a report launch failure keeps the completed result available');
  assert.ok(document.root.querySelector('button[data-intent="OPEN_REPORT"]'),
    'the user can retry opening the report without rehydrating the audit');
  assert.equal(document.root.querySelector('button[data-intent="RETRY"]'), null);
  assert.equal(
    document.root.querySelector('[role="status"][aria-live="polite"]')?.textContent,
    'Não foi possível abrir o relatório. Tente novamente.',
  );

  const openReportRetry = document.root.querySelector('button[data-intent="OPEN_REPORT"]');
  await openReportRetry.click();
  await new Promise(resolve => setImmediate(resolve));
  const reportRetryPacket = ports[0].posted
    .filter(packet => packet?.envelope?.type === 'PANEL_OPEN_REPORT').at(-1);
  assert.ok(reportRetryPacket, 'retrying the report launch uses the existing admitted panel Port');
  assert.deepEqual(reportRetryPacket, {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: reportRetryPacket.requestId,
    envelope: {
      type: 'PANEL_OPEN_REPORT', sessionCapabilityId, auditId: 'audit-panel-1',
    },
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: reportRetryPacket.requestId,
    response: { ok: true, auditId: 'audit-panel-1', state: 'connected' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(document.root.querySelector('[data-focus-id="result-summary"]'));
  assert.equal(
    document.root.querySelector('[role="status"][aria-live="polite"]')?.textContent,
    'Relatório completo aberto em uma nova aba.',
  );

  const readerButton = document.root.querySelector('button[data-persona-mode="reader"]');
  assert.ok(readerButton);
  await readerButton.click();
  await new Promise(resolve => setImmediate(resolve));
  const preparePersonaPacket = ports[0].posted.filter(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY').at(-1);
  assert.ok(preparePersonaPacket, 'persona selection first requests a target-bound capability through the admitted Port');
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: preparePersonaPacket.requestId,
    response: {
      ok: true, requestId: preparePersonaPacket.envelope.requestId,
      capabilityId: 'P'.repeat(22),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const startPersonaPacket = ports[0].posted.find(packet => packet?.envelope?.type === 'PANEL_START_PERSONA');
  assert.deepEqual(startPersonaPacket?.envelope, {
    type: 'PANEL_START_PERSONA', capabilityId: 'P'.repeat(22), mode: 'reader',
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: startPersonaPacket.requestId,
    response: {
      ok: true,
      lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: 'reader', expiresAt: 1_788_001_800_000 },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const readerStatePacket = ports[0].posted.find(packet => packet?.envelope?.type === 'PANEL_READER_STATE');
  assert.deepEqual(readerStatePacket?.envelope, {
    type: 'PANEL_READER_STATE', leaseId: `lease-${'L'.repeat(22)}`,
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: readerStatePacket.requestId,
    response: {
      ok: true,
      readerState: {
        version: 1, playback: 'playing', index: 0, total: 2,
        caption: 'Positivo um, botão', canPrevious: false, canNext: true,
        speechAvailability: 'unavailable', voiceId: '', rate: 1,
      },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.root.querySelector('button[data-persona-mode="reader"]')?.getAttribute('aria-pressed'), 'true');
  assert.match(document.root.textContent, /Leitura 1 de 2: Positivo um, botão/u);
  const enableVoice = document.root.querySelector('button[data-intent="PERSONA_READER_ENABLE_VOICE"]');
  assert.ok(enableVoice);
  await enableVoice.click();
  await new Promise(resolve => setImmediate(resolve));
  const enableVoicePacket = ports[0].posted.find(packet =>
    packet?.envelope?.type === 'PANEL_READER_ENABLE_VOICE');
  assert.deepEqual(enableVoicePacket?.envelope, {
    type: 'PANEL_READER_ENABLE_VOICE', leaseId: `lease-${'L'.repeat(22)}`,
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: enableVoicePacket.requestId,
    response: {
      ok: true,
      readerState: {
        version: 1, playback: 'playing', index: 0, total: 2,
        caption: 'Positivo um, botão', canPrevious: false, canNext: true,
        speechAvailability: 'available', voiceId: 'local-a', rate: 1,
      },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.root.textContent, /Voz local ativa/u);
  assert.equal(document.root.querySelector('button[data-intent="PERSONA_READER_ENABLE_VOICE"]'), null);

  const nextReader = document.root.querySelector('button[data-intent="PERSONA_READER_NEXT"]');
  await nextReader.click();
  await new Promise(resolve => setImmediate(resolve));
  const nextPacket = ports[0].posted.find(packet =>
    packet?.envelope?.type === 'PANEL_READER_ACTION' && packet.envelope.action === 'next');
  assert.deepEqual(nextPacket?.envelope, {
    type: 'PANEL_READER_ACTION', leaseId: `lease-${'L'.repeat(22)}`, action: 'next',
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: nextPacket.requestId,
    response: {
      ok: true,
      readerState: {
        version: 1, playback: 'playing', index: 1, total: 2,
        caption: 'Positivo dois, botão', canPrevious: true, canNext: false,
        speechAvailability: 'available', voiceId: 'local-a', rate: 1,
      },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.root.textContent, /Leitura 2 de 2: Positivo dois, botão/u);

  const keyboard = document.root.querySelector('button[data-persona-mode="keyboard"]');
  await keyboard.click();
  await new Promise(resolve => setImmediate(resolve));
  const modePacket = ports[0].posted.find(packet =>
    packet?.envelope?.type === 'PANEL_SET_PERSONA_MODE' && packet.envelope.mode === 'motor');
  assert.deepEqual(modePacket?.envelope, {
    type: 'PANEL_SET_PERSONA_MODE', leaseId: `lease-${'L'.repeat(22)}`, mode: 'motor',
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: modePacket.requestId,
    response: {
      ok: true,
      lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: 'motor', expiresAt: 1_788_001_800_001 },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.root.querySelector('button[data-persona-mode="keyboard"]')?.getAttribute('aria-pressed'), 'true');

  const endPersona = document.root.querySelector('button[data-intent="PERSONA_END"]');
  await endPersona.click();
  await new Promise(resolve => setImmediate(resolve));
  const stopPacket = ports[0].posted.find(packet => packet?.envelope?.type === 'PANEL_STOP_PERSONA');
  assert.deepEqual(stopPacket?.envelope, {
    type: 'PANEL_STOP_PERSONA', leaseId: `lease-${'L'.repeat(22)}`,
  });
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: stopPacket.requestId,
    response: { ok: true, lease: null },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.root.querySelectorAll('button[data-persona-mode][aria-pressed="true"]').length, 0);

  assert.equal(runtimeMessageCalls, 0);
  assert.equal(currentWindowReads, 0);

  const openReportBeforeDisconnect = document.root.querySelector('button[data-intent="OPEN_REPORT"]');
  const interruptedReportRequest = openReportBeforeDisconnect.click();
  await new Promise(resolve => setImmediate(resolve));
  const interruptedReportPacket = ports[0].posted
    .filter(packet => packet?.envelope?.type === 'PANEL_OPEN_REPORT').at(-1);
  assert.notEqual(interruptedReportPacket.requestId, reportRetryPacket.requestId);
  ports[0].onDisconnect.emit();
  await interruptedReportRequest;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(document.root.querySelector('[data-focus-id="result-summary"]'),
    'a Port interruption while opening the report must not discard the completed result');
  assert.ok(document.root.querySelector('button[data-intent="OPEN_REPORT"]'));
  assert.equal(
    document.root.querySelector('[role="status"][aria-live="polite"]')?.textContent,
    'Não foi possível abrir o relatório. Tente novamente.',
  );
});
