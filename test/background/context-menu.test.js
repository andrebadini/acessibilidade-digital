import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_MENU_IDS,
  CONTEXT_MENU_ITEMS,
  parseContextMenuClick,
  registerAuditContextMenus,
} from '../../src/background/context-menu.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;

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

test('declares and installs exactly one page-only HTTP(S) item', async () => {
  assert.deepEqual(CONTEXT_MENU_IDS, { page: 'audita.accessibility.audit-page' });
  assert.deepEqual(CONTEXT_MENU_ITEMS, [{
    id: 'audita.accessibility.audit-page',
    title: 'Auditar esta página com Audita Acessibilidade',
    contexts: ['page'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  }]);
  const installed = event();
  const clicked = event();
  const created = [];
  let removed = 0;
  const chromeApi = {
    runtime: { onInstalled: installed },
    contextMenus: {
      onClicked: clicked,
      async removeAll() { removed += 1; },
      create(item) { created.push(structuredClone(item)); },
    },
    sidePanel: { async open() {} },
  };
  const controller = registerAuditContextMenus(chromeApi, {
    getReadyRuntime: () => Promise.resolve({}),
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-context', epochNow: () => 1,
    logger: { error() {} },
  });
  assert.equal(installed.listeners.size, 1);
  assert.equal(clicked.listeners.size, 1);
  assert.equal(await controller.installMenus(), true);
  assert.equal(removed, 1);
  assert.deepEqual(created, CONTEXT_MENU_ITEMS);
  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
});

test('serializes concurrent installations and rolls back a partial registration', async () => {
  const installed = event();
  const clicked = event();
  const calls = [];
  const gates = [];
  let active = 0;
  let maxActive = 0;
  const chromeApi = {
    runtime: { onInstalled: installed, lastError: null },
    contextMenus: {
      onClicked: clicked,
      async removeAll() {
        calls.push('remove');
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => gates.push(resolve));
        active -= 1;
      },
      create() { calls.push('create'); },
    },
    sidePanel: { async open() {} },
  };
  const logs = [];
  const controller = registerAuditContextMenus(chromeApi, {
    getReadyRuntime: () => Promise.resolve({}),
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-context', epochNow: () => 1,
    logger: { error(code) { logs.push(code); } },
  });
  const first = controller.installMenus();
  const second = controller.installMenus();
  await Promise.resolve();
  assert.equal(gates.length, 1);
  gates.shift()();
  await tick();
  assert.equal(gates.length, 1);
  gates.shift()();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, ['remove', 'create', 'remove', 'create']);
  assert.deepEqual(logs, []);
});

test('contains callback lastError, settles callback-plus-Promise once, and performs one rollback', async () => {
  const installed = event();
  const clicked = event();
  const logs = [];
  let removes = 0;
  let creates = 0;
  const chromeApi = {
    runtime: { onInstalled: installed, lastError: null },
    contextMenus: {
      onClicked: clicked,
      removeAll(callback) {
        removes += 1;
        callback();
        return Promise.resolve();
      },
      create(_item, callback) {
        creates += 1;
        chromeApi.runtime.lastError = { message: 'native secret' };
        callback();
        chromeApi.runtime.lastError = null;
        return Promise.resolve();
      },
    },
    sidePanel: { async open() {} },
  };
  const controller = registerAuditContextMenus(chromeApi, {
    getReadyRuntime: () => Promise.resolve({}),
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-context', epochNow: () => 1,
    logger: { error(code) { logs.push(code); } },
  });
  assert.equal(await controller.installMenus(), false);
  assert.equal(creates, 1);
  assert.equal(removes, 2);
  assert.deepEqual(logs, ['CONTEXT_MENU_INSTALL_FAILED']);
  assert.equal(JSON.stringify(logs).includes('native secret'), false);
});

test('pure click parsing never reads URL-bearing info fields or accessors', () => {
  const info = { menuItemId: CONTEXT_MENU_IDS.page, frameId: 0 };
  let secretReads = 0;
  for (const key of ['pageUrl', 'linkUrl', 'frameUrl']) {
    Object.defineProperty(info, key, { enumerable: true, get() { secretReads += 1; throw new Error('secret'); } });
  }
  assert.deepEqual(parseContextMenuClick(info, {
    id: 17, windowId: 9, status: 'complete', url: 'https://example.test/', pendingUrl: '',
  }), { tabId: 17, windowId: 9 });
  assert.equal(secretReads, 0);

  const hostileTab = { id: 17, windowId: 9, status: 'complete', pendingUrl: '' };
  Object.defineProperty(hostileTab, 'url', { enumerable: true, get() { secretReads += 1; return 'https://example.test/'; } });
  assert.equal(parseContextMenuClick(info, hostileTab), null);
  assert.equal(secretReads, 0);
  const hostilePending = { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/' };
  Object.defineProperty(hostilePending, 'pendingUrl', { enumerable: true, get() { secretReads += 1; return ''; } });
  assert.equal(parseContextMenuClick(info, hostilePending), null);
  assert.equal(secretReads, 0);
  for (const [badInfo, badTab] of [
    [{ menuItemId: CONTEXT_MENU_IDS.page, frameId: 2 }, { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/' }],
    [{ menuItemId: 'other', frameId: 0 }, { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/' }],
    [{ menuItemId: CONTEXT_MENU_IDS.page, frameId: 0 }, { id: 17, windowId: 9, status: 'loading', url: 'https://example.test/' }],
    [{ menuItemId: CONTEXT_MENU_IDS.page, frameId: 0 }, { id: 17, windowId: 9, status: 'complete', url: 'chrome://settings/' }],
    [{ menuItemId: CONTEXT_MENU_IDS.page, frameId: 0 }, { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/', pendingUrl: 'https://next.test/' }],
  ]) assert.equal(parseContextMenuClick(badInfo, badTab), null);
});

test('opens the side panel as the first Chrome call, then uses the shared adapter, authority and starter', async () => {
  const installed = event();
  const clicked = event();
  const calls = [];
  const chromeApi = {
    runtime: { onInstalled: installed },
    contextMenus: { onClicked: clicked, async removeAll() {}, create() {} },
    sidePanel: { open(value) { calls.push(['open', value]); return Promise.resolve(); } },
  };
  const runtime = Object.freeze({
    chromeAdapter: {
      async probeDocumentIdentity(tabId) { calls.push(['probe', tabId]); return { tabId, windowId: 9, documentId: 'document-1', urlSessionDigest: DIGEST }; },
      async getEvidenceUrl(tabId, includeQuery) { calls.push(['evidence', tabId, includeQuery]); return 'https://example.test/'; },
    },
    authority: {
      async prepare(value) { calls.push(['prepare', value]); return { ok: true, capabilityId: 'C'.repeat(22), expiresAt: 100 }; },
    },
    auditStarter: {
      async beginAuthorizedAudit(value) { calls.push(['start', value]); return { response: { ok: true, auditId: value.auditId, state: 'running' }, sessionCapabilityId: 'S'.repeat(22), completion: Promise.resolve() }; },
    },
  });
  let readinessCalls = 0;
  registerAuditContextMenus(chromeApi, {
    getReadyRuntime() { readinessCalls += 1; calls.push(['ready']); return Promise.resolve(runtime); },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-context-1', epochNow: () => 50,
    logger: { error(code) { calls.push(['log', code]); } },
  });
  clicked.emit({ menuItemId: CONTEXT_MENU_IDS.page, frameId: 0, pageUrl: 'https://secret.test/?token=hidden' }, {
    id: 17, windowId: 9, status: 'complete', url: 'https://example.test/', pendingUrl: null,
  });
  assert.deepEqual(calls, [['open', { windowId: 9 }]]);
  assert.equal(readinessCalls, 0);
  await tick();
  assert.equal(calls[1][0], 'ready');
  assert.equal(calls[2][0], 'probe');
  const prepare = calls.find(([name]) => name === 'prepare')[1];
  assert.deepEqual(prepare.issuer, { type: 'worker-event', event: 'context-menu', eventNonce: 'N'.repeat(22) });
  assert.equal(JSON.stringify(calls).includes('token=hidden'), false);
  const started = calls.find(([name]) => name === 'start')[1];
  assert.equal(started.eventNonce, 'N'.repeat(22));
  assert.equal(started.senderContext, null);
  assert.equal(started.capturePolicy.mode, 'no-pixels');
  assert.deepEqual(started.retentionPreference, { version: 1, deleteAfterCompleteExport: false });
});

test('invalid clicks and readiness failure perform no post-open audit effects or secret logging', async () => {
  const installed = event();
  const clicked = event();
  const logs = [];
  const opens = [];
  const chromeApi = {
    runtime: { onInstalled: installed },
    contextMenus: { onClicked: clicked, async removeAll() {}, create() {} },
    sidePanel: { open(value) { opens.push(value); return Promise.resolve(); } },
  };
  registerAuditContextMenus(chromeApi, {
    getReadyRuntime: () => Promise.reject(new Error('native secret')),
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-context-2', epochNow: () => 50,
    logger: { error(code) { logs.push(code); } },
  });
  clicked.emit({ menuItemId: 'unknown', frameId: 0 }, { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/' });
  assert.deepEqual(opens, []);
  clicked.emit({ menuItemId: CONTEXT_MENU_IDS.page, frameId: 0 }, { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/' });
  await tick();
  assert.deepEqual(opens, [{ windowId: 9 }]);
  assert.deepEqual(logs, ['CONTEXT_MENU_UNAVAILABLE']);
});

test('contains a closed starter denial after opening without exposing its native detail', async () => {
  const installed = event();
  const clicked = event();
  const logs = [];
  const chromeApi = {
    runtime: { onInstalled: installed },
    contextMenus: { onClicked: clicked, async removeAll() {}, create() {} },
    sidePanel: { async open() {} },
  };
  registerAuditContextMenus(chromeApi, {
    getReadyRuntime: () => Promise.resolve({
      chromeAdapter: {
        async probeDocumentIdentity() { return { tabId: 17, windowId: 9, documentId: 'document-1', urlSessionDigest: DIGEST }; },
        async getEvidenceUrl() { return 'https://example.test/'; },
      },
      authority: { async prepare() { return { ok: true, capabilityId: 'C'.repeat(22), expiresAt: 100 }; } },
      auditStarter: { async beginAuthorizedAudit() { return { response: { ok: false, code: 'AUDIT_BUSY', native: 'secret' } }; } },
    }),
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-context-denied', epochNow: () => 50,
    logger: { error(code) { logs.push(code); } },
  });
  clicked.emit({ menuItemId: CONTEXT_MENU_IDS.page, frameId: 0 }, {
    id: 17, windowId: 9, status: 'complete', url: 'https://example.test/', pendingUrl: '',
  });
  await tick();
  assert.deepEqual(logs, ['CONTEXT_MENU_UNAVAILABLE']);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});
