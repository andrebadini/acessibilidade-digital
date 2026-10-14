import assert from 'node:assert/strict';
import test from 'node:test';

import { createNavigationFreeze } from '../../src/background/navigation-freeze.js';

const TAB = 21;
const TOP_FRAME = 'FRAME-TOP';

function harness({ frameTree = { frameTree: { frame: { id: TOP_FRAME } } } } = {}) {
  const calls = [];
  const listeners = [];
  let nextCommandFails = false;
  let failingMethod = null;
  const cdp = {
    async command(method, params) {
      calls.push([method, params]);
      if (nextCommandFails || method === failingMethod) {
        nextCommandFails = false;
        throw new Error('CDP_COMMAND_FAILED');
      }
      if (method === 'Page.getFrameTree') return frameTree;
      return {};
    },
  };
  const chromeApi = {
    debugger: {
      onEvent: {
        addListener(listener) { listeners.push(listener); },
        removeListener(listener) { listeners.splice(listeners.indexOf(listener), 1); },
      },
    },
  };
  const emit = (source, method, params) => {
    for (const listener of [...listeners]) listener(source, method, params);
  };
  return {
    cdp, chromeApi, calls, listeners, emit,
    failNextCommand() { nextCommandFails = true; },
    failOn(method) { failingMethod = method; },
    freeze: () => createNavigationFreeze({ chromeApi, cdp, tabId: TAB }),
  };
}

const paused = (requestId, frameId) => ({ requestId, frameId, resourceType: 'Document', request: { url: 'http://127.0.0.1/' } });
const pause = async (h, requestId, frameId) => {
  h.emit({ tabId: TAB }, 'Fetch.requestPaused', paused(requestId, frameId));
  await new Promise(resolve => setImmediate(resolve));
};

test('start lê a árvore de quadros, ouve eventos e habilita só resourceType Document', async () => {
  const h = harness();
  const freeze = h.freeze();
  await freeze.start();
  assert.deepEqual(h.calls, [
    ['Page.getFrameTree', {}],
    ['Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }],
  ]);
  assert.equal(h.listeners.length, 1);
  assert.equal(freeze.intercepted(), true);
});

test('pedido de documento do frame principal é segurado com Aborted e contado', async () => {
  const h = harness();
  const freeze = h.freeze();
  await freeze.start();
  await pause(h, 'req-1', TOP_FRAME);
  assert.deepEqual(h.calls.at(-1), ['Fetch.failRequest', { requestId: 'req-1', errorReason: 'Aborted' }]);
  assert.equal(freeze.blocked(), 1);
  // A segunda tentativa da mesma página também é segurada: o congelamento vale até o fim.
  await pause(h, 'req-2', TOP_FRAME);
  assert.equal(freeze.blocked(), 2);
});

test('iframes e pedidos sem frame atribuível seguem adiante: o congelamento nunca inventa tela de erro', async () => {
  const h = harness();
  const freeze = h.freeze();
  await freeze.start();
  await pause(h, 'iframe-1', 'FRAME-IFRAME');
  await pause(h, 'unknown-1', undefined);
  await pause(h, 'unknown-2', '');
  assert.deepEqual(h.calls.slice(-3), [
    ['Fetch.continueRequest', { requestId: 'iframe-1' }],
    ['Fetch.continueRequest', { requestId: 'unknown-1' }],
    ['Fetch.continueRequest', { requestId: 'unknown-2' }],
  ]);
  assert.equal(freeze.blocked(), 0);
});

test('eventos de outra aba, de outro método e pedidos repetidos não produzem resposta dupla', async () => {
  const h = harness();
  const freeze = h.freeze();
  await freeze.start();
  h.emit({ tabId: TAB + 1 }, 'Fetch.requestPaused', paused('outra-aba', TOP_FRAME));
  h.emit({ tabId: TAB }, 'Page.frameNavigated', { frame: { id: TOP_FRAME } });
  await pause(h, 'req-1', TOP_FRAME);
  h.emit({ tabId: TAB }, 'Fetch.requestPaused', paused('req-1', TOP_FRAME));
  await new Promise(resolve => setImmediate(resolve));
  const answers = h.calls.filter(([method]) => method.startsWith('Fetch.') && method !== 'Fetch.enable');
  assert.deepEqual(answers, [['Fetch.failRequest', { requestId: 'req-1', errorReason: 'Aborted' }]]);
  assert.equal(freeze.blocked(), 1);
});

test('stop desabilita o Fetch antes de remover o ouvinte e nada mais responde', async () => {
  const h = harness();
  const freeze = h.freeze();
  await freeze.start();
  await pause(h, 'req-1', TOP_FRAME);
  h.calls.length = 0;
  assert.equal(await freeze.stop(), true);
  assert.deepEqual(h.calls, [['Fetch.disable', {}]]);
  assert.equal(h.listeners.length, 0);
  // Depois de parar, nem um pedido novo é respondido: nenhuma interceptação sobra.
  await pause(h, 'req-2', TOP_FRAME);
  assert.deepEqual(h.calls, [['Fetch.disable', {}]]);
  assert.equal(freeze.blocked(), 1);
});

test('stop é idempotente e continua desabilitando o Fetch quando o disable falha', async () => {
  const h = harness();
  const freeze = h.freeze();
  await freeze.start();
  h.failNextCommand();
  assert.equal(await freeze.stop(), false);
  assert.equal(h.listeners.length, 0);
  assert.equal(await freeze.stop(), true);
  assert.equal(h.listeners.length, 0);
});

test('falha ao habilitar não deixa ouvinte registrado e propaga para o chamador decidir', async () => {
  const h = harness();
  const freeze = h.freeze();
  h.failOn('Fetch.enable');
  await assert.rejects(freeze.start(), /CDP_COMMAND_FAILED/u);
  assert.equal(h.listeners.length, 0, 'o ouvinte registrado antes do enable tem de ser removido');
  assert.equal(freeze.intercepted(), false);
  // A auditoria segue sem congelamento: nada foi interceptado e um novo start é possível.
  h.failOn(null);
  await freeze.start();
  assert.equal(freeze.intercepted(), true);
  assert.equal(h.listeners.length, 1);
  await freeze.stop();
});

test('falha ao responder não derruba o ouvinte nem deixa de contar como tentativa', async () => {
  const h = harness();
  const freeze = h.freeze();
  await freeze.start();
  h.failNextCommand();
  await pause(h, 'req-1', TOP_FRAME);
  assert.equal(freeze.blocked(), 1);
  await pause(h, 'req-2', TOP_FRAME);
  assert.equal(freeze.blocked(), 2);
  assert.equal(h.listeners.length, 1);
});

test('recusa entradas fora do contrato fechado', () => {
  assert.throws(() => createNavigationFreeze(), TypeError);
  assert.throws(() => createNavigationFreeze({}), TypeError);
  const h = harness();
  assert.throws(() => createNavigationFreeze({ chromeApi: {}, cdp: h.cdp, tabId: TAB }), /NAVIGATION_FREEZE_INVALID/u);
  assert.throws(() => createNavigationFreeze({ chromeApi: h.chromeApi, cdp: {}, tabId: TAB }), /NAVIGATION_FREEZE_INVALID/u);
  assert.throws(() => createNavigationFreeze({ chromeApi: h.chromeApi, cdp: h.cdp, tabId: -1 }), /NAVIGATION_FREEZE_INVALID/u);
  assert.throws(() => createNavigationFreeze({ chromeApi: h.chromeApi, cdp: h.cdp, tabId: '21' }), /NAVIGATION_FREEZE_INVALID/u);
});

test('sem frame principal identificável o congelamento não arma e a auditoria segue sem ele', async () => {
  const h = harness({ frameTree: {} });
  const freeze = h.freeze();
  await assert.rejects(freeze.start(), /NAVIGATION_FREEZE_UNAVAILABLE/u);
  assert.equal(h.listeners.length, 0);
  assert.equal(freeze.intercepted(), false);
});
