import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOB_URL_PORT_NAME } from '../../src/export/blob-url-protocol.js';

const moduleUrl = new URL('../../src/export/blob-url-client.js', import.meta.url);
const clientModule = await import(moduleUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});
const EXTENSION = 'a'.repeat(32);
const CAPABILITY = 'R'.repeat(22);
const AUDIT = 'audit-local';
const URL_A = `blob:chrome-extension://${EXTENSION}/11111111-1111-4111-8111-111111111111`;
const URL_B = `blob:chrome-extension://${EXTENSION}/22222222-2222-4222-8222-222222222222`;
const FOREIGN = `blob:chrome-extension://${'b'.repeat(32)}/11111111-1111-4111-8111-111111111111`;
const PRIVATE = 'PRIVATE_SENTINEL';
const settle = () => new Promise(resolve => setImmediate(resolve));
function observe(promise) {
  let settled = false;
  const result = promise.then(value => { settled = true; return { ok: true, value }; },
    error => { settled = true; return { ok: false, error }; });
  return { result, get settled() { return settled; } };
}
async function unavailable(observed) {
  const result = await observed.result;
  assert.equal(result.ok, false);
  assert.equal(result.error.constructor, Error);
  assert.equal(result.error.message, 'BLOB_CLIENT_UNAVAILABLE');
  assert.equal(result.error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(result.error), /PRIVATE_SENTINEL|blob:|sessionCapabilityId/u);
}
function event() {
  const listeners = new Set(); const history = [];
  return { listeners, history,
    addListener(listener) { listeners.add(listener); history.push(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(value) { for (const listener of [...listeners]) listener(value); },
  };
}
function fixture(t) {
  const ports = []; const connects = []; const nativeRevocations = []; const live = new Set([URL_A, URL_B]);
  const controls = { connectFails: false, postFails: false, revokeFails: false };
  const runtime = { id: EXTENSION,
    connect(options) {
      connects.push(structuredClone(options));
      if (controls.connectFails) throw new Error(PRIVATE);
      const port = { sent: [], disconnects: 0, onMessage: event(), onDisconnect: event(),
        postMessage(message) {
          if (controls.postFails) throw new Error(PRIVATE);
          this.sent.push(structuredClone(message));
        },
        disconnect() { this.disconnects++; this.onDisconnect.emit(); },
        send(message) { this.onMessage.emit(message); },
      };
      ports.push(port); return port;
    },
  };
  const urlApi = { revokeObjectURL(url) {
    if (controls.revokeFails) throw new Error(PRIVATE);
    nativeRevocations.push(url); live.delete(url);
  } };
  const options = { runtime, urlApi, auditId: AUDIT, sessionCapabilityId: CAPABILITY };
  let client;
  const create = (input = options) => {
    assert.equal(typeof clientModule.createExportBlobUrlClientV1, 'function', 'Blob client factory is missing');
    client = clientModule.createExportBlobUrlClientV1(input); return client;
  };
  t.after(() => client?.dispose());
  return { ports, connects, nativeRevocations, live, controls, options, create };
}
function lastOperation(port, type) { return port.sent.filter(message => message.type === type).at(-1); }
async function registered(env, client, url = URL_A) {
  const registration = observe(client.blobLifecycle.register(url));
  const port = env.ports.at(-1);
  if (!lastOperation(port, 'register')) port.send({ type: 'ready' });
  const operation = lastOperation(port, 'register');
  assert.ok(operation);
  port.send({ type: 'result', requestId: operation.requestId, ok: true });
  assert.deepEqual(await registration.result, { ok: true, value: undefined });
  return port;
}

test('client has a frozen void-hook surface and stays disconnected until a valid operation', async t => {
  const env = fixture(t); const client = env.create();
  assert.deepEqual(Object.keys(client).sort(), ['blobLifecycle', 'dispose']);
  assert.deepEqual(Object.keys(client.blobLifecycle).sort(), ['register', 'release']);
  assert.ok(Object.isFrozen(client)); assert.ok(Object.isFrozen(client.blobLifecycle));
  assert.deepEqual(env.connects, []);
  for (const url of [undefined, 'https://example.test/', FOREIGN, URL_A + '#fragment']) {
    await unavailable(observe(client.blobLifecycle.register(url)));
  }
  await unavailable(observe(client.blobLifecycle.release(URL_A)));
  assert.deepEqual(env.connects, []); assert.deepEqual(env.nativeRevocations, []);
});

test('client rejects invalid constructor authority without effects or private error payloads', async t => {
  for (const changed of [{ auditId: 'a'.repeat(161) }, { auditId: 'audit.with.dot' },
    { sessionCapabilityId: 'bad' }, { extra: true }, { urlApi: {} }, { runtime: { id: EXTENSION } }]) {
    const env = fixture(t);
    assert.throws(() => env.create({ ...env.options, ...changed }), error => {
      assert.equal(error.message, 'BLOB_CLIENT_UNAVAILABLE'); assert.equal(error.cause, undefined); return true;
    });
    assert.deepEqual(env.connects, []);
  }
});

test('client captures callable native runtime Port and event methods even when inherited', async t => {
  const env = fixture(t); const baseConnect = env.options.runtime.connect;
  env.options.runtime = Object.assign(Object.create({ connect(options) {
    const port = baseConnect.call(this, options);
    for (const [value, methods] of [[port, ['postMessage', 'disconnect']],
      [port.onMessage, ['addListener', 'removeListener']], [port.onDisconnect, ['addListener', 'removeListener']]]) {
      const prototype = Object.fromEntries(methods.map(name => [name, value[name]]));
      for (const name of methods) delete value[name];
      Object.setPrototypeOf(value, prototype);
    }
    return port;
  } }), { id: EXTENSION });
  const client = env.create(); const port = await registered(env, client);
  port.send({ type: 'revoke', requestId: 1, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, [URL_A]);
  assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId: 1, ok: true });
});

test('register waits for READY and a positive correlated ACK before delivery', async t => {
  const env = fixture(t); const client = env.create(); let delivered = false;
  const pending = observe(client.blobLifecycle.register(URL_A).then(value => { delivered = true; return value; }));
  const port = env.ports[0];
  assert.deepEqual(env.connects, [{ name: BLOB_URL_PORT_NAME }]);
  assert.deepEqual(port.sent, [{ type: 'hello', auditId: AUDIT, sessionCapabilityId: CAPABILITY }]);
  await settle(); assert.equal(delivered, false);
  port.send({ type: 'ready' });
  const request = lastOperation(port, 'register');
  assert.deepEqual(request, { type: 'register', requestId: 1, blobUrl: URL_A });
  port.send({ type: 'result', requestId: request.requestId + 1, ok: true });
  await settle(); assert.equal(pending.settled, false);
  port.send({ type: 'result', requestId: request.requestId, ok: true });
  assert.deepEqual(await pending.result, { ok: true, value: undefined }); assert.equal(delivered, true);
  assert.equal(env.live.has(URL_A), true);
});

test('REVOKE before registration ACK runs natively outside the queue and prevents late delivery', async t => {
  const env = fixture(t); const client = env.create();
  const registering = observe(client.blobLifecycle.register(URL_A)); const port = env.ports[0];
  port.send({ type: 'ready' }); const request = lastOperation(port, 'register');
  port.send({ type: 'revoke', requestId: 1, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, [URL_A]);
  assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId: 1, ok: true });
  assert.equal(port.sent.some(message => message.type === 'release'), false);
  port.send({ type: 'result', requestId: request.requestId, ok: true });
  await unavailable(registering);
  port.send({ type: 'revoke', requestId: 2, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, [URL_A]);
  assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId: 2, ok: true });
});

test('URL tracking precedes REGISTER transport and also permits revocation before READY', async t => {
  const env = fixture(t); const client = env.create();
  const registering = observe(client.blobLifecycle.register(URL_A)); const port = env.ports[0];
  port.send({ type: 'revoke', requestId: 7, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, [URL_A]);
  assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId: 7, ok: true });
  port.send({ type: 'ready' });
  const request = lastOperation(port, 'register');
  if (request) port.send({ type: 'result', requestId: request.requestId, ok: true });
  await unavailable(registering);
});

test('release awaits its own remote ACK and never awaits release inside the REVOKE handler', async t => {
  const env = fixture(t); const client = env.create(); const port = await registered(env, client);
  const releasing = observe(client.blobLifecycle.release(URL_A)); const request = lastOperation(port, 'release');
  assert.ok(request);
  port.send({ type: 'revoke', requestId: 12, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, [URL_A]);
  assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId: 12, ok: true });
  await settle(); assert.equal(releasing.settled, false, 'native undefined is not the remote RELEASE acknowledgement');
  assert.equal(port.sent.filter(message => message.type === 'release').length, 1);
  port.send({ type: 'result', requestId: request.requestId, ok: true });
  assert.deepEqual(await releasing.result, { ok: true, value: undefined });
  const messages = port.sent.length;
  assert.equal(await client.blobLifecycle.release(URL_A), undefined);
  assert.equal(port.sent.length, messages, 'confirmed repeat release must not recreate ownership');
  await unavailable(observe(client.blobLifecycle.register(URL_A)));
});

test('native revocation failures and foreign or never-tracked URLs never produce a positive ACK', async t => {
  const env = fixture(t); const client = env.create(); const port = await registered(env, client);
  env.controls.revokeFails = true;
  port.send({ type: 'revoke', requestId: 1, blobUrl: URL_A });
  assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId: 1, ok: false });
  assert.equal(env.live.has(URL_A), true);
  env.controls.revokeFails = false;
  for (const [requestId, blobUrl] of [[2, URL_B], [3, FOREIGN]]) {
    port.send({ type: 'revoke', requestId, blobUrl });
    assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId, ok: false });
  }
  assert.deepEqual(env.nativeRevocations, []);
  port.send({ type: 'revoke', requestId: 4, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, [URL_A]);
  assert.deepEqual(port.sent.at(-1), { type: 'revoked', requestId: 4, ok: true });
});

test('negative or malformed results reject registration with fixed errors and no false delivery', async t => {
  for (const kind of ['negative', 'malformed', 'direction', 'getter']) await t.test(kind, async subtest => {
    const env = fixture(subtest); const client = env.create();
    const registering = observe(client.blobLifecycle.register(URL_A)); const port = env.ports[0]; port.send({ type: 'ready' });
    const request = lastOperation(port, 'register');
    let reads = 0;
    const message = kind === 'negative' ? { type: 'result', requestId: request.requestId, ok: false }
      : kind === 'malformed' ? { type: 'result', requestId: request.requestId, ok: undefined }
        : kind === 'direction' ? { type: 'register', requestId: request.requestId, blobUrl: URL_A }
          : Object.defineProperty({ type: 'result', requestId: request.requestId }, 'ok', { enumerable: true, get() { reads++; throw new Error(PRIVATE); } });
    port.send(message); await unavailable(registering); assert.equal(reads, 0);
  });
});

test('operation timeout rejects once and late ACK cannot resolve the next request in the same Port', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture(t); const client = env.create();
  const first = observe(client.blobLifecycle.register(URL_A)); const port = env.ports[0]; port.send({ type: 'ready' });
  const firstRequest = lastOperation(port, 'register');
  t.mock.timers.tick(4999); await settle(); assert.equal(first.settled, false);
  t.mock.timers.tick(1); await unavailable(first);
  const second = observe(client.blobLifecycle.register(URL_B)); const secondRequest = lastOperation(port, 'register');
  assert.ok(secondRequest.requestId > firstRequest.requestId);
  port.send({ type: 'result', requestId: firstRequest.requestId, ok: true });
  await settle(); assert.equal(second.settled, false);
  port.send({ type: 'result', requestId: secondRequest.requestId, ok: true });
  assert.deepEqual(await second.result, { ok: true, value: undefined });
});

test('disconnect reconnects for cleanup without replaying REGISTER or preparing a new capability', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture(t); const client = env.create();
  const registering = observe(client.blobLifecycle.register(URL_A)); const old = env.ports[0]; old.send({ type: 'ready' });
  const staleHandler = old.onMessage.history[0]; old.disconnect(); await unavailable(registering);
  t.mock.timers.tick(249); assert.equal(env.ports.length, 1);
  t.mock.timers.tick(1); const current = env.ports[1];
  assert.deepEqual(current.sent, [{ type: 'hello', auditId: AUDIT, sessionCapabilityId: CAPABILITY }]);
  current.send({ type: 'ready' });
  assert.equal(current.sent.some(message => message.type === 'register'), false);
  staleHandler({ type: 'revoke', requestId: 4, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, []);
  current.send({ type: 'revoke', requestId: 4, blobUrl: URL_A });
  assert.deepEqual(env.nativeRevocations, [URL_A]);
  const releasing = observe(client.blobLifecycle.release(URL_A));
  current.send({ type: 'result', requestId: lastOperation(current, 'release').requestId, ok: true });
  assert.deepEqual(await releasing.result, { ok: true, value: undefined });
  current.disconnect(); t.mock.timers.tick(10_000); assert.equal(env.ports.length, 2);
});

test('pending RELEASE retries on the new Port and an old result cannot acknowledge it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture(t); const client = env.create(); const old = await registered(env, client);
  const releasing = observe(client.blobLifecycle.release(URL_A)); const previous = lastOperation(old, 'release');
  const staleHandler = old.onMessage.history[0]; old.disconnect();
  t.mock.timers.tick(250); const current = env.ports[1]; current.send({ type: 'ready' });
  const retry = lastOperation(current, 'release'); assert.equal(retry.blobUrl, URL_A);
  assert.equal(current.sent.some(message => message.type === 'register'), false);
  staleHandler({ type: 'result', requestId: previous.requestId, ok: true });
  await settle(); assert.equal(releasing.settled, false);
  current.send({ type: 'revoke', requestId: 1, blobUrl: URL_A });
  current.send({ type: 'result', requestId: retry.requestId, ok: true });
  assert.deepEqual(await releasing.result, { ok: true, value: undefined });
});

test('cleanup reconnection backs off from 250ms to 5s and disposal cancels every retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture(t); env.controls.connectFails = true; const client = env.create();
  const registering = observe(client.blobLifecycle.register(URL_A));
  assert.equal(env.connects.length, 1);
  for (const [index, delay] of [250, 500, 1000, 2000, 4000, 5000, 5000].entries()) {
    t.mock.timers.tick(delay - 1); assert.equal(env.connects.length, index + 1);
    t.mock.timers.tick(1); assert.equal(env.connects.length, index + 2);
  }
  await unavailable(registering);
  client.dispose(); const attempts = env.connects.length; t.mock.timers.tick(30_000);
  assert.equal(env.connects.length, attempts); assert.deepEqual(env.nativeRevocations, [URL_A]);
});

test('connection without READY times out and a throwing post cannot leak a pending operation', async t => {
  for (const mode of ['ready-timeout', 'post-throw']) await t.test(mode, async subtest => {
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    const env = fixture(subtest); env.controls.postFails = mode === 'post-throw'; const client = env.create();
    const registering = observe(client.blobLifecycle.register(URL_A)); const old = env.ports[0];
    subtest.mock.timers.tick(5000); await unavailable(registering);
    assert.ok(old.disconnects >= 1);
  });
});

test('dispose rejects all requests, revokes local live URLs, disconnects and never sends journal release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fixture(t); const client = env.create();
  const first = observe(client.blobLifecycle.register(URL_A)); const port = env.ports[0]; port.send({ type: 'ready' });
  const second = observe(client.blobLifecycle.register(URL_B));
  client.dispose(); client.dispose(); await unavailable(first); await unavailable(second);
  assert.deepEqual(env.nativeRevocations, [URL_A, URL_B]);
  assert.equal(port.disconnects, 1); assert.equal(port.onMessage.listeners.size, 0); assert.equal(port.onDisconnect.listeners.size, 0);
  assert.equal(port.sent.some(message => message.type === 'release'), false);
  await unavailable(observe(client.blobLifecycle.register(URL_A)));
  await unavailable(observe(client.blobLifecycle.release(URL_A)));
  const attempts = env.connects.length; t.mock.timers.tick(30_000); assert.equal(env.connects.length, attempts);
});
