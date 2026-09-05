import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { createExportLaunchAuthority, deriveExportLeaseOwner } from '../../src/background/export-launch.js';

async function optionalModule(path) {
  const url = new URL(path, import.meta.url);
  return import(url.href).catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === url.href) return {};
    throw error;
  });
}
const serverModule = await optionalModule('../../src/background/blob-url-port.js');
const clientModule = await optionalModule('../../src/export/blob-url-client.js');
const EXTENSION = 'a'.repeat(32);
const ISO = '2026-09-05T14:00:00.000Z';
const EPOCH = Date.parse(ISO);
const urlFor = index => `blob:chrome-extension://${EXTENSION}/11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: value => { for (const fn of [...listeners]) fn(value); } };
};
async function until(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Local paired-Port condition did not settle');
}

async function fixture(t) {
  assert.equal(typeof serverModule.createBlobUrlPortBridgeV1, 'function', 'bridge factory missing');
  assert.equal(typeof clientModule.createExportBlobUrlClientV1, 'function', 'client factory missing');
  const rows = new Map(); const contexts = new Map(); const tabs = new Map(); const clients = []; const ports = [];
  const nativeRevocations = []; const held = []; let holdResults = false; let contextFailure = false; let nextTab = 70; let random = 1;
  const area = {
    async get(keys) { const selected = keys === null ? [...rows.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter(key => rows.has(key)).map(key => [key, structuredClone(rows.get(key))])); },
    async set(values) { for (const [key, value] of Object.entries(values)) rows.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) rows.delete(key); },
  };
  const runtime = { id: EXTENSION,
    getURL: path => `chrome-extension://${EXTENSION}${path.startsWith('/') ? path : '/' + path}`,
    async getContexts(filter) { if (contextFailure) throw new Error('PRIVATE_NATIVE_FAILURE');
      return [...contexts.values()].filter(value => !filter?.documentIds || filter.documentIds.includes(value.documentId)); },
  };
  const chromeApi = { runtime, tabs: {
    async create({ windowId }) { const tab = { id: ++nextTab, windowId, url: 'about:blank' }; tabs.set(tab.id, tab); return { ...tab }; },
    async update(tabId, changes) {
      const tab = { ...tabs.get(tabId), ...changes }; tabs.set(tabId, tab);
      const documentId = `export-document-${tabId}`;
      contexts.set(documentId, { contextId: `context-${tabId}`, contextType: 'TAB', documentId,
        documentUrl: tab.url, documentOrigin: `chrome-extension://${EXTENSION}`, tabId, windowId: tab.windowId, frameId: 0, incognito: false });
      return { ...tab };
    },
    async get(id) { return { ...tabs.get(id) }; },
    async remove(id) { tabs.delete(id); contexts.delete(`export-document-${id}`); },
  } };
  const store = createInMemoryAuditStore();
  const exportLaunch = createExportLaunchAuthority({ chromeApi, sessionArea: area, auditStore: store,
    reportLaunch: { async authorizeExport({ auditId }) { return { ok: true, auditId, windowId: 7, sessionCapabilityId: 'R'.repeat(22) }; },
      async validateConsumer() { return true; } },
    epochNow: () => EPOCH, modelNow: () => ISO, randomBytes: size => new Uint8Array(size).fill(random++),
  });
  let bridge;
  const rebuild = () => {
    bridge = serverModule.createBlobUrlPortBridgeV1({ chromeApi, sessionArea: area, exportLaunch, auditStore: store, now: () => EPOCH });
  };
  rebuild();
  t.after(() => { for (const client of clients) client.dispose(); bridge.dispose(); });
  async function owner(auditId) {
    const model = structuredClone(SAMPLE_AUDIT); model.auditId = auditId;
    await store.commitAudit(auditId, model, { auditId }, { now: ISO });
    assert.equal((await exportLaunch.requestExport({ auditId, sessionCapabilityId: 'R'.repeat(22), sender: {} })).ok, true);
    const launch = await exportLaunch.getLaunch(auditId);
    const sender = { id: EXTENSION, documentId: `export-document-${launch.tabId}`, frameId: 0,
      documentLifecycle: 'active', url: runtime.getURL(`/src/export/index.html?auditId=${auditId}`),
      origin: `chrome-extension://${EXTENSION}`, tab: { id: launch.tabId, windowId: launch.windowId } };
    const connected = await exportLaunch.connect({ auditId, sender });
    assert.equal(connected.ok, true, 'real launch must authenticate before the Blob client exists');
    const snapshot = await store.getAuditSnapshot(auditId);
    const ownerId = deriveExportLeaseOwner(auditId, connected.attemptId);
    const lease = { ownerId, exportAttempt: Number(connected.attemptId), now: ISO, ttlMs: 600_000,
      latestState: { auditId, exportStatus: 'running', exportRevision: snapshot.revision,
        exportAttempt: Number(connected.attemptId), leaseOwnerId: ownerId } };
    await store.claimExportLease(auditId, snapshot.capability, lease);
    await store.beginExportDelivery(auditId, snapshot.capability, { ...lease,
      latestState: { ...lease.latestState, exportStatus: 'delivering' } });
    const sent = [];
    const connect = ({ name }) => {
      let closed = false;
      const clientPort = { name, onMessage: event(), onDisconnect: event() };
      const serverPort = { name, sender, onMessage: event(), onDisconnect: event() };
      const disconnect = () => { if (closed) return; closed = true;
        queueMicrotask(() => { clientPort.onDisconnect.emit(); serverPort.onDisconnect.emit(); }); };
      clientPort.disconnect = serverPort.disconnect = disconnect;
      clientPort.postMessage = value => { if (closed) throw new Error('Closed local Port');
        queueMicrotask(() => { if (!closed) serverPort.onMessage.emit(structuredClone(value)); }); };
      serverPort.postMessage = value => { if (closed) throw new Error('Closed local Port'); sent.push(structuredClone(value));
        const deliver = () => { if (!closed) clientPort.onMessage.emit(structuredClone(value)); };
        if (holdResults && value.type === 'result') held.push(deliver); else queueMicrotask(deliver); };
      ports.push({ auditId, clientPort, serverPort });
      assert.equal(bridge.attachPort(serverPort), true);
      return clientPort;
    };
    const client = clientModule.createExportBlobUrlClientV1({ runtime: { ...runtime, connect },
      urlApi: { revokeObjectURL: blobUrl => { nativeRevocations.push([auditId, blobUrl]); } },
      auditId, sessionCapabilityId: connected.sessionCapabilityId });
    clients.push(client);
    return { auditId, client, sent, sender };
  }
  return { owner, store, rows, ports, contexts, nativeRevocations,
    get bridge() { return bridge; },
    liveRows: () => [...rows.keys()].filter(key => key.startsWith('audita:blob-url:v1:')),
    holdResults: () => { holdResults = true; },
    releaseResults: () => { holdResults = false; for (const deliver of held.splice(0)) queueMicrotask(deliver); },
    get heldCount() { return held.length; },
    failContexts: value => { contextFailure = value; },
    restart: () => { bridge.dispose(); rebuild(); },
  };
}

test('local Blob composition records five export URLs before use and releases without changing the audit', async t => {
  const f = await fixture(t); const owner = await f.owner('audit-one');
  const before = JSON.stringify(await f.store.getAudit('audit-one'));
  for (let index = 1; index <= 5; index++) {
    const blobUrl = urlFor(index);
    await owner.client.blobLifecycle.register(blobUrl);
    assert.equal(f.liveRows().length, 1, 'registration is durable before URL can be used');
    await owner.client.blobLifecycle.release(blobUrl);
    assert.equal(f.liveRows().length, 0);
    assert.ok(f.nativeRevocations.some(row => row[1] === blobUrl));
  }
  assert.equal(JSON.stringify(await f.store.getAudit('audit-one')), before);
});

test('local Blob composition revokes while the registration ACK is delayed and prevents delivery', async t => {
  const f = await fixture(t); const owner = await f.owner('audit-one'); f.holdResults();
  const pending = owner.client.blobLifecycle.register(urlFor(1));
  const rejection = assert.rejects(pending, /BLOB_CLIENT_UNAVAILABLE/u);
  await until(() => f.heldCount === 1);
  await f.bridge.registry.clearAudit('audit-one');
  assert.equal(f.liveRows().length, 0);
  assert.ok(f.nativeRevocations.some(row => row[1] === urlFor(1)));
  f.releaseResults(); await rejection;
});

test('local Blob composition reconnects the same owner after worker restart without registering again', async t => {
  const f = await fixture(t); const owner = await f.owner('audit-one');
  await owner.client.blobLifecycle.register(urlFor(1));
  f.restart(); await until(() => f.ports.length === 2 && owner.sent.filter(packet => packet.type === 'ready').length === 2);
  assert.equal(f.liveRows().length, 1);
  await f.bridge.registry.clearAudit('audit-one');
  assert.equal(f.liveRows().length, 0);
  assert.ok(f.nativeRevocations.some(row => row[1] === urlFor(1)));
});

test('local Blob composition distinguishes unavailable contexts from a destroyed owner', async t => {
  const f = await fixture(t); const owner = await f.owner('audit-one');
  await owner.client.blobLifecycle.register(urlFor(1));
  f.failContexts(true); await assert.rejects(f.bridge.registry.clearAudit('audit-one'));
  assert.equal(f.liveRows().length, 1);
  f.failContexts(false); owner.client.dispose(); f.contexts.delete(owner.sender.documentId);
  assert.equal(await f.bridge.registry.clearAudit('audit-one'), 1);
  assert.equal(f.liveRows().length, 0);
});

test('local Blob composition sends revocation only to the exact owner and preserves another audit', async t => {
  const f = await fixture(t); const one = await f.owner('audit-one'); const two = await f.owner('audit-two');
  await one.client.blobLifecycle.register(urlFor(1)); await two.client.blobLifecycle.register(urlFor(2));
  const before = structuredClone(two.sent);
  await f.bridge.registry.clearAudit('audit-one');
  assert.deepEqual(two.sent, before);
  assert.equal(f.liveRows().length, 1);
  assert.equal(f.nativeRevocations.some(row => row[0] === 'audit-two'), false);
  await two.client.blobLifecycle.release(urlFor(2)); assert.equal(f.liveRows().length, 0);
});
