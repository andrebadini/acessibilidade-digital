import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditLifecycle } from '../../src/background/audit-lifecycle.js';

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function tick() { return new Promise(resolve => setImmediate(resolve)); }

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('registers one stable lifecycle graph and aborts before authority invalidation', async () => {
  const updated = event();
  const removed = event();
  const detached = event();
  const windows = event();
  const order = [];
  const runtime = Object.freeze({
    authority: {
      async invalidateForTab(tabId, reason) { order.push(['invalidate-tab', tabId, reason]); },
      async invalidateForWindow(windowId, reason) { order.push(['invalidate-window', windowId, reason]); },
    },
    auditStarter: {
      async abortAttachedAuditForTarget(value) { order.push(['abort', value]); return { aborted: true, auditId: 'audit-1' }; },
    },
    personaCoordinator: {
      async invalidateTab(tabId, reason) { order.push(['persona-tab', tabId, reason]); },
      async invalidateWindow(windowId, reason) { order.push(['persona-window', windowId, reason]); },
    },
    highlightController: {
      async invalidateTab(tabId, reason) { order.push(['highlight-tab', tabId, reason]); },
    },
    chromeAdapter: Object.freeze({}),
  });
  const lifecycle = createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: updated, onRemoved: removed, onDetached: detached }, windows: { onRemoved: windows } },
    getReadyRuntime: () => Promise.resolve(runtime),
  });
  assert.deepEqual(Object.keys(lifecycle), ['register', 'dispose']);
  assert.equal(lifecycle.register(), true);
  assert.equal(lifecycle.register(), false);
  assert.equal(updated.listeners.size, 1);
  assert.equal(removed.listeners.size, 1);
  assert.equal(detached.listeners.size, 1);
  assert.equal(windows.listeners.size, 1);

  updated.emit(17, { status: 'loading' }, {});
  await tick();
  assert.deepEqual(order, [
    ['abort', { tabId: 17, windowId: null, reasonCode: 'TAB_LOADING' }],
    ['highlight-tab', 17, 'navigation'],
    ['invalidate-tab', 17, 'TAB_LOADING'],
    ['persona-tab', 17, 'navigation'],
  ]);
  order.length = 0;
  updated.emit(17, { discarded: true }, {});
  await tick();
  assert.deepEqual(order, [
    ['abort', { tabId: 17, windowId: null, reasonCode: 'TAB_DISCARDED' }],
    ['highlight-tab', 17, 'discarded'],
    ['invalidate-tab', 17, 'TAB_DISCARDED'],
    ['persona-tab', 17, 'discarded'],
  ]);
  order.length = 0;
  removed.emit(17);
  await tick();
  assert.deepEqual(order, [
    ['abort', { tabId: 17, windowId: null, reasonCode: 'TAB_REMOVED' }],
    ['highlight-tab', 17, 'tab-removed'],
    ['invalidate-tab', 17, 'TAB_REMOVED'],
    ['persona-tab', 17, 'tab-removed'],
  ]);
  order.length = 0;
  detached.emit(17, { oldWindowId: 9, oldPosition: 0 });
  await tick();
  assert.deepEqual(order, [
    ['abort', { tabId: 17, windowId: null, reasonCode: 'TAB_REMOVED' }],
    ['highlight-tab', 17, 'window-changed'],
    ['invalidate-tab', 17, 'TAB_REMOVED'],
    ['persona-tab', 17, 'window-changed'],
  ]);
  order.length = 0;
  windows.emit(9);
  await tick();
  assert.deepEqual(order, [
    ['abort', { tabId: null, windowId: 9, reasonCode: 'WINDOW_REMOVED' }],
    ['invalidate-window', 9, 'WINDOW_REMOVED'],
    ['persona-window', 9, 'window-changed'],
  ]);

  assert.equal(lifecycle.dispose(), true);
  assert.equal(lifecycle.dispose(), false);
  assert.equal(updated.listeners.size + removed.listeners.size + detached.listeners.size + windows.listeners.size, 0);
});

test('admits every navigation field descriptor-safely and ignores malformed or accessor records', async () => {
  const updated = event();
  const removed = event();
  const windows = event();
  const calls = [];
  const runtime = Object.freeze({
    authority: { async invalidateForTab() {}, async invalidateForWindow() {} },
    auditStarter: { async abortAttachedAuditForTarget(value) { calls.push(value); return { aborted: false, auditId: null }; } },
    chromeAdapter: Object.freeze({}),
  });
  createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: updated, onRemoved: removed }, windows: { onRemoved: windows } },
    getReadyRuntime: () => Promise.resolve(runtime),
  }).register();

  updated.emit(1, { url: 'https://secret.test/?token=hidden' }, {});
  updated.emit(2, { pendingUrl: 'https://secret.test/next' }, {});
  updated.emit(3, { status: 'complete' }, {});
  updated.emit(-1, { status: 'loading' }, {});
  let getterReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'url', { enumerable: true, get() { getterReads += 1; return 'https://secret.test/'; } });
  updated.emit(4, hostile, {});
  await tick();
  assert.deepEqual(calls, [
    { tabId: 1, windowId: null, reasonCode: 'TAB_URL_CHANGED' },
    { tabId: 2, windowId: null, reasonCode: 'TAB_PENDING_URL' },
  ]);
  assert.equal(getterReads, 0);
  assert.equal(JSON.stringify(calls).includes('secret'), false);
});

test('readiness rejection makes lifecycle events no-ops without native diagnostics', async () => {
  const updated = event();
  const removed = event();
  const windows = event();
  createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: updated, onRemoved: removed }, windows: { onRemoved: windows } },
    getReadyRuntime: () => Promise.reject(new Error('native secret')),
  }).register();
  updated.emit(1, { status: 'loading' }, {});
  removed.emit(1);
  windows.emit(1);
  await tick();
  assert.equal(updated.listeners.size, 1);
});

test('isolates every invalidation adapter so all cleanup stages run best-effort', async () => {
  const updated = event(); const removed = event(); const windows = event(); const calls = [];
  const runtime = {
    auditStarter: { async abortAttachedAuditForTarget() { calls.push('abort'); throw new Error('private abort'); } },
    authority: { async invalidateForTab() { calls.push('authority'); throw new Error('private authority'); }, async invalidateForWindow() {} },
    reportLaunch: { async handleTabRemoved() { calls.push('report'); throw new Error('private report'); } },
    exportLaunch: { async handleTabRemoved() { calls.push('export'); throw new Error('private export'); } },
    highlightController: { async invalidateTab() { calls.push('highlight'); throw new Error('private highlight'); } },
  };
  createAuditLifecycle({ chromeApi: { tabs: { onUpdated: updated, onRemoved: removed }, windows: { onRemoved: windows } },
    getReadyRuntime: async () => runtime }).register();
  removed.emit(17);
  await tick();
  assert.deepEqual(calls, ['abort', 'highlight', 'authority', 'report', 'export']);
});

test('serializes overlapping navigation invalidations for the same tab through publication and revocation', async () => {
  const updated = event(); const removed = event(); const windows = event();
  const firstHighlight = deferred();
  const calls = [];
  let highlightCalls = 0;
  const runtime = {
    auditStarter: {
      async abortAttachedAuditForTarget(value) { calls.push(`abort:${value.reasonCode}`); },
    },
    highlightController: {
      async invalidateTab(_tabId, reason) {
        highlightCalls += 1;
        calls.push(`highlight:${reason}:start`);
        if (highlightCalls === 1) await firstHighlight.promise;
        calls.push(`highlight:${reason}:published`);
      },
    },
    authority: {
      async invalidateForTab(_tabId, reason) { calls.push(`authority:${reason}`); },
      async invalidateForWindow() {},
    },
    personaCoordinator: {
      async invalidateTab(_tabId, reason) { calls.push(`persona:${reason}`); },
    },
    reportLaunch: {
      async handleTabUpdated(_tabId, changeInfo) { calls.push(`report:${changeInfo.status ?? 'url'}`); },
    },
    exportLaunch: {
      async handleTabUpdated(_tabId, changeInfo) { calls.push(`export:${changeInfo.status ?? 'url'}`); },
    },
  };
  createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: updated, onRemoved: removed }, windows: { onRemoved: windows } },
    getReadyRuntime: async () => runtime,
  }).register();

  updated.emit(17, { status: 'loading' }, {});
  await tick();
  updated.emit(17, { url: 'https://example.test/after' }, {});
  await tick();
  assert.deepEqual(calls, ['abort:TAB_LOADING', 'highlight:navigation:start']);

  firstHighlight.resolve();
  for (let index = 0; index < 4; index += 1) await tick();
  assert.deepEqual(calls, [
    'abort:TAB_LOADING', 'highlight:navigation:start', 'highlight:navigation:published',
    'authority:TAB_LOADING', 'persona:navigation', 'report:loading', 'export:loading',
    'abort:TAB_URL_CHANGED', 'highlight:navigation:start', 'highlight:navigation:published',
    'authority:TAB_URL_CHANGED', 'persona:navigation', 'report:url', 'export:url',
  ]);
});

test('rebinds the existing Side Panel once after loading invalidation completes', async () => {
  const updated = event(); const removed = event(); const windows = event();
  const calls = [];
  const runtime = {
    auditStarter: { async abortAttachedAuditForTarget() { calls.push('abort'); } },
    highlightController: { async invalidateTab() { calls.push('highlight'); } },
    authority: {
      async invalidateForTab() { calls.push('authority'); },
      async invalidateForWindow() {},
    },
  };
  createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: updated, onRemoved: removed }, windows: { onRemoved: windows } },
    getReadyRuntime: async () => runtime,
    async rebindPanelForNavigation(value) { calls.push(['rebind', value]); return true; },
  }).register();

  updated.emit(17, { status: 'loading' }, {});
  for (let index = 0; index < 3; index += 1) await tick();
  assert.deepEqual(calls, [
    'abort', 'highlight', 'authority', ['rebind', { tabId: 17 }],
  ]);

  calls.length = 0;
  updated.emit(17, { url: 'https://example.test/after' }, {});
  for (let index = 0; index < 3; index += 1) await tick();
  assert.deepEqual(calls, ['abort', 'highlight', 'authority']);
});

test('an audit interrupted by loading leaves a notice for the recreated panel before the rebind', async () => {
  // 1.1.56: uma loja que recarrega a própria página quando o painel abre interrompia a auditoria e o painel
  // recriado voltava ao início em silêncio. O aviso precisa existir antes de o painel novo nascer.
  const updated = event(); const removed = event(); const windows = event();
  const calls = [];
  let settlement = Object.freeze({ aborted: true, auditId: 'audit-reloaded' });
  createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: updated, onRemoved: removed }, windows: { onRemoved: windows } },
    getReadyRuntime: async () => ({
      auditStarter: { async abortAttachedAuditForTarget() { calls.push('abort'); return settlement; } },
      authority: { async invalidateForTab() { calls.push('authority'); }, async invalidateForWindow() {} },
    }),
    async rebindPanelForNavigation(value) { calls.push(['rebind', value]); return true; },
    notePanelNavigationInterruption(value) { calls.push(['notice', value]); return true; },
  }).register();

  updated.emit(17, { status: 'loading' }, {});
  for (let index = 0; index < 3; index += 1) await tick();
  assert.deepEqual(calls, [
    'abort', 'authority', ['notice', { tabId: 17, auditId: 'audit-reloaded' }], ['rebind', { tabId: 17 }],
  ]);

  calls.length = 0;
  settlement = Object.freeze({ aborted: false, auditId: null });
  updated.emit(17, { status: 'loading' }, {});
  for (let index = 0; index < 3; index += 1) await tick();
  assert.deepEqual(calls, ['abort', 'authority', ['rebind', { tabId: 17 }]], 'sem auditoria interrompida não há aviso');

  assert.throws(() => createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: event(), onRemoved: event() }, windows: { onRemoved: event() } },
    getReadyRuntime: async () => ({}),
    rebindPanelForNavigation: async () => true,
    notePanelNavigationInterruption: 'not-a-function',
  }), /AUDIT_LIFECYCLE_INVALID/u);
});

test('a handled paused-pixel invalidation never falls through to an independent capability invalidation', async () => {
  const updated = event(); const removed = event(); const windows = event();
  const calls = [];
  createAuditLifecycle({
    chromeApi: { tabs: { onUpdated: updated, onRemoved: removed }, windows: { onRemoved: windows } },
    getReadyRuntime: async () => ({
      auditStarter: {
        async abortAttachedAuditForTarget(value) {
          calls.push(['liquidator', value]);
          return Object.freeze({ handled: true, liquidated: false, aborted: false, auditId: 'audit-paused' });
        },
      },
      authority: {
        async invalidateForTab() { calls.push(['independent-invalidate']); },
        async invalidateForWindow() { calls.push(['independent-window-invalidate']); },
      },
    }),
  }).register();

  updated.emit(17, { status: 'loading' }, {});
  for (let index = 0; index < 3; index += 1) await tick();
  assert.deepEqual(calls, [[
    'liquidator', { tabId: 17, windowId: null, reasonCode: 'TAB_LOADING' },
  ]]);
});

test('a fragment-only change of the same document never aborts the audit or resets the panel', async () => {
  const updated = event();
  const removed = event();
  const windows = event();
  const calls = [];
  const runtime = Object.freeze({
    authority: { async invalidateForTab() {}, async invalidateForWindow() {} },
    auditStarter: { async abortAttachedAuditForTarget(value) { calls.push(value.reasonCode); return { aborted: false, auditId: null }; } },
    chromeAdapter: Object.freeze({}),
  });
  createAuditLifecycle({
    chromeApi: {
      tabs: { onUpdated: updated, onRemoved: removed, query: async () => [{ id: 5, url: 'https://loja.test/vitrine?cat=1' }] },
      windows: { onRemoved: windows },
    },
    getReadyRuntime: () => Promise.resolve(runtime),
  }).register();
  await tick();
  // Carrossel trocando o fragmento sozinho, a partir da semente.
  updated.emit(5, { status: 'loading', url: 'https://loja.test/vitrine?cat=1#slide-2' }, {});
  updated.emit(5, { status: 'complete' }, {});
  updated.emit(5, { status: 'loading', url: 'https://loja.test/vitrine?cat=1#slide-3' }, {});
  await tick();
  assert.deepEqual(calls, []);
  // Outra consulta é outro endereço; recarregar (loading sem url) continua invalidando.
  updated.emit(5, { status: 'loading', url: 'https://loja.test/vitrine?cat=2' }, {});
  await tick();
  updated.emit(5, { status: 'loading' }, {});
  await tick();
  assert.deepEqual(calls, ['TAB_LOADING', 'TAB_LOADING']);
  // Aba sem semente: a primeira mudança invalida (conservador), as trocas de fragmento seguintes não.
  updated.emit(6, { status: 'loading', url: 'https://outra.test/' }, {});
  await tick();
  updated.emit(6, { status: 'loading', url: 'https://outra.test/#topo' }, {});
  await tick();
  assert.deepEqual(calls, ['TAB_LOADING', 'TAB_LOADING', 'TAB_LOADING']);
});
