import assert from 'node:assert/strict';
import test from 'node:test';

import { registerServiceWorker } from '../../src/background/service-worker.js';

const createChrome = () => {
  const action = {};
  const message = {};
  const createdTabs = [];
  return {
    action: { onClicked: { addListener(listener) { action.listener = listener; } } },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener(listener) { message.listener = listener; } },
    },
    tabs: { create: async (options) => { createdTabs.push(options); } },
    listeners: { action, message },
    createdTabs,
  };
};

test('opens the local panel in one tab when the action is clicked', async () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { createId: () => 'audit-1' });
  await chromeApi.listeners.action.listener();
  assert.deepEqual(chromeApi.createdTabs, [{ url: 'chrome-extension://test/src/panel/index.html' }]);
});

test('validates START_AUDIT, stores an armed session, and keeps the response channel open', () => {
  const chromeApi = createChrome();
  const sessions = new Map();
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', sessions });
  let response;
  const keepOpen = chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: ' example.test/a ' },
    {},
    (value) => { response = value; },
  );
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  assert.equal(sessions.get('audit-1').requestedUrl, 'https://example.test/a');
});

test('rejects unknown and malformed worker messages safely', () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { createId: () => 'audit-1' });
  let response;
  assert.equal(chromeApi.listeners.message.listener({ type: 'OTHER' }, {}, (value) => { response = value; }), false);
  assert.equal(response, undefined);
  const keepOpen = chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'file:///tmp/x' }, {}, (value) => { response = value; });
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: false, error: 'A URL deve usar HTTP ou HTTPS.' });
});
