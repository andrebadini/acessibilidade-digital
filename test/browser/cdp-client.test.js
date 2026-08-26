import assert from 'node:assert/strict';
import test from 'node:test';

import { createCdpClient, createChromeDebuggerTransport } from '../../src/browser/cdp-client.js';

const transport = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    attach: async (...args) => calls.push(['attach', ...args]),
    send: async (...args) => {
      calls.push(['send', ...args]);
      return { ok: true };
    },
    detach: async (...args) => calls.push(['detach', ...args]),
    ...overrides,
  };
};

test('connects, sends commands, and detaches exactly once when disconnected twice', async () => {
  const fake = transport();
  const client = createCdpClient(fake);
  await client.connect(17);
  assert.deepEqual(await client.command('Page.enable'), { ok: true });
  await client.disconnect();
  await client.disconnect();
  assert.deepEqual(fake.calls, [
    ['attach', { tabId: 17 }, '1.3'],
    ['send', { tabId: 17 }, 'Page.enable', undefined],
    ['detach', { tabId: 17 }],
  ]);
});

test('fails clearly before connection and after disconnection', async () => {
  const client = createCdpClient(transport());
  await assert.rejects(client.command('Page.enable'), /não está conectado/i);
  await client.connect(7);
  await client.disconnect();
  await assert.rejects(client.command('Page.enable'), /não está conectado/i);
});

test('returns to a safe disconnected state when attach, send, or detach reject', async () => {
  const attachFailure = createCdpClient(transport({ attach: async () => { throw new Error('attach falhou'); } }));
  await assert.rejects(attachFailure.connect(1), /attach falhou/);
  await assert.rejects(attachFailure.command('Page.enable'), /não está conectado/i);

  const sendTransport = transport({ send: async () => { throw new Error('send falhou'); } });
  const sendFailure = createCdpClient(sendTransport);
  await sendFailure.connect(2);
  await assert.rejects(sendFailure.command('Page.enable'), /send falhou/);
  await sendFailure.disconnect();
  assert.equal(sendTransport.calls.filter(([method]) => method === 'detach').length, 1);

  const detachFailure = createCdpClient(transport({ detach: async () => { throw new Error('detach falhou'); } }));
  await detachFailure.connect(3);
  await assert.rejects(detachFailure.disconnect(), /detach falhou/);
  await detachFailure.disconnect();
  await assert.rejects(detachFailure.command('Page.enable'), /não está conectado/i);
});

test('keeps the CDP connection usable after one command fails until explicit disconnect', async () => {
  let attempts = 0;
  const fake = transport({ send: async (...args) => {
    fake.calls.push(['send', ...args]);
    attempts += 1;
    if (attempts === 1) throw new Error('captura falhou');
    return { recovered: true };
  } });
  const client = createCdpClient(fake);
  await client.connect(23);
  await assert.rejects(client.command('Page.captureScreenshot'), /captura falhou/);
  assert.deepEqual(await client.command('DOMSnapshot.captureSnapshot'), { recovered: true });
  assert.equal(fake.calls.filter(([method]) => method === 'detach').length, 0);
  await client.disconnect();
  assert.equal(fake.calls.filter(([method]) => method === 'detach').length, 1);
});

test('serializes concurrent connects and detaches the old tab before attaching a new tab', async () => {
  const fake = transport();
  const client = createCdpClient(fake);
  await Promise.all([client.connect(10), client.connect(11)]);
  assert.deepEqual(fake.calls, [
    ['attach', { tabId: 10 }, '1.3'],
    ['detach', { tabId: 10 }],
    ['attach', { tabId: 11 }, '1.3'],
  ]);
  await client.disconnect();
});

test('treats a concurrent connect to the same tab as idempotent', async () => {
  const fake = transport();
  const client = createCdpClient(fake);
  await Promise.all([client.connect(12), client.connect(12)]);
  assert.equal(fake.calls.filter(([method]) => method === 'attach').length, 1);
  await client.disconnect();
});

test('serializes concurrent command failures without implicit detach', async () => {
  const fake = transport({ send: async () => { throw new Error('comando falhou'); } });
  const client = createCdpClient(fake);
  await client.connect(13);
  await Promise.allSettled([client.command('Page.enable'), client.command('Runtime.enable')]);
  assert.equal(fake.calls.filter(([method]) => method === 'detach').length, 0);
  await assert.rejects(client.command('Page.enable'), /comando falhou/i);
  await client.disconnect();
  assert.equal(fake.calls.filter(([method]) => method === 'detach').length, 1);
});

test('does not let a failed old command detach a newer connection', async () => {
  let rejectSend;
  const pendingSend = new Promise((_, reject) => { rejectSend = reject; });
  const fake = transport({ send: () => pendingSend });
  const client = createCdpClient(fake);
  await client.connect(14);
  const command = client.command('Page.enable');
  const reconnect = client.connect(15);
  rejectSend(new Error('falha tardia'));
  await assert.rejects(command, /falha tardia/);
  await reconnect;
  assert.deepEqual(fake.calls.filter(([method]) => method === 'detach'), [['detach', { tabId: 14 }]]);
  assert.deepEqual(fake.calls.at(-1), ['attach', { tabId: 15 }, '1.3']);
  await client.disconnect();
});

test('wraps callback-only Chrome debugger APIs and reads lastError before settling', async () => {
  const chromeApi = {
    runtime: { lastError: null },
    debugger: {
      attach(_target, _version, callback) { callback(); },
      sendCommand(_target, _method, _params, callback) { callback({ value: 1 }); },
      detach(_target, callback) { callback(); },
    },
  };
  const client = createCdpClient(createChromeDebuggerTransport(chromeApi));
  await client.connect(16);
  assert.deepEqual(await client.command('Runtime.evaluate', { expression: '1' }), { value: 1 });
  await client.disconnect();

  chromeApi.debugger.attach = (_target, _version, callback) => {
    chromeApi.runtime.lastError = { message: 'sem permissão' };
    callback();
    chromeApi.runtime.lastError = null;
  };
  await assert.rejects(createCdpClient(createChromeDebuggerTransport(chromeApi)).connect(17), /sem permissão/);
});

test('settles once when Chrome debugger API calls both callback and promise', async () => {
  let callbacks = 0;
  const chromeApi = {
    runtime: { lastError: null },
    debugger: {
      attach(_target, _version, callback) { callback(); return Promise.resolve('ignored'); },
      sendCommand(_target, _method, _params, callback) { callbacks += 1; callback({ callback: true }); return Promise.resolve({ promise: true }); },
      detach(_target, callback) { callback(); return Promise.resolve(); },
    },
  };
  const client = createCdpClient(createChromeDebuggerTransport(chromeApi));
  await client.connect(18);
  assert.deepEqual(await client.command('Page.enable'), { callback: true });
  assert.equal(callbacks, 1);
  await client.disconnect();
});

test('propagates callback lastError from send and detach without duplicate cleanup', async () => {
  const chromeApi = {
    runtime: { lastError: null },
    debugger: {
      attach(_target, _version, callback) { callback(); },
      sendCommand(_target, _method, _params, callback) {
        chromeApi.runtime.lastError = { message: 'send bloqueado' };
        callback();
        chromeApi.runtime.lastError = null;
      },
      detach(_target, callback) { callback(); },
    },
  };
  const client = createCdpClient(createChromeDebuggerTransport(chromeApi));
  await client.connect(19);
  await assert.rejects(client.command('Page.enable'), /send bloqueado/);

  chromeApi.debugger.sendCommand = (_target, _method, _params, callback) => callback({ ok: true });
  const second = createCdpClient(createChromeDebuggerTransport(chromeApi));
  await second.connect(20);
  chromeApi.debugger.detach = (_target, callback) => {
    chromeApi.runtime.lastError = { message: 'detach bloqueado' };
    callback();
    chromeApi.runtime.lastError = null;
  };
  await assert.rejects(second.disconnect(), /detach bloqueado/);
});

test('concurrent disconnects make exactly one rejecting detach attempt', async () => {
  const fake = transport();
  fake.detach = async (target) => {
    fake.calls.push(['detach', target]);
    throw new Error('detach falhou');
  };
  const client = createCdpClient(fake);
  await client.connect(21);
  const outcomes = await Promise.allSettled([client.disconnect(), client.disconnect()]);
  assert.equal(fake.calls.filter(([method]) => method === 'detach').length, 1);
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
  await assert.rejects(client.connect(22), /limpeza manual/);
});
