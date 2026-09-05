import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../../src/background/blob-url-port.js', import.meta.url);
const bridgeModule = await import(moduleUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});
const EXTENSION = 'a'.repeat(32);
const AUDIT = 'audit-a';
const CAPABILITY = 'A'.repeat(22);
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EPOCH = Date.parse('2026-09-05T14:00:00.000Z');
const PAGE = `chrome-extension://${EXTENSION}/src/export/index.html?auditId=${AUDIT}`;
const BLOB = `blob:chrome-extension://${EXTENSION}/11111111-1111-4111-8111-111111111111`;
const OTHER_BLOB = `blob:chrome-extension://${EXTENSION}/22222222-2222-4222-8222-222222222222`;
const NAME = 'audita-export-blobs-v1';
const SECRET = 'PRIVATE_BLOB_PORT_FAILURE';
const copy = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const context = (documentId = OWNER, tabId = 7) => ({ contextType: 'TAB', documentId, documentUrl: PAGE, tabId, windowId: 3, frameId: 0 });
const sender = (documentId = OWNER, tabId = 7) => ({ id: EXTENSION, url: PAGE, documentId, frameId: 0, tab: { id: tabId, windowId: 3 } });
const registryUnavailable = error => {
  assert.equal(error.message, 'BLOB_REGISTRY_UNAVAILABLE');
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(SECRET), false);
  return true;
};

function event() {
  const listeners = new Set();
  return { listeners, addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    emit: value => { for (const listener of [...listeners]) listener(value); } };
}
function port(nativeSender = sender()) {
  const waiters = [];
  const disconnected = deferred();
  const value = {
    name: NAME, sender: nativeSender, onMessage: event(), onDisconnect: event(), sent: [], closed: false,
    postMessage(message) {
      if (value.closed) throw new Error(SECRET);
      value.sent.push(copy(message));
      for (const waiter of [...waiters]) if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(copy(message));
      }
      value.onPost?.(message);
    },
    disconnect() { if (!value.closed) { value.closed = true; value.onDisconnect.emit(); disconnected.resolve(); } },
    receive: message => value.onMessage.emit(message),
    wait(predicate) {
      const existing = value.sent.find(predicate);
      if (existing) return Promise.resolve(copy(existing));
      return new Promise(resolve => waiters.push({ predicate, resolve }));
    },
    disconnected: disconnected.promise,
  };
  return value;
}
function fixture(t) {
  const values = new Map();
  const contexts = new Map([[OWNER, context()], [OTHER, context(OTHER, 8)]]);
  const trace = [];
  const handlers = {};
  const state = {
    now: EPOCH,
    launch: { version: 1, auditId: AUDIT, sourceReviewSessionCapabilityId: 'B'.repeat(22), expectedRevision: 2,
      attemptId: '1', tabId: 7, windowId: 3, path: '/src/export/index.html', documentId: OWNER,
      state: 'connected', issuedAt: EPOCH - 1000, expiresAt: EPOCH + 60_000 },
    session: { version: 1, sessionCapabilityId: CAPABILITY, auditId: AUDIT, launchTabId: 7, launchDocumentId: OWNER,
      expectedRevision: 2, attemptId: '1', intents: ['execute-export', 'complete-export'], state: 'active',
      issuedAt: EPOCH - 1000, expiresAt: EPOCH + 60_000 },
    lease: { active: true, phase: 'delivering', retryAt: '2026-09-05T14:01:00.000Z', revision: 2, exportAttempt: 1,
      ownerId: `export:${AUDIT}:1` },
  };
  const sessionArea = {
    async get(key) {
      if (handlers.get) await handlers.get(key);
      return key === null ? Object.fromEntries([...values].map(([k, v]) => [k, copy(v)])) :
        values.has(key) ? { [key]: copy(values.get(key)) } : {};
    },
    async set(entries) {
      if (handlers.set) await handlers.set(entries);
      for (const [key, value] of Object.entries(entries)) values.set(key, copy(value));
    },
    async remove(key) { values.delete(key); },
  };
  const options = {
    chromeApi: { runtime: { id: EXTENSION, async getContexts(filter) {
      trace.push(['contexts', copy(filter)]);
      if (handlers.contexts) return handlers.contexts(filter);
      return filter.documentIds.flatMap(id => contexts.has(id) ? [copy(contexts.get(id))] : []);
    } } },
    sessionArea,
    exportLaunch: {
      async getLaunch(auditId) { trace.push(['launch', auditId]); return handlers.launch ? handlers.launch(auditId) : copy(state.launch); },
      async getSession(id) { trace.push(['session', id]); return handlers.session ? handlers.session(id) : copy(state.session); },
    },
    auditStore: { async getExportLeaseState(auditId, request) {
      trace.push(['lease', auditId, copy(request)]); return handlers.lease ? handlers.lease(auditId, request) : copy(state.lease);
    } },
    now: () => state.now,
  };
  const create = () => {
    assert.equal(typeof bridgeModule.createBlobUrlPortBridgeV1, 'function', 'blob Port bridge factory is missing');
    const bridge = bridgeModule.createBlobUrlPortBridgeV1(options);
    t.after(() => bridge.dispose());
    return bridge;
  };
  const connect = async (bridge, nativeSender = sender()) => {
    const owner = port(nativeSender);
    assert.equal(bridge.attachPort(owner), true);
    owner.receive({ type: 'hello', auditId: AUDIT, sessionCapabilityId: CAPABILITY });
    await owner.wait(value => value.type === 'ready');
    return owner;
  };
  const request = async (owner, type, requestId, blobUrl = BLOB) => {
    owner.receive({ type, requestId, blobUrl });
    return owner.wait(value => value.type === 'result' && value.requestId === requestId);
  };
  const rows = () => [...values.values()].filter(value => Object.hasOwn(value, 'blobUrl'));
  return { values, contexts, trace, handlers, state, options, create, connect, request, rows };
}

test('Blob Port binds native export identity and rejects untrusted owners before registration', async t => {
  for (const [label, change] of [
    ['extension', value => { value.id = 'b'.repeat(32); }],
    ['frame', value => { value.frameId = 1; }],
    ['missing frame', value => { delete value.frameId; }],
    ['document', value => { value.documentId = 'absent'; }],
    ['tab', value => { value.tab.id = 8; }],
    ['window', value => { value.tab.windowId = 4; }],
    ['path', value => { value.url = value.url.replace('/export/', '/review/'); }],
    ['hash', value => { value.url += '#extra'; }],
    ['audit query', value => { value.url += '&auditId=audit-foreign'; }],
  ]) await t.test(label, async sub => {
    const f = fixture(sub); const bridge = f.create(); const identity = sender(); change(identity);
    const owner = port(identity);
    bridge.attachPort(owner);
    owner.receive({ type: 'hello', auditId: AUDIT, sessionCapabilityId: CAPABILITY });
    await owner.disconnected;
    assert.deepEqual(f.rows(), []);
    assert.equal(owner.sent.some(value => value.type === 'ready'), false);
    assert.equal(f.trace.some(([name]) => name === 'launch' || name === 'lease'), false);
  });
  await t.test('foreign Port name is untouched', sub => {
    const f = fixture(sub); const owner = port(); owner.name = 'foreign';
    assert.equal(f.create().attachPort(owner), false);
    assert.equal(owner.closed, false);
    assert.equal(owner.onMessage.listeners.size, 0);
  });
});

test('Blob Port registers only the correlated active delivery lease and current launch session', async t => {
  await t.test('successful registration persists only the derived registry tuple', async sub => {
    const f = fixture(sub); const bridge = f.create();
    assert.equal(Object.isFrozen(bridge), true);
    const owner = await f.connect(bridge);
    assert.deepEqual(await f.request(owner, 'register', 1), { type: 'result', requestId: 1, ok: true });
    assert.deepEqual(f.rows(), [{ version: 1, auditId: AUDIT, blobUrl: BLOB, ownerDocumentId: OWNER }]);
    assert.ok(f.trace.some(row => row[0] === 'lease' && row[1] === AUDIT && row[2].now === '2026-09-05T14:00:00.000Z'));
  });
  for (const [label, change] of [
    ['launch revoked', s => { s.launch.state = 'revoked'; }],
    ['launch gone', s => { s.launch = null; }],
    ['launch document', s => { s.launch.documentId = OTHER; }],
    ['launch window', s => { s.launch.windowId = 4; }],
    ['launch tab', s => { s.launch.tabId = 8; }],
    ['launch audit', s => { s.launch.auditId = 'foreign'; }],
    ['session revoked', s => { s.session.state = 'revoked'; }],
    ['session missing', s => { s.session = null; }],
    ['session capability', s => { s.session.sessionCapabilityId = 'C'.repeat(22); }],
    ['session document', s => { s.session.launchDocumentId = OTHER; }],
    ['session attempt', s => { s.session.attemptId = '2'; }],
    ['session revision', s => { s.session.expectedRevision = 3; }],
    ['session expiry mismatch', s => { s.session.expiresAt += 1; }],
    ['lease released', s => { s.lease = { active: false, revision: 2 }; }],
    ['lease phase', s => { s.lease.phase = 'claimed'; }],
    ['lease owner', s => { s.lease.ownerId = 'export:foreign:1'; }],
    ['lease attempt', s => { s.lease.exportAttempt = 2; }],
    ['lease revision', s => { s.lease.revision = 3; }],
    ['lease expired', s => { s.lease.retryAt = '2026-09-05T14:00:00.000Z'; }],
    ['lease numeric deadline is not the real store contract', s => { s.lease.retryAt = EPOCH + 60_000; }],
    ['lease noncanonical deadline', s => { s.lease.retryAt = '2026-09-05T14:01:00Z'; }],
    ['clock regressed', s => { s.now = EPOCH - 2000; }],
  ]) await t.test(label, async sub => {
    const f = fixture(sub); const owner = await f.connect(f.create()); change(f.state);
    assert.deepEqual(await f.request(owner, 'register', 1), { type: 'result', requestId: 1, ok: false });
    assert.deepEqual(f.rows(), []);
  });
  await t.test('expiry reached during awaited lease read denies without persistence', async sub => {
    const f = fixture(sub); const owner = await f.connect(f.create());
    f.handlers.lease = async () => { f.state.now = EPOCH + 60_000; return copy(f.state.lease); };
    assert.equal((await f.request(owner, 'register', 1)).ok, false);
    assert.deepEqual(f.rows(), []);
  });
  await t.test('ISO lease expiry crossed during await denies while launch and session remain active', async sub => {
    const f = fixture(sub); const owner = await f.connect(f.create());
    f.state.lease.retryAt = '2026-09-05T14:00:10.000Z';
    f.handlers.lease = async () => { f.state.now = EPOCH + 10_000; return copy(f.state.lease); };
    assert.equal((await f.request(owner, 'register', 1)).ok, false);
    assert.deepEqual(f.rows(), []);
  });
  await t.test('new origin or a revoked session cannot reuse the authenticated Port', async sub => {
    const f = fixture(sub); const owner = await f.connect(f.create());
    assert.equal((await f.request(owner, 'register', 1)).ok, true);
    f.state.session.state = 'revoked';
    assert.equal((await f.request(owner, 'register', 2, OTHER_BLOB)).ok, false);
    assert.equal((await f.request(owner, 'register', 3, BLOB.replace(EXTENSION, 'b'.repeat(32)))).ok, false);
    assert.equal(f.rows().length, 1);
  });
});

test('Blob Port native revocation acknowledges outside the registry queue and isolates the owner', async t => {
  const f = fixture(t); const bridge = f.create(); const owner = await f.connect(bridge);
  const foreign = await f.connect(bridge, sender(OTHER, 8));
  const revocations = [];
  owner.onPost = value => {
    if (value.type === 'revoke') { revocations.push(value.blobUrl); owner.receive({ type: 'revoked', requestId: value.requestId, ok: true }); }
  };
  assert.equal((await f.request(owner, 'register', 1)).ok, true);
  assert.equal((await f.request(foreign, 'release', 1)).ok, false);
  assert.equal(f.rows().length, 1);
  f.state.launch.state = 'revoked'; f.state.session.state = 'revoked'; f.state.lease.active = false;
  assert.equal((await f.request(owner, 'release', 2)).ok, true);
  assert.deepEqual(revocations, [BLOB]);
  assert.deepEqual(f.rows(), []);
  assert.equal(foreign.sent.some(value => value.type === 'revoke'), false);
  assert.equal((await f.request(owner, 'release', 3)).ok, true);
});

test('Blob Port restart reconnects cleanup without active session and only confirmed absence retires an owner', async t => {
  for (const mode of ['reconnect', 'absent', 'error', 'malformed', 'malformed empty', 'ambiguous', 'wrong document']) await t.test(mode, async sub => {
    const f = fixture(sub); const first = f.create(); const owner = await f.connect(first);
    assert.equal((await f.request(owner, 'register', 1)).ok, true);
    first.dispose();
    f.state.launch = null; f.state.session = null;
    const restarted = f.create();
    if (mode === 'reconnect') {
      const recovered = await f.connect(restarted);
      recovered.onPost = value => { if (value.type === 'revoke') recovered.receive({ type: 'revoked', requestId: value.requestId, ok: true }); };
      assert.equal((await f.request(recovered, 'register', 1, OTHER_BLOB)).ok, false);
      assert.equal(await restarted.registry.clearAudit(AUDIT), 1);
    } else if (mode === 'absent') {
      f.contexts.delete(OWNER);
      assert.equal(await restarted.registry.clearAudit(AUDIT), 1);
    } else {
      f.handlers.contexts = () => {
        if (mode === 'error') throw new Error(SECRET);
        if (mode === 'malformed') return undefined;
        if (mode === 'malformed empty') return Object.assign([], { unknown: true });
        if (mode === 'ambiguous') return [context(), context()];
        return [context(OTHER, 8)];
      };
      await assert.rejects(restarted.registry.clearAudit(AUDIT), registryUnavailable);
    }
    assert.equal(f.rows().length, ['reconnect', 'absent'].includes(mode) ? 0 : 1);
  });
});

test('Blob Port bad acknowledgements and timeout keep cleanup recoverable without exposing native errors', async t => {
  for (const mode of ['false', 'wrong id', 'disconnect', 'timeout']) await t.test(mode, async sub => {
    const f = fixture(sub); const bridge = f.create(); const owner = await f.connect(bridge);
    assert.equal((await f.request(owner, 'register', 1)).ok, true);
    owner.onPost = value => {
      if (value.type !== 'revoke') return;
      if (mode === 'false') owner.receive({ type: 'revoked', requestId: value.requestId, ok: false });
      if (mode === 'wrong id') owner.receive({ type: 'revoked', requestId: value.requestId + 1, ok: true });
      if (mode === 'disconnect') owner.disconnect();
    };
    await assert.rejects(bridge.registry.clearAudit(AUDIT), registryUnavailable);
    assert.equal(f.rows().length, 1);
  });
});

test('Blob Port bounds queued operations and rejects replays while allowing registry cleanup during register', async t => {
  await t.test('clearAudit can revoke before a delayed register acknowledgement', async sub => {
    const f = fixture(sub); const bridge = f.create(); const owner = await f.connect(bridge);
    const entered = deferred(); const release = deferred(); let once = true;
    f.handlers.set = async entries => { if (once && Object.values(entries).some(value => value.blobUrl)) {
      once = false; entered.resolve(); await release.promise;
    } };
    owner.onPost = value => { if (value.type === 'revoke') owner.receive({ type: 'revoked', requestId: value.requestId, ok: true }); };
    const registering = f.request(owner, 'register', 1);
    await entered.promise;
    const clearing = bridge.registry.clearAudit(AUDIT);
    release.resolve();
    await registering;
    assert.equal(await clearing, 1);
    assert.deepEqual(f.rows(), []);
    assert.equal((await f.request(owner, 'register', 2, OTHER_BLOB)).ok, false);
  });
  await t.test('33rd pending operation disconnects without starting queued writes', async sub => {
    const f = fixture(sub); const bridge = f.create(); const owner = await f.connect(bridge);
    const entered = deferred(); const release = deferred();
    f.handlers.lease = async () => { entered.resolve(); await release.promise; return copy(f.state.lease); };
    owner.receive({ type: 'register', requestId: 1, blobUrl: BLOB });
    await entered.promise;
    for (let requestId = 2; requestId <= 33; requestId += 1) owner.receive({ type: 'register', requestId, blobUrl: OTHER_BLOB });
    await owner.disconnected;
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.rows(), []);
  });
  await t.test('same request id and second HELLO disconnect their own Port only', async sub => {
    const f = fixture(sub); const bridge = f.create();
    for (const second of [{ type: 'release', requestId: 1, blobUrl: BLOB }, { type: 'hello', auditId: AUDIT, sessionCapabilityId: CAPABILITY }]) {
      const owner = await f.connect(bridge);
      assert.equal((await f.request(owner, 'release', 1)).ok, true);
      owner.receive(second); await owner.disconnected;
    }
  });
});
