import assert from 'node:assert/strict';
import test from 'node:test';

import { createPanelLauncher } from '../../src/background/panel-launcher.js';

const TOKEN = 'L'.repeat(43);

function fixture() {
  const calls = [];
  const callbacks = { setOptions: [] };
  const chromeApi = {
    runtime: { lastError: null },
    sidePanel: {
      setOptions(...args) { calls.push(['setOptions', args]); callbacks.setOptions.push(args[1]); },
      open(...args) { calls.push(['open', args]); callbacks.open = args[1]; },
    },
  };
  const issued = Object.freeze({
    ok: true, token: TOKEN, path: `src/panel/index.html?launch=${TOKEN}`, generation: 1,
  });
  const launchAuthority = {
    issue(value) { calls.push(['issue', value]); return issued; },
    async rotateForNavigation(value) { calls.push(['rotate', value]); return issued; },
    async whenReady(value) { calls.push(['whenReady', value]); return true; },
    async revoke(value) { calls.push(['revoke', value]); return { ok: true, revoked: true }; },
  };
  const logger = { error(code) { calls.push(['log', code]); } };
  return { callbacks, calls, chromeApi, issued, launchAuthority, logger };
}

function launcher(env) {
  return createPanelLauncher({ chromeApi: env.chromeApi, launchAuthority: env.launchAuthority, logger: env.logger });
}

test('preserves the gesture with one exact tab setOptions callback before open', async () => {
  const env = fixture();
  const panelLauncher = launcher(env);
  let opened = 0;

  assert.equal(panelLauncher.launch({ id: 17, windowId: 9, url: 'https://example.test/' }, () => { opened += 1; }), true);
  assert.deepEqual(env.calls.slice(0, 2), [
    ['issue', { tabId: 17, windowId: 9 }],
    ['setOptions', [{ tabId: 17, enabled: true, path: env.issued.path }, env.callbacks.setOptions[0]]],
  ]);
  assert.equal(env.calls[1][1].length, 2);
  assert.equal(env.calls.some(([name]) => name === 'open'), false);

  env.callbacks.setOptions[0]();
  assert.equal(opened, 0);
  assert.deepEqual(env.calls.at(-1), ['open', [{ tabId: 17 }, env.callbacks.open]]);
  assert.equal(env.calls.at(-1)[1].length, 2);
  env.callbacks.open();
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(env.calls.some(([name]) => name === 'revoke'), false);
});

test('one action click reopens an existing panel and rotates a conflicting live launch', async () => {
  const env = fixture();
  env.launchAuthority.issue = value => {
    env.calls.push(['issue', value]);
    return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_CONFLICT' });
  };
  const panelLauncher = launcher(env);
  let opened = 0;

  assert.equal(panelLauncher.launch({ id: 17, windowId: 9 }, () => { opened += 1; }), true);
  assert.deepEqual(env.calls.slice(0, 2), [
    ['issue', { tabId: 17, windowId: 9 }],
    ['open', [{ tabId: 17 }, env.callbacks.open]],
  ]);
  assert.equal(env.calls.some(([name]) => name === 'setOptions'), false);

  env.callbacks.open();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(env.calls.find(([name]) => name === 'rotate'), ['rotate', { tabId: 17 }]);
  assert.deepEqual(env.calls.find(([name]) => name === 'setOptions'), [
    'setOptions', [{ tabId: 17, enabled: true, path: env.issued.path }, env.callbacks.setOptions[0]],
  ]);
  assert.equal(opened, 0);

  env.callbacks.setOptions[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 1);
});

test('does not open an existing panel for a non-conflict launch denial', () => {
  const env = fixture();
  env.launchAuthority.issue = value => {
    env.calls.push(['issue', value]);
    return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' });
  };

  assert.equal(launcher(env).launch({ id: 17, windowId: 9 }), false);
  assert.equal(env.calls.some(([name]) => name === 'open'), false);
});

test('revokes the token on synchronous, setOptions, or open failure without logging the secret', async t => {
  await t.test('setOptions lastError', async () => {
    const env = fixture();
    const panelLauncher = launcher(env);
    panelLauncher.launch({ id: 17, windowId: 9 });
    env.chromeApi.runtime.lastError = { message: `secret ${TOKEN}` };
    env.callbacks.setOptions[0]();
    await Promise.resolve();
    assert.deepEqual(env.calls.find(([name]) => name === 'revoke')[1], env.issued);
    assert.doesNotMatch(JSON.stringify(env.calls.filter(([name]) => name === 'log')), new RegExp(TOKEN, 'u'));
    assert.equal(env.calls.some(([name]) => name === 'open'), false);
  });

  await t.test('open lastError', async () => {
    const env = fixture();
    const panelLauncher = launcher(env);
    panelLauncher.launch({ id: 17, windowId: 9 });
    env.callbacks.setOptions[0]();
    env.chromeApi.runtime.lastError = { message: 'denied' };
    env.callbacks.open();
    await Promise.resolve();
    assert.deepEqual(env.calls.find(([name]) => name === 'revoke')[1], env.issued);
  });

  await t.test('synchronous setOptions throw', async () => {
    const env = fixture();
    env.chromeApi.sidePanel.setOptions = () => { throw new Error(`secret ${TOKEN}`); };
    const panelLauncher = launcher(env);
    assert.equal(panelLauncher.launch({ id: 17, windowId: 9 }), false);
    await Promise.resolve();
    assert.deepEqual(env.calls.find(([name]) => name === 'revoke')[1], env.issued);
    assert.doesNotMatch(JSON.stringify(env.calls.filter(([name]) => name === 'log')), new RegExp(TOKEN, 'u'));
  });
});

test('rejects hostile or invalid tabs before issuing a launch', () => {
  const env = fixture();
  const panelLauncher = launcher(env);
  let reads = 0;
  const hostile = { windowId: 9 };
  Object.defineProperty(hostile, 'id', { enumerable: true, get() { reads += 1; return 17; } });

  assert.equal(panelLauncher.launch(hostile), false);
  assert.equal(panelLauncher.launch({ id: -1, windowId: 9 }), false);
  assert.equal(panelLauncher.launch({ id: 17, windowId: -1 }), false);
  assert.equal(reads, 0);
  assert.equal(env.calls.some(([name]) => name === 'issue'), false);
});

test('opens inside the gesture but never runs the caller callback when durable issuance later fails', async () => {
  const env = fixture();
  let settlePersistence;
  env.launchAuthority.whenReady = value => {
    env.calls.push(['whenReady', value]);
    return new Promise(resolve => { settlePersistence = resolve; });
  };
  const panelLauncher = launcher(env);
  let opened = 0;

  assert.equal(panelLauncher.launch({ id: 17, windowId: 9 }, () => { opened += 1; }), true);
  env.callbacks.setOptions[0]();
  assert.deepEqual(env.calls.at(-1), ['open', [{ tabId: 17 }, env.callbacks.open]],
    'Chrome open remains directly inside the setOptions callback');
  env.callbacks.open();
  await Promise.resolve();

  assert.equal(opened, 0);
  assert.equal(env.calls.some(([name]) => name === 'revoke'), false);
  settlePersistence(false);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(opened, 0, 'a failed durable reservation cannot start a context-menu audit');
  assert.deepEqual(env.calls.find(([name]) => name === 'revoke')?.[1], env.issued);
  assert.ok(env.calls.some(([name, value]) => name === 'log' && value === 'PANEL_LAUNCH_UNAVAILABLE'));
});

test('rebinds an already-open panel after navigation without attempting another gesture-gated open', async () => {
  const env = fixture();
  const panelLauncher = launcher(env);

  const rebound = panelLauncher.rebindForNavigation({ tabId: 17 });
  await Promise.resolve();
  assert.deepEqual(env.calls.slice(0, 2), [
    ['rotate', { tabId: 17 }],
    ['setOptions', [{ tabId: 17, enabled: true, path: env.issued.path }, env.callbacks.setOptions[0]]],
  ]);
  assert.equal(env.calls.some(([name]) => name === 'open'), false);
  env.callbacks.setOptions[0]();
  assert.equal(await rebound, true);
  assert.equal(env.calls.some(([name]) => name === 'open'), false);
  assert.deepEqual(env.calls.find(([name]) => name === 'whenReady')[1], env.issued);
});
