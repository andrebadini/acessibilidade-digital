import assert from 'node:assert/strict';
import test from 'node:test';

import * as panelLaunchModule from '../../src/background/panel-launch-authority.js';

const { createPanelLaunchAuthority } = panelLaunchModule;
const isPanelLaunchRetirementV1 = value =>
  panelLaunchModule.isPanelLaunchRetirementV1?.(value) ?? false;

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EPOCH = 1_788_000_000_000;
const TOKEN_A = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';
const TOKEN_B = 'vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLw';

function createSessionArea() {
  const values = Object.create(null);
  return {
    values,
    async get(keys) {
      if (keys === null) return structuredClone(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      const envelope = {};
      for (const key of requested) {
        if (Object.hasOwn(values, key)) envelope[key] = structuredClone(values[key]);
      }
      return envelope;
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function restartFacade(area) {
  return {
    get: keys => area.get(keys),
    set: entries => area.set(entries),
    remove: keys => area.remove(keys),
  };
}

function fixture(overrides = {}) {
  const sessionArea = overrides.sessionArea ?? createSessionArea();
  const randomCalls = [];
  const chromeApi = overrides.chromeApi ?? {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return []; },
    },
  };
  const authority = createPanelLaunchAuthority({
    chromeApi,
    sessionArea,
    now: overrides.now ?? (() => EPOCH),
    randomBytes: overrides.randomBytes ?? (length => {
      randomCalls.push(length);
      return new Uint8Array(length).fill(0xab);
    }),
    ttlMs: overrides.ttlMs,
  });
  return { authority, chromeApi, randomCalls, sessionArea };
}

async function flushPersistence() {
  await new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function initialize(env) {
  assert.equal(await env.authority.initialize(), true);
  return env;
}

function senderFor(token) {
  const url = `chrome-extension://${RUNTIME_ID}/src/panel/index.html?launch=${token}`;
  return { id: RUNTIME_ID, url, origin: `chrome-extension://${RUNTIME_ID}` };
}

function contextFor(token, overrides = {}) {
  return {
    contextType: 'SIDE_PANEL',
    contextId: 'panel-context-1',
    documentId: 'panel-document-1',
    documentUrl: senderFor(token).url,
    tabId: -1,
    windowId: -1,
    ...overrides,
  };
}

test('issues a synchronous frozen 256-bit launch and starts session-only persistence', async () => {
  const { authority, randomCalls, sessionArea } = await initialize(fixture());

  const issued = authority.issue({ tabId: 41, windowId: 9 });

  assert.equal(typeof issued?.then, 'undefined');
  assert.deepEqual(issued, {
    ok: true,
    token: TOKEN_A,
    path: `src/panel/index.html?launch=${TOKEN_A}`,
    generation: 1,
  });
  assert.equal(Object.isFrozen(issued), true);
  assert.deepEqual(randomCalls, [32]);

  await flushPersistence();
  const persisted = await sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.equal(Object.keys(persisted).every(key => key.startsWith('audita:panel-launch:')), true);
  assert.doesNotMatch(JSON.stringify(persisted), /https?:\/\//u);
});

test('admits one exact tokenized Side Panel context and returns a document-bound sender', async () => {
  const contextFilters = [];
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts(filter) {
        contextFilters.push(structuredClone(filter));
        return [contextFor(TOKEN_A)];
      },
    },
  };
  const { authority, sessionArea } = await initialize(fixture({ chromeApi }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  const sender = senderFor(issued.token);

  const admitted = await authority.admitPort({ sender });

  assert.deepEqual(admitted, {
    ok: true,
    token: TOKEN_A,
    tabId: 41,
    windowId: 9,
    generation: 1,
    contextId: 'panel-context-1',
    documentId: 'panel-document-1',
    url: sender.url,
    syntheticSender: {
      id: RUNTIME_ID,
      url: sender.url,
      origin: `chrome-extension://${RUNTIME_ID}`,
      documentId: 'panel-document-1',
    },
  });
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.syntheticSender), true);
  assert.deepEqual(contextFilters, [{
    contextTypes: ['SIDE_PANEL'],
    documentUrls: [sender.url],
  }]);
  const persisted = await sessionArea.get(null);
  assert.equal(Object.values(persisted).every(record => record.state === 'admitted'), true);
});

test('confirms only the exact connected admitted Side Panel for its audited source tab', async () => {
  let contexts = [contextFor(TOKEN_A)];
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return contexts; },
    },
  };
  const { authority } = await initialize(fixture({ chromeApi }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  assert.equal((await authority.admitPort({ sender: senderFor(issued.token) })).ok, true);

  assert.equal(await authority.hasOpenPanelForSource({ tabId: 41, windowId: 9 }), true);
  assert.equal(await authority.hasOpenPanelForSource({ tabId: 42, windowId: 9 }), false);
  assert.equal(await authority.hasOpenPanelForSource({ tabId: 41, windowId: 10 }), false);
  contexts = [contextFor(TOKEN_A, { documentId: 'foreign-panel-document' })];
  assert.equal(await authority.hasOpenPanelForSource({ tabId: 41, windowId: 9 }), false);
});

test('atomically rotates an admitted panel to a fresh navigation launch for the same source tab', async () => {
  const entropy = [0xab, 0xbc];
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return [contextFor(TOKEN_A)]; },
    },
  };
  const env = await initialize(fixture({
    chromeApi,
    randomBytes(length) { return new Uint8Array(length).fill(entropy.shift()); },
  }));
  const first = env.authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  const admission = await env.authority.admitPort({ sender: senderFor(first.token) });
  assert.equal(admission.ok, true);

  const rotated = await env.authority.rotateForNavigation({ tabId: 41 });
  assert.deepEqual(rotated, {
    ok: true,
    token: TOKEN_B,
    path: `src/panel/index.html?launch=${TOKEN_B}`,
    generation: 2,
  });
  assert.equal(await env.authority.whenReady(rotated), true);
  assert.deepEqual(await env.authority.reprove(admission), {
    ok: false, code: 'PANEL_LAUNCH_DENIED',
  });
  const persisted = await env.sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.equal(JSON.stringify(persisted).includes(TOKEN_A), false);
  assert.equal(JSON.stringify(persisted).includes(TOKEN_B), true);
});

test('rejects a second live or pending launch for the same source tab synchronously', async () => {
  const { authority, randomCalls } = await initialize(fixture());

  const first = authority.issue({ tabId: 41, windowId: 9 });
  const conflict = authority.issue({ tabId: 41, windowId: 9 });

  assert.equal(first.ok, true);
  assert.deepEqual(conflict, { ok: false, code: 'PANEL_LAUNCH_CONFLICT' });
  assert.equal(Object.isFrozen(conflict), true);
  assert.deepEqual(randomCalls, [32]);
});

test('keeps static, malformed and hostile sender shapes outside launch authority', async () => {
  const url = senderFor(TOKEN_A).url;
  const cases = [
    ['static panel', { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`, origin: `chrome-extension://${RUNTIME_ID}` }],
    ['short token', { id: RUNTIME_ID, url: `${url.slice(0, -43)}short`, origin: `chrome-extension://${RUNTIME_ID}` }],
    ['duplicate token', { id: RUNTIME_ID, url: `${url}&launch=${'M'.repeat(43)}`, origin: `chrome-extension://${RUNTIME_ID}` }],
    ['extra query', { id: RUNTIME_ID, url: `${url}&extra=1`, origin: `chrome-extension://${RUNTIME_ID}` }],
    ['fragment', { id: RUNTIME_ID, url: `${url}#fragment`, origin: `chrome-extension://${RUNTIME_ID}` }],
    ['wrong runtime', { id: 'other-extension', url, origin: `chrome-extension://${RUNTIME_ID}` }],
    ['wrong origin', { id: RUNTIME_ID, url, origin: 'chrome-extension://other-extension' }],
    ['extra identity claim', { id: RUNTIME_ID, url, origin: `chrome-extension://${RUNTIME_ID}`, documentId: 'claimed-document' }],
    ['null prototype', Object.assign(Object.create(null), { id: RUNTIME_ID, url, origin: `chrome-extension://${RUNTIME_ID}` })],
  ];
  let getterReads = 0;
  cases.push(['accessor', Object.defineProperties({}, {
    id: { enumerable: true, value: RUNTIME_ID },
    url: { enumerable: true, get() { getterReads += 1; return url; } },
    origin: { enumerable: true, value: `chrome-extension://${RUNTIME_ID}` },
  })]);

  for (const [name, sender] of cases) {
    let contextCalls = 0;
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { contextCalls += 1; return [contextFor(TOKEN_A)]; },
      },
    };
    const { authority } = await initialize(fixture({ chromeApi }));
    assert.equal(authority.issue({ tabId: 41, windowId: 9 }).ok, true, name);
    assert.deepEqual(await authority.admitPort({ sender }), { ok: false, code: 'PANEL_LAUNCH_DENIED' }, name);
    assert.equal(contextCalls, 0, name);
  }
  assert.equal(getterReads, 0);
});

test('rejects absent, ambiguous or malformed native contexts without consuming the token', async () => {
  const badContexts = [
    [],
    [contextFor(TOKEN_A), contextFor(TOKEN_A, { contextId: 'panel-context-2' })],
    [contextFor(TOKEN_A, { contextType: 'TAB' })],
    [contextFor(TOKEN_A, { contextId: '' })],
    [contextFor(TOKEN_A, { documentId: '' })],
    [contextFor(TOKEN_A, { documentUrl: `${senderFor(TOKEN_A).url}&extra=1` })],
    [contextFor(TOKEN_A, { tabId: 41 })],
    [contextFor(TOKEN_A, { windowId: 9 })],
  ];

  for (const contexts of badContexts) {
    let currentContexts = contexts;
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return structuredClone(currentContexts); },
      },
    };
    const { authority } = await initialize(fixture({ chromeApi }));
    const issued = authority.issue({ tabId: 41, windowId: 9 });
    const sender = senderFor(issued.token);
    assert.deepEqual(await authority.admitPort({ sender }), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
    currentContexts = [contextFor(TOKEN_A, {
      documentOrigin: `chrome-extension://${RUNTIME_ID}`,
      incognito: false,
      frameId: -1,
    })];
    assert.equal((await authority.admitPort({ sender })).ok, true);
  }
});

test('rehydrates an admitted launch after restart with a fresh one-shot connection owner', async () => {
  const filters = [];
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts(filter) {
        filters.push(structuredClone(filter));
        return [contextFor(TOKEN_A)];
      },
    },
  };
  const original = await initialize(fixture({ chromeApi }));
  const issued = original.authority.issue({ tabId: 41, windowId: 9 });
  const firstAdmission = await original.authority.admitPort({ sender: senderFor(issued.token) });
  assert.equal(firstAdmission.ok, true);

  const restartedEnv = await initialize(fixture({
    chromeApi, sessionArea: restartFacade(original.sessionArea),
  }));
  const admitted = await restartedEnv.authority.admitPort({ sender: senderFor(issued.token) });
  assert.equal(admitted.ok, true);
  assert.deepEqual(await restartedEnv.authority.admitPort({ sender: senderFor(issued.token) }), {
    ok: false, code: 'PANEL_LAUNCH_DENIED',
  });

  const rehydrated = await initialize(fixture({
    chromeApi, sessionArea: restartFacade(original.sessionArea),
  }));
  assert.deepEqual(await rehydrated.authority.reprove(admitted), {
    ok: false, code: 'PANEL_LAUNCH_DENIED',
  });
  const freshOwner = await rehydrated.authority.admitPort({ sender: senderFor(issued.token) });
  assert.equal(freshOwner.ok, true);
  assert.deepEqual(await rehydrated.authority.reprove(freshOwner), freshOwner);
  assert.equal(filters.length, 6);
  assert.equal(filters.every(filter =>
    JSON.stringify(filter) === JSON.stringify({
      contextTypes: ['SIDE_PANEL'], documentUrls: [senderFor(TOKEN_A).url],
    })), true);
});

test('revokes either an issued or admitted launch, removes both records, and rejects stale cleanup', async () => {
  const bytes = [0xab, 0xbc];
  const { authority, sessionArea } = await initialize(fixture({
    randomBytes: length => new Uint8Array(length).fill(bytes.shift()),
  }));
  const first = authority.issue({ tabId: 41, windowId: 9 });

  const revoked = await authority.revoke(first);

  assert.deepEqual(revoked, { ok: true, revoked: true });
  assert.equal(Object.isFrozen(revoked), true);
  assert.deepEqual(await sessionArea.get(null), {});

  const second = authority.issue({ tabId: 41, windowId: 9 });
  assert.deepEqual(second, {
    ok: true,
    token: TOKEN_B,
    path: `src/panel/index.html?launch=${TOKEN_B}`,
    generation: 2,
  });
  assert.deepEqual(await authority.revoke(first), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  assert.equal(Object.keys(await sessionArea.get(null)).length, 2);
  assert.deepEqual(await authority.revoke(second), { ok: true, revoked: true });
  assert.deepEqual(await sessionArea.get(null), {});
});

test('erases an expired launch and atomically rotates its tab to a fresh generation', async () => {
  let current = EPOCH;
  const bytes = [0xab, 0xbc];
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts({ documentUrls }) {
        const token = new URL(documentUrls[0]).searchParams.get('launch');
        return [contextFor(token)];
      },
    },
  };
  const firstRun = await initialize(fixture({
    chromeApi,
    now: () => current,
    randomBytes: length => new Uint8Array(length).fill(bytes.shift()),
    ttlMs: 10,
  }));
  const first = firstRun.authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  current += 10;

  assert.deepEqual(await firstRun.authority.admitPort({ sender: senderFor(first.token) }), {
    ok: false, code: 'PANEL_LAUNCH_DENIED',
  });
  assert.deepEqual(await firstRun.sessionArea.get(null), {});

  const second = firstRun.authority.issue({ tabId: 41, windowId: 9 });
  assert.equal(second.token, TOKEN_B);
  assert.equal(second.generation, 2);
  assert.equal((await firstRun.authority.admitPort({ sender: senderFor(second.token) })).ok, true);
  const persisted = await firstRun.sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(TOKEN_A, 'u'));
});

test('rotates an expired pending token without leaving its record behind', async () => {
  let current = EPOCH;
  const bytes = [0xab, 0xbc];
  const { authority, sessionArea } = await initialize(fixture({
    now: () => current,
    randomBytes: length => new Uint8Array(length).fill(bytes.shift()),
    ttlMs: 10,
  }));
  authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  current += 10;

  const rotated = authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();

  assert.equal(rotated.token, TOKEN_B);
  assert.equal(rotated.generation, 2);
  const persisted = await sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(TOKEN_A, 'u'));
});

test('a restarted issuer may replace only the now-disconnected admitted launch', async () => {
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return [contextFor(TOKEN_A)]; },
    },
  };
  const original = await initialize(fixture({ chromeApi }));
  const first = original.authority.issue({ tabId: 41, windowId: 9 });
  assert.equal((await original.authority.admitPort({ sender: senderFor(first.token) })).ok, true);
  const restartedArea = restartFacade(original.sessionArea);
  const restarted = await initialize(fixture({
    chromeApi,
    sessionArea: restartedArea,
    randomBytes: length => new Uint8Array(length).fill(0xbc),
  }));

  const competing = restarted.authority.issue({ tabId: 41, windowId: 9 });
  assert.deepEqual(competing, {
    ok: true, token: TOKEN_B, path: `src/panel/index.html?launch=${TOKEN_B}`, generation: 2,
  });
  assert.equal(await restarted.authority.whenReady(competing), true);

  const persisted = await original.sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(first.token, 'u'));
  assert.match(JSON.stringify(persisted), new RegExp(TOKEN_B, 'u'));
});

test('initializes across restart, removes a stale issued generation and makes the fresh launch admissible', async () => {
  const original = await initialize(fixture());
  const first = original.authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  assert.equal(first.token, TOKEN_A);

  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts({ documentUrls }) {
        const token = new URL(documentUrls[0]).searchParams.get('launch');
        return [contextFor(token)];
      },
    },
  };
  const restarted = await initialize(fixture({
    chromeApi,
    sessionArea: restartFacade(original.sessionArea),
    randomBytes: length => new Uint8Array(length).fill(0xbc),
  }));

  const fresh = restarted.authority.issue({ tabId: 41, windowId: 9 });
  assert.equal(fresh.token, TOKEN_B);
  assert.equal(fresh.generation, 2);
  await flushPersistence();
  assert.equal(restarted.authority.isReady(fresh), true);
  assert.equal((await restarted.authority.admitPort({ sender: senderFor(fresh.token) })).ok, true);
  const persisted = await original.sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(first.token, 'u'));
  assert.match(JSON.stringify(persisted), new RegExp(fresh.token, 'u'));
});

test('reserves a fresh launch during cold initialization and reconciles a stale persisted issue before admission', async () => {
  const original = await initialize(fixture());
  const stale = original.authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  const gate = deferred();
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts({ documentUrls }) {
        const token = new URL(documentUrls[0]).searchParams.get('launch');
        return [contextFor(token)];
      },
    },
  };
  const restarted = fixture({
    chromeApi,
    sessionArea: restartFacade(original.sessionArea),
    randomBytes: length => new Uint8Array(length).fill(0xbc),
  });

  const initializing = restarted.authority.initialize(gate.promise);
  const fresh = restarted.authority.issue({ tabId: 41, windowId: 9 });
  assert.equal(fresh.ok, true, 'a cold action must synchronously mint its bound path');
  assert.equal(fresh.token, TOKEN_B);
  assert.equal(await Promise.race([
    restarted.authority.whenReady(fresh),
    Promise.resolve('pending'),
  ]), 'pending', 'durable authority remains gated until trusted session storage is ready');

  gate.resolve(true);
  assert.equal(await initializing, true);
  assert.equal(await restarted.authority.whenReady(fresh), true);
  assert.equal((await restarted.authority.admitPort({ sender: senderFor(fresh.token) })).ok, true);
  const persisted = await original.sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(stale.token, 'u'));
  assert.match(JSON.stringify(persisted), new RegExp(fresh.token, 'u'));
});

test('reports a synchronously issued reservation unready when its durable write later fails', async () => {
  const sessionArea = createSessionArea();
  const env = await initialize(fixture({ sessionArea }));
  sessionArea.set = async () => { throw new Error('PRIVATE_STORAGE_FAILURE'); };

  const issued = env.authority.issue({ tabId: 41, windowId: 9 });
  assert.equal(env.authority.isReady(issued), false);
  await flushPersistence();
  assert.equal(env.authority.isReady(issued), false);
  assert.deepEqual(await env.authority.admitPort({ sender: senderFor(issued.token) }), {
    ok: false, code: 'PANEL_LAUNCH_DENIED',
  });
});

test('fails closed and erases authority when expiry is reached during native context proof', async () => {
  let current = EPOCH;
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() {
        current += 10;
        return [contextFor(TOKEN_A)];
      },
    },
  };
  const { authority, sessionArea } = await initialize(fixture({ chromeApi, now: () => current, ttlMs: 10 }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });

  assert.deepEqual(await authority.admitPort({ sender: senderFor(issued.token) }), {
    ok: false, code: 'PANEL_LAUNCH_DENIED',
  });
  assert.deepEqual(await sessionArea.get(null), {});
});

test('keeps the exact admitted document authorized after the pre-admission token deadline', async () => {
  let current = EPOCH;
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return [contextFor(TOKEN_A)]; },
    },
  };
  const { authority, sessionArea } = await initialize(fixture({ chromeApi, now: () => current, ttlMs: 10 }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  current += 9;
  const admitted = await authority.admitPort({ sender: senderFor(issued.token) });
  assert.equal(admitted.ok, true);

  current += 1;
  assert.deepEqual(await authority.reprove(admitted), admitted,
    'the exact expiry boundary applies only before admission');
  current += 86_400_000;
  assert.deepEqual(await authority.reprove(admitted), admitted,
    'a live admitted Port/document remains valid until disconnect or explicit revocation');
  assert.equal(Object.keys(await sessionArea.get(null)).length, 2);
});

test('serializes duplicate admission so one port wins and native identity is proved once', async () => {
  let contextCalls = 0;
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { contextCalls += 1; return [contextFor(TOKEN_A)]; },
    },
  };
  const { authority } = await initialize(fixture({ chromeApi }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });

  const attempts = await Promise.all([
    authority.admitPort({ sender: senderFor(issued.token) }),
    authority.admitPort({ sender: senderFor(issued.token) }),
  ]);

  assert.equal(attempts.filter(result => result.ok).length, 1);
  assert.equal(attempts.filter(result => !result.ok).length, 1);
  assert.equal(contextCalls, 1);
});

test('revokes a document-bound admission and makes subsequent proof unavailable', async () => {
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return [contextFor(TOKEN_A)]; },
    },
  };
  const { authority, sessionArea } = await initialize(fixture({ chromeApi }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  const admission = await authority.admitPort({ sender: senderFor(issued.token) });

  assert.deepEqual(await authority.revoke(admission), { ok: true, revoked: true });
  assert.deepEqual(await sessionArea.get(null), {});
  assert.deepEqual(await authority.reprove(admission), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  assert.doesNotMatch(JSON.stringify(admission), /side-panel-window:/u);
});

test('retires one branded owner by releasing the exact live document for same-token reconnect', async () => {
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return [contextFor(TOKEN_A)]; },
    },
  };
  const { authority, sessionArea } = await initialize(fixture({ chromeApi }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  const owner1 = await authority.admitPort({ sender: senderFor(issued.token) });

  const released = await authority.retirePort(owner1);

  assert.deepEqual(released, { version: 1, state: 'released' });
  assert.equal(Object.isFrozen(released), true);
  assert.equal(isPanelLaunchRetirementV1(released), true);
  assert.equal(isPanelLaunchRetirementV1({ version: 1, state: 'released' }), false);
  assert.doesNotMatch(JSON.stringify(released), new RegExp(TOKEN_A, 'u'));
  assert.equal(Object.keys(await sessionArea.get(null)).length, 2);
  assert.deepEqual(await authority.reprove(owner1), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  assert.deepEqual(await authority.revoke(owner1), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  assert.deepEqual(await authority.retirePort(owner1), { version: 1, state: 'denied' });

  const owner2 = await authority.admitPort({ sender: senderFor(issued.token) });
  assert.equal(owner2.ok, true);
  assert.equal(owner2.token, owner1.token);
  assert.notEqual(owner2, owner1);
  assert.deepEqual(await authority.reprove(owner2), owner2);
  assert.deepEqual(await authority.retirePort(owner1), { version: 1, state: 'denied' });
  assert.deepEqual(await authority.reprove(owner2), owner2);
});

test('removes the admitted pair when retirement proves the Side Panel closed or changed', async t => {
  for (const [name, contexts] of [
    ['closed', []],
    ['changed', [contextFor(TOKEN_A, { documentId: 'replacement-document' })]],
  ]) await t.test(name, async () => {
    let currentContexts = [contextFor(TOKEN_A)];
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return structuredClone(currentContexts); },
      },
    };
    const { authority, sessionArea } = await initialize(fixture({ chromeApi }));
    const issued = authority.issue({ tabId: 41, windowId: 9 });
    const admission = await authority.admitPort({ sender: senderFor(issued.token) });
    currentContexts = contexts;

    const retired = await authority.retirePort(admission);

    assert.deepEqual(retired, { version: 1, state: 'revoked' });
    assert.equal(isPanelLaunchRetirementV1(retired), true);
    assert.deepEqual(await sessionArea.get(null), {});
    assert.deepEqual(await authority.reprove(admission), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  });
});

test('a denied retirement preserves the current owner and blocks replacement or reconnect', async t => {
  for (const mode of ['context rejection', 'remove no-op']) await t.test(mode, async () => {
    let contexts = [contextFor(TOKEN_A)];
    const sessionArea = createSessionArea();
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() {
          if (mode === 'context rejection' && contexts.length === 0) throw new Error('PRIVATE_CONTEXT_FAILURE');
          return structuredClone(contexts);
        },
      },
    };
    const { authority } = await initialize(fixture({ chromeApi, sessionArea }));
    const issued = authority.issue({ tabId: 41, windowId: 9 });
    const admission = await authority.admitPort({ sender: senderFor(issued.token) });
    contexts = [];
    if (mode === 'remove no-op') sessionArea.remove = async () => {};

    assert.deepEqual(await authority.retirePort(admission), { version: 1, state: 'denied' });
    assert.equal(Object.keys(await sessionArea.get(null)).length, 2);
    assert.deepEqual(await authority.admitPort({ sender: senderFor(issued.token) }), {
      ok: false, code: 'PANEL_LAUNCH_DENIED',
    });
    assert.deepEqual(authority.issue({ tabId: 41, windowId: 9 }), {
      ok: false, code: 'PANEL_LAUNCH_CONFLICT',
    });
  });
});

test('a released admission can be atomically replaced by a fresh launch generation', async () => {
  const bytes = [0xab, 0xbc];
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return [contextFor(TOKEN_A)]; },
    },
  };
  const { authority, sessionArea } = await initialize(fixture({
    chromeApi,
    randomBytes: length => new Uint8Array(length).fill(bytes.shift()),
  }));
  const first = authority.issue({ tabId: 41, windowId: 9 });
  const owner1 = await authority.admitPort({ sender: senderFor(first.token) });
  assert.equal((await authority.retirePort(owner1)).state, 'released');

  const second = authority.issue({ tabId: 41, windowId: 9 });
  assert.deepEqual(second, {
    ok: true, token: TOKEN_B, path: `src/panel/index.html?launch=${TOKEN_B}`, generation: 2,
  });
  assert.equal(await authority.whenReady(second), true);
  const persisted = await sessionArea.get(null);
  assert.equal(Object.keys(persisted).length, 2);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(TOKEN_A, 'u'));
  assert.match(JSON.stringify(persisted), new RegExp(TOKEN_B, 'u'));
  assert.deepEqual(await authority.retirePort(owner1), { version: 1, state: 'denied' });
});

test('treats an exact admission write committed before storage throws as committed', async () => {
  let current = EPOCH;
  const sessionArea = createSessionArea();
  const originalSet = sessionArea.set.bind(sessionArea);
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return [contextFor(TOKEN_A)]; },
    },
  };
  const { authority } = await initialize(fixture({
    chromeApi, sessionArea, now: () => current, ttlMs: 10,
  }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  assert.equal(await authority.whenReady(issued), true);
  let committedThrow = 0;
  sessionArea.set = async entries => {
    await originalSet(entries);
    if (Object.entries(entries).some(([key, value]) =>
      key.startsWith('audita:panel-launch:') && value?.state === 'admitted')) {
      committedThrow += 1;
      throw new Error('PRIVATE_COMMIT_THEN_THROW');
    }
  };

  const owner = await authority.admitPort({ sender: senderFor(issued.token) });

  assert.equal(owner.ok, true);
  assert.equal(committedThrow, 1);
  assert.deepEqual(await authority.reprove(owner), owner);
  assert.equal(Object.values(await sessionArea.get(null)).every(value => value.state === 'admitted'), true);
  current += 10;
  assert.deepEqual(authority.issue({ tabId: 41, windowId: 9 }), {
    ok: false, code: 'PANEL_LAUNCH_CONFLICT',
  }, 'a connected one-shot owner blocks rotation independently of the pre-admission TTL');
});

test('treats an exact removal committed before storage throws as a confirmed revocation', async () => {
  let contexts = [contextFor(TOKEN_A)];
  const sessionArea = createSessionArea();
  const originalRemove = sessionArea.remove.bind(sessionArea);
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts() { return structuredClone(contexts); },
    },
  };
  const { authority } = await initialize(fixture({ chromeApi, sessionArea }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  const owner = await authority.admitPort({ sender: senderFor(issued.token) });
  contexts = [];
  sessionArea.remove = async keys => {
    await originalRemove(keys);
    throw new Error('PRIVATE_COMMIT_THEN_THROW');
  };

  const retired = await authority.retirePort(owner);

  assert.deepEqual(retired, { version: 1, state: 'revoked' });
  assert.deepEqual(await sessionArea.get(null), {});
  assert.deepEqual(await authority.retirePort(owner), { version: 1, state: 'denied' });
});

test('rereads the exact pair after a storage throw-before and preserves the prior authority', async t => {
  await t.test('admission write', async () => {
    const sessionArea = createSessionArea();
    const originalGet = sessionArea.get.bind(sessionArea);
    const originalSet = sessionArea.set.bind(sessionArea);
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return [contextFor(TOKEN_A)]; },
      },
    };
    const { authority } = await initialize(fixture({ chromeApi, sessionArea }));
    const issued = authority.issue({ tabId: 41, windowId: 9 });
    assert.equal(await authority.whenReady(issued), true);
    const before = await sessionArea.get(null);
    let mutationAttempted = false;
    let readsAfterAttempt = 0;
    sessionArea.get = async keys => {
      if (mutationAttempted) readsAfterAttempt += 1;
      return originalGet(keys);
    };
    sessionArea.set = async entries => {
      if (Object.values(entries).some(value => value?.state === 'admitted')) {
        mutationAttempted = true;
        throw new Error('PRIVATE_THROW_BEFORE');
      }
      return originalSet(entries);
    };

    assert.deepEqual(await authority.admitPort({ sender: senderFor(issued.token) }), {
      ok: false, code: 'PANEL_LAUNCH_DENIED',
    });
    assert.equal(readsAfterAttempt > 0, true);
    assert.deepEqual(await sessionArea.get(null), before);
    sessionArea.set = originalSet;
    assert.equal((await authority.admitPort({ sender: senderFor(issued.token) })).ok, true);
  });

  await t.test('retirement removal', async () => {
    let contexts = [contextFor(TOKEN_A)];
    const sessionArea = createSessionArea();
    const originalGet = sessionArea.get.bind(sessionArea);
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return structuredClone(contexts); },
      },
    };
    const { authority } = await initialize(fixture({ chromeApi, sessionArea }));
    const issued = authority.issue({ tabId: 41, windowId: 9 });
    const owner = await authority.admitPort({ sender: senderFor(issued.token) });
    const before = await sessionArea.get(null);
    contexts = [];
    let mutationAttempted = false;
    let readsAfterAttempt = 0;
    sessionArea.get = async keys => {
      if (mutationAttempted) readsAfterAttempt += 1;
      return originalGet(keys);
    };
    sessionArea.remove = async () => {
      mutationAttempted = true;
      throw new Error('PRIVATE_THROW_BEFORE');
    };

    assert.deepEqual(await authority.retirePort(owner), { version: 1, state: 'denied' });
    assert.equal(readsAfterAttempt > 0, true);
    assert.deepEqual(await sessionArea.get(null), before);
    contexts = [contextFor(TOKEN_A)];
    assert.deepEqual(await authority.reprove(owner), owner);
  });
});

test('classifies partial or foreign pair mutations without touching another launch pair', async t => {
  await t.test('partial admission write', async () => {
    const bytes = [0xab, 0xbc];
    const sessionArea = createSessionArea();
    const originalGet = sessionArea.get.bind(sessionArea);
    const originalSet = sessionArea.set.bind(sessionArea);
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return [contextFor(TOKEN_A)]; },
      },
    };
    const { authority } = await initialize(fixture({
      chromeApi, sessionArea,
      randomBytes: length => new Uint8Array(length).fill(bytes.shift()),
    }));
    const target = authority.issue({ tabId: 41, windowId: 9 });
    const foreign = authority.issue({ tabId: 42, windowId: 9 });
    assert.equal(await authority.whenReady(target), true);
    assert.equal(await authority.whenReady(foreign), true);
    const foreignKeys = [
      `audita:panel-launch:record:v1:${foreign.token}`,
      'audita:panel-launch:index:v1:42',
    ];
    const foreignBefore = await sessionArea.get(foreignKeys);
    let faulted = false;
    let readsAfterFault = 0;
    sessionArea.get = async keys => {
      if (faulted) readsAfterFault += 1;
      return originalGet(keys);
    };
    sessionArea.set = async entries => {
      const admittedRecord = Object.entries(entries).find(([key, value]) =>
        key === `audita:panel-launch:record:v1:${target.token}` && value?.state === 'admitted');
      if (!admittedRecord) return originalSet(entries);
      await originalSet({ [admittedRecord[0]]: admittedRecord[1] });
      faulted = true;
      throw new Error('PRIVATE_PARTIAL_COMMIT');
    };

    assert.deepEqual(await authority.admitPort({ sender: senderFor(target.token) }), {
      ok: false, code: 'PANEL_LAUNCH_DENIED',
    });
    assert.equal(readsAfterFault > 0, true);
    assert.deepEqual(await sessionArea.get(foreignKeys), foreignBefore);
  });

  await t.test('foreign retirement replacement', async () => {
    const bytes = [0xab, 0xbc];
    let contexts = [contextFor(TOKEN_A)];
    const sessionArea = createSessionArea();
    const originalGet = sessionArea.get.bind(sessionArea);
    const originalRemove = sessionArea.remove.bind(sessionArea);
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return structuredClone(contexts); },
      },
    };
    const { authority } = await initialize(fixture({
      chromeApi, sessionArea,
      randomBytes: length => new Uint8Array(length).fill(bytes.shift()),
    }));
    const target = authority.issue({ tabId: 41, windowId: 9 });
    const foreign = authority.issue({ tabId: 42, windowId: 9 });
    const owner = await authority.admitPort({ sender: senderFor(target.token) });
    assert.equal(await authority.whenReady(foreign), true);
    const targetRecordKey = `audita:panel-launch:record:v1:${target.token}`;
    const foreignKeys = [
      `audita:panel-launch:record:v1:${foreign.token}`,
      'audita:panel-launch:index:v1:42',
    ];
    const foreignBefore = await sessionArea.get(foreignKeys);
    let faulted = false;
    let readsAfterFault = 0;
    sessionArea.get = async keys => {
      if (faulted) readsAfterFault += 1;
      return originalGet(keys);
    };
    sessionArea.remove = async keys => {
      const requested = Array.isArray(keys) ? keys : [keys];
      if (!requested.includes(targetRecordKey)) return originalRemove(keys);
      sessionArea.values[targetRecordKey] = structuredClone(foreignBefore[foreignKeys[0]]);
      faulted = true;
      throw new Error('PRIVATE_FOREIGN_COMMIT');
    };
    contexts = [];

    assert.deepEqual(await authority.retirePort(owner), { version: 1, state: 'denied' });
    assert.equal(readsAfterFault > 0, true);
    assert.deepEqual(await sessionArea.get(foreignKeys), foreignBefore);
  });
});

test('foreign and forged admissions cannot retire or revoke a current owner', async () => {
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts({ documentUrls }) {
        const token = new URL(documentUrls[0]).searchParams.get('launch');
        return [contextFor(token)];
      },
    },
  };
  const bytes = [0xab, 0xbc];
  const { authority, sessionArea } = await initialize(fixture({
    chromeApi,
    randomBytes: length => new Uint8Array(length).fill(bytes.shift()),
  }));
  const first = authority.issue({ tabId: 41, windowId: 9 });
  const owner1 = await authority.admitPort({ sender: senderFor(first.token) });
  assert.equal((await authority.retirePort(owner1)).state, 'released');
  const owner2 = await authority.admitPort({ sender: senderFor(first.token) });
  const foreign = authority.issue({ tabId: 42, windowId: 9 });
  await authority.whenReady(foreign);
  const before = await sessionArea.get(null);
  const forged = structuredClone(owner2);

  assert.deepEqual(await authority.retirePort(forged), { version: 1, state: 'denied' });
  assert.deepEqual(await authority.revoke(forged), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  assert.deepEqual(await authority.retirePort(owner1), { version: 1, state: 'denied' });
  assert.deepEqual(await authority.reprove(owner2), owner2);
  assert.deepEqual(await sessionArea.get(null), before);
});

test('fails closed when session writes or removals cannot be verified', async () => {
  for (const mode of ['throw', 'noop']) {
    const sessionArea = createSessionArea();
    sessionArea.set = mode === 'throw'
      ? async () => { throw new Error('PRIVATE_STORAGE_FAILURE'); }
      : async () => {};
    let contextCalls = 0;
    const chromeApi = {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { contextCalls += 1; return [contextFor(TOKEN_A)]; },
      },
    };
    const { authority } = await initialize(fixture({ chromeApi, sessionArea }));
    const issued = authority.issue({ tabId: 41, windowId: 9 });
    assert.deepEqual(await authority.admitPort({ sender: senderFor(issued.token) }), {
      ok: false, code: 'PANEL_LAUNCH_DENIED',
    }, mode);
    assert.equal(contextCalls, 0, mode);
  }

  const sessionArea = createSessionArea();
  const { authority } = await initialize(fixture({ sessionArea }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  sessionArea.remove = async () => {};
  assert.deepEqual(await authority.revoke(issued), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  assert.equal(Object.keys(await sessionArea.get(null)).length, 2);
});

test('rejects malformed persisted state, invalid clocks and non-256-bit entropy', async () => {
  const malformed = await initialize(fixture());
  const issued = malformed.authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  const recordKey = Object.keys(malformed.sessionArea.values).find(key => key.includes(':record:'));
  malformed.sessionArea.values[recordKey].unexpected = true;
  assert.deepEqual(await malformed.authority.admitPort({ sender: senderFor(issued.token) }), {
    ok: false, code: 'PANEL_LAUNCH_DENIED',
  });

  for (const clock of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const env = await initialize(fixture({ now: () => clock }));
    const candidate = env.authority.issue({ tabId: 41, windowId: 9 });
    assert.deepEqual(candidate, { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  }
  for (const bytes of [new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), []]) {
    const env = await initialize(fixture({ randomBytes: () => bytes }));
    const candidate = env.authority.issue({ tabId: 41, windowId: 9 });
    assert.deepEqual(candidate, { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  }
});

test('does not mistake hostile storage accessors for verified removal', async () => {
  const sessionArea = createSessionArea();
  const originalGet = sessionArea.get.bind(sessionArea);
  const { authority } = await initialize(fixture({ sessionArea }));
  const issued = authority.issue({ tabId: 41, windowId: 9 });
  await flushPersistence();
  let getterReads = 0;
  let afterRemove = false;
  sessionArea.remove = async () => { afterRemove = true; };
  sessionArea.get = async keys => {
    const envelope = await originalGet(keys);
    if (!afterRemove) return envelope;
    for (const key of Object.keys(envelope)) {
      delete envelope[key];
      Object.defineProperty(envelope, key, {
        enumerable: true,
        get() { getterReads += 1; return 'forged-absence'; },
      });
    }
    return envelope;
  };

  assert.deepEqual(await authority.revoke(issued), { ok: false, code: 'PANEL_LAUNCH_DENIED' });
  assert.equal(getterReads, 0);
});
