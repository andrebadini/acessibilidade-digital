import assert from 'node:assert/strict';
import test from 'node:test';

import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { canonicalTime, runAudit } from '../../src/background/run-audit.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { remapAuditPage } from '../../src/core/batch/remap-audit.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { createAnnotationMapFixture } from '../report/annotation-map-fixture.js';
import { captureElement as captureElementEvidence, captureFullPage as captureFullPageEvidence } from '../../src/browser/capture-evidence.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TEST_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

test('exports the single canonical audit timestamp normalizer used by observed runners', () => {
  assert.equal(canonicalTime('2026-08-29T10:00:00-04:00'), '2026-08-29T14:00:00.000Z');
  assert.throws(() => canonicalTime('not-a-time'), /relógio/u);
});

function rawPage() {
  return {
    format: 'simplified-v1',
    document: { url: 'https://example.test/final?token=REMOVE&view=public', title: 'Página', language: 'pt-BR' },
    coverage: { runtime: { outcome: 'complete' }, accessibility: { outcome: 'complete' } },
    warnings: [],
    layoutMetrics: { cssContentSize: { width: 800, height: 1200 }, cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } },
    nodes: [
      { backendNodeId: 1, tagName: 'button', attributes: { id: 'ok' }, text: 'OK', parentBackendNodeId: null, rect: { x: 10, y: 20, width: 80, height: 30 } },
      { backendNodeId: 2, tagName: 'button', attributes: { id: 'other' }, text: 'Outro', parentBackendNodeId: null, rect: { x: 10, y: 60, width: 80, height: 30 } },
      { backendNodeId: 3, tagName: 'video', attributes: { id: 'clip' }, text: '', parentBackendNodeId: null, rect: { x: 10, y: 100, width: 320, height: 180 }, media: { kind: 'video', currentSrc: 'https://user:pass@example.test/clip.mp4?token=REMOVE&lang=pt' } },
    ],
    axTree: { nodes: [] },
  };
}

function pageWithAxName(name) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    attributes: {
      ...page.nodes[0].attributes,
      'aria-label': 'Fallback DOM',
      'aria-selected': 'true',
      'aria-expanded': 'false',
      'aria-invalid': 'grammar',
    },
    checked: 'mixed',
    disabled: true,
    required: true,
  };
  page.axTree.nodes = [{
    backendDOMNodeId: 1,
    role: { value: 'button' },
    name: { value: name },
    description: { value: 'Envia o formulário' },
    value: { value: 'Pronto' },
  }];
  return page;
}

function pageWithSensitiveControl(secret) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    tagName: 'input',
    attributes: { id: 'credential', type: 'password', autocomplete: 'current-password', value: secret },
    text: secret,
    visibleText: secret,
    form: { type: 'password', value: secret, currentValue: secret },
  };
  page.axTree.nodes = [{
    backendDOMNodeId: 1,
    role: { value: 'textbox' },
    name: { value: 'Senha da conta' },
    value: { value: secret },
  }];
  return page;
}

function pageWithEditableSecret(secret) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    tagName: 'input',
    attributes: { id: 'api-field', type: 'text', name: 'api_key', value: secret },
    text: secret,
    visibleText: secret,
    form: { type: 'text', value: secret, currentValue: secret, rawValue: secret, inputValue: secret },
  };
  page.axTree.nodes = [{
    backendDOMNodeId: 1,
    role: { value: 'textbox' },
    name: { value: 'Chave da API' },
    description: { value: 'Informe a chave' },
    value: { value: secret },
  }];
  return page;
}

function pageWithFormCheckbox() {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    tagName: 'input',
    attributes: { id: 'terms', type: 'checkbox', 'aria-disabled': 'true', 'aria-required': 'true', 'aria-invalid': 'true' },
    form: { type: 'checkbox', checked: true, disabled: false, required: false },
  };
  page.axTree.nodes = [{ backendDOMNodeId: 1, role: { value: 'checkbox' }, name: { value: 'Aceito os termos' } }];
  return page;
}

function pageWithContentEditableSecret(secret) {
  const page = rawPage();
  page.nodes.push({
    backendNodeId: 8, tagName: 'div', parentBackendNodeId: null,
    attributes: { role: 'button', tabindex: '0', 'aria-label': 'Painel público' },
    text: 'Estrutura pública', visibleText: `Conteúdo público ${secret}`,
    focusable: true, interactive: true, interaction: 'button',
    rect: { x: 8, y: 8, width: 160, height: 96 },
  });
  page.nodes[0] = {
    ...page.nodes[0], tagName: 'div', parentBackendNodeId: 8,
    attributes: {
      id: secret, name: secret, contenteditable: 'true', role: 'textbox', tabindex: '0',
      title: secret, 'aria-label': secret, 'aria-description': secret,
      'aria-labelledby': 'editor-label', 'aria-describedby': 'editor-description',
      'data-private': secret, href: `https://example.test/editor?view=${secret}`,
    },
    selectorHint: `#${secret}`,
    text: secret, visibleText: secret, focusable: true, interactive: true, interaction: 'text-entry',
    media: { kind: 'video', currentSrc: `https://example.test/editor-media?view=${secret}` },
  };
  page.nodes.push({
    backendNodeId: 4, tagName: 'div', parentBackendNodeId: 1,
    attributes: {
      id: secret, name: secret, title: secret, 'aria-label': secret,
      'data-private': secret, src: `https://example.test/child?view=${secret}`,
    },
    selectorHint: `#${secret}`, text: secret, visibleText: secret,
    interactive: true, interaction: 'button',
    media: { kind: 'video', currentSrc: `https://example.test/child-media?view=${secret}` },
    rect: { x: 12, y: 24, width: 40, height: 20 },
  });
  page.nodes.push({
    backendNodeId: 5, tagName: 'input', parentBackendNodeId: 1,
    attributes: { id: secret, name: secret, type: 'text', title: secret, 'data-private': secret, value: secret },
    selectorHint: `#${secret}`, text: secret, visibleText: secret,
    form: { type: 'text', value: secret, currentValue: secret },
    rect: { x: 12, y: 48, width: 80, height: 24 },
  });
  page.nodes.push(
    { backendNodeId: 6, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'editor-label' }, text: 'Editor externo seguro' },
    { backendNodeId: 7, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'editor-description' }, text: 'Descrição externa segura' },
  );
  page.axTree.nodes = [
    { backendDOMNodeId: 8, role: { value: 'button' }, name: { value: 'Painel público' } },
    { backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: secret }, description: { value: secret }, value: { value: secret } },
    { backendDOMNodeId: 4, role: { value: 'generic' }, name: { value: secret }, description: { value: secret }, value: { value: secret } },
    { backendDOMNodeId: 5, role: { value: 'textbox' }, name: { value: 'Campo interno seguro' }, description: { value: 'Descrição do campo segura' }, value: { value: secret } },
  ];
  return page;
}

function pageWithSelect({ attributeMultiple = false, formMultiple = false, axRole = '' } = {}) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0], tagName: 'select',
    attributes: { id: 'choice', ...(attributeMultiple ? { multiple: '' } : {}) },
    form: { type: 'select', multiple: formMultiple },
  };
  page.axTree.nodes = axRole ? [{ backendDOMNodeId: 1, role: { value: axRole }, name: { value: 'Escolha' } }] : [];
  return page;
}

function pageWithFallbackInput(type) {
  const page = rawPage();
  page.nodes[0] = { ...page.nodes[0], tagName: 'input', attributes: { id: `field-${type}`, type }, form: { type } };
  page.axTree.nodes = [];
  return page;
}

function fakeAdapter(options = {}) {
  const events = [];
  const page = options.page || rawPage();
  let screenshots = 0;
  let fullPageCalls = 0;
  let elementCalls = 0;
  let disconnects = 0;
  let removals = 0;
  const cdp = {
    async command(method, params = {}) {
      if (method === 'Page.getLayoutMetrics') return page.layoutMetrics;
      if (method === 'Page.captureScreenshot') {
        screenshots += 1;
        const pristine = screenshots === 1;
        events.push(pristine ? 'full-page' : `thumbnail:${params.clip?.y}`);
        if (options.fullPageFailure && pristine) {
          throw options.fullPageFailure instanceof Error ? options.fullPageFailure : new Error('capture unavailable');
        }
        return { data: PNG };
      }
      if (method === 'DOM.getOuterHTML') {
        if (options.snippetFailureNode === params.backendNodeId) throw new Error('node vanished');
        options.afterSnippet?.(params.backendNodeId);
        return { outerHTML: options.outerHtml?.(params.backendNodeId) ?? `<button data-token="SECRET">Node ${params.backendNodeId}</button>` };
      }
      return {};
    },
    async disconnect() {
      disconnects += 1;
      events.push('disconnect');
      if (options.disconnectFailure) throw new Error('detalhe privado de desconexão');
    },
  };
  const sessionValues = {};
  let randomValue = 0;
  const adapter = {
    events,
    get counts() { return { screenshots, fullPageCalls, elementCalls, disconnects, removals }; },
    async createTab() {
      events.push('create-tab');
      if (options.createTabFailure) throw new Error('detalhe privado de criação');
      return Object.hasOwn(options, 'createTabResult') ? options.createTabResult : { id: 42, windowId: 9 };
    },
    async navigateTab(_id, url) { events.push(`navigate:${url}`); },
    async waitForStable(_id, { signal } = {}) {
      events.push('stable');
      if (options.waitFailure) throw options.waitFailure;
      if (signal?.aborted) throw signal.reason;
      return { url: 'https://example.test/final?token=REMOVE&view=public' };
    },
    async probeDocumentIdentity(tabId) { return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}` }; },
    async getEvidenceUrl() { return 'https://example.test/final?view=public'; },
    async probePrivacySignals() { return []; },
    async connectCdp() { events.push('connect-cdp'); return cdp; },
    async runAxeInTab() {
      events.push('axe');
      if (options.axeFailure) throw options.axeFailure;
      return options.axeRun || {
        status: 'disabled', provenance: AXE_PROVENANCE, frames: [],
        diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }],
      };
    },
    async collectPage() {
      events.push('collect');
      options.afterCollect?.();
      if (options.collectError) throw options.collectError;
      if (options.collectFailure) throw new Error('DOM unavailable');
      return page;
    },
    async runDynamicProbes() { events.push('probes'); return options.rawProbes || { focus: { completed: false, events: [] }, warnings: [], actions: [] }; },
    async getEnvironment() {
      return Object.hasOwn(options, 'environmentResult')
        ? options.environmentResult
        : { chromeVersion: 'Chrome/140.0', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } };
    },
    async getFinalUrl() { return 'https://example.test/final?token=REMOVE&view=public'; },
    async emitProgress(message) { events.push(`progress:${message.percent}`); },
    async handoffReport(model) { events.push('handoff'); return options.handoff || { reviewUrl: `chrome-extension://${TEST_EXTENSION_ID}/src/review/index.html?auditId=${model.auditId}`, artifact: { status: 'pending', formats: [] } }; },
    async removeTab(id) {
      if (!Object.hasOwn(options, 'createTabResult')) assert.equal(id, 42);
      removals += 1;
      events.push(`remove-tab:${String(id)}`);
      if (options.removeTabFailure) throw new Error('detalhe privado de fechamento');
    },
  };
  if (options.trackCaptureCalls) {
    adapter.captureFullPage = async (...args) => { fullPageCalls += 1; return captureFullPageEvidence(...args); };
    adapter.captureElement = async (...args) => { elementCalls += 1; return captureElementEvidence(...args); };
  }
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {}; },
        async set(entries) { Object.assign(sessionValues, structuredClone(entries)); },
        async remove(key) { delete sessionValues[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
      epochNow: () => 1_788_000_000_000,
      capturePolicy: createCapturePolicyV1({ mode: options.mode ?? (options.noPixels ? 'no-pixels' : 'full-evidence'), includeQuery: false }),
      privacyDecision: options.noPixels || options.mode === 'no-pixels'
        ? Object.freeze({ status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' })
        : Object.freeze({
          status: 'allowed', consentCapabilityId: 'consent-a', documentId: 'document-a',
          urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
        }),
      ...(options.noPixels || options.mode === 'no-pixels' ? {} : { consentAuthority: Object.freeze({ async consume() { return true; } }) }),
    }),
  });
  if (options.composeMap || options.mapFailure) adapter.composeAnnouncementMap = async input => {
    events.push('map');
    if (options.mapFailure) throw options.mapFailure;
    return options.composeMap(input);
  };
  return adapter;
}

const clock = (() => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 26, 14, 0, tick++)).toISOString();
})();

function legacyOccurrenceHash(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

test('keeps diagnostics and evidence correlated when two new findings have the same legacy hash ID', async () => {
  const auditId = 'audit-real-collision';
  const firstBackendId = 180154;
  const secondBackendId = 300601;
  const signature = (backendId, ordinal) => [
    auditId, '5.8.6', 'target-size-enhanced', `n-${backendId}`, ordinal,
  ].join('\u0000');
  assert.equal(legacyOccurrenceHash(signature(firstBackendId, 10)), legacyOccurrenceHash(signature(secondBackendId, 11)));

  const page = rawPage();
  page.nodes = [firstBackendId, secondBackendId].map((backendNodeId, index) => ({
    backendNodeId,
    tagName: 'button',
    attributes: {},
    text: `Alvo ${index + 1}`,
    parentBackendNodeId: null,
    rect: { x: index * 30, y: 0, width: 20, height: 20 },
  }));
  const model = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page,
      snippetFailureNode: firstBackendId,
      rawProbes: {
        focus: { completed: false, events: [] },
        targetSizes: [firstBackendId, secondBackendId].map(backendNodeId => ({
          nodeId: `n-${backendNodeId}`, width: 20, height: 20,
          exception: 'none', exceptionProof: 'complete',
        })),
        warnings: [], actions: [],
      },
    }),
    now: clock,
    idFactory: () => auditId,
  });

  const occurrences = model.occurrences.filter(value => value.ruleId === 'target-size-enhanced');
  assert.equal(occurrences.length, 2);
  assert.equal(new Set(occurrences.map(value => value.occurrenceId)).size, 2);
  const first = occurrences.find(value => value.nodeId === `n-${firstBackendId}`);
  const second = occurrences.find(value => value.nodeId === `n-${secondBackendId}`);
  const diagnostic = model.session.diagnostics.find(value => value.code === 'SNIPPET_CAPTURE_FAILED');
  assert.equal(diagnostic.details.occurrenceId, first.occurrenceId);
  assert.notEqual(diagnostic.details.occurrenceId, second.occurrenceId);
  for (const occurrence of occurrences) {
    const elementEvidence = model.evidence.artifacts.find(value => value.nodeId === occurrence.nodeId);
    assert.ok(elementEvidence);
    assert.ok(occurrence.evidenceIds.includes(elementEvidence.evidenceId));
  }
});

test('runs the 130→146 pipeline with pristine capture before collection, probes and rules', async () => {
  const adapter = fakeAdapter();
  const model = await runAudit({
    url: ' example.test/start?password=REMOVE&view=public ', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-1', closeAuditTab: true,
  });
  assert.equal(model.auditId, 'audit-1');
  assert.equal(model.ruleResults.length, 131);
  assert.equal(model.methodology.coreRuleCount, 130);
  assert.equal(model.methodology.supplementalRuleCount, 1);
  assert.equal(model.ruleResults.find(rule => rule.ruleId === 'editorial.placeholder-text').outcome, 'inapplicable');
  assert.equal(model.itemResults.length, 146);
  assert.equal(model.session.status, 'complete');
  assert.equal(model.axe.status, 'disabled');
  assert.ok(model.limitations.some(value => /axe-core|MV3|CSP/i.test(value)));
  assert.ok(model.session.diagnostics.some(value => value.code === 'AXE_FEATURE_DISABLED'));
  assert.equal(model.requestedUrl, 'https://example.test/');
  assert.equal(model.finalUrl, 'https://example.test/final?view=public');
  assert.ok(adapter.events.indexOf('full-page') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('probes'));
  assert.ok(adapter.events.indexOf('full-page') < adapter.events.indexOf('probes'));
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
  assert.equal(model.evidence.artifacts.filter(item => item.kind === 'full-page').length, 1);
  assert.ok(model.evidence.artifacts.every(item => /^[a-f0-9]{64}$/u.test(item.hash)));
  for (const key of ['snapshotHash', 'ruleResultsHash', 'evidenceHash']) {
    assert.match(model.reproducibility[key], /^[a-f0-9]{64}$/u, key);
  }
  assert.equal(model.evidence.artifacts.filter(item => item.nodeId === 'n-1').length, 1);
  assert.deepEqual(model.evidence.artifacts.find(item => item.nodeId === 'n-1').metadata.highlightBox, {
    x: 10, y: 20, width: 80, height: 30,
    coordinateSpace: 'capture-css-px',
  });
  assert.ok(model.occurrences.length > 0);
  assert.deepEqual(model.occurrences.map(value => value.occurrenceId), model.occurrences.map((_value, index) =>
    `occurrence-page-1-${String(index + 1).padStart(6, '0')}`));
  for (const occurrence of model.occurrences) {
    assert.ok(['failed', 'cantTell'].includes(occurrence.outcome));
    assert.ok(occurrence.evidenceIds.length > 0 || occurrence.justification);
    if (occurrence.nodeId) {
      const elementEvidence = model.evidence.artifacts.find(item => item.nodeId === occurrence.nodeId);
      assert.ok(elementEvidence);
      assert.ok(occurrence.evidenceIds.includes(elementEvidence.evidenceId));
    }
  }
  for (const item of model.itemResults.filter(value => value.outcome === 'cantTell' && ['manual', 'assisted'].includes(value.evaluation))) {
    assert.ok(model.occurrences.some(occurrence => occurrence.itemId === item.id));
  }
  const percents = model.progress.map(entry => entry.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.deepEqual(model.progress.map(entry => entry.message), [
    'Abrindo o site', 'Lendo a estrutura', 'Verificando acessibilidade',
    'Preparando evidências', 'Gerando relatório', 'Auditoria concluída',
  ]);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.occurrences), true);
  assert.doesNotThrow(() => JSON.stringify(model));
  assert.doesNotMatch(JSON.stringify(model), /REMOVE|SECRET|user:pass|password=/i);
});

test('public compatibility path defaults to an owned proof boundary and performs no pixel operation without consent', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  const model = await runAudit({
    url: 'https://example.test/?secret=ERASE', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-owned-no-pixels',
  });
  assert.equal(adapter.counts.screenshots, 0);
  assert.ok(adapter.events.indexOf('create-tab') < adapter.events.findIndex(value => value.startsWith('navigate:')));
  assert.ok(adapter.events.findIndex(value => value.startsWith('navigate:')) < adapter.events.findIndex(value => value.startsWith('remove-tab:')));
  assert.equal(Object.hasOwn(model, 'checkpoint'), false);
  assert.doesNotMatch(JSON.stringify(model), /owner-|navigationToken|urlSessionDigest|ERASE/u);
});

test('uses one conservative durable URL projection for successful and failed no-pixels audits', async () => {
  const rawUrl = 'https://example.test/pessoa/CPF-123456789?case=7&secret=x#fragmento';
  const models = [
    await runAudit({ url: rawUrl, chromeAdapter: fakeAdapter({ noPixels: true }), now: clock, idFactory: () => 'audit-safe-url-success' }),
    await runAudit({ url: rawUrl, chromeAdapter: fakeAdapter({ noPixels: true, waitFailure: new Error('PRIVATE_NATIVE_URL') }), now: clock, idFactory: () => 'audit-safe-url-failure' }),
  ];
  const durable = JSON.stringify(models);
  assert.match(durable, /https:\/\/example\.test/u);
  assert.doesNotMatch(durable, /CPF-123456789|case=7|secret=x|fragmento|PRIVATE_NATIVE_URL|\?case=7|&secret=x/u);
});

test('routes element-only, no-pixels, and full-evidence capture independently', async () => {
  const elementOnly = fakeAdapter({ mode: 'element-only', trackCaptureCalls: true });
  const elementModel = await runAudit({
    url: 'https://example.test/', chromeAdapter: elementOnly, now: clock, idFactory: () => 'audit-element-only',
  });
  assert.equal(elementOnly.counts.fullPageCalls, 0);
  assert.ok(elementOnly.counts.elementCalls >= 1);
  assert.equal(elementModel.evidence.artifacts.some(artifact => artifact.kind === 'full-page'), false);
  assert.equal(elementModel.evidence.artifacts.some(artifact => artifact.kind === 'announcement-map'), false);
  const element = elementModel.evidence.artifacts.find(artifact => artifact.kind === 'element' && artifact.dataUrl);
  assert.ok(element);
  assert.equal(Object.hasOwn(element, 'fullPageEvidenceId'), false);

  const noPixels = fakeAdapter({ mode: 'no-pixels', trackCaptureCalls: true });
  await runAudit({ url: 'https://example.test/', chromeAdapter: noPixels, now: clock, idFactory: () => 'audit-no-pixels-route' });
  assert.equal(noPixels.counts.screenshots, 0);
  assert.equal(noPixels.counts.fullPageCalls, 0);
  assert.equal(noPixels.counts.elementCalls, 0);

  const full = fakeAdapter({ mode: 'full-evidence', trackCaptureCalls: true });
  const fullModel = await runAudit({ url: 'https://example.test/', chromeAdapter: full, now: clock, idFactory: () => 'audit-full-route' });
  assert.ok(full.counts.screenshots >= 2);
  assert.equal(full.counts.fullPageCalls, 1);
  assert.ok(full.counts.elementCalls >= 1);
  assert.equal(fullModel.evidence.artifacts.some(artifact => artifact.kind === 'full-page'), true);
  assert.equal(fullModel.evidence.artifacts.some(artifact => artifact.kind === 'element' && artifact.dataUrl), true);
});

test('orders capture→axe→collect→probes→core→normalize, correlates target-size by node and drops raw axe', async () => {
  const page = rawPage();
  page.nodes = [
    { backendNodeId: 10, tagName: 'html', attributes: {}, text: '', parentBackendNodeId: null, rect: { x: 0, y: 0, width: 800, height: 600 } },
    { backendNodeId: 11, tagName: 'body', attributes: {}, text: '', parentBackendNodeId: 10, rect: { x: 0, y: 0, width: 800, height: 600 } },
    { backendNodeId: 12, tagName: 'button', attributes: {}, text: 'Continuar', parentBackendNodeId: 11, rect: { x: 10, y: 20, width: 20, height: 20 } },
  ];
  const options = {
    page,
    rawProbes: {
      focus: { completed: false, events: [] },
      targetSizes: [{ nodeId: 'n-12', width: 20, height: 20, exception: 'none', exceptionProof: 'complete' }],
      warnings: [], actions: [],
    },
  };
  const adapter = fakeAdapter(options);
  let normalizeObserved = false;
  options.axeRun = new Proxy({
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [], privateRaw: 'AXE_RAW_PRIVATE_SENTINEL',
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{ id: 'target-size', impact: 'serious', nodes: [{ impact: 'serious', target: 'html > body > button' }] }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  }, {
    getOwnPropertyDescriptor(target, property) {
      if (!normalizeObserved) {
        normalizeObserved = true;
        adapter.events.push('normalize-axe');
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-target-size-order',
  });
  const axe = model.occurrences.find(occurrence => occurrence.ruleId === 'axe.target-size');
  const core = model.occurrences.find(occurrence => occurrence.ruleId === 'target-size-minimum');

  assert.ok(adapter.events.indexOf('full-page') < adapter.events.indexOf('axe'));
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('collect') < adapter.events.indexOf('probes'));
  assert.ok(adapter.events.indexOf('probes') < adapter.events.indexOf('normalize-axe'));
  assert.equal(core.outcome, 'failed');
  assert.equal(core.nodeId, 'n-12');
  assert.equal(axe.outcome, 'failed', 'conclusion proves core authority existed before axe normalization');
  assert.equal(axe.nodeId, 'n-12');
  assert.equal(axe.applicabilityEvidence.nodeId, 'n-12');
  const group = model.presentation.groups.find(entry => entry.occurrenceIds.includes(core.occurrenceId));
  assert.deepEqual(group.occurrenceIds, [core.occurrenceId, axe.occurrenceId]);
  assert.doesNotMatch(JSON.stringify(model), /AXE_RAW_PRIVATE_SENTINEL/u);

  const reportOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  const report = await enrichAuditForReport(model, reportOptions);
  assert.doesNotThrow(() => createAuditModel(report));
  assert.doesNotThrow(() => renderHtmlReport(report));
  const technical = JSON.parse(renderTechnicalJson(report));
  assert.equal(technical.assertions.length, 146);
  assert.deepEqual(technical.audit, report);

  const attacks = [
    candidate => {
      candidate.occurrences.find(value => value.ruleId === 'axe.target-size').applicabilityEvidence.nodeId = 'n-11';
      candidate.axe.occurrences.find(value => value.ruleId === 'axe.target-size').applicabilityEvidence.nodeId = 'n-11';
    },
    candidate => {
      candidate.occurrences.push(structuredClone(candidate.occurrences.find(value => value.ruleId === 'axe.target-size')));
      candidate.axe.occurrences.push(structuredClone(candidate.axe.occurrences.find(value => value.ruleId === 'axe.target-size')));
    },
    candidate => {
      candidate.occurrences.find(value => value.ruleId === 'axe.target-size').outcome = 'cantTell';
      candidate.axe.occurrences.find(value => value.ruleId === 'axe.target-size').outcome = 'cantTell';
    },
  ];
  for (const mutate of attacks) {
    const candidate = structuredClone(report);
    mutate(candidate);
    candidate.integrity.canonicalModelHash = 'pending';
    candidate.integrity.evidenceManifestHash = 'pending';
    assert.throws(() => createAuditModel(candidate), /modelo|axe|inválid|ocorrência/iu);
    await assert.rejects(enrichAuditForReport(candidate, reportOptions), /modelo|axe|inválid|ocorrência/iu);
    assert.throws(() => renderHtmlReport(candidate), /modelo|axe|inválid|ocorrência/iu);
    assert.throws(() => renderTechnicalJson(candidate), /modelo|axe|inválid|ocorrência/iu);
  }
});

test('creates one page-level derived map after structural evidence without mutating or linking the pristine source', async () => {
  let pristineBefore;
  let pristineAfter;
  let observedDeviceScaleFactor;
  const adapter = fakeAdapter({
    composeMap: async input => {
      observedDeviceScaleFactor = input.layoutMetrics.deviceScaleFactor;
      pristineBefore = JSON.stringify(input.fullPageEvidence);
      const artifact = await createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId });
      pristineAfter = JSON.stringify(input.fullPageEvidence);
      return artifact;
    },
  });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-annotation-map',
  });
  const map = model.evidence.artifacts.find(artifact => artifact.kind === 'announcement-map');
  const pristine = model.evidence.artifacts.find(artifact => artifact.kind === 'full-page');

  assert.equal(map.status, 'complete');
  assert.equal(map.fullPageEvidenceId, pristine.evidenceId);
  assert.equal(pristineBefore, pristineAfter);
  assert.equal(observedDeviceScaleFactor, 1);
  assert.ok(adapter.events.indexOf('map') > adapter.events.findLastIndex(event => event.startsWith('thumbnail:')));
  assert.ok(adapter.events.indexOf('map') < adapter.events.indexOf('handoff'));
  assert.equal(model.occurrences.some(occurrence => occurrence.evidenceIds.includes(map.evidenceId)), false);
  assert.equal(model.session.status, 'complete');
});

test('keeps the pristine evidence and reports a fixed recoverable diagnostic when the local map compositor fails', async () => {
  const adapter = fakeAdapter({
    mapFailure: Object.assign(new Error('PRIVATE-RAW-ERROR'), { code: 'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE' }),
  });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-annotation-map-failure',
  });

  assert.equal(model.evidence.artifacts.some(artifact => artifact.kind === 'full-page'), true);
  assert.equal(model.evidence.artifacts.some(artifact => artifact.kind === 'announcement-map'), false);
  assert.equal(model.session.status, 'partial');
  assert.ok(model.session.diagnostics.some(entry => entry.code === 'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE'));
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE-RAW-ERROR/u);
});

test('preserves the explicit printable-segment limit diagnostic from the map compositor', async () => {
  const adapter = fakeAdapter({
    mapFailure: Object.assign(new Error('PRIVATE-RAW-ERROR'), { code: 'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT' }),
  });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-annotation-map-print-limit',
  });

  assert.equal(model.session.status, 'partial');
  assert.ok(model.session.diagnostics.some(entry => entry.code === 'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT'));
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE-RAW-ERROR/u);
});

test('integrates the recommendation failure, editorial occurrence and informational widget inventory without cross-contamination', async () => {
  const page = rawPage();
  page.nodes.push(
    {
      backendNodeId: 20, tagName: 'a', attributes: { href: '/ajuda', target: '  _BLANK  ' },
      text: 'Ajuda', visibleText: 'Ajuda', parentBackendNodeId: null,
      adjacentNewWindowWarning: false, linkPurposeContext: 'missing-context',
      rect: { x: 10, y: 200, width: 80, height: 24 },
    },
    {
      backendNodeId: 21, tagName: 'p', attributes: {},
      text: 'Lorem ipsum PRIVATE-MATCH-SENTINEL', visibleText: 'Lorem ipsum PRIVATE-MATCH-SENTINEL',
      parentBackendNodeId: null, rect: { x: 10, y: 240, width: 300, height: 40 },
    },
  );
  page.axTree.nodes.push({
    backendDOMNodeId: 20, role: { value: 'link' }, name: { value: 'Ajuda' },
  });
  page.widgetObservations = {
    coverage: 'complete', widgets: {
      vlibras: { dom: true, script: false, global: false },
      'hand-talk': { dom: false, script: false, global: false },
    },
  };
  const snippetNodeIds = [];
  const model = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ page, afterSnippet: backendNodeId => snippetNodeIds.push(backendNodeId) }),
    now: clock, idFactory: () => 'audit-complementary',
  });

  assert.equal(model.methodology.coreRuleCount, 130);
  assert.equal(model.itemResults.length, 146);
  assert.equal(model.itemResults.find(item => item.id === '5.7.6').outcome, 'failed');
  assert.deepEqual(model.accessibilityWidgets, {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'complete',
    widgets: [
      { id: 'vlibras', status: 'present', signals: ['dom-signature'] },
      { id: 'hand-talk', status: 'absent', signals: [] },
    ],
  });
  assert.equal(model.ruleResults.some(rule => rule.ruleId === 'vlibras' || rule.ruleId === 'hand-talk'), false);

  const editorialRule = model.ruleResults.find(rule => rule.ruleId === 'editorial.placeholder-text');
  const editorial = model.occurrences.find(occurrence => occurrence.ruleId === 'editorial.placeholder-text');
  const newWindow = model.occurrences.find(occurrence => occurrence.ruleId === 'new-window-link-warning');
  assert.equal(editorialRule.outcome, 'failed');
  assert.equal(editorial.itemId, null);
  assert.equal(editorial.nbrItemRef, null);
  assert.deepEqual(editorial.evidenceIds, []);
  assert.deepEqual(editorial.target, { nodeId: 'n-21', selector: null, framePath: [] });
  assert.equal(model.manualReview.some(entry => entry.occurrenceId === editorial.occurrenceId), false);
  assert.equal(snippetNodeIds.includes(21), false);
  assert.equal(newWindow.itemId, '5.7.6');
  assert.equal(newWindow.outcome, 'failed');

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const reportEditorial = report.occurrences.find(occurrence => occurrence.ruleId === 'editorial.placeholder-text');
  const reportNewWindow = report.occurrences.find(occurrence => occurrence.ruleId === 'new-window-link-warning');
  assert.deepEqual(reportEditorial.wcagRefs, []);
  assert.deepEqual(reportEditorial.foreignBenchmarkRefs, []);
  assert.deepEqual(reportEditorial.evidenceRefs, []);
  assert.equal(reportEditorial.accessiblePreview, null);
  assert.equal(reportEditorial.legalAnalysis, null);
  assert.deepEqual(reportNewWindow.reason, {
    code: 'missing-new-window-warning',
    context: { behavior: 'target-blank', warning: 'absent' },
  });
  assert.deepEqual(reportNewWindow.itemWcagRefs, ['2.4.4', '2.4.9', '3.2.5']);
  assert.deepEqual(reportNewWindow.sourceWcagRefs, []);
  assert.deepEqual(reportNewWindow.testedWcagRefs, []);
  assert.deepEqual(reportNewWindow.wcagRefs, []);
  assert.deepEqual(reportNewWindow.foreignBenchmarkRefs, []);
  assert.deepEqual(reportNewWindow.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v1' });
  assert.equal(reportNewWindow.classification, 'recommendation');
  assert.deepEqual(reportNewWindow.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v1' });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-MATCH-SENTINEL/iu);
});

test('rejects a forged disabled axe payload even when the report has no axe findings', async () => {
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter(),
    now: clock, idFactory: () => 'audit-disabled-axe-boundary',
  });
  for (const mutate of [
    value => { value.axe.privateText = 'Paciente HIV positivo'; },
    value => { value.axe.diagnostics[0].privateText = 'Paciente HIV positivo'; },
    value => { value.axe.technicalSummary.passes.nodes = 1; },
  ]) {
    const forged = structuredClone(model);
    mutate(forged);
    await assert.rejects(enrichAuditForReport(forged, {
      now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
    }), /axe|inválid|esquema|resumo/i);
  }
});

test('integrates a confirmed top-frame axe violation with provenance, ABNT outcome and fixed legal reference', async () => {
  const page = rawPage();
  page.document.language = '';
  const axeRun = {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{
        id: 'html-has-lang', impact: 'serious', tags: ['wcag2a', 'wcag311', 'section508'],
        nodes: [{ impact: 'serious', target: ['html'], html: '<html data-private="NÃO-PERSISTIR">', failureSummary: 'NÃO-PERSISTIR' }],
      }],
      incomplete: [], passes: [{ id: 'document-title', nodes: [] }], inapplicable: [],
    } }],
  };
  const adapter = fakeAdapter({ page, axeRun });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-axe-confirmed',
  });
  const axeOccurrence = model.occurrences.find(occurrence => occurrence.source?.engine === 'axe-core');
  const coreOccurrence = model.occurrences.find(occurrence => occurrence.ruleId === 'page-language');

  assert.equal(model.ruleResults.length, 132);
  assert.equal(model.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
  assert.equal(axeOccurrence.outcome, 'failed');
  assert.equal(axeOccurrence.itemId, '5.13.2');
  assert.equal(axeOccurrence.applicabilityEvidence.source.ruleId, 'page-language');
  assert.deepEqual(axeOccurrence.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v1' });
  assert.ok(axeOccurrence.evidenceIds.includes(model.evidence.artifacts.find(item => item.kind === 'full-page').evidenceId));
  assert.equal(model.axe.provenance.version, '4.13.0');
  assert.equal(model.axe.provenance.config.rules['target-size'].enabled, true);
  assert.equal(model.ruleResults.some(rule => rule.outcome === 'passed' && rule.source?.engine === 'axe-core'), false);
  assert.doesNotMatch(JSON.stringify(model), /NÃO-PERSISTIR|section508/iu);
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('probes'));
  assert.ok(coreOccurrence);
  const corroboratedGroup = model.presentation.groups.find(group =>
    group.occurrenceIds.includes(coreOccurrence.occurrenceId));
  assert.deepEqual(corroboratedGroup.occurrenceIds, [coreOccurrence.occurrenceId, axeOccurrence.occurrenceId]);
  assert.deepEqual(corroboratedGroup.sources.map(source => source.engine), ['audita-core', 'axe-core']);
  assert.ok(corroboratedGroup.occurrenceIds.every(id => model.occurrences.some(occurrence => occurrence.occurrenceId === id)));

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const reportOccurrence = report.occurrences.find(occurrence => occurrence.source.engine === 'axe-core');
  assert.equal(report.schemaVersion, 2);
  assert.equal(reportOccurrence.target.selector, 'html');
  assert.equal(reportOccurrence.impact, 'serious');
  assert.equal(reportOccurrence.confidence, 'high');
  assert.deepEqual(reportOccurrence.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v1' });
  assert.deepEqual(reportOccurrence.wcagRefs, reportOccurrence.testedWcagRefs);
  assert.deepEqual(reportOccurrence.foreignBenchmarkRefs.map(reference => reference.criterionId), reportOccurrence.testedWcagRefs);
  const forgedResultType = structuredClone(report);
  forgedResultType.occurrences.find(occurrence => occurrence.source.engine === 'axe-core').engineResultType = 'incomplete';
  await assert.rejects(enrichAuditForReport(forgedResultType, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }), /axe|suplement|diverge|inválid/i);

  const mutations = [
    value => { value.ruleResults.find(rule => rule.source?.engine === 'axe-core').summary = 'Prontuário privado Oliveira'; },
    value => { value.occurrences.find(item => item.source?.engine === 'axe-core').justification = 'Prontuário privado Oliveira'; },
    value => { value.ruleResults.find(rule => rule.source?.engine === 'axe-core').privateText = 'Prontuário privado Oliveira'; },
    value => { value.occurrences.find(item => item.source?.engine === 'axe-core').privateText = 'Prontuário privado Oliveira'; },
    value => { value.occurrences.find(item => item.source?.engine === 'axe-core').target.privateText = 'Prontuário privado Oliveira'; },
    value => {
      const occurrence = value.occurrences.find(item => item.source?.engine === 'axe-core');
      const fullPage = value.evidence.artifacts.find(item => item.kind === 'full-page' && item.state === 'pristine');
      occurrence.evidenceIds = occurrence.evidenceIds.filter(id => id !== fullPage.evidenceId);
    },
    value => { value.evidence.artifacts.find(item => item.kind === 'full-page').state = 'annotated'; },
    value => {
      value.evidence.artifacts.find(item => item.kind === 'full-page').state = 'annotated';
      value.session.diagnostics.push({
        code: 'FULL_PAGE_CAPTURE_FAILED', message: 'Paciente HIV positivo',
        at: '2026-08-26T15:00:00.000Z', recoverable: true,
      });
    },
    value => { value.itemResults.find(item => item.id === '5.13.2').outcome = 'cantTell'; },
    value => {
      const rule = value.ruleResults.find(item => item.source?.engine === 'axe-core');
      const occurrence = value.occurrences.find(item => item.source?.engine === 'axe-core');
      const normalizedRule = value.axe.ruleResults[0];
      const normalizedOccurrence = value.axe.occurrences[0];
      for (const target of [rule, normalizedRule]) {
        target.ruleId = 'axe.fake-rule'; target.engineRuleId = 'fake-rule';
        target.source.ruleId = 'axe.fake-rule'; target.source.engineRuleId = 'fake-rule';
      }
      for (const target of [occurrence, normalizedOccurrence]) {
        target.ruleId = 'axe.fake-rule'; target.engineRuleId = 'fake-rule';
        target.source.ruleId = 'axe.fake-rule'; target.source.engineRuleId = 'fake-rule';
      }
    },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(model);
    mutate(forged);
    await assert.rejects(enrichAuditForReport(forged, {
      now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
    }), /axe|suplement|autoritativ|diverge|inválid/i);
  }
});

test('keeps a conclusive axe occurrence auditable when pristine capture absence has the fixed bounded diagnostic', async () => {
  const page = rawPage();
  page.document.language = '';
  const axeRun = {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{ id: 'html-has-lang', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  };
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page, axeRun, fullPageFailure: new Error('capture') }),
    now: clock, idFactory: () => 'audit-axe-no-pristine',
  });
  assert.equal(model.evidence.artifacts.some(item => item.kind === 'full-page' && item.state === 'pristine'), false);
  assert.ok(model.session.diagnostics.some(item => item.code === 'FULL_PAGE_CAPTURE_FAILED' &&
    item.message === 'Não foi possível capturar a página completa no estado original.'));
  await assert.doesNotReject(enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }));
});

test('rejects a forged failed item when validated axe evidence is only cantTell', async () => {
  const axeRun = {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [],
      incomplete: [{ id: 'document-title', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
      passes: [], inapplicable: [],
    } }],
  };
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ axeRun }),
    now: clock, idFactory: () => 'audit-axe-cant-tell',
  });
  assert.equal(model.itemResults.find(item => item.id === '5.13.1').outcome, 'cantTell');
  const enrichOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  await assert.doesNotReject(enrichAuditForReport(model, enrichOptions));
  const forged = structuredClone(model);
  forged.itemResults.find(item => item.id === '5.13.1').outcome = 'failed';
  await assert.rejects(enrichAuditForReport(forged, enrichOptions), /autoritativ|diverge|axe|inválid/i);

  const forgedReview = structuredClone(model);
  Object.assign(forgedReview.itemResults.find(item => item.id === '5.13.1'), {
    originalOutcome: 'cantTell', reviewedOutcome: 'failed', outcome: 'failed',
    review: { mode: 'assisted', evaluator: 'forjado', decidedAt: '2026-08-26T15:00:00.000Z', decisionIds: [] },
  });
  const projectedReview = await enrichAuditForReport(forgedReview, enrichOptions);
  const projectedItem = projectedReview.itemResults.find(item => item.id === '5.13.1');
  assert.equal(projectedItem.outcome, 'cantTell');
  assert.equal(Object.hasOwn(projectedItem, 'reviewedOutcome'), false);
  assert.equal(Object.hasOwn(projectedItem, 'review'), false);
});

for (const fixture of [
  { ruleId: 'input-image-alt', target: 'input', itemId: '5.2.2', wcag: ['1.1.1', '2.4.4', '2.4.9'], sourceWcag: ['1.1.1'] },
  { ruleId: 'meta-viewport', target: 'meta', itemId: '5.13.5', wcag: ['1.4.4', '1.4.10'], sourceWcag: ['1.4.4'] },
  { ruleId: 'aria-roles', target: 'div', itemId: '5.13.12', wcag: ['1.3.1', '4.1.2'], sourceWcag: ['4.1.2'] },
  { ruleId: 'frame-title', target: 'iframe', itemId: '5.13.4', wcag: ['1.3.1', '4.1.2'], sourceWcag: ['4.1.2'] },
]) {
  test(`keeps item context but claims no tested WCAG/508 coverage for incomplete ${fixture.ruleId}`, async () => {
    const axeRun = {
      status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
      frames: [{ frameId: 0, status: 'success', result: {
        violations: [], incomplete: [{
          id: fixture.ruleId, impact: 'serious',
          nodes: [{ impact: 'serious', target: [fixture.target] }],
        }], passes: [], inapplicable: [],
      } }],
    };
    const model = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter({ axeRun }), now: clock,
      idFactory: () => `audit-axe-${fixture.ruleId}`,
    });
    const report = await enrichAuditForReport(model, {
      now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
    });
    const occurrence = report.occurrences.find(item => item.source?.engine === 'axe-core');
    assert.equal(occurrence.nbrItemRef, fixture.itemId);
    assert.deepEqual(occurrence.itemWcagRefs, fixture.wcag);
    assert.deepEqual(occurrence.sourceWcagRefs, fixture.sourceWcag);
    assert.deepEqual(occurrence.testedWcagRefs, []);
    assert.deepEqual(occurrence.wcagRefs, []);
    assert.deepEqual(occurrence.foreignBenchmarkRefs, []);
    assert.equal(occurrence.outcome, 'cantTell');
    assert.equal(occurrence.legalAnalysis, null);
  });
}

test('keeps the Audita core running when axe throws and records a bounded partial diagnostic', async () => {
  const adapter = fakeAdapter({ axeFailure: new Error('PRIVATE axe failure details') });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-axe-partial',
  });

  assert.equal(model.session.status, 'partial');
  assert.equal(model.axe.status, 'partial', 'partial supplemental coverage deterministically marks the audit recoverable/partial');
  assert.equal(model.ruleResults.length, 131);
  assert.equal(model.itemResults.length, 146);
  assert.ok(model.session.diagnostics.some(entry => entry.code === 'AXE_EXECUTION_FAILED'));
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE axe failure details/iu);
  assert.ok(adapter.events.includes('collect'));
  assert.ok(adapter.events.includes('probes'));

  const enrichOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  const forgedSession = structuredClone(model);
  forgedSession.session.status = 'complete';
  await assert.rejects(enrichAuditForReport(forgedSession, enrichOptions), /axe|partial|parcial|session|cobertura/i);

  const report = await enrichAuditForReport(model, enrichOptions);
  const forgedPage = structuredClone(report);
  forgedPage.pages[0].status = 'complete';
  await assert.rejects(enrichAuditForReport(forgedPage, enrichOptions), /axe|partial|parcial|página|cobertura/i);
});

test('normalizes a revoked raw axe collection before report enrichment without proxy exceptions', async () => {
  const pair = Proxy.revocable([], {});
  pair.revoke();
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({
      axeRun: { status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [], frames: pair.proxy },
    }),
    now: clock, idFactory: () => 'audit-axe-revoked-raw',
  });
  assert.equal(model.axe.status, 'partial');
  assert.deepEqual(model.axe.occurrences, []);
  await assert.doesNotReject(enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }));
});

test('attaches normalized AX accessibility to element evidence, its hash and the final HTML', async () => {
  const first = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithAxName('Confirmar pedido') }),
    now: clock, idFactory: () => 'audit-accessibility',
  });
  const second = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithAxName('Enviar pedido') }),
    now: clock, idFactory: () => 'audit-accessibility',
  });
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.deepEqual(evidence.accessibility, {
    name: 'Confirmar pedido',
    nameSource: 'accessibility-tree',
    description: 'Envia o formulário',
    descriptionSource: 'accessibility-tree',
    role: 'button',
    states: ['recolhido', 'indisponível'],
    visibleText: 'OK',
    announcementPreview: 'Confirmar pedido, botão, Envia o formulário, recolhido, indisponível',
  });
  assert.notEqual(evidence.hash, changed.hash);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.match(html, /Nome acessível<\/dt><dd>Confirmar pedido/iu);
  assert.match(html, /Prévia de anúncio<\/dt><dd>Confirmar pedido, botão/iu);
  assert.match(html, /não é transcrição literal/iu);
});

test('never discloses sensitive control values in accessibility, hashes or final HTML', async () => {
  const firstSecret = 'TOPSECRET-current-password';
  const secondSecret = 'OTHERSECRET-current-password';
  const run = secret => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page: pageWithSensitiveControl(secret),
      outerHtml: backendNodeId => backendNodeId === 1
        ? `<input type="password" autocomplete="current-password" value="${secret}">`
        : `<button>Node ${backendNodeId}</button>`,
    }),
    now: clock, idFactory: () => 'audit-sensitive-accessibility',
  });
  const [first, second] = await Promise.all([run(firstSecret), run(secondSecret)]);
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.equal(evidence.accessibility.name, 'Senha da conta');
  assert.equal(Object.hasOwn(evidence.accessibility, 'value'), false);
  assert.doesNotMatch(evidence.accessibility.announcementPreview, /TOPSECRET|current-password/iu);
  assert.equal(evidence.hash, changed.hash);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.doesNotMatch(`${JSON.stringify(first)}\n${evidence.hash}\n${html}`, /TOPSECRET-current-password/iu);
  assert.match(html, /Nome acessível<\/dt><dd>Senha da conta/iu);
  assert.match(html, /Prévia de anúncio/iu);
});

test('removes an ordinary api_key current value from snapshot, evidence, preview, hash and HTML', async () => {
  const run = secret => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page: pageWithEditableSecret(secret),
      outerHtml: backendNodeId => backendNodeId === 1
        ? `<input id="api-field" type="text" name="api_key" value="${secret}">`
        : `<button>Node ${backendNodeId}</button>`,
    }),
    now: clock,
    idFactory: () => 'audit-api-key-privacy',
  });
  const [first, second] = await Promise.all([run('TOPSECRET-one'), run('TOPSECRET-two')]);
  const node = first.snapshot.nodes.find(item => item.nodeId === 'n-1');
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.equal(node.valueStatus, 'omitted-privacy');
  assert.equal(Object.hasOwn(node.attributes, 'value'), false);
  assert.equal(Object.hasOwn(node, 'axValue'), false);
  for (const key of ['value', 'currentValue', 'rawValue', 'inputValue']) assert.equal(Object.hasOwn(node.form, key), false);
  assert.equal(evidence.accessibility.valueStatus, 'omitted-privacy');
  assert.equal(Object.hasOwn(evidence.accessibility, 'value'), false);
  assert.doesNotMatch(evidence.accessibility.announcementPreview, /TOPSECRET|valor/iu);
  assert.doesNotMatch(evidence.snippet, /TOPSECRET|\bvalue=/iu);
  assert.equal(evidence.hash, changed.hash);
  assert.doesNotMatch(JSON.stringify(first), /TOPSECRET/iu);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.match(html, /Valor<\/dt><dd>não coletado por privacidade/iu);
  assert.doesNotMatch(html, /TOPSECRET/iu);
});

test('removes a nested contenteditable secret from model, evidence, preview, hash, snippet and HTML', async () => {
  const run = secret => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page: pageWithContentEditableSecret(secret),
      outerHtml: backendNodeId => {
        if (backendNodeId === 1) return `<div id="${secret}" name="${secret}" contenteditable="true" role="textbox" tabindex="0" aria-labelledby="editor-label" aria-describedby="editor-description" aria-label="${secret}" title="${secret}" data-private="${secret}" href="https://example.test/?view=${secret}"><div title="${secret}">${secret}</div></div>`;
        if (backendNodeId === 4) return `<div id="${secret}" title="${secret}" data-private="${secret}">${secret}</div>`;
        if (backendNodeId === 5) return `<input id="${secret}" name="${secret}" type="text" title="${secret}" data-private="${secret}" value="${secret}">`;
        return '<button id="other">Outro</button>';
      },
    }),
    now: clock,
    idFactory: () => 'audit-contenteditable-privacy',
  });
  const [first, second] = await Promise.all([run('TOPSECRET-editor-one'), run('TOPSECRET-editor-two')]);
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const ancestor = first.snapshot.nodes.find(node => node.nodeId === 'n-8');
  const ancestorEvidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-8');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const descendantEvidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-4');
  const nestedControlEvidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-5');

  assert.equal(ancestor.text, 'Estrutura pública');
  assert.equal(ancestor.visibleText, '');
  assert.ok(ancestorEvidence);
  assert.equal(ancestorEvidence.accessibility.name, 'Painel público');
  assert.equal(ancestorEvidence.accessibility.visibleText, '');
  assert.equal(evidence.snippet, '<div contenteditable="true" role="textbox" tabindex="0" aria-labelledby="editor-label" aria-describedby="editor-description"></div>');
  assert.equal(evidence.accessibility.name, 'Editor externo seguro');
  assert.equal(evidence.accessibility.nameSource, 'aria-labelledby');
  assert.equal(evidence.accessibility.description, 'Descrição externa segura');
  assert.equal(evidence.accessibility.descriptionSource, 'aria-describedby');
  assert.match(evidence.accessibility.announcementPreview, /Editor externo seguro, campo de texto, Descrição externa segura/iu);
  assert.ok(descendantEvidence);
  assert.equal(descendantEvidence.snippet, '<div></div>');
  assert.ok(nestedControlEvidence);
  assert.equal(nestedControlEvidence.snippet, '<input>');
  assert.equal(nestedControlEvidence.accessibility.name, 'Campo interno seguro');
  assert.equal(nestedControlEvidence.accessibility.description, 'Descrição do campo segura');
  assert.equal(evidence.hash, changed.hash);
  assert.deepEqual(
    first.evidence.artifacts.map(artifact => artifact.hash),
    second.evidence.artifacts.map(artifact => artifact.hash),
  );
  for (const artifact of first.evidence.artifacts) assert.doesNotMatch(JSON.stringify(artifact), /TOPSECRET/iu);
  const leakedContexts = [...JSON.stringify(first).matchAll(/.{0,80}TOPSECRET.{0,80}/giu)].map(match => match[0]);
  assert.deepEqual(leakedContexts, []);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.doesNotMatch(html, /TOPSECRET/iu);
  assert.match(html, /Nome acessível<\/dt><dd>Editor externo seguro/iu);
  assert.match(html, /Prévia de anúncio<\/dt><dd>Editor externo seguro, campo de texto, Descrição externa segura/iu);
});

test('lets true ARIA presence win over false node.form state and ignores aria-selected on a button', async () => {
  const checkboxModel = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithFormCheckbox() }),
    now: clock, idFactory: () => 'audit-form-checkbox',
  });
  const buttonModel = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithAxName('Continuar') }),
    now: clock, idFactory: () => 'audit-button-states',
  });
  const checkbox = checkboxModel.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1').accessibility;
  const button = buttonModel.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1').accessibility;

  assert.deepEqual(checkbox.states, ['marcado', 'indisponível', 'obrigatório', 'inválido']);
  assert.match(checkbox.announcementPreview, /marcado, indisponível, obrigatório, inválido/iu);
  assert.doesNotMatch(button.states.join(' '), /selecionado|marcado|obrigatório|inválido/iu);
  assert.deepEqual(button.states, ['recolhido', 'indisponível']);
});

test('uses conservative native roles for range, number, text-like and unknown inputs without AX', async () => {
  const expected = new Map([
    ['range', 'slider'], ['number', 'spinbutton'], ['checkbox', 'checkbox'], ['radio', 'radio'],
    ['button', 'button'], ['text', 'textbox'], ['color', ''],
  ]);
  for (const [type, role] of expected) {
    const model = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithFallbackInput(type) }),
      now: clock, idFactory: () => `audit-role-${type}`,
    });
    const evidence = model.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
    assert.equal(evidence.accessibility.role, role, type);
  }
});

test('maps multiple select to listbox, simple select to combobox and keeps AX role priority', async () => {
  const formMultiple = pageWithSelect({ formMultiple: true });
  formMultiple.nodes[0].form.disabled = true;
  formMultiple.nodes[0].form.required = true;
  const cases = [
    ['attribute', pageWithSelect({ attributeMultiple: true }), 'listbox'],
    ['form', formMultiple, 'listbox'],
    ['simple', pageWithSelect(), 'combobox'],
    ['ax-priority', pageWithSelect({ attributeMultiple: true, axRole: 'combobox' }), 'combobox'],
  ];
  for (const [label, page, expected] of cases) {
    const model = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter({ page }),
      now: clock, idFactory: () => `audit-select-${label}`,
    });
    const accessibility = model.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1').accessibility;
    assert.equal(accessibility.role, expected, label);
    assert.match(accessibility.announcementPreview, expected === 'listbox' ? /caixa de listagem/iu : /caixa de combinação/iu);
    if (label === 'form') assert.deepEqual(accessibility.states, ['indisponível', 'obrigatório']);
  }
});

test('stores readable sanitized snippets and the report encodes them exactly once', async () => {
  const secret = 'TOPSECRET-snippet';
  const run = outerHtml => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      outerHtml: backendNodeId => backendNodeId === 1
        ? outerHtml
        : `<button>Node ${backendNodeId}</button>`,
    }),
    now: clock,
    idFactory: () => 'audit-readable-snippet',
  });
  const model = await run(`<iframe title="Mapa" src="javascript:${secret}" onload="steal()"></iframe><button aria-label="Abrir">Abrir</button></code><script>${secret}</script>`);
  const changed = await run('<iframe title="Mapa"></iframe><button aria-label="Abrir">Outro texto</button></code>');
  const evidence = model.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changedEvidence = changed.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.equal(evidence.snippet, '<iframe title="Mapa"></iframe><button aria-label="Abrir">Abrir</button></code>');
  assert.notEqual(evidence.hash, changedEvidence.hash);
  assert.doesNotMatch(JSON.stringify(model), /TOPSECRET|javascript:|onload=|<script/iu);

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  const encodedSnippet = html.match(/<pre><code>([^]*?)<\/code><\/pre>/u)?.[1];

  assert.match(html, /&lt;iframe title=&quot;Mapa&quot;&gt;&lt;\/iframe&gt;/u);
  assert.match(html, /&lt;button aria-label=&quot;Abrir&quot;&gt;Abrir&lt;\/button&gt;/u);
  assert.doesNotMatch(html, /&amp;lt;(?:iframe|button)/u);
  assert.doesNotMatch(html, /TOPSECRET|javascript:|onload=/iu);
  assert.equal((html.match(/<script>/gu) || []).length, 1, 'somente o script estático do relatório é permitido');
  assert.equal(decodeHtmlText(encodedSnippet), evidence.snippet);
});

function decodeHtmlText(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

test('keeps a pristine capture timeout partial without retrying element screenshots', async () => {
  const adapter = fakeAdapter({ fullPageFailure: new DOMException('capture timeout', 'TimeoutError'), snippetFailureNode: 1 });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-partial' });
  assert.equal(model.session.status, 'partial');
  assert.ok(model.session.diagnostics.some(item => item.code === 'FULL_PAGE_CAPTURE_FAILED'));
  assert.ok(model.session.diagnostics.some(item => item.code === 'SNIPPET_CAPTURE_FAILED'));
  assert.ok(model.session.diagnostics.some(item => item.code === 'ELEMENT_CAPTURE_SKIPPED_NO_FULL_PAGE'));
  assert.ok(adapter.events.includes('collect'));
  assert.equal(adapter.counts.screenshots, 1);
  assert.equal(adapter.events.some(event => event.startsWith('thumbnail:')), false);
  const element = model.evidence.artifacts.find(item => item.nodeId === 'n-2');
  assert.ok(element);
  assert.ok(element.selector?.css);
  assert.match(element.snippet, /Node 2/);
  assert.equal(Object.hasOwn(element, 'dataUrl'), false);
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
});

test('returns failed on structural collection failure and still cleans only the disposable tab', async () => {
  const adapter = fakeAdapter({ collectFailure: true });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-failed' });
  assert.equal(model.session.status, 'failed');
  assert.ok(model.session.diagnostics.some(item => item.code === 'COLLECTION_FAILED'));
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
  assert.equal(adapter.events.includes('handoff'), false);
  assert.equal(model.progress.at(-1).percent < 100, true);
  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  assert.equal(report.session.status, 'failed');
  assert.equal(report.pages[0].axeStatus, report.axe?.status ?? 'not-run');
  assert.equal(report.session.diagnostics.some(entry => entry.code === 'AXE_FEATURE_DISABLED'), false);
});

test('does not claim an axe fallback when collection fails before the core audit starts', async () => {
  const model = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ collectFailure: true }),
    now: clock,
    idFactory: () => 'audit-collection-before-core',
  });

  assert.equal(model.session.status, 'failed');
  assert.equal(Object.hasOwn(model, 'axe'), false);
  assert.equal(model.session.diagnostics.some(entry => entry.code === 'AXE_FEATURE_DISABLED'), false);

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  assert.equal(report.pages[0].axeStatus, 'not-run');
  assert.equal(Object.hasOwn(report, 'axe'), false);
  assert.equal(report.session.diagnostics.some(entry => entry.code === 'AXE_FEATURE_DISABLED'), false);
});

test('labels requested URLs as not observed in HTML and EARL after a pre-execution failure', async () => {
  const draft = await runAudit({
    url: 'https://example.test/requested',
    chromeAdapter: fakeAdapter({ createTabFailure: true }),
    now: clock,
    idFactory: () => 'audit-url-not-observed',
  });
  const report = await enrichAuditForReport(draft, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  const technical = JSON.parse(renderTechnicalJson(report));

  assert.equal(report.pages[0].attempted, false);
  assert.equal(report.pages[0].finalUrlObserved, false);
  assert.match(html, /URL final<\/dt><dd>Não observada/u);
  assert.doesNotMatch(html, /URL final<\/dt><dd><code>https:\/\/example\.test\/requested/u);
  assert.equal(technical.assertions.length, 146);
  assert.deepEqual(technical.assertions[0].subject, {
    id: report.pages[0].requestedUrl,
    requestedUrl: report.pages[0].requestedUrl,
    finalUrlObserved: false,
  });
});

test('distinguishes a pre-execution tab failure from navigation that actually started', async t => {
  const reportOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  for (const scenario of [
    { name: 'createTab', options: { createTabFailure: true }, attempted: false, historicalAttempted: false },
    {
      name: 'navigation', options: { waitFailure: new Error('detalhe privado de navegação') },
      attempted: true, historicalAttempted: false,
    },
  ]) await t.test(scenario.name, async () => {
    const draft = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter(scenario.options), now: clock,
      idFactory: () => `audit-execution-${scenario.name.toLowerCase()}`,
    });
    const report = await enrichAuditForReport(draft, reportOptions);
    const page = report.pages[0];

    assert.equal(page.attempted, scenario.attempted);
    assert.equal(page.finalUrlObserved, false);
    if (!scenario.attempted) {
      assert.equal(page.timestamps.startedAt, page.timestamps.endedAt);
      assert.ok(page.timestamps.generatedAt >= page.timestamps.endedAt);
      assert.deepEqual(page.viewport, { width: null, height: null, deviceScaleFactor: null });
      assert.equal(page.axeStatus, 'not-run');
      assert.equal(report.occurrences.some(value => value.pageId === page.pageId), false);
      assert.equal(report.evidence.some(value => value.pageId === page.pageId), false);
      const remapped = await remapAuditPage(report, {
        batchAuditId: 'batch-pre-execution', pageId: 'page-1',
      });
      assert.equal(remapped.page.attempted, false);
      assert.equal(remapped.page.finalUrlObserved, false);
      assert.equal(remapped.page.timestamps.startedAt, remapped.page.timestamps.endedAt);
      assert.equal(remapped.page.axeStatus, 'not-run');

    }

    const historicalDraft = structuredClone(draft);
    delete historicalDraft.attempted;
    delete historicalDraft.finalUrlObserved;
    const historical = await enrichAuditForReport(historicalDraft, reportOptions);
    assert.equal(historical.pages[0].attempted, scenario.historicalAttempted);
    assert.equal(historical.pages[0].finalUrlObserved, false);

    if (scenario.name === 'createTab') {
      const navigationSignalled = structuredClone(historicalDraft);
      navigationSignalled.progress.push({
        ...navigationSignalled.progress[0], phase: 'navigating', message: 'Iniciando navegação', percent: 10,
      });
      const inferred = await enrichAuditForReport(navigationSignalled, reportOptions);
      assert.equal(inferred.pages[0].attempted, true);
      assert.equal(inferred.pages[0].finalUrlObserved, false);
    }
  });

  await t.test('historical complete audit', async () => {
    const draft = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter(), now: clock,
      idFactory: () => 'audit-execution-historical-complete',
    });
    const historicalDraft = structuredClone(draft);
    delete historicalDraft.attempted;
    delete historicalDraft.finalUrlObserved;
    const historical = await enrichAuditForReport(historicalDraft, reportOptions);
    assert.equal(historical.pages[0].attempted, true);
    assert.equal(historical.pages[0].finalUrlObserved, true);
  });
});

test('does not claim or clean ownership when createTab returns an invalid resource', async () => {
  const adapter = fakeAdapter({ createTabResult: { id: 'PRIVATE_INVALID_TAB_ID' } });
  const draft = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter, now: clock,
    idFactory: () => 'audit-invalid-tab-resource',
  });
  const report = await enrichAuditForReport(draft, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });

  assert.equal(adapter.counts.removals, 0);
  assert.equal(adapter.events.some(entry => entry.startsWith('remove-tab:')), false);
  assert.equal(report.pages[0].attempted, false);
  assert.equal(report.pages[0].finalUrlObserved, false);
  assert.deepEqual(report.session.diagnostics.map(entry => entry.code), ['NAVIGATION_FAILED']);
});

test('records a missing environment as a factual partial cause', async () => {
  const draft = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ environmentResult: undefined }), now: clock,
    idFactory: () => 'audit-missing-environment',
  });
  assert.equal(draft.session.status, 'partial');
  assert.equal(draft.session.diagnostics.some(entry => entry.code === 'ENVIRONMENT_UNAVAILABLE'), true);
});

test('maps an AbortError raised by collection to cancellation instead of collection failure', async () => {
  const draft = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ collectError: new DOMException('cancelada', 'AbortError') }),
    now: clock,
    idFactory: () => 'audit-abort-during-collection',
  });
  assert.equal(draft.session.status, 'cancelled');
  assert.equal(draft.session.diagnostics.some(entry => entry.code === 'COLLECTION_FAILED'), false);
  assert.deepEqual(
    draft.session.diagnostics.filter(entry => entry.recoverable === false).map(entry => entry.code),
    ['NAVIGATION_FAILED'],
  );
});

test('keeps cleanup failures explicit but recoverable in a valid partial audit model', async t => {
  for (const scenario of [
    { name: 'CDP', option: 'disconnectFailure', code: 'CDP_DISCONNECT_FAILED' },
    { name: 'aba', option: 'removeTabFailure', code: 'TAB_CLOSE_FAILED' },
  ]) await t.test(scenario.name, async () => {
    const adapter = fakeAdapter({ [scenario.option]: true });
    const model = await runAudit({
      url: 'https://example.test/', chromeAdapter: adapter, now: clock,
      idFactory: () => `audit-cleanup-${scenario.name.toLowerCase()}`,
    });

    assert.equal(model.session.status, 'partial');
    assert.equal(model.session.partial, true);
    const cleanupDiagnostic = model.session.diagnostics.find(entry => entry.code === scenario.code);
    assert.ok(cleanupDiagnostic);
    assert.equal(cleanupDiagnostic.recoverable, true);
    assert.doesNotMatch(JSON.stringify(model), /detalhe privado/iu);
    await assert.doesNotReject(() => enrichAuditForReport(model, {
      now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
    }));
  });
});

test('cancels conservatively during navigation and never reports complete', async () => {
  const aborted = new DOMException('Operação cancelada', 'AbortError');
  const adapter = fakeAdapter({ waitFailure: aborted });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-cancelled' });
  assert.equal(model.session.status, 'cancelled');
  assert.equal(model.progress.some(entry => entry.percent === 100), false);
  assert.equal(adapter.counts.disconnects, 0);
  assert.equal(adapter.counts.removals, 1);
});

test('can preserve the disposable audit tab only when explicitly configured', async () => {
  const adapter = fakeAdapter();
  await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-open', closeAuditTab: false });
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 0);
});

test('rejects unsafe generated audit IDs before opening a tab', async () => {
  const adapter = fakeAdapter();
  await assert.rejects(runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'token=SECRET' }), /identificador/i);
  assert.equal(adapter.events.includes('create-tab'), false);
});

test('accepts only a JSON-safe report placeholder and never copies handoff secrets', async () => {
  const adapter = fakeAdapter({ handoff: {
    reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=audit-safe&token=REMOVE',
    artifact: { status: 'ready', formats: ['pdf', 'html'], authorization: 'Bearer REMOVE' },
  } });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-safe' });
  assert.deepEqual(model.report.artifact, { status: 'pending', formats: [] });
  assert.doesNotMatch(JSON.stringify(model), /REMOVE|Bearer|authorization|"pdf"|"html"/i);
});

test('validated handoff capability cannot be persisted by runAudit or alter report hashes', async () => {
  const auditId = 'audit-transient-review';
  const makeClock = () => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 29, 10, 0, tick++)).toISOString();
  };
  const trustedReviewUrl =
    `chrome-extension://${TEST_EXTENSION_ID}/src/review/index.html?auditId=${auditId}`;
  const hostileReviewUrl =
    `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/src/review/index.html?auditId=${auditId}`;
  const trusted = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ handoff: { reviewUrl: trustedReviewUrl } }),
    now: makeClock(), idFactory: () => auditId, expectedExtensionId: TEST_EXTENSION_ID,
  });
  const hostile = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ handoff: { reviewUrl: hostileReviewUrl } }),
    now: makeClock(), idFactory: () => auditId, expectedExtensionId: TEST_EXTENSION_ID,
  });

  for (const model of [trusted, hostile]) {
    assert.deepEqual(model.report, {
      status: 'review-ready',
      reviewUrl: null,
      artifact: { status: 'pending', formats: [] },
    });
  }
  assert.deepEqual(trusted.reproducibility, hostile.reproducibility);
  assert.doesNotMatch(JSON.stringify([trusted, hostile]), /abcdefghijklmnopabcdefghijklmnop|ponmlkjihgfedcbaponmlkjihgfedcba/u);
});

test('cancels immediately when the signal aborts after collection', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({ afterCollect: () => controller.abort(new DOMException('cancelada', 'AbortError')) });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-abort-collect', signal: controller.signal });
  assert.equal(model.session.status, 'cancelled');
  assert.equal(model.progress.some(entry => entry.percent === 100), false);
  assert.equal(adapter.events.includes('handoff'), false);
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
});

test('stops the occurrence loop immediately when evidence capture observes abort', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({ afterSnippet: backendNodeId => {
    if (backendNodeId === 1) controller.abort(new DOMException('cancelada', 'AbortError'));
  } });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-abort-evidence', signal: controller.signal });
  assert.equal(model.session.status, 'cancelled');
  assert.equal(model.progress.some(entry => entry.percent === 100), false);
  assert.equal(adapter.events.includes('handoff'), false);
  assert.equal(model.evidence.artifacts.some(item => item.nodeId === 'n-2'), false);
  assert.ok(model.occurrences.every((occurrence, index) =>
    occurrence.occurrenceId === `occurrence-page-1-${String(index + 1).padStart(6, '0')}`));
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
});

test('marks timed-out or incomplete dynamic probes partial with a fixed diagnostic', async () => {
  const adapter = fakeAdapter({ rawProbes: {
    focus: { completed: false, events: [] }, warnings: [{ code: 'TIMEOUT' }], actions: [],
  } });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-probe-timeout' });
  assert.equal(model.session.status, 'partial');
  assert.ok(model.session.diagnostics.some(entry => entry.code === 'DYNAMIC_PROBES_INCOMPLETE'));
});
