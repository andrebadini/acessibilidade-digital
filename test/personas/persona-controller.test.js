import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createInitialPersonaState, expectPersonaHello, reducePersonaState,
} from '../../src/panel/panel-state.js';

let controllerModule = {};
try { controllerModule = await import('../../src/background/persona-controller.js'); } catch { /* RED */ }
const PERSONA_CLASSIC_FILES = controllerModule.PERSONA_CLASSIC_FILES ?? [
  'src/core/accessibility/accessible-preview-runtime.classic.js',
  'src/personas/screen-reader-module.js',
  'src/personas/content.js',
];
const PERSONA_LOCAL_KEYS = controllerModule.PERSONA_LOCAL_KEYS ?? {
  voiceId: 'audita:persona:voiceId', rate: 'audita:persona:rate',
};
const PERSONA_SESSION_KEY = controllerModule.PERSONA_SESSION_KEY ?? 'audita:persona:bindings:v1';
function createPersonaController(...args) {
  assert.equal(typeof controllerModule.createPersonaController, 'function', 'o controlador de personas precisa existir');
  return controllerModule.createPersonaController(...args);
}

function eventHook() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    fire(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function createChrome(options = {}) {
  const tabsById = new Map([
    [7, { id: 7, url: 'https://alvo.test/pagina', status: 'complete' }],
    [99, { id: 99, url: 'https://decoy.test/', status: 'complete' }],
  ]);
  const sessionData = { ...(options.sessionData || {}) };
  const bindingProofs = new Map();
  const proofDocuments = new Map();
  const proofUrls = new Map();
  const documentIdsByTab = new Map([
    [7, 'document-target-7'],
    [99, 'document-target-99'],
  ]);
  for (const entry of sessionData[PERSONA_SESSION_KEY] || []) {
    if (!Number.isSafeInteger(entry?.panelTabId) || !Number.isSafeInteger(entry?.targetTabId)) continue;
    tabsById.set(entry.panelTabId, {
      id: entry.panelTabId,
      url: 'chrome-extension://test-extension/src/panel/index.html',
      status: 'complete',
    });
    if (options.seedBindingProofs !== false) {
      bindingProofs.set(entry.targetTabId, {
        version: 1, panelTabId: entry.panelTabId, targetTabId: entry.targetTabId,
      });
      proofDocuments.set(entry.targetTabId, documentIdsByTab.get(entry.targetTabId));
      proofUrls.set(entry.targetTabId, tabsById.get(entry.targetTabId)?.url);
    }
  }
  const localData = {
    [PERSONA_LOCAL_KEYS.voiceId]: 'voice-initial',
    [PERSONA_LOCAL_KEYS.rate]: 1.25,
  };
  const calls = { create: [], update: [], remove: [], execute: [], insertCss: [], removeCss: [], send: [], connect: [], sessionWrites: [], localWrites: [] };
  const onUpdated = eventHook();
  const onRemoved = eventHook();
  const runtimeOnMessage = eventHook();
  const lostAckCommands = new Set();
  const sessionSetStarted = [];
  const panelGetCounts = new Map();
  let nextPanelId = 50;
  const chromeApi = {
    runtime: {
      id: 'test-extension',
      getURL(path) { return `chrome-extension://test-extension/${String(path).replace(/^\//u, '')}`; },
      onMessage: runtimeOnMessage,
    },
    tabs: {
      onUpdated,
      onRemoved,
      async create(init) {
        calls.create.push(init);
        if (options.createGate) await options.createGate.promise;
        const panelId = nextPanelId++;
        const tab = options.panelPending
          ? {
              id: panelId,
              url: options.panelInitialUrl ?? '',
              pendingUrl: options.panelPendingUrl ?? init.url,
              status: 'loading',
            }
          : { id: panelId, url: init.url, status: 'complete' };
        tabsById.set(tab.id, tab);
        return tab;
      },
      async get(id) {
        if (!tabsById.has(id)) throw new Error('No tab with id');
        const current = tabsById.get(id);
        if (options.panelPending && id >= 50 && current.status === 'loading') {
          const count = (panelGetCounts.get(id) || 0) + 1;
          panelGetCounts.set(id, count);
          if (Number.isSafeInteger(options.panelCommitAfterGets) && count >= options.panelCommitAfterGets) {
            const committed = { id, url: current.pendingUrl, status: 'complete' };
            tabsById.set(id, committed);
            return committed;
          }
        }
        return tabsById.get(id);
      },
      async update(id, init) { calls.update.push([id, init]); return tabsById.get(id); },
      async remove(id) { calls.remove.push(id); tabsById.delete(id); },
      async sendMessage(tabId, message, target) {
        calls.send.push({ tabId, message, target });
        if (options.ackGate) await options.ackGate.promise;
        if (message.command === 'activate' && options.activateGate) await options.activateGate.promise;
        if (message.command === 'stop' && options.stopGate) await options.stopGate.promise;
        if (message.command === options.gatedCommand && options.commandGate) await options.commandGate.promise;
        if (options.sendFailure) throw new Error('send failed');
        const ack = contentAck(message, options.contentState);
        if (message.command === options.loseAckFor && !lostAckCommands.has(message.command)) {
          lostAckCommands.add(message.command);
          throw new Error('ACK lost after content execution');
        }
        return options.ackTransform ? options.ackTransform(ack, message) : ack;
      },
      connect(tabId, init) {
        calls.connect.push({ tabId, init });
        return options.contentPortFactory?.() || options.contentPort || createContentPort();
      },
    },
    scripting: {
      async executeScript(init) {
        calls.execute.push(init);
        if (Array.isArray(init.files) && options.executeGate) await options.executeGate.promise;
        if (Array.isArray(init.files) && options.executeFailure) throw new Error('execute failed');
        const tabId = init?.target?.tabId;
        if (!tabsById.has(tabId)) throw new Error('No tab with id');
        const currentDocumentId = documentIdsByTab.get(tabId) ?? `document-target-${tabId}`;
        documentIdsByTab.set(tabId, currentDocumentId);
        if (Object.hasOwn(init.target, 'documentIds')) {
          if (!Array.isArray(init.target.documentIds) || init.target.documentIds.length !== 1 ||
            init.target.documentIds[0] !== currentDocumentId) throw new Error('No document with id');
          assert.equal(Object.hasOwn(init.target, 'frameIds'), false, 'documentId não pode ser combinado com frameId');
        }
        if (typeof init.func === 'function') {
          const [panelTabId, targetTabId] = init.args || [];
          let result = false;
          if (init.func.name === 'installPersonaBindingProof') {
            if (options.proofInstallFailure) throw new Error('proof install failed');
            bindingProofs.set(tabId, { version: 1, panelTabId, targetTabId });
            proofDocuments.set(tabId, currentDocumentId);
            proofUrls.set(tabId, tabsById.get(tabId)?.url);
            result = true;
          } else if (init.func.name === 'checkPersonaBindingProof') {
            if (options.proofCheckFailure) throw new Error('proof check failed');
            const proof = bindingProofs.get(tabId);
            result = proof?.version === 1 && proof.panelTabId === panelTabId && proof.targetTabId === targetTabId &&
              proofDocuments.get(tabId) === currentDocumentId && proofUrls.get(tabId) === tabsById.get(tabId)?.url;
            options.afterProofCheck?.({
              tabId, currentDocumentId, result, bindingProofs, proofDocuments, proofUrls,
              documentIdsByTab, tabsById,
            });
          } else if (init.func.name === 'clearPersonaBindingProof') {
            if (options.proofClearGate) await options.proofClearGate.promise;
            if (options.proofClearFailure) throw new Error('proof clear failed');
            const proof = bindingProofs.get(tabId);
            if (proof?.version === 1 && proof.panelTabId === panelTabId && proof.targetTabId === targetTabId) {
              bindingProofs.delete(tabId);
              proofDocuments.delete(tabId);
              proofUrls.delete(tabId);
              result = true;
            }
          }
          return [{ frameId: 0, documentId: currentDocumentId, result }];
        }
        return [{ frameId: 0, documentId: currentDocumentId, result: true }];
      },
      async insertCSS(init) {
        calls.insertCss.push(init);
        if (options.cssGate) await options.cssGate.promise;
        if (options.cssFailure) throw new Error('css failed');
      },
      async removeCSS(init) { calls.removeCss.push(init); },
    },
    storage: {
      session: {
        async get(key) {
          if (options.sessionGetGate) await options.sessionGetGate.promise;
          return { [key]: sessionData[key] };
        },
        async set(value) {
          const index = sessionSetStarted.length;
          sessionSetStarted.push({ index, value });
          if (options.sessionSetGates?.[index]) await options.sessionSetGates[index].promise;
          if (options.sessionSetFailures?.includes(index)) throw new Error('session set failed');
          Object.assign(sessionData, value);
          calls.sessionWrites.push(value);
        },
      },
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter(key => Object.hasOwn(localData, key)).map(key => [key, localData[key]]));
        },
        async set(value) { Object.assign(localData, value); calls.localWrites.push(value); },
      },
    },
  };
  return {
    chromeApi, calls, tabsById, bindingProofs, proofDocuments, proofUrls, documentIdsByTab, sessionData, localData,
    onUpdated, onRemoved, runtimeOnMessage, sessionSetStarted,
  };
}

function contentAck(message, state = {}) {
  return {
    protocol: 'audita-persona-content', version: 1, type: 'ack',
    requestId: message.requestId, token: message.token, generation: message.generation,
    documentId: message.documentId, ok: true,
    state: {
      activeMode: message.command === 'stop' ? null : (message.args?.mode ?? state.activeMode ?? null),
      reader: {
        playback: message.args?.mode === 'reader' ? 'playing' : 'idle', index: message.args?.mode === 'reader' ? 0 : -1,
        total: message.args?.mode === 'reader' ? 2 : 0, caption: message.args?.mode === 'reader' ? 'Enviar, botão' : '',
        canPrevious: false, canNext: message.args?.mode === 'reader', speechAvailability: 'available',
        voiceId: '', rate: 1,
      },
      limitations: [{ code: 'frame-unavailable', count: 1 }],
      coverage: 'dom-fallback-top-document-open-shadow',
      ...state,
    },
  };
}

function createPort(panelTabId = 50, documentId = 'panel-document-1') {
  const onMessage = eventHook();
  const onDisconnect = eventHook();
  const posted = [];
  const port = {
    name: 'audita-persona-v1',
    sender: {
      id: 'test-extension', frameId: 0, documentId,
      url: 'chrome-extension://test-extension/src/panel/index.html',
      tab: { id: panelTabId },
    },
    onMessage,
    onDisconnect,
    postMessage(message) { posted.push(message); },
    disconnectCalls: 0,
    disconnect() { port.disconnectCalls += 1; onDisconnect.fire(); },
    posted,
  };
  return port;
}

function createContentPort(options = {}) {
  const onMessage = eventHook();
  const onDisconnect = eventHook();
  const posted = [];
  const port = {
    name: 'audita-persona-content-v1', onMessage, onDisconnect,
    postMessage(message) {
      posted.push(message);
      if (message?.type === 'bind-events' && options.autoBindAck !== false) {
        queueMicrotask(() => onMessage.fire({
          protocol: 'audita-persona-content', version: 1, type: 'events-bound',
          token: message.token, generation: message.generation, documentId: message.documentId,
        }));
      }
    },
    disconnectCalls: 0,
    disconnect() { port.disconnectCalls += 1; onDisconnect.fire(); },
    posted,
  };
  return port;
}

async function flush() { await new Promise(resolve => setImmediate(resolve)); }

async function waitUntil(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('Condição focada não foi atendida.');
}

function hello(requestId = 'hello-1') {
  return { protocol: 'audita-persona-panel', version: 1, type: 'hello', requestId };
}

function command(state, requestId, name, args = {}) {
  return {
    protocol: 'audita-persona-panel', version: 1, type: 'command', requestId,
    token: state.token, generation: state.generation, command: name, args,
  };
}

test('openPanel binds one explicit HTTP tab with forward/reverse ownership despite concurrent creation', async () => {
  const createGate = deferred();
  const { chromeApi, calls, sessionData } = createChrome({ createGate });
  const controller = createPersonaController(chromeApi, { randomToken: () => 'token-1' });
  const source = { id: 7, url: 'https://alvo.test/pagina' };
  const first = controller.openPanel({ sourceTab: source });
  const second = controller.openPanel({ sourceTab: source });
  await flush();
  assert.equal(calls.create.length, 1);
  createGate.resolve();
  const [firstPanel, secondPanel] = await Promise.all([first, second]);
  assert.equal(firstPanel.id, 50);
  assert.equal(secondPanel.id, 50);
  assert.deepEqual(controller.getBinding(50), { panelTabId: 50, targetTabId: 7 });
  assert.equal(controller.getOwnerPanel(7), 50);
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [{ panelTabId: 50, targetTabId: 7 }]);
  assert.doesNotMatch(JSON.stringify(sessionData), /alvo|decoy|token|https?:/iu);
  assert.equal(calls.update.some(([id]) => id === 99), false);

  const reused = await controller.openPanel({ sourceTab: source });
  assert.equal(reused.id, 50);
  assert.deepEqual(calls.update.at(-1), [50, { active: true }]);
  const unbound = await controller.openPanel({ sourceTab: { id: 99, url: 'chrome://settings/' } });
  assert.equal(unbound.id, 51);
  assert.equal(controller.getBinding(51), null);
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [{ panelTabId: 50, targetTabId: 7 }]);
});

test('a source closed while panel creation is pending can never be persisted as a dead binding', async () => {
  const createGate = deferred();
  const { chromeApi, calls, tabsById, sessionData } = createChrome({ createGate });
  const controller = createPersonaController(chromeApi);
  const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await waitUntil(() => calls.create.length === 1);
  tabsById.delete(7);
  controller.handleTabRemoved(7);
  createGate.resolve();
  await assert.rejects(opening);
  assert.equal(controller.getOwnerPanel(7), null);
  assert.equal(controller.getBinding(50), null);
  assert.deepEqual(calls.remove, [50]);
  assert.equal(Object.hasOwn(sessionData, PERSONA_SESSION_KEY), false);
});

test('openPanel waits for an exact local panel URL commit and never persists a pending or divergent endpoint', async () => {
  {
    const { chromeApi, calls, sessionData } = createChrome({
      panelPending: true,
      panelCommitAfterGets: 2,
    });
    const controller = createPersonaController(chromeApi, { panelCommitDelay: async () => {} });
    const panel = await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    assert.equal(panel.url, 'chrome-extension://test-extension/src/panel/index.html');
    assert.deepEqual(calls.remove, []);
    assert.deepEqual(controller.getBinding(panel.id), { panelTabId: panel.id, targetTabId: 7 });
    assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [{ panelTabId: panel.id, targetTabId: 7 }]);
  }

  for (const scenario of [
    { name: 'pending divergente', panelPendingUrl: 'chrome-extension://test-extension/src/panel/index.html#hostil' },
    { name: 'URL ativa divergente', panelInitialUrl: 'https://hostil.test/', panelPendingUrl: 'chrome-extension://test-extension/src/panel/index.html' },
    { name: 'timeout sem commit', panelPendingUrl: 'chrome-extension://test-extension/src/panel/index.html' },
  ]) {
    const { chromeApi, calls, sessionData } = createChrome({ panelPending: true, ...scenario });
    const controller = createPersonaController(chromeApi, { panelCommitDelay: async () => {} });
    await assert.rejects(
      controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } }),
      error => error?.code === 'PERSONA_TARGET_CHANGED',
      scenario.name,
    );
    assert.deepEqual(calls.remove, [50], scenario.name);
    assert.equal(controller.getBinding(50), null, scenario.name);
    assert.equal(Object.hasOwn(sessionData, PERSONA_SESSION_KEY), false, scenario.name);
  }

  {
    const { chromeApi, calls, tabsById, sessionData } = createChrome({
      panelPending: true,
      panelCommitAfterGets: 3,
    });
    const controller = createPersonaController(chromeApi, {
      panelCommitDelay: async () => {
        tabsById.set(7, { id: 7, url: 'https://alvo.test/outra-pagina', status: 'complete' });
      },
    });
    await assert.rejects(
      controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } }),
      error => error?.code === 'PERSONA_TARGET_CHANGED',
    );
    assert.deepEqual(calls.remove, [50]);
    assert.equal(controller.getBinding(50), null);
    assert.equal(Object.hasOwn(sessionData, PERSONA_SESSION_KEY), false);
  }
});

test('a panel port connected during URL commit is promoted only after exact ownership persists', async () => {
  const commitGate = deferred();
  let commitWaits = 0;
  const { chromeApi, sessionData } = createChrome({
    panelPending: true,
    panelCommitAfterGets: 2,
  });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-panel-during-commit',
    panelCommitDelay: async () => {
      commitWaits += 1;
      await commitGate.promise;
    },
  });
  const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await waitUntil(() => commitWaits === 1);

  const port = createPort(50, 'panel-document-during-commit');
  assert.equal(controller.attachPanelPort(port), true);
  port.onMessage.fire(hello('hello-during-panel-commit'));
  await flush();
  assert.deepEqual(port.posted, [], 'pendingUrl não pode expor vínculo nem estado unbound prematuro');

  commitGate.resolve();
  const panel = await opening;
  await waitUntil(() => port.posted.length === 1);
  assert.equal(panel.url, 'chrome-extension://test-extension/src/panel/index.html');
  assert.equal(port.posted[0].requestId, 'hello-during-panel-commit');
  assert.equal(port.posted[0].bound, true);
  assert.equal(port.posted[0].targetTabId, 7);
  assert.deepEqual(controller.getBinding(50), { panelTabId: 50, targetTabId: 7 });
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [{ panelTabId: 50, targetTabId: 7 }]);
});

test('a provisional panel port is disconnected when exact URL commit diverges or times out', async () => {
  for (const scenario of [
    { id: 'divergence', name: 'divergência', diverge: true },
    { id: 'timeout', name: 'timeout', diverge: false },
  ]) {
    const commitGate = deferred();
    let commitWaits = 0;
    const { chromeApi, calls, tabsById, sessionData } = createChrome({ panelPending: true });
    const controller = createPersonaController(chromeApi, {
      panelCommitDelay: async () => {
        commitWaits += 1;
        if (commitWaits === 1) await commitGate.promise;
      },
    });
    const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    await waitUntil(() => commitWaits === 1);

    const port = createPort(50, `panel-document-${scenario.id}-commit`);
    assert.equal(controller.attachPanelPort(port), true);
    port.onMessage.fire(hello(`hello-${scenario.id}-panel-commit`));
    await flush();
    assert.deepEqual(port.posted, [], `${scenario.name}: painel provisório não recebe estado antes do commit exato`);

    if (scenario.diverge) tabsById.set(50, { id: 50, url: 'https://hostil.test/', status: 'complete' });
    commitGate.resolve();
    await assert.rejects(opening, error => error?.code === 'PERSONA_TARGET_CHANGED', scenario.name);
    await waitUntil(() => port.disconnectCalls === 1);
    assert.equal(port.posted.some(message => message?.bound === true), false, scenario.name);
    assert.deepEqual(calls.remove, [50], scenario.name);
    assert.equal(controller.getBinding(50), null, scenario.name);
    assert.equal(controller.getOwnerPanel(7), null, scenario.name);
    assert.equal(Object.hasOwn(sessionData, PERSONA_SESSION_KEY), false, scenario.name);
  }
});

test('panel or source lifecycle during binding persistence cancels provisional ownership', async () => {
  for (const scenario of [
    { id: 'panel-removed', mutate(controller, tabs) { tabs.delete(50); controller.handleTabRemoved(50); } },
    { id: 'source-removed', mutate(controller, tabs) { tabs.delete(7); controller.handleTabRemoved(7); } },
    {
      id: 'source-navigated',
      mutate(controller, tabs) {
        const next = { id: 7, url: 'https://alvo.test/outra', status: 'loading' };
        tabs.set(7, next);
        controller.handleTabUpdated(7, { status: 'loading', url: next.url }, next);
      },
    },
  ]) {
    const persistenceGate = deferred();
    const { chromeApi, calls, tabsById, sessionData, sessionSetStarted } = createChrome({
      sessionSetGates: [persistenceGate],
    });
    const controller = createPersonaController(chromeApi);
    const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    await waitUntil(() => sessionSetStarted.length === 1);

    const port = createPort(50, `panel-document-${scenario.id}-during-persist`);
    assert.equal(controller.attachPanelPort(port), true);
    port.onMessage.fire(hello(`hello-${scenario.id}-during-persist`));
    await flush();
    assert.deepEqual(port.posted, [], `${scenario.id}: binding não persistido não publica estado`);

    scenario.mutate(controller, tabsById);
    persistenceGate.resolve();
    await assert.rejects(opening, error => error?.code === 'PERSONA_TARGET_CHANGED', scenario.id);
    await waitUntil(() => port.disconnectCalls === 1);
    assert.equal(controller.getBinding(50), null, scenario.id);
    assert.equal(controller.getOwnerPanel(7), null, scenario.id);
    assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [], scenario.id);
    assert.deepEqual(calls.remove, [50], scenario.id);
  }
});

test('restart before rollback rejects an orphan snapshot after HTTP source navigation', async () => {
  const gates = [deferred(), deferred()];
  const { chromeApi, tabsById, bindingProofs, sessionData, sessionSetStarted } = createChrome({
    sessionSetGates: gates,
  });
  const controller = createPersonaController(chromeApi);
  const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await waitUntil(() => sessionSetStarted.length === 1);
  assert.deepEqual(bindingProofs.get(7), { version: 1, panelTabId: 50, targetTabId: 7 });

  const navigated = { id: 7, url: 'https://alvo.test/outra', status: 'loading' };
  tabsById.set(7, navigated);
  bindingProofs.delete(7);
  controller.handleTabUpdated(7, { status: 'loading', url: navigated.url }, navigated);
  gates[0].resolve();
  await waitUntil(() => sessionSetStarted.length === 2);
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [{ panelTabId: 50, targetTabId: 7 }]);

  const restarted = createPersonaController(chromeApi);
  await waitUntil(() => Array.isArray(sessionData[PERSONA_SESSION_KEY]) && sessionData[PERSONA_SESSION_KEY].length === 0);
  assert.equal(restarted.getOwnerPanel(7), null);
  gates[1].resolve();
  await assert.rejects(opening, error => error?.code === 'PERSONA_TARGET_CHANGED');
  assert.doesNotMatch(JSON.stringify(sessionData), /https?:|alvo|token|caption/iu);
});

test('a rejected rollback cannot restore an orphan snapshot after the panel was removed', async () => {
  const persistenceGate = deferred();
  const { chromeApi, tabsById, bindingProofs, sessionData, sessionSetStarted } = createChrome({
    sessionSetGates: [persistenceGate],
    sessionSetFailures: [1],
  });
  const controller = createPersonaController(chromeApi, { logger: { error() {} } });
  const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await waitUntil(() => sessionSetStarted.length === 1);
  assert.equal(bindingProofs.has(7), true);

  tabsById.delete(50);
  controller.handleTabRemoved(50);
  persistenceGate.resolve();
  await assert.rejects(opening, error => error?.code === 'PERSONA_TARGET_CHANGED');
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [{ panelTabId: 50, targetTabId: 7 }]);
  assert.equal(bindingProofs.has(7), false, 'rollback limpa sua prova mesmo quando storage.session rejeita');

  const restarted = createPersonaController(chromeApi, { logger: { error() {} } });
  await waitUntil(() => Array.isArray(sessionData[PERSONA_SESSION_KEY]) && sessionData[PERSONA_SESSION_KEY].length === 0);
  assert.equal(restarted.getOwnerPanel(7), null);
  assert.doesNotMatch(JSON.stringify(sessionData), /https?:|alvo|token|caption/iu);
});

test('post-persist proof rejects a same-document URL mutation even when the tab event is delayed', async () => {
  const persistenceGate = deferred();
  const { chromeApi, tabsById, sessionData, sessionSetStarted } = createChrome({
    sessionSetGates: [persistenceGate],
  });
  const controller = createPersonaController(chromeApi);
  const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await waitUntil(() => sessionSetStarted.length === 1);

  tabsById.set(7, { id: 7, url: 'https://alvo.test/rota-spa', status: 'complete' });
  persistenceGate.resolve();
  await assert.rejects(opening, error => error?.code === 'PERSONA_TARGET_CHANGED');
  assert.equal(controller.getOwnerPanel(7), null);
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], []);
});

test('restore treats storage as a hint and rejects a same-document URL change whose event was lost', async () => {
  const { chromeApi, tabsById, sessionData } = createChrome({
    sessionData: { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] },
  });
  tabsById.set(7, { id: 7, url: 'https://alvo.test/rota-perdida', status: 'complete' });
  const controller = createPersonaController(chromeApi);
  await waitUntil(() => Array.isArray(sessionData[PERSONA_SESSION_KEY]) && sessionData[PERSONA_SESSION_KEY].length === 0);
  assert.equal(controller.getOwnerPanel(7), null);
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], []);
});

test('restore clears a revoked proof only in the document observed by its false check', async () => {
  const {
    chromeApi, bindingProofs, proofDocuments, proofUrls, documentIdsByTab, sessionData, calls,
  } = createChrome({
    sessionData: { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] },
  });
  documentIdsByTab.set(7, 'doc-revoked');
  proofDocuments.set(7, 'doc-revoked');
  proofUrls.set(7, 'https://alvo.test/rota-anterior');

  const controller = createPersonaController(chromeApi);
  await waitUntil(() => Array.isArray(sessionData[PERSONA_SESSION_KEY]) && sessionData[PERSONA_SESSION_KEY].length === 0);

  assert.equal(controller.getOwnerPanel(7), null);
  assert.equal(bindingProofs.has(7), false, 'a prova revogada observada ainda deve ser removida best-effort');
  const proofCalls = calls.execute.filter(call =>
    call.func?.name === 'checkPersonaBindingProof' || call.func?.name === 'clearPersonaBindingProof');
  assert.deepEqual(proofCalls.map(call => ({ name: call.func.name, target: call.target })), [
    { name: 'checkPersonaBindingProof', target: { tabId: 7, frameIds: [0] } },
    { name: 'clearPersonaBindingProof', target: { tabId: 7, documentIds: ['doc-revoked'] } },
  ]);
});

test('restore observes and clears a valid target proof when its stored panel is missing', async () => {
  const {
    chromeApi, tabsById, bindingProofs, proofDocuments, documentIdsByTab, sessionData, calls,
  } = createChrome({
    sessionData: { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] },
  });
  documentIdsByTab.set(7, 'doc-panel-missing');
  proofDocuments.set(7, 'doc-panel-missing');
  tabsById.delete(50);

  const controller = createPersonaController(chromeApi);
  await waitUntil(() => Array.isArray(sessionData[PERSONA_SESSION_KEY]) && sessionData[PERSONA_SESSION_KEY].length === 0);

  assert.equal(controller.getOwnerPanel(7), null);
  assert.equal(bindingProofs.has(7), false, 'painel ausente não deve deixar sua prova órfã no alvo ainda válido');
  const proofCalls = calls.execute.filter(call =>
    call.func?.name === 'checkPersonaBindingProof' || call.func?.name === 'clearPersonaBindingProof');
  assert.deepEqual(proofCalls.map(call => ({ name: call.func.name, target: call.target })), [
    { name: 'checkPersonaBindingProof', target: { tabId: 7, frameIds: [0] } },
    { name: 'clearPersonaBindingProof', target: { tabId: 7, documentIds: ['doc-panel-missing'] } },
  ]);
});

test('revoked-proof cleanup never retries by frame or touches a replacement document after churn', async () => {
  let replaced = false;
  const environment = createChrome({
    sessionData: { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] },
    afterProofCheck(state) {
      if (state.tabId !== 7 || state.result !== false || replaced) return;
      replaced = true;
      state.documentIdsByTab.set(7, 'doc-replacement');
      state.bindingProofs.set(7, { version: 1, panelTabId: 50, targetTabId: 7 });
      state.proofDocuments.set(7, 'doc-replacement');
      state.proofUrls.set(7, state.tabsById.get(7)?.url);
    },
  });
  const {
    chromeApi, bindingProofs, proofDocuments, proofUrls, documentIdsByTab, sessionData, calls,
  } = environment;
  documentIdsByTab.set(7, 'doc-revoked');
  proofDocuments.set(7, 'doc-revoked');
  proofUrls.set(7, 'https://alvo.test/rota-anterior');

  const controller = createPersonaController(chromeApi);
  await waitUntil(() => Array.isArray(sessionData[PERSONA_SESSION_KEY]) && sessionData[PERSONA_SESSION_KEY].length === 0);

  assert.equal(controller.getOwnerPanel(7), null);
  assert.deepEqual(bindingProofs.get(7), { version: 1, panelTabId: 50, targetTabId: 7 });
  assert.equal(proofDocuments.get(7), 'doc-replacement');
  assert.equal(proofUrls.get(7), 'https://alvo.test/pagina');
  const proofCalls = calls.execute.filter(call =>
    call.func?.name === 'checkPersonaBindingProof' || call.func?.name === 'clearPersonaBindingProof');
  assert.deepEqual(proofCalls.map(call => ({ name: call.func.name, target: call.target })), [
    { name: 'checkPersonaBindingProof', target: { tabId: 7, frameIds: [0] } },
    { name: 'clearPersonaBindingProof', target: { tabId: 7, documentIds: ['doc-revoked'] } },
  ], 'o documento substituto nunca pode ser redescoberto por frame nem limpo por retry');
});

test('proof cleanup is pinned to the captured document and cannot erase a replacement document', async () => {
  const {
    chromeApi, bindingProofs, proofDocuments, proofUrls, documentIdsByTab, tabsById, calls,
  } = createChrome();
  const controller = createPersonaController(chromeApi);
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });

  documentIdsByTab.set(7, 'document-target-7-replacement');
  tabsById.set(7, { id: 7, url: 'https://alvo.test/substituta', status: 'loading' });
  bindingProofs.set(7, { version: 1, panelTabId: 50, targetTabId: 7 });
  proofDocuments.set(7, 'document-target-7-replacement');
  proofUrls.set(7, 'https://alvo.test/substituta');
  controller.handleTabUpdated(7, {
    status: 'loading', url: 'https://alvo.test/substituta',
  }, tabsById.get(7));
  await flush();
  await flush();

  assert.deepEqual(bindingProofs.get(7), { version: 1, panelTabId: 50, targetTabId: 7 });
  assert.equal(proofDocuments.get(7), 'document-target-7-replacement');
  const lateClear = calls.execute.find(call => call.func?.name === 'clearPersonaBindingProof');
  assert.deepEqual(lateClear?.target, { tabId: 7, documentIds: ['document-target-7'] });
});

test('an observed HTTP navigation requires a correlated hello before installing a new document proof', async () => {
  const {
    chromeApi, tabsById, bindingProofs, proofDocuments, proofUrls, documentIdsByTab, calls,
  } = createChrome();
  const controller = createPersonaController(chromeApi, { randomToken: () => 'token-proof-reconnect' });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello('hello-before-proof-navigation'));
  await flush();
  assert.equal(port.posted.at(-1).bound, true);

  documentIdsByTab.set(7, 'document-target-7-after-navigation');
  tabsById.set(7, { id: 7, url: 'https://alvo.test/depois', status: 'loading' });
  bindingProofs.delete(7);
  proofDocuments.delete(7);
  proofUrls.delete(7);
  controller.handleTabUpdated(7, {
    status: 'loading', url: 'https://alvo.test/depois',
  }, tabsById.get(7));
  await flush();
  assert.equal(bindingProofs.has(7), false, 'evento de navegação não promove silenciosamente o novo documento');

  tabsById.set(7, { id: 7, url: 'https://alvo.test/depois', status: 'complete' });
  port.onMessage.fire(hello('hello-after-proof-navigation'));
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).bound, true);
  assert.equal(proofDocuments.get(7), 'document-target-7-after-navigation');
  assert.equal(proofUrls.get(7), 'https://alvo.test/depois');
  assert.equal(calls.execute.filter(call => call.func?.name === 'installPersonaBindingProof').length, 2);
});

test('rollback invalidates the panel endpoint before waiting for proof or storage cleanup', async () => {
  const persistenceGate = deferred();
  const proofClearGate = deferred();
  const { chromeApi, tabsById, calls, sessionSetStarted } = createChrome({
    sessionSetGates: [persistenceGate], proofClearGate,
  });
  const controller = createPersonaController(chromeApi);
  const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await waitUntil(() => sessionSetStarted.length === 1);
  tabsById.set(7, { id: 7, url: 'https://alvo.test/mudou', status: 'complete' });
  persistenceGate.resolve();
  await waitUntil(() => calls.execute.some(call => call.func?.name === 'clearPersonaBindingProof'));
  assert.deepEqual(calls.remove, [50], 'endpoint do painel é invalidado antes do cleanup potencialmente lento');
  proofClearGate.resolve();
  await assert.rejects(opening, error => error?.code === 'PERSONA_TARGET_CHANGED');
});

test('isolated binding proof has a private frozen descriptor and expires on URL change or pagehide', async () => {
  const { chromeApi, calls } = createChrome();
  const controller = createPersonaController(chromeApi);
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const install = calls.execute.find(call => call.func?.name === 'installPersonaBindingProof');
  const check = calls.execute.find(call => call.func?.name === 'checkPersonaBindingProof');
  assert.ok(install && check);

  const listeners = new Map();
  const navigationListeners = new Map();
  const context = vm.createContext({
    location: { href: 'https://alvo.test/pagina' },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    navigation: {
      addEventListener(type, listener) { navigationListeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (navigationListeners.get(type) === listener) navigationListeners.delete(type);
      },
    },
  });
  const invoke = (func, args) => vm.runInContext(`(${func.toString()}).apply(null, ${JSON.stringify(args)})`, context);
  assert.equal(invoke(install.func, install.args), true);
  const descriptor = vm.runInContext(
    "Object.getOwnPropertyDescriptor(globalThis, Symbol.for('audita.persona.binding-proof.v1'))", context,
  );
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.configurable, true);
  assert.equal(descriptor.writable, false);
  assert.equal(Object.isFrozen(descriptor.value), true);
  assert.equal(Object.getPrototypeOf(descriptor.value), null);
  assert.deepEqual(Object.keys(descriptor.value), ['version', 'panelTabId', 'targetTabId']);
  assert.doesNotMatch(JSON.stringify(descriptor.value), /https?:|alvo/iu);
  assert.equal(invoke(check.func, check.args), true);
  context.location.href = 'https://alvo.test/outra#spa';
  assert.equal(invoke(check.func, check.args), false);
  assert.equal(typeof listeners.get('hashchange'), 'function', 'fallback de navegação precisa revogar monotonicamente');
  listeners.get('hashchange')();
  context.location.href = 'https://alvo.test/pagina';
  assert.equal(invoke(check.func, check.args), false, 'A→B→A não revive uma prova monotonicamente revogada');
  assert.deepEqual([...navigationListeners.keys()].sort(), ['currententrychange', 'navigate']);
  assert.equal(invoke(install.func, install.args), true, 'reprova explícita substitui apenas o namespace válido anterior');
  context.location.href = 'https://alvo.test/rota-navigation-api';
  navigationListeners.get('currententrychange')();
  context.location.href = 'https://alvo.test/pagina';
  assert.equal(invoke(check.func, check.args), false, 'Navigation API também revoga A→B→A monotonicamente');
  listeners.get('pagehide')();
  assert.equal(invoke(check.func, check.args), false);
  assert.deepEqual([...listeners.keys()], []);
  assert.deepEqual([...navigationListeners.keys()], []);
  context.hostileCalls = 0;
  vm.runInContext(`
    const hostile = Object.freeze(function () { globalThis.hostileCalls += 1; return true; });
    Object.defineProperty(globalThis, Symbol.for('audita.persona.binding-proof-cleanup.v1'), {
      value: hostile, enumerable: false, configurable: true, writable: false,
    });
  `, context);
  assert.equal(invoke(install.func, install.args), false);
  assert.equal(context.hostileCalls, 0, 'namespace conflitante nunca executa callback não autenticado');
});

test('ownership transitions serialize persistence so reverse storage completion cannot lose a binding', async () => {
  const gates = [deferred(), deferred()];
  const { chromeApi, sessionData, sessionSetStarted } = createChrome({ sessionSetGates: gates });
  const controller = createPersonaController(chromeApi);
  const first = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const second = controller.openPanel({ sourceTab: { id: 99, url: 'https://decoy.test/' } });
  await waitUntil(() => sessionSetStarted.length >= 1);
  for (let turn = 0; turn < 5; turn += 1) await flush();
  const startsBeforeFirstCompletion = sessionSetStarted.length;
  if (startsBeforeFirstCompletion > 1) {
    gates[1].resolve();
    await flush();
    gates[0].resolve();
  } else {
    gates[0].resolve();
    await waitUntil(() => sessionSetStarted.length === 2);
    gates[1].resolve();
  }
  await Promise.all([first, second]);
  assert.equal(startsBeforeFirstCompletion, 1, 'somente um snapshot pode estar em voo');
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [
    { panelTabId: 50, targetTabId: 7 },
    { panelTabId: 51, targetTabId: 99 },
  ]);
  const restarted = createPersonaController(chromeApi);
  await flush();
  await flush();
  assert.equal(restarted.getOwnerPanel(7), 50);
  assert.equal(restarted.getOwnerPanel(99), 51);
});

test('open then unbind persists in mutation order and restart cannot resurrect released ownership', async () => {
  const gates = [deferred(), deferred()];
  const { chromeApi, sessionData, sessionSetStarted } = createChrome({ sessionSetGates: gates });
  const controller = createPersonaController(chromeApi);
  const opening = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await waitUntil(() => sessionSetStarted.length === 1);
  controller.handleTabRemoved(50);
  for (let turn = 0; turn < 5; turn += 1) await flush();
  const startsBeforeOpenCommit = sessionSetStarted.length;
  gates[0].resolve();
  await waitUntil(() => sessionSetStarted.length === 2);
  gates[1].resolve();
  await assert.rejects(opening, error => error?.code === 'PERSONA_TARGET_CHANGED');
  await waitUntil(() => controller.getOwnerPanel(7) === null);
  assert.equal(startsBeforeOpenCommit, 1, 'unbind aguarda a transição de bind anterior');
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], []);
  const restarted = createPersonaController(chromeApi);
  await flush();
  await flush();
  assert.equal(restarted.getOwnerPanel(7), null);
});

test('release persists the ownership tombstone before a slow content cleanup can be suspended', async () => {
  const stopGate = deferred();
  const stored = { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] };
  const { chromeApi, calls } = createChrome({ sessionData: stored, stopGate });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-durable-release',
    requestId: (() => { let id = 0; return () => `worker-durable-release-${++id}`; })(),
  });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello('hello-durable-release'));
  await flush();
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-durable-release', 'activate', { mode: 'motor' }));
  await flush();
  await flush();
  controller.handleTabRemoved(50);
  await waitUntil(() => calls.send.some(call => call.message.command === 'stop'));

  const restarted = createPersonaController(chromeApi);
  await flush();
  await flush();
  const restoredOwner = restarted.getOwnerPanel(7);
  stopGate.resolve();
  await flush();
  assert.equal(restoredOwner, null);
});

test('replacing a vanished owner panel stops its active target before rebinding ownership', async () => {
  const { chromeApi, calls, tabsById } = createChrome();
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-vanished-owner',
    requestId: (() => { let id = 0; return () => `worker-vanished-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-before-owner-loss', 'activate', { mode: 'motor' }));
  await flush();
  await flush();
  tabsById.delete(50);

  const replacement = await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await flush();
  assert.equal(replacement.id, 51);
  assert.equal(calls.send.at(-1).message.command, 'stop');
  assert.equal(calls.removeCss.length, 1);
  assert.equal(controller.getOwnerPanel(7), 51);
});

test('throwing token and request factories fail closed with a public response and no orphaned CSS', async () => {
  {
    const { chromeApi } = createChrome();
    const controller = createPersonaController(chromeApi, {
      randomToken() { throw new Error('segredo da fábrica de token'); },
    });
    await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    const port = createPort();
    controller.attachPanelPort(port);
    port.onMessage.fire(hello('hello-throwing-token'));
    await flush();
    await flush();
    assert.equal(port.posted.at(-1).code, 'PERSONA_TOKEN_FAILED');
    const connecting = expectPersonaHello(createInitialPersonaState(), 'hello-throwing-token');
    const reduced = reducePersonaState(connecting, port.posted.at(-1));
    assert.equal(reduced.connection, 'error');
    assert.equal(reduced.code, 'PERSONA_TOKEN_FAILED');
    assert.doesNotMatch(JSON.stringify(port.posted), /segredo/iu);
  }

  {
    const { chromeApi, calls } = createChrome();
    const controller = createPersonaController(chromeApi, {
      randomToken: () => 'token-request-factory',
      requestId() { throw new Error('segredo da fábrica de request'); },
    });
    await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    const port = createPort();
    controller.attachPanelPort(port);
    port.onMessage.fire(hello('hello-request-factory'));
    await flush();
    port.onMessage.fire(command(port.posted.at(-1), 'activate-throwing-request', 'activate', { mode: 'reader' }));
    await flush();
    await flush();
    assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_CHANGED');
    assert.equal(calls.removeCss.length, 1);
    assert.doesNotMatch(JSON.stringify(port.posted), /segredo/iu);
  }
});

test('internal, PDF-like and URL-less sources answer the panel hello with a correlated unbound state', async () => {
  const { chromeApi, sessionData } = createChrome();
  const controller = createPersonaController(chromeApi);
  for (const [index, sourceTab] of [
    { id: 90, url: 'chrome://extensions/' },
    { id: 91, url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html' },
    { id: 92 },
  ].entries()) {
    const panel = await controller.openPanel({ sourceTab });
    assert.equal(controller.getBinding(panel.id), null);
    const port = createPort(panel.id, `panel-unbound-document-${index}`);
    assert.equal(controller.attachPanelPort(port), true);
    await flush();
    assert.deepEqual(port.posted, [], 'estado sem vínculo só pode responder ao hello correlacionado');

    const requestId = `hello-unbound-${index}`;
    const connecting = expectPersonaHello(createInitialPersonaState(), requestId);
    port.onMessage.fire(hello(requestId));
    await flush();
    assert.equal(port.posted.length, 1);
    assert.equal(port.posted[0].requestId, requestId);
    assert.equal(port.posted[0].bound, false);
    const reduced = reducePersonaState(connecting, port.posted[0]);
    assert.equal(reduced.connection, 'unbound');
    assert.equal(reduced.code, 'PERSONA_UNBOUND');
  }
  assert.equal(Object.hasOwn(sessionData, PERSONA_SESSION_KEY), false);
});

test('injects the exact classic files in frame 0/ISOLATED and publishes state only after correlated ACK', async () => {
  const ackGate = deferred();
  const { chromeApi, calls } = createChrome({ ackGate });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-panel-1', requestId: (() => { let id = 0; return () => `worker-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  assert.equal(controller.attachPanelPort(port), true);
  port.onMessage.fire(hello());
  await flush();
  const initial = port.posted.at(-1);
  assert.equal(initial.bound, true);
  assert.equal(initial.targetTabId, 7);
  assert.equal(initial.preferences.voiceId, 'voice-initial');
  assert.doesNotMatch(JSON.stringify(initial), /alvo\.test|decoy\.test/iu);

  const postedBefore = port.posted.length;
  port.onMessage.fire(command(initial, 'activate-1', 'activate', { mode: 'reader' }));
  await flush();
  const personaInjections = calls.execute.filter(call => Array.isArray(call.files));
  assert.equal(personaInjections.length, 1);
  assert.deepEqual(personaInjections[0], {
    target: { tabId: 7, frameIds: [0] }, world: 'ISOLATED', files: PERSONA_CLASSIC_FILES,
  });
  assert.equal(calls.insertCss.length, 1);
  assert.equal(port.posted.length, postedBefore, 'estado não é otimista antes do ACK');
  assert.equal(calls.send[0].target.frameId, 0);
  assert.equal(calls.send[0].target.documentId, 'document-target-7');
  assert.equal(calls.send[0].message.command, 'initialize');
  ackGate.resolve();
  await flush();
  await flush();
  const active = port.posted.at(-1);
  assert.equal(active.ok, true);
  assert.equal(active.activeMode, 'reader');
  assert.equal(active.reader.caption, 'Enviar, botão');
  assert.equal(personaInjections.some(call => call.target.tabId === 99), false);
  assert.equal(calls.send.some(call => call.tabId === 99), false);
});

test('serial target execution revalidates generation before a queued duplicate can act', async () => {
  const activateGate = deferred();
  const { chromeApi, calls } = createChrome({ activateGate });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-queued-generation',
    requestId: (() => { let id = 0; return () => `worker-queued-generation-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  const initial = port.posted.at(-1);
  port.onMessage.fire(command(initial, 'activate-queued-first', 'activate', { mode: 'reader' }));
  port.onMessage.fire(command(initial, 'activate-queued-stale', 'activate', { mode: 'motor' }));
  await flush();
  assert.equal(calls.send.filter(call => call.message.command === 'activate').length, 1);
  assert.equal(calls.connect.length, 0, 'bind-events nunca antecede o ACK da ativação correlacionada');
  activateGate.resolve();
  await flush();
  await flush();
  assert.equal(calls.send.filter(call => call.message.command === 'activate').length, 1);
  assert.equal(port.posted.at(-1).code, 'PERSONA_CORRELATION_REJECTED');
});

test('activation remains pending until the correlated event-port handshake is acknowledged', async () => {
  const contentPort = createContentPort({ autoBindAck: false });
  const { chromeApi } = createChrome({ contentPort });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-bind-handshake',
    requestId: (() => { let id = 0; return () => `worker-bind-handshake-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  const initial = port.posted.at(-1);
  const beforeActivation = port.posted.length;
  port.onMessage.fire(command(initial, 'activate-bind-handshake', 'activate', { mode: 'reader' }));
  await waitUntil(() => contentPort.posted.some(message => message.type === 'bind-events'));
  assert.equal(port.posted.length, beforeActivation, 'o painel não recebe ready antes do handshake do canal');
  const bind = contentPort.posted.find(message => message.type === 'bind-events');
  contentPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'events-bound',
    token: bind.token, generation: bind.generation, documentId: bind.documentId,
  });
  await flush();
  assert.equal(port.posted.at(-1).activeMode, 'reader');
});

test('preserves an exact bounded DOM truncation limitation across the content ACK', async () => {
  const limitation = { code: 'dom-traversal-truncated', count: 37, truncated: true };
  const { chromeApi } = createChrome({ contentState: { limitations: [limitation] } });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-truncated-dom',
    requestId: (() => { let id = 0; return () => `worker-truncated-dom-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-truncated-dom', 'activate', { mode: 'reader' }));
  await flush();
  await flush();
  assert.deepEqual(port.posted.at(-1).limitations, [limitation]);
});

test('navigation invalidates an in-flight injection before CSS/ACK and fails closed', async () => {
  const executeGate = deferred();
  const { chromeApi, calls } = createChrome({ executeGate });
  const controller = createPersonaController(chromeApi, { randomToken: () => 'token-navigation' });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  const initial = port.posted.at(-1);
  port.onMessage.fire(command(initial, 'activate-navigation', 'activate', { mode: 'motor' }));
  await flush();
  controller.handleTabUpdated(7, { status: 'loading', url: 'https://alvo.test/nova' }, { id: 7, url: 'https://alvo.test/nova' });
  executeGate.resolve();
  await flush();
  await flush();
  assert.equal(calls.insertCss.length, 0);
  assert.equal(calls.send.length, 0);
  assert.equal(port.posted.at(-1).ok, false);
  assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_CHANGED');
  assert.equal(controller.getOwnerPanel(7), 50);
});

test('rolls back a partial CSS failure and a stale port disconnect cannot tear down its replacement', async () => {
  const { chromeApi, calls } = createChrome({ cssFailure: true });
  const controller = createPersonaController(chromeApi, { randomToken: () => 'token-css' });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const oldPort = createPort(50, 'panel-old');
  const newPort = createPort(50, 'panel-new');
  controller.attachPanelPort(oldPort);
  oldPort.onMessage.fire(hello('hello-old'));
  await flush();
  controller.attachPanelPort(newPort);
  newPort.onMessage.fire(hello('hello-new'));
  await flush();
  oldPort.onDisconnect.fire();
  await flush();
  const initial = newPort.posted.at(-1);
  newPort.onMessage.fire(command(initial, 'activate-css', 'activate', { mode: 'achromatopsia' }));
  await flush();
  await flush();
  assert.equal(newPort.posted.at(-1).code, 'PERSONA_TARGET_CHANGED');
  assert.equal(calls.removeCss.length, 1, 'rollback tenta remover CSS parcial');
  assert.equal(controller.getOwnerPanel(7), 50);
});

test('an activation ACK that did not acquire page ownership fails closed and removes CSS', async () => {
  const { chromeApi, calls } = createChrome({ contentState: { activeMode: null } });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-root-collision',
    requestId: (() => { let id = 0; return () => `worker-root-collision-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-root-collision', 'activate', { mode: 'achromatopsia' }));
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_CHANGED');
  assert.equal(calls.send.at(-1).message.command, 'stop');
  assert.equal(calls.removeCss.length, 1);
});

test('failed activation leaves no stale event owner and reconnects cleanly before lifecycle events', async () => {
  const contentPorts = [createContentPort(), createContentPort()];
  let connectIndex = 0;
  let activationCount = 0;
  const { chromeApi } = createChrome({
    contentPortFactory: () => contentPorts[connectIndex++],
    ackTransform(ack, message) {
      if (message.command === 'activate' && ++activationCount === 1) ack.state.activeMode = null;
      return ack;
    },
  });
  const controller = createPersonaController(chromeApi, {
    randomToken: (() => { let id = 0; return () => `token-retry-${++id}`; })(),
    requestId: (() => { let id = 0; return () => `worker-retry-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello('hello-retry-first'));
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-retry-first', 'activate', { mode: 'motor' }));
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_CHANGED');
  assert.equal(connectIndex, 0, 'o canal de eventos só nasce após ACK de ativação válido');

  port.onMessage.fire(hello('hello-retry-second'));
  await flush();
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-retry-second', 'activate', { mode: 'motor' }));
  await flush();
  await flush();
  const active = port.posted.at(-1);
  assert.equal(active.activeMode, 'motor');
  assert.equal(connectIndex, 1);
  contentPorts[0].onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'event', event: 'lifecycle-stop',
    eventId: 'event-after-retry', token: active.token, generation: active.generation,
    documentId: 'document-target-7',
  });
  await flush();
  assert.equal(port.posted.at(-1).activeMode, null);
});

test('a panel tab that navigates away is cleaned, unbound and never reused as an owner', async () => {
  for (const nextUrl of [
    'https://example.test/away',
    'chrome-extension://test-extension/src/review/index.html',
    'chrome://settings/',
  ]) {
    const { chromeApi, calls, tabsById, sessionData } = createChrome();
    const controller = createPersonaController(chromeApi, {
      randomToken: () => 'token-panel-navigation',
      requestId: (() => { let id = 0; return () => `worker-panel-navigation-${++id}`; })(),
    });
    await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    const port = createPort();
    controller.attachPanelPort(port);
    port.onMessage.fire(hello());
    await flush();
    port.onMessage.fire(command(port.posted.at(-1), 'activate-before-panel-navigation', 'activate', { mode: 'motor' }));
    await flush();
    await flush();
    tabsById.set(50, { id: 50, url: nextUrl, status: 'loading' });
    controller.handleTabUpdated(50, { status: 'loading', url: nextUrl }, tabsById.get(50));
    await flush();
    await flush();
    assert.equal(controller.getOwnerPanel(7), null, nextUrl);
    assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [], nextUrl);
    assert.equal(calls.send.at(-1).message.command, 'stop', nextUrl);
    assert.equal(calls.removeCss.length, 1, nextUrl);
    const replacement = await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    assert.equal(replacement.id, 51, nextUrl);
  }
});

test('openPanel validates an existing owner URL before reuse and cleans stale ownership', async () => {
  const { chromeApi, calls, tabsById } = createChrome();
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-owner-url',
    requestId: (() => { let id = 0; return () => `worker-owner-url-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-owner-url', 'activate', { mode: 'motor' }));
  await flush();
  await flush();
  tabsById.set(50, { id: 50, url: 'chrome-extension://test-extension/src/panel/index.html#stale', status: 'complete' });
  const replacement = await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  assert.equal(replacement.id, 51);
  assert.equal(calls.send.at(-1).message.command, 'stop');
  assert.equal(calls.removeCss.length, 1);
});

test('a target leaving HTTP unbinds and disconnects the panel instead of leaving a zombie port', async () => {
  const { chromeApi, tabsById } = createChrome();
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-target-internal',
    requestId: (() => { let id = 0; return () => `worker-target-internal-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-before-internal', 'activate', { mode: 'motor' }));
  await flush();
  await flush();

  tabsById.set(7, { id: 7, url: 'chrome://settings/', status: 'loading' });
  controller.handleTabUpdated(7, { status: 'loading', url: 'chrome://settings/' }, tabsById.get(7));
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).bound, false);
  assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_CHANGED');
  assert.equal(port.disconnectCalls, 1);
  assert.equal(controller.getOwnerPanel(7), null);

  const reconnected = createPort();
  assert.equal(controller.attachPanelPort(reconnected), true);
  await flush();
  assert.deepEqual(reconnected.posted, []);
  reconnected.onMessage.fire(hello('hello-after-target-navigation'));
  await flush();
  assert.equal(reconnected.posted.at(-1).requestId, 'hello-after-target-navigation');
  assert.equal(reconnected.posted.at(-1).bound, false);
});

test('an old release cleanup completes before replacement ownership and cannot erase the new target', async () => {
  const stopGate = deferred();
  const { chromeApi, calls } = createChrome({ stopGate });
  const controller = createPersonaController(chromeApi, {
    randomToken: (() => { let id = 0; return () => `token-release-epoch-${++id}`; })(),
    requestId: (() => { let id = 0; return () => `worker-release-epoch-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-before-release-race', 'activate', { mode: 'motor' }));
  await flush();
  await flush();

  controller.handleTabRemoved(50);
  const replacementPromise = controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  await flush();
  assert.equal(calls.create.length, 1, 'a substituição aguarda o cleanup correlacionado anterior');
  stopGate.resolve();
  const replacement = await replacementPromise;
  assert.equal(replacement.id, 51);
  assert.equal(controller.getOwnerPanel(7), 51);
  assert.deepEqual(controller.getBinding(51), { panelTabId: 51, targetTabId: 7 });
});

test('rejects accessors, proxies and replay before acting, and persists exactly voice/rate keys', async () => {
  const { chromeApi, calls, localData } = createChrome();
  const controller = createPersonaController(chromeApi, { randomToken: () => 'token-hostile' });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  const initial = port.posted.at(-1);

  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'type', { enumerable: true, get() { getterReads += 1; return 'command'; } });
  port.onMessage.fire(accessor);
  const proxy = new Proxy(command(initial, 'proxy-1', 'stop'), {});
  port.onMessage.fire(proxy);
  await flush();
  assert.equal(getterReads, 0);
  assert.equal(calls.execute.some(call => Array.isArray(call.files)), false);

  const preference = command(initial, 'prefs-1', 'preferences', { voiceId: 'local-voice', rate: 1.5 });
  port.onMessage.fire(preference);
  await flush();
  assert.deepEqual(calls.localWrites, [{
    [PERSONA_LOCAL_KEYS.voiceId]: 'local-voice',
    [PERSONA_LOCAL_KEYS.rate]: 1.5,
  }]);
  assert.deepEqual(Object.keys(localData).sort(), Object.values(PERSONA_LOCAL_KEYS).sort());

  const posted = port.posted.length;
  port.onMessage.fire(preference);
  await flush();
  assert.equal(calls.localWrites.length, 1);
  assert.equal(port.posted.length, posted + 1);
  assert.equal(port.posted.at(-1).code, 'PERSONA_REPLAY_REJECTED');
});

test('disconnect cleanup sends a correlated stop and removes injected CSS', async () => {
  const { chromeApi, calls } = createChrome();
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-disconnect', requestId: (() => { let id = 0; return () => `worker-disconnect-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-disconnect', 'activate', { mode: 'motor' }));
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).activeMode, 'motor');

  port.onDisconnect.fire();
  await flush();
  await flush();
  assert.equal(calls.send.at(-1).message.command, 'stop');
  assert.equal(calls.removeCss.length, 1);
});

test('rejects a nested accessor in a content ACK without reading it or publishing state', async () => {
  let getterReads = 0;
  const { chromeApi, calls } = createChrome({
    ackTransform(ack, message) {
      if (message.command !== 'activate') return ack;
      Object.defineProperty(ack.state.reader, 'caption', {
        enumerable: true, get() { getterReads += 1; return 'segredo'; },
      });
      return ack;
    },
  });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-hostile-ack', requestId: (() => { let id = 0; return () => `worker-hostile-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  const postedBefore = port.posted.length;
  port.onMessage.fire(command(port.posted.at(-1), 'activate-hostile-ack', 'activate', { mode: 'reader' }));
  await flush();
  await flush();
  assert.equal(getterReads, 0);
  assert.equal(port.posted.length, postedBefore + 1);
  assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_CHANGED');
  assert.equal(calls.removeCss.length, 1, 'ACK hostil reverte CSS e estado parcial');
});

test('a restored binding accepts an early panel port only after session storage is ready', async () => {
  const sessionGetGate = deferred();
  const { chromeApi } = createChrome({
    sessionGetGate,
    sessionData: { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] },
  });
  const controller = createPersonaController(chromeApi, { randomToken: () => 'token-restored' });
  const port = createPort();
  assert.equal(controller.attachPanelPort(port), true);
  port.onMessage.fire(hello('hello-restored'));
  await flush();
  assert.equal(port.posted.length, 0, 'o vínculo não é rejeitado enquanto storage.session restaura');
  sessionGetGate.resolve();
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).bound, true);
  assert.equal(port.posted.at(-1).targetTabId, 7);
});

test('hello stays safely unbound when restore rejects a target that disappeared before resume', async () => {
  const stored = { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] };
  const { chromeApi, tabsById, sessionData } = createChrome({ sessionData: stored });
  tabsById.delete(7);
  const controller = createPersonaController(chromeApi);
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello('hello-missing-restored-target'));
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).bound, false);
  assert.equal(port.disconnectCalls, 0, 'painel sem owner continua disponível para auditoria por URL');
  assert.equal(controller.getOwnerPanel(7), null);
  await waitUntil(() => Array.isArray(sessionData[PERSONA_SESSION_KEY]) && sessionData[PERSONA_SESSION_KEY].length === 0);
  assert.deepEqual(sessionData[PERSONA_SESSION_KEY], []);
});

test('go-target does not desynchronize the generation shared with content', async () => {
  const { chromeApi } = createChrome();
  const controller = createPersonaController(chromeApi, { randomToken: () => 'token-go-target' });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  const initial = port.posted.at(-1);
  port.onMessage.fire(command(initial, 'go-target-1', 'go-target'));
  await flush();
  assert.equal(port.posted.at(-1).generation, initial.generation);
});

test('a new panel document stops the old persona before rotating correlation and ignores the stale disconnect', async () => {
  const { chromeApi, calls } = createChrome();
  const controller = createPersonaController(chromeApi, {
    randomToken: (() => { let id = 0; return () => `token-reload-${++id}`; })(),
    requestId: (() => { let id = 0; return () => `worker-reload-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const oldPort = createPort(50, 'panel-document-old');
  controller.attachPanelPort(oldPort);
  oldPort.onMessage.fire(hello('hello-old-active'));
  await flush();
  oldPort.onMessage.fire(command(oldPort.posted.at(-1), 'activate-old', 'activate', { mode: 'motor' }));
  await flush();
  await flush();

  const replacement = createPort(50, 'panel-document-new');
  controller.attachPanelPort(replacement);
  replacement.onMessage.fire(hello('hello-new-document'));
  await flush();
  await flush();
  assert.equal(calls.send.at(-1).message.command, 'stop');
  assert.notEqual(replacement.posted.at(-1).token, oldPort.posted.at(-1).token);
  const cleanupCount = calls.removeCss.length;
  oldPort.onDisconnect.fire();
  await flush();
  assert.equal(calls.removeCss.length, cleanupCount);
});

test('correlated lifecycle event clears panel state and CSS without treating null as an ACK state', async () => {
  const contentPort = createContentPort();
  const { chromeApi, calls } = createChrome({ contentPort });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-lifecycle', requestId: (() => { let id = 0; return () => `worker-life-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const panelPort = createPort();
  controller.attachPanelPort(panelPort);
  panelPort.onMessage.fire(hello());
  await flush();
  panelPort.onMessage.fire(command(panelPort.posted.at(-1), 'activate-life', 'activate', { mode: 'achromatopsia' }));
  await flush();
  await flush();
  const active = panelPort.posted.at(-1);
  contentPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'event', event: 'lifecycle-stop',
    eventId: 'event-life-1', token: active.token, generation: active.generation,
    documentId: 'document-target-7',
  });
  await flush();
  assert.equal(panelPort.posted.at(-1).activeMode, null);
  assert.equal(calls.removeCss.length, 1);

  panelPort.onMessage.fire(hello('hello-after-lifecycle'));
  await flush();
  await flush();
  panelPort.onMessage.fire(command(panelPort.posted.at(-1), 'activate-after-lifecycle', 'activate', { mode: 'achromatopsia' }));
  await flush();
  await flush();
  const reactivated = panelPort.posted.at(-1);
  contentPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'event', event: 'lifecycle-stop',
    eventId: 'event-life-1', token: reactivated.token, generation: reactivated.generation,
    documentId: 'document-target-7',
  });
  await flush();
  assert.equal(panelPort.posted.at(-1).activeMode, null, 'eventId reinicia seu escopo quando token/documento giram');
  assert.equal(calls.removeCss.length, 2);
});

test('a lifecycle event for the in-flight generation is reconciled after ACK instead of dropped', async () => {
  const commandGate = deferred();
  const contentPort = createContentPort();
  const { chromeApi, calls, bindingProofs } = createChrome({
    contentPort, gatedCommand: 'reader-action', commandGate,
    contentState: { activeMode: 'reader' },
  });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-future-event',
    requestId: (() => { let id = 0; return () => `worker-future-event-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const panelPort = createPort();
  controller.attachPanelPort(panelPort);
  panelPort.onMessage.fire(hello());
  await flush();
  panelPort.onMessage.fire(command(panelPort.posted.at(-1), 'activate-future-event', 'activate', { mode: 'reader' }));
  await flush();
  await flush();
  const active = panelPort.posted.at(-1);
  panelPort.onMessage.fire(command(active, 'reader-future-event', 'reader-action', { action: 'next' }));
  await waitUntil(() => calls.send.some(call => call.message.command === 'reader-action'));
  contentPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'event', event: 'lifecycle-stop',
    eventId: 'event-future-generation', token: active.token, generation: active.generation + 1,
    documentId: 'document-target-7',
  });
  await waitUntil(() => bindingProofs.has(7) === false);
  commandGate.resolve();
  await flush();
  await flush();
  assert.equal(panelPort.posted.at(-1).activeMode, null);
  assert.equal(calls.removeCss.length, 1);
});

test('a lifecycle stop revokes the binding proof and a correlated hello reproves the current document', async () => {
  const contentPort = createContentPort();
  const { chromeApi, bindingProofs, proofDocuments, calls } = createChrome({ contentPort });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-lifecycle-reproof',
    requestId: (() => { let id = 0; return () => `worker-lifecycle-reproof-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const panelPort = createPort();
  controller.attachPanelPort(panelPort);
  panelPort.onMessage.fire(hello('hello-lifecycle-reproof-before'));
  await flush();
  panelPort.onMessage.fire(command(
    panelPort.posted.at(-1), 'activate-lifecycle-reproof', 'activate', { mode: 'reader' },
  ));
  await flush();
  await flush();
  const active = panelPort.posted.at(-1);
  contentPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'event', event: 'lifecycle-stop',
    eventId: 'event-lifecycle-reproof-stale', token: active.token, generation: active.generation + 7,
    documentId: 'document-target-7',
  });
  await flush();
  assert.equal(bindingProofs.has(7), true, 'evento fora da geração corrente/in-flight não revoga a prova');
  contentPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'event', event: 'lifecycle-stop',
    eventId: 'event-lifecycle-reproof', token: active.token, generation: active.generation,
    documentId: 'document-target-7',
  });
  await flush();
  await flush();
  assert.equal(bindingProofs.has(7), false, 'lifecycle-stop revoga autorização efêmera do documento');

  panelPort.onMessage.fire(hello('hello-lifecycle-reproof-after'));
  await flush();
  await flush();
  assert.equal(panelPort.posted.at(-1).bound, true);
  assert.equal(bindingProofs.has(7), true);
  assert.equal(proofDocuments.get(7), 'document-target-7');
  assert.equal(calls.execute.filter(call => call.func?.name === 'installPersonaBindingProof').length, 2);
});

test('disconnecting the bound content channel reconciles inactive state and permits a clean event rebind', async () => {
  const contentPorts = [createContentPort(), createContentPort()];
  let contentPortIndex = 0;
  const { chromeApi, calls } = createChrome({ contentPortFactory: () => contentPorts[contentPortIndex++] });
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-content-disconnect',
    requestId: (() => { let id = 0; return () => `worker-content-disconnect-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const panelPort = createPort();
  controller.attachPanelPort(panelPort);
  panelPort.onMessage.fire(hello());
  await flush();
  panelPort.onMessage.fire(command(panelPort.posted.at(-1), 'activate-content-disconnect', 'activate', { mode: 'motor' }));
  await flush();
  await flush();
  assert.equal(panelPort.posted.at(-1).activeMode, 'motor');
  contentPorts[0].disconnect();
  await flush();
  await flush();
  const inactive = panelPort.posted.at(-1);
  assert.equal(inactive.activeMode, null);
  assert.equal(calls.removeCss.length, 1);

  panelPort.onMessage.fire(command(inactive, 'activate-after-content-disconnect', 'activate', { mode: 'achromatopsia' }));
  await flush();
  await flush();
  assert.equal(panelPort.posted.at(-1).activeMode, 'achromatopsia');
  assert.equal(contentPortIndex, 2);
});

test('removing the target tab immediately unbinds the connected panel and invalidates its listeners', async () => {
  const { chromeApi, calls } = createChrome();
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-target-removed', requestId: (() => { let id = 0; return () => `worker-remove-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  const ready = port.posted.at(-1);
  controller.handleTabRemoved(7);
  await flush();
  await flush();
  assert.equal(port.posted.at(-1).bound, false);
  assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_REMOVED');
  assert.equal(controller.getOwnerPanel(7), null);
  const sends = calls.send.length;
  const posts = port.posted.length;
  port.onMessage.fire(command(ready, 'stale-after-remove', 'activate', { mode: 'motor' }));
  await flush();
  assert.equal(calls.send.length, sends);
  assert.equal(port.posted.length, posts, 'listener do vínculo removido não continua respondendo');
});

test('reader start is a correlated content command so an idle empty queue can be recollected', async () => {
  const { chromeApi, calls } = createChrome();
  const controller = createPersonaController(chromeApi, {
    randomToken: () => 'token-reader-restart', requestId: (() => { let id = 0; return () => `worker-reader-${++id}`; })(),
  });
  await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
  const port = createPort();
  controller.attachPanelPort(port);
  port.onMessage.fire(hello());
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'activate-empty-reader', 'activate', { mode: 'reader' }));
  await flush();
  await flush();
  port.onMessage.fire(command(port.posted.at(-1), 'restart-reader', 'reader-action', { action: 'start' }));
  await flush();
  assert.equal(calls.send.at(-1).message.command, 'reader-action');
  assert.deepEqual(calls.send.at(-1).message.args, { action: 'start' });
});

test('early tab lifecycle events are replayed after binding restoration and cannot resurrect stale ownership', async () => {
  for (const lifecycle of ['removed', 'internal-navigation']) {
    const sessionGetGate = deferred();
    const { chromeApi, sessionData } = createChrome({
      sessionGetGate,
      sessionData: { [PERSONA_SESSION_KEY]: [{ panelTabId: 50, targetTabId: 7 }] },
    });
    const controller = createPersonaController(chromeApi);
    if (lifecycle === 'removed') controller.handleTabRemoved(7);
    else controller.handleTabUpdated(7, { status: 'loading', url: 'chrome://settings/' }, { id: 7, url: 'chrome://settings/' });
    assert.equal(controller.getOwnerPanel(7), null);
    sessionGetGate.resolve();
    await flush();
    await flush();
    assert.equal(controller.getOwnerPanel(7), null, lifecycle);
    assert.deepEqual(sessionData[PERSONA_SESSION_KEY], [], lifecycle);
  }
});

test('uncertain ACK recovery stops the executed generation, invalidates correlation and permits a clean rebind', async () => {
  for (const failedCommand of ['activate', 'reader-action', 'preferences', 'stop']) {
    const options = { contentPort: createContentPort() };
    const { chromeApi, calls } = createChrome(options);
    let token = 0;
    let request = 0;
    const controller = createPersonaController(chromeApi, {
      randomToken: () => `token-uncertain-${failedCommand}-${++token}`,
      requestId: () => `worker-uncertain-${failedCommand}-${++request}`,
    });
    await controller.openPanel({ sourceTab: { id: 7, url: 'https://alvo.test/pagina' } });
    const port = createPort();
    controller.attachPanelPort(port);
    port.onMessage.fire(hello(`hello-${failedCommand}`));
    await flush();
    if (failedCommand !== 'activate') {
      port.onMessage.fire(command(port.posted.at(-1), `prepare-${failedCommand}`, 'activate', { mode: 'reader' }));
      await flush();
      await flush();
    }
    options.loseAckFor = failedCommand;
    const stateBeforeFailure = port.posted.at(-1);
    const requestId = `lose-${failedCommand}`;
    const message = failedCommand === 'activate'
      ? command(stateBeforeFailure, requestId, 'activate', { mode: 'motor' })
      : failedCommand === 'reader-action'
        ? command(stateBeforeFailure, requestId, 'reader-action', { action: 'pause' })
        : failedCommand === 'preferences'
          ? command(stateBeforeFailure, requestId, 'preferences', { voiceId: 'voice-safe', rate: 1.4 })
          : command(stateBeforeFailure, requestId, 'stop');
    const sendStart = calls.send.length;
    port.onMessage.fire(message);
    await flush();
    await flush();

    const attemptedIndex = calls.send.findIndex((call, index) => index >= sendStart && call.message.command === failedCommand);
    assert.ok(attemptedIndex >= sendStart, failedCommand);
    const attempted = calls.send[attemptedIndex].message;
    const recovery = calls.send.slice(attemptedIndex + 1).find(call => call.message.command === 'stop');
    assert.ok(recovery, `${failedCommand}: cleanup correlacionado ausente`);
    assert.equal(recovery.message.generation, attempted.generation + 1, failedCommand);
    assert.equal(port.posted.at(-1).code, 'PERSONA_TARGET_CHANGED', failedCommand);
    assert.ok(calls.removeCss.length >= 1, failedCommand);
    if (failedCommand === 'activate') {
      assert.equal(calls.connect.length, 0, 'um ACK de ativação incerto nunca ganha o canal de eventos');
    } else assert.ok(options.contentPort.disconnectCalls >= 1, failedCommand);

    options.loseAckFor = null;
    port.onMessage.fire(hello(`hello-rebind-${failedCommand}`));
    await flush();
    await flush();
    assert.ok(port.posted.at(-1).token, failedCommand);
    port.onMessage.fire(command(port.posted.at(-1), `activate-clean-${failedCommand}`, 'activate', { mode: 'achromatopsia' }));
    await flush();
    await flush();
    assert.equal(port.posted.at(-1).activeMode, 'achromatopsia', failedCommand);
  }
});
