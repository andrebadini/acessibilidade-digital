import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_MENU_IDS,
  CONTEXT_MENU_ITEMS,
  parseContextMenuClick,
  registerAuditContextMenus as registerAuditContextMenusImplementation,
} from '../../src/background/context-menu.js';

function registerAuditContextMenus(chromeApi, options = {}) {
  const leases = new WeakSet();
  return registerAuditContextMenusImplementation(chromeApi, {
    async issueBindingLease() {
      const lease = Object.freeze(Object.create(null));
      leases.add(lease);
      return lease;
    },
    consumeBindingLease(lease) {
      if (!leases.has(lease)) return false;
      leases.delete(lease);
      return true;
    },
    ...options,
  });
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condição de teste não foi atendida no prazo.');
    await tick();
  }
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    fire(...args) { for (const listener of listeners) listener(...args); },
  };
}

function createChrome() {
  const onInstalled = createEvent();
  const onClicked = createEvent();
  const onStartup = createEvent();
  const outbound = [];
  const menuCalls = [];
  const tabs = new Map([
    [7, { id: 7, url: 'https://origem.test/pagina#secao', status: 'complete' }],
    [50, { id: 50, url: 'chrome-extension://test/src/panel/index.html', status: 'complete' }],
  ]);
  const api = {
    runtime: {
      id: 'test',
      lastError: null,
      getURL(path) { return `chrome-extension://test/${String(path).replace(/^\//u, '')}`; },
      onInstalled,
      onStartup,
      sendMessage(message, callback) {
        outbound.push(structuredClone(message));
        queueMicrotask(() => callback?.());
      },
    },
    contextMenus: {
      onClicked,
      removeAll(callback) {
        menuCalls.push(['removeAll']);
        queueMicrotask(() => callback?.());
      },
      create(item, callback) {
        menuCalls.push(['create', structuredClone(item)]);
        queueMicrotask(() => callback?.());
        return item.id;
      },
    },
    tabs: {
      async get(tabId) {
        const value = tabs.get(tabId);
        if (!value) throw new Error('No tab with id');
        return structuredClone(value);
      },
      query() { throw new Error('A aba ativa nunca pode ser consultada.'); },
    },
    events: { onInstalled, onClicked, onStartup },
    outbound,
    menuCalls,
    tabState: tabs,
  };
  return api;
}

const pageInfo = Object.freeze({
  menuItemId: 'audita.accessibility.audit-page',
  frameId: 0,
  pageUrl: 'https://origem.test/pagina',
});
const sourceTab = Object.freeze({ id: 7, url: 'https://origem.test/pagina#secao' });

test('declares the two exact menu items and registers only installed/click listeners without boot recreation', async () => {
  const chromeApi = createChrome();
  const controller = registerAuditContextMenus(chromeApi, {
    openPanel: async () => ({ id: 50 }),
    beginSingleAudit: () => ({ response: { ok: true, auditId: 'audit-1', state: 'idle' }, completion: Promise.resolve() }),
    createRequestId: () => 'context-1',
  });

  assert.deepEqual(CONTEXT_MENU_IDS, {
    page: 'audita.accessibility.audit-page',
    link: 'audita.accessibility.audit-link',
  });
  assert.deepEqual(CONTEXT_MENU_ITEMS, [
    {
      id: 'audita.accessibility.audit-page',
      title: 'Auditar esta página com Audita Acessibilidade',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    },
    {
      id: 'audita.accessibility.audit-link',
      title: 'Auditar este link com Audita Acessibilidade',
      contexts: ['link'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
      targetUrlPatterns: ['http://*/*', 'https://*/*'],
    },
  ]);
  assert.equal(chromeApi.events.onInstalled.listeners.length, 1);
  assert.equal(chromeApi.events.onClicked.listeners.length, 1);
  assert.equal(chromeApi.events.onStartup.listeners.length, 0);
  assert.deepEqual(chromeApi.menuCalls, [], 'reiniciar o worker não recria menus persistentes');

  chromeApi.events.onInstalled.fire({ reason: 'install' });
  await waitUntil(() => chromeApi.menuCalls.length === 3);
  assert.deepEqual(chromeApi.menuCalls, [
    ['removeAll'],
    ['create', CONTEXT_MENU_ITEMS[0]],
    ['create', CONTEXT_MENU_ITEMS[1]],
  ]);
  assert.equal(typeof controller.installMenus, 'function');
});

test('serializes concurrent installs and cleans a partial registration using callback lastError', async () => {
  const chromeApi = createChrome();
  const errors = [];
  let createCount = 0;
  chromeApi.contextMenus.create = (item, callback) => {
    chromeApi.menuCalls.push(['create', structuredClone(item)]);
    createCount += 1;
    queueMicrotask(() => {
      chromeApi.runtime.lastError = createCount === 2 ? { message: 'secret raw browser failure' } : null;
      callback?.();
      chromeApi.runtime.lastError = null;
    });
    return item.id;
  };
  const controller = registerAuditContextMenus(chromeApi, {
    openPanel: async () => ({ id: 50 }),
    beginSingleAudit: () => ({ response: { ok: true, auditId: 'audit-1', state: 'idle' }, completion: Promise.resolve() }),
    logger: { error: message => errors.push(message) },
  });

  const [first, second] = await Promise.all([controller.installMenus(), controller.installMenus()]);
  assert.deepEqual([first, second], [false, true]);
  assert.deepEqual(chromeApi.menuCalls.map(([kind]) => kind), [
    'removeAll', 'create', 'create', 'removeAll',
    'removeAll', 'create', 'create',
  ]);
  assert.deepEqual(errors, ['Não foi possível registrar os atalhos do menu de contexto.']);
  assert.doesNotMatch(JSON.stringify(errors), /secret raw browser failure/u);
});

test('settles callback-plus-Promise APIs once and gives callback lastError a contained rollback', async () => {
  const chromeApi = createChrome();
  const errors = [];
  let removes = 0;
  let creates = 0;
  chromeApi.contextMenus.removeAll = callback => {
    removes += 1;
    callback?.();
    return Promise.resolve('late-remove');
  };
  chromeApi.contextMenus.create = (_item, callback) => {
    creates += 1;
    const callNumber = creates;
    const early = Promise.resolve('early-create');
    setTimeout(() => {
      if (callNumber === 2) chromeApi.runtime.lastError = { message: 'raw secret error' };
      callback?.();
      chromeApi.runtime.lastError = null;
    }, 5);
    return early;
  };
  const controller = registerAuditContextMenus(chromeApi, {
    openPanel: async () => ({ id: 50 }),
    beginSingleAudit: () => ({ response: { ok: true }, completion: Promise.resolve() }),
    logger: { error: message => errors.push(message) },
  });
  assert.equal(await controller.installMenus(), false);
  assert.equal(removes, 2, 'uma remoção inicial e um rollback, sem liquidação duplicada');
  assert.equal(creates, 2);
  assert.deepEqual(errors, ['Não foi possível registrar os atalhos do menu de contexto.']);
  assert.doesNotMatch(JSON.stringify(errors), /raw secret error/u);
});

test('fails registration finitely when a callback API returns a Promise but never invokes its callback', async () => {
  const chromeApi = createChrome();
  const errors = [];
  chromeApi.contextMenus.removeAll = () => Promise.resolve('promise-only-must-not-authorize');
  const controller = registerAuditContextMenus(chromeApi, {
    apiCallbackTimeoutMs: 5,
    openPanel: async () => ({ id: 50 }),
    beginSingleAudit: () => ({ response: { ok: true }, completion: Promise.resolve() }),
    logger: { error: message => errors.push(message) },
  });
  assert.equal(await controller.installMenus(), false);
  assert.deepEqual(errors, ['Não foi possível registrar os atalhos do menu de contexto.']);
});

test('parses page and framed-link clicks from exact HTTP(S) fields without an active-tab fallback', () => {
  assert.deepEqual(parseContextMenuClick(pageInfo, sourceTab), {
    kind: 'page', sourceTabId: 7,
    sourceUrl: 'https://origem.test/pagina#secao',
    auditUrl: 'https://origem.test/pagina', frameId: 0,
  });
  assert.deepEqual(parseContextMenuClick({
    menuItemId: 'audita.accessibility.audit-link', frameId: 4,
    pageUrl: 'https://origem.test/pagina', frameUrl: 'https://frames.test/conteudo',
    linkUrl: 'https://destino.test/alvo?token=nao-persistir&view=public#parte',
  }, sourceTab), {
    kind: 'link', sourceTabId: 7,
    sourceUrl: 'https://origem.test/pagina#secao',
    auditUrl: 'https://destino.test/alvo?token=nao-persistir&view=public#parte', frameId: 4,
  });
});

test('fails closed for unknown menus, frames, divergent pages, forbidden URLs, malformed IDs and accessors', () => {
  const invalid = [
    [{ ...pageInfo, menuItemId: 'unknown' }, sourceTab],
    [{ ...pageInfo, frameId: 1 }, sourceTab],
    [{ ...pageInfo, pageUrl: 'https://other.test/' }, sourceTab],
    [{ ...pageInfo, pageUrl: 'javascript:alert(1)' }, sourceTab],
    [{ menuItemId: CONTEXT_MENU_IDS.page, pageUrl: pageInfo.pageUrl }, sourceTab],
    [{ ...pageInfo, frameId: null }, sourceTab],
    [{ ...pageInfo, frameId: Number.NaN }, sourceTab],
    [{ ...pageInfo, frameId: Number.POSITIVE_INFINITY }, sourceTab],
    [{ ...pageInfo, frameId: -1 }, sourceTab],
    [{ ...pageInfo, frameId: 0.5 }, sourceTab],
    [{ ...pageInfo }, { url: sourceTab.url }],
    [{ menuItemId: CONTEXT_MENU_IDS.link, frameId: 2, pageUrl: pageInfo.pageUrl, linkUrl: 'https://destino.test/' }, sourceTab],
    [{ menuItemId: CONTEXT_MENU_IDS.link, frameId: 0, pageUrl: pageInfo.pageUrl, linkUrl: 'https://user:pass@destino.test/' }, sourceTab],
    [{ menuItemId: CONTEXT_MENU_IDS.link, frameId: 0, pageUrl: pageInfo.pageUrl, linkUrl: 'https://destino.test/\\evil' }, sourceTab],
    [{ menuItemId: CONTEXT_MENU_IDS.link, frameId: 0, pageUrl: pageInfo.pageUrl, linkUrl: 'https://destino.test/\u202Eevil' }, sourceTab],
  ];
  for (const [info, tab] of invalid) assert.equal(parseContextMenuClick(info, tab), null);

  let reads = 0;
  const hostile = { menuItemId: CONTEXT_MENU_IDS.page, frameId: 0 };
  Object.defineProperty(hostile, 'pageUrl', { enumerable: true, get() { reads += 1; return pageInfo.pageUrl; } });
  assert.equal(parseContextMenuClick(hostile, sourceTab), null);
  assert.equal(reads, 0);

  for (const [target, key, value] of [
    [{ ...sourceTab }, 'id', 7],
    [{ ...sourceTab }, 'url', sourceTab.url],
    [{ menuItemId: CONTEXT_MENU_IDS.link, frameId: 0, pageUrl: pageInfo.pageUrl }, 'linkUrl', 'https://destino.test/'],
    [{ menuItemId: CONTEXT_MENU_IDS.link, frameId: 2, pageUrl: pageInfo.pageUrl, linkUrl: 'https://destino.test/' }, 'frameUrl', 'https://frame.test/'],
  ]) {
    let accessorReads = 0;
    Object.defineProperty(target, key, { enumerable: true, get() { accessorReads += 1; return value; } });
    const info = target === sourceTab || Object.hasOwn(target, 'id') ? pageInfo : target;
    const tab = info === pageInfo ? target : sourceTab;
    assert.equal(parseContextMenuClick(info, tab), null);
    assert.equal(accessorReads, 0);
  }
});

test('settles wrong-sender, replay and accessor ACKs with a finite failure response', () => {
  const chromeApi = createChrome();
  const controller = registerAuditContextMenus(chromeApi, {
    openPanel: async () => ({ id: 50 }),
    beginSingleAudit: () => ({ response: { ok: true }, completion: Promise.resolve() }),
  });
  const ack = { type: 'CONTEXT_PREFILL_ACK', requestId: 'not-pending', panelTabId: 50, accepted: true };
  for (const sender of [
    { id: 'other', frameId: 0, documentId: 'doc-1', url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 } },
    { id: 'test', frameId: 1, documentId: 'doc-1', url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 } },
    { id: 'test', frameId: 0, documentId: 'doc-1', url: 'chrome-extension://test/src/panel/index.html', tab: { id: 51 } },
  ]) {
    let response;
    assert.equal(controller.handlePanelProtocolMessage(ack, sender, value => { response = value; }), true);
    assert.deepEqual(response, { ok: false, error: 'ACK de painel não correlacionado.' });
  }
  let reads = 0;
  const hostile = { type: 'CONTEXT_PREFILL_ACK', panelTabId: 50, accepted: true };
  Object.defineProperty(hostile, 'requestId', { enumerable: true, get() { reads += 1; return 'not-pending'; } });
  let response;
  assert.equal(controller.handlePanelProtocolMessage(hostile, {}, value => { response = value; }), true);
  assert.equal(reads, 0);
  assert.deepEqual(response, { ok: false, error: 'ACK de painel não correlacionado.' });
});

test('correlates one-shot panel ACKs to tab/document, confirms the same document, and holds the source gate until runner completion', async () => {
  const chromeApi = createChrome();
  const opens = [];
  const starts = [];
  let finishRunner;
  const completion = new Promise(resolve => { finishRunner = resolve; });
  const controller = registerAuditContextMenus(chromeApi, {
    createRequestId: () => 'context-one-shot',
    async openPanel(value) { opens.push(structuredClone(value)); return { id: 50 }; },
    beginSingleAudit(value) {
      starts.push(value);
      return { response: { ok: true, auditId: 'audit-context', state: 'idle' }, completion };
    },
  });

  chromeApi.events.onClicked.fire({
    menuItemId: CONTEXT_MENU_IDS.link, frameId: 0, pageUrl: pageInfo.pageUrl,
    linkUrl: 'https://destino.test/alvo?token=TOPSECRET&view=public#auth=TOPSECRET',
  }, sourceTab);
  chromeApi.events.onClicked.fire(pageInfo, sourceTab);
  await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));

  assert.deepEqual(opens, [{ sourceTab: { id: 7, url: sourceTab.url } }]);
  const prefill = chromeApi.outbound.find(message => message.type === 'AUDIT_CONTEXT_PREFILL');
  assert.deepEqual(prefill, {
    type: 'AUDIT_CONTEXT_PREFILL', requestId: 'context-one-shot', panelTabId: 50,
    prefill: { kind: 'link', url: 'https://destino.test/alvo?view=public', autoStarted: true },
  });
  assert.doesNotMatch(JSON.stringify(chromeApi.outbound), /TOPSECRET|token=|auth=/iu);

  let panelStartResponse;
  const ackSender = {
    id: 'test', frameId: 0, documentId: 'panel-document-1',
    url: 'chrome-extension://test/src/panel/index.html',
    tab: { id: 50, url: 'chrome-extension://test/src/panel/index.html' },
  };
  assert.equal(controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_ACK', requestId: 'context-one-shot', panelTabId: 50, accepted: true,
  }, ackSender, value => { panelStartResponse = value; }), true);
  assert.equal(controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_ACK', requestId: 'context-one-shot', panelTabId: 50, accepted: true,
  }, ackSender, () => {}), true, 'replay é reconhecido e rejeitado sem consumir novamente');

  await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT'));
  const commit = chromeApi.outbound.find(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT');
  assert.deepEqual(commit, {
    type: 'AUDIT_CONTEXT_PREFILL_COMMIT', requestId: 'context-one-shot', panelTabId: 50,
  });
  assert.equal(controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'context-one-shot', panelTabId: 50, accepted: true,
  }, { ...ackSender, documentId: 'other-document' }, () => {}), true);
  assert.equal(starts.length, 0);
  assert.equal(controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'context-one-shot', panelTabId: 50, accepted: true,
  }, ackSender, () => {}), true);
  await waitUntil(() => starts.length === 1);

  assert.equal(starts[0].navigationUrl, 'https://destino.test/alvo?token=TOPSECRET&view=public#auth=TOPSECRET');
  assert.equal(starts[0].senderKey, 'context:7');
  assert.deepEqual(panelStartResponse, { ok: true, auditId: 'audit-context', state: 'idle' });
  chromeApi.events.onClicked.fire(pageInfo, sourceTab);
  await tick();
  assert.equal(opens.length, 1, 'o gate continua retido enquanto o runner está ativo');

  finishRunner();
  await waitUntil(() => controller.isSourceActive(7) === false);
});

test('issues the document-bound persona lease only after commit and rejects an invalid final proof', async () => {
  const chromeApi = createChrome();
  const lease = Object.freeze(Object.create(null));
  const issued = [];
  let leaseIsLive = true;
  let consumeCalls = 0;
  let starts = 0;
  const controller = registerAuditContextMenus(chromeApi, {
    createRequestId: () => 'context-binding-lease',
    openPanel: async () => ({ id: 50 }),
    async issueBindingLease(value) { issued.push(structuredClone(value)); return leaseIsLive ? lease : null; },
    consumeBindingLease(value) {
      consumeCalls += 1;
      assert.equal(value, lease);
      const result = leaseIsLive;
      leaseIsLive = false;
      return result;
    },
    beginSingleAudit: () => { starts += 1; return { response: { ok: true }, completion: Promise.resolve() }; },
  });
  chromeApi.events.onClicked.fire(pageInfo, sourceTab);
  await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));
  const sender = {
    id: 'test', frameId: 0, documentId: 'panel-doc-lease',
    url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 },
  };
  controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_ACK', requestId: 'context-binding-lease', panelTabId: 50, accepted: true,
  }, sender, () => {});
  await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT'));
  assert.deepEqual(issued, [], 'nenhuma prova pode envelhecer enquanto o painel confirma o commit');
  leaseIsLive = false;
  controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'context-binding-lease', panelTabId: 50, accepted: true,
  }, sender, () => {});
  await waitUntil(() => controller.isSourceActive(7) === false);
  assert.deepEqual(issued, [{
    panelTabId: 50, targetTabId: 7, sourceUrl: sourceTab.url, panelDocumentId: 'panel-doc-lease',
  }]);
  assert.equal(consumeCalls, 0);
  assert.equal(starts, 0, 'prova reinstalada/navegada durante o handshake impede auditoria invisível');
});

test('never starts an invisible audit when the panel, source, pending navigation, ACK or final correlation changes', async () => {
  for (const mutate of ['source', 'pending', 'panel', 'panel-pending', 'ack']) {
    const chromeApi = createChrome();
    let starts = 0;
    const controller = registerAuditContextMenus(chromeApi, {
      createRequestId: () => `context-${mutate}`,
      openPanel: async () => ({ id: 50 }),
      beginSingleAudit: () => { starts += 1; return { response: { ok: true }, completion: Promise.resolve() }; },
    });
    chromeApi.events.onClicked.fire(pageInfo, sourceTab);
    await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));
    if (mutate === 'source') chromeApi.tabState.set(7, { id: 7, url: 'https://origem.test/outra', status: 'complete' });
    if (mutate === 'pending') chromeApi.tabState.set(7, {
      id: 7, url: sourceTab.url, pendingUrl: 'https://origem.test/outra', status: 'complete',
    });
    if (mutate === 'panel') chromeApi.tabState.delete(50);
    if (mutate === 'panel-pending') chromeApi.tabState.set(50, {
      id: 50, url: 'chrome-extension://test/src/panel/index.html',
      pendingUrl: 'chrome-extension://test/src/panel/index.html', status: 'complete',
    });
    const requestId = `context-${mutate}`;
    controller.handlePanelProtocolMessage({
      type: 'CONTEXT_PREFILL_ACK', requestId, panelTabId: 50, accepted: mutate !== 'ack',
    }, {
      id: 'test', frameId: 0, documentId: 'panel-document-1',
      url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 },
    }, () => {});
    await waitUntil(() => controller.isSourceActive(7) === false);
    assert.equal(starts, 0, `${mutate} não pode iniciar o runner`);
  }
});

test('releases the source gate after open, broadcast, or begin failures without retrying the runner', async () => {
  for (const failure of ['open', 'broadcast', 'begin']) {
    const chromeApi = createChrome();
    const errors = [];
    let beginCalls = 0;
    if (failure === 'broadcast') chromeApi.runtime.sendMessage = () => { throw new Error('send failed'); };
    const controller = registerAuditContextMenus(chromeApi, {
      prefillTimeoutMs: 20,
      createRequestId: () => `request-${failure}`,
      logger: { error: message => errors.push(message) },
      openPanel: async () => {
        if (failure === 'open') throw new Error('open failed');
        return { id: 50 };
      },
      beginSingleAudit: () => {
        beginCalls += 1;
        if (failure === 'begin') throw new Error('begin failed');
        return { response: { ok: true, auditId: 'audit-1', state: 'idle' }, completion: Promise.resolve() };
      },
    });
    chromeApi.events.onClicked.fire(pageInfo, sourceTab);
    if (failure === 'begin') {
      await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));
      const sender = {
        id: 'test', frameId: 0, documentId: 'panel-doc',
        url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 },
      };
      controller.handlePanelProtocolMessage({
        type: 'CONTEXT_PREFILL_ACK', requestId: 'request-begin', panelTabId: 50, accepted: true,
      }, sender, () => {});
      await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT'));
      controller.handlePanelProtocolMessage({
        type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'request-begin', panelTabId: 50, accepted: true,
      }, sender, () => {});
    }
    await waitUntil(() => controller.isSourceActive(7) === false);
    assert.equal(beginCalls, failure === 'begin' ? 1 : 0);
    assert.deepEqual(errors, ['Não foi possível iniciar a auditoria pelo menu de contexto.']);
  }
});

test('a worker-owned decision deadline prevents a slow final proof from starting after the panel can recover', async () => {
  const chromeApi = createChrome();
  let starts = 0;
  let panelResponse;
  const controller = registerAuditContextMenus(chromeApi, {
    decisionTimeoutMs: 10,
    prefillTimeoutMs: 20,
    createRequestId: () => 'context-slow-proof',
    openPanel: async () => ({ id: 50 }),
    issueBindingLease: () => new Promise(() => {}),
    consumeBindingLease: () => { throw new Error('uma lease não emitida não pode ser consumida'); },
    beginSingleAudit: () => { starts += 1; return { response: { ok: true }, completion: Promise.resolve() }; },
  });
  const sender = {
    id: 'test', frameId: 0, documentId: 'panel-doc-slow-proof',
    url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 },
  };
  chromeApi.events.onClicked.fire(pageInfo, sourceTab);
  await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));
  controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_ACK', requestId: 'context-slow-proof', panelTabId: 50, accepted: true,
  }, sender, value => { panelResponse = value; });
  await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT'));
  controller.handlePanelProtocolMessage({
    type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'context-slow-proof', panelTabId: 50, accepted: true,
  }, sender, () => {});
  await waitUntil(() => controller.isSourceActive(7) === false);
  assert.equal(starts, 0);
  assert.deepEqual(panelResponse, { ok: false, error: 'Não foi possível iniciar a auditoria pelo menu de contexto.' });
});

test('rejects a panel URL or document replacement between initial ACK and commit', async () => {
  for (const replacement of ['url', 'document']) {
    const chromeApi = createChrome();
    let starts = 0;
    const controller = registerAuditContextMenus(chromeApi, {
      prefillTimeoutMs: 20,
      createRequestId: () => `replace-${replacement}`,
      openPanel: async () => ({ id: 50 }),
      beginSingleAudit: () => { starts += 1; return { response: { ok: true }, completion: Promise.resolve() }; },
    });
    chromeApi.events.onClicked.fire(pageInfo, sourceTab);
    await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));
    const sender = {
      id: 'test', frameId: 0, documentId: 'panel-doc-old',
      url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 },
    };
    controller.handlePanelProtocolMessage({
      type: 'CONTEXT_PREFILL_ACK', requestId: `replace-${replacement}`, panelTabId: 50, accepted: true,
    }, sender, () => {});
    if (replacement === 'url') {
      chromeApi.tabState.set(50, { id: 50, url: 'chrome-extension://test/src/review/index.html', status: 'complete' });
    } else {
      await waitUntil(() => chromeApi.outbound.some(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT'));
      controller.handlePanelProtocolMessage({
        type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'replace-document', panelTabId: 50, accepted: true,
      }, { ...sender, documentId: 'panel-doc-new' }, () => {});
    }
    await waitUntil(() => controller.isSourceActive(7) === false);
    assert.equal(starts, 0);
  }
});
