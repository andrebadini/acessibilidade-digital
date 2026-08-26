import assert from 'node:assert/strict';
import test from 'node:test';

import { createCdpClient } from '../../src/browser/cdp-client.js';

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
