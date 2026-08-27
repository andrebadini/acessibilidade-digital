import assert from 'node:assert/strict';
import test from 'node:test';

import { runAudit } from '../../src/background/run-audit.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderHtmlReport } from '../../src/core/report/html.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

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

function fakeAdapter(options = {}) {
  const events = [];
  const page = options.page || rawPage();
  let screenshots = 0;
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
    async disconnect() { disconnects += 1; events.push('disconnect'); },
  };
  return {
    events,
    get counts() { return { screenshots, disconnects, removals }; },
    async createTab() { events.push('create-tab'); return { id: 42 }; },
    async navigateTab(_id, url) { events.push(`navigate:${url}`); },
    async waitForStable(_id, { signal } = {}) {
      events.push('stable');
      if (options.waitFailure) throw options.waitFailure;
      if (signal?.aborted) throw signal.reason;
      return { url: 'https://example.test/final?token=REMOVE&view=public' };
    },
    async connectCdp() { events.push('connect-cdp'); return cdp; },
    async collectPage() { events.push('collect'); options.afterCollect?.(); if (options.collectFailure) throw new Error('DOM unavailable'); return page; },
    async runDynamicProbes() { events.push('probes'); return options.rawProbes || { focus: { completed: false, events: [] }, warnings: [], actions: [] }; },
    async getEnvironment() { return { chromeVersion: 'Chrome/140.0', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }; },
    async getFinalUrl() { return 'https://example.test/final?token=REMOVE&view=public'; },
    async emitProgress(message) { events.push(`progress:${message.percent}`); },
    async handoffReport(model) { events.push('handoff'); return options.handoff || { reviewUrl: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}`, artifact: { status: 'pending', formats: [] } }; },
    async removeTab(id) { assert.equal(id, 42); removals += 1; events.push('remove-tab'); },
  };
}

const clock = (() => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 26, 14, 0, tick++)).toISOString();
})();

test('runs the 130→146 pipeline with pristine capture before collection, probes and rules', async () => {
  const adapter = fakeAdapter();
  const model = await runAudit({
    url: ' example.test/start?password=REMOVE&view=public ', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-1', closeAuditTab: true,
  });
  assert.equal(model.auditId, 'audit-1');
  assert.equal(model.ruleResults.length, 130);
  assert.equal(model.itemResults.length, 146);
  assert.equal(model.session.status, 'complete');
  assert.equal(model.requestedUrl, 'https://example.test/start?view=public');
  assert.equal(model.finalUrl, 'https://example.test/final?view=public');
  assert.ok(adapter.events.indexOf('full-page') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('full-page') < adapter.events.indexOf('probes'));
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
  assert.equal(model.evidence.artifacts.filter(item => item.kind === 'full-page').length, 1);
  assert.equal(model.evidence.artifacts.filter(item => item.nodeId === 'n-1').length, 1);
  assert.ok(model.occurrences.length > 0);
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
    value: 'Pronto',
    states: ['parcialmente marcado', 'selecionado', 'recolhido', 'indisponível', 'obrigatório', 'inválido'],
    visibleText: 'OK',
    announcementPreview: 'Confirmar pedido, botão, Envia o formulário, valor Pronto, parcialmente marcado, selecionado, recolhido, indisponível, obrigatório, inválido',
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
