import assert from 'node:assert/strict';
import test from 'node:test';

let runtimeModule = {};
try { runtimeModule = await import('../../src/background/persona-runtime.js'); } catch { /* RED */ }

function chromeFixture() {
  const listeners = { updated: 0, removed: 0 };
  return {
    chromeApi: {
      runtime: {
        id: 'test', getURL: path => `chrome-extension://test/${path}`,
        onConnect: { addListener() {} },
      },
      tabs: {
        create: async () => ({ id: 50 }), get: async id => ({ id, url: 'https://example.test/' }),
        onUpdated: { addListener() { listeners.updated += 1; } },
        onRemoved: { addListener() { listeners.removed += 1; } },
      },
      scripting: { executeScript: async () => [], insertCSS: async () => {}, removeCSS: async () => {} },
      storage: {
        session: { get: async () => ({}), set: async () => {} },
        local: { get: async () => ({}), set: async () => {} },
      },
    },
    listeners,
  };
}

test('one Chrome realm receives one persona authority without duplicate lifecycle listeners', () => {
  assert.equal(typeof runtimeModule.getPersonaController, 'function');
  const first = chromeFixture();
  const authority = runtimeModule.getPersonaController(first.chromeApi);
  const repeated = runtimeModule.getPersonaController(first.chromeApi, { logger: { error() {} } });
  assert.strictEqual(repeated, authority);
  assert.deepEqual(first.listeners, { updated: 1, removed: 1 });

  const second = chromeFixture();
  assert.notStrictEqual(runtimeModule.getPersonaController(second.chromeApi), authority);
  assert.deepEqual(second.listeners, { updated: 1, removed: 1 });
});

test('unavailable Chrome surfaces remain unbound instead of constructing partial authority', () => {
  assert.equal(runtimeModule.getPersonaController({ runtime: {} }), null);
});
