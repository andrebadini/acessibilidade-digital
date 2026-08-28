import assert from 'node:assert/strict';
import test from 'node:test';

import { captureFocusLocator, createChromeAdapter, resolveActiveNodeId, restoreFocusLocator } from '../../src/background/chrome-adapter.js';

test('captures and restores focus for elements without DOM IDs', () => {
  const first = { localName: 'button', id: '', parentElement: null };
  const second = { localName: 'button', id: '', parentElement: null, focused: false, focus() { this.focused = true; } };
  const body = { localName: 'body', id: '', parentElement: null, children: [first, second] };
  first.parentElement = body;
  second.parentElement = body;
  const documentElement = { localName: 'html', id: '', parentElement: null, children: [body] };
  body.parentElement = documentElement;
  const root = { activeElement: second, documentElement, querySelector: selector => selector === 'body:nth-of-type(1) > button:nth-of-type(2)' ? second : null };
  const locator = captureFocusLocator(root);
  assert.equal(locator, 'body:nth-of-type(1) > button:nth-of-type(2)');
  assert.equal(restoreFocusLocator(locator, root), true);
  assert.equal(second.focused, true);
});

test('resolves the active element to the authoritative SnapshotV1 backend node ID', async () => {
  const calls = [];
  const cdp = {
    async command(method, params) {
      calls.push([method, params]);
      if (method === 'Runtime.evaluate') return { result: { objectId: 'remote-active' } };
      if (method === 'DOM.requestNode') return { nodeId: 12 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 45 } };
      return {};
    },
  };
  assert.equal(await resolveActiveNodeId(cdp), 'n-45');
  assert.deepEqual(calls.map(([method]) => method), ['Runtime.evaluate', 'DOM.requestNode', 'DOM.describeNode', 'Runtime.releaseObject']);
});

function chromeFake() {
  const calls = [];
  const updated = {};
  const removed = {};
  const chromeApi = {
    runtime: { getURL: path => `chrome-extension://test/${path}`, sendMessage: async message => calls.push(['message', message]) },
    tabs: {
      create: async options => { calls.push(['create', options]); return { id: 17, ...options }; },
      update: async (id, options) => { calls.push(['update', id, options]); return { id, ...options }; },
      get: async id => ({ id, status: 'complete', url: 'https://example.test/final' }),
      remove: async id => calls.push(['remove', id]),
      onUpdated: { addListener(listener) { updated.listener = listener; }, removeListener() { updated.removed = true; } },
      onRemoved: { addListener(listener) { removed.listener = listener; }, removeListener() { removed.removed = true; } },
    },
    scripting: { executeScript: async options => { calls.push(['script', options.target]); return []; } },
    debugger: {
      attach: async (target, version) => calls.push(['attach', target, version]),
      sendCommand: async (_target, method) => {
        calls.push(['cdp', method]);
        if (method === 'Browser.getVersion') return { product: 'Chrome/140.0' };
        if (method === 'Runtime.evaluate') return { result: { value: { width: 1280, height: 720, deviceScaleFactor: 2 } } };
        return {};
      },
      detach: async target => calls.push(['detach', target]),
    },
  };
  return { chromeApi, calls, updated, removed };
}

test('creates, navigates, waits, scripts all frames, connects CDP and removes only the exact tab', async () => {
  const fake = chromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);
  const tab = await adapter.createTab({ url: 'about:blank', active: false });
  await adapter.navigateTab(tab.id, 'https://example.test/');
  const stable = await adapter.waitForStable(tab.id, { timeoutMs: 50 });
  await adapter.executeScript({ target: { tabId: tab.id, allFrames: true }, func() {} });
  const cdp = await adapter.connectCdp(tab.id);
  assert.equal(typeof adapter.captureFullPage, 'function');
  assert.equal(typeof adapter.composeAnnouncementMap, 'function');
  assert.equal(typeof adapter.captureElement, 'function');
  const environment = await adapter.getEnvironment(tab.id, cdp);
  await cdp.disconnect();
  await adapter.removeTab(tab.id);
  assert.equal(stable.url, 'https://example.test/final');
  assert.deepEqual(environment, { chromeVersion: 'Chrome/140.0', viewport: { width: 1280, height: 720, deviceScaleFactor: 2 } });
  assert.ok(fake.calls.some(call => call[0] === 'script' && call[1].allFrames === true));
  assert.deepEqual(fake.calls.filter(call => call[0] === 'remove'), [['remove', 17]]);
  assert.deepEqual(fake.calls.filter(call => call[0] === 'detach'), [['detach', { tabId: 17 }]]);
});

test('times out a tab that never reaches complete and removes its listeners', async () => {
  const fake = chromeFake();
  fake.chromeApi.tabs.get = async id => ({ id, status: 'loading', url: 'https://example.test/' });
  const adapter = createChromeAdapter(fake.chromeApi);
  await assert.rejects(adapter.waitForStable(17, { timeoutMs: 5 }), error => error?.name === 'TimeoutError');
  assert.equal(fake.updated.removed, true);
  assert.equal(fake.removed.removed, true);
});

test('runs dynamic probes with viewport data captured inside the audited page', async () => {
  const fake = chromeFake();
  const scriptResults = [
    { scroll: { x: 0, y: 0 }, focus: '', styles: true, viewport: { deviceScaleFactor: 2 } },
    '', true, 0,
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    { testedWidthCssPx: 320, horizontalOverflow: false, exception: 'none' },
    { scalePercent: 200, lossOfContent: false },
    [{ selector: 'html > body > button:nth-of-type(2)', width: 44, height: 44, exception: 'none' }],
    { complete: true, preference: 'reduce', prefersReducedMotion: true, animatedCount: 0, reducedAnimatedCount: 0 },
    true, true, true, true,
  ];
  fake.chromeApi.scripting.executeScript = async () => [{ frameId: 0, result: scriptResults.shift() }];
  const adapter = createChromeAdapter(fake.chromeApi);
  const cdpCalls = [];
  const cdp = {
    async command(method, params) {
      cdpCalls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [101] };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
      return {};
    },
  };
  const result = await adapter.runDynamicProbes(17, cdp, {});
  assert.equal(result.focus.completed, true);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.targetSizes, [{ selector: 'html > body > button:nth-of-type(2)', frameId: 'main-frame', backendNodeId: 42, width: 44, height: 44, exception: 'none' }]);
  assert.deepEqual(cdpCalls.find(([method]) => method === 'DOM.querySelectorAll'), ['DOM.querySelectorAll', { nodeId: 100, selector: 'html > body > button:nth-of-type(2)' }]);
});

test('keeps selector and frame fallback when duplicate IDs prevent target backend identity proof', async () => {
  const fake = chromeFake();
  const scriptResults = [
    { scroll: { x: 0, y: 0 }, focus: '', styles: true, viewport: { deviceScaleFactor: 1 } },
    '', true, 0,
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    { testedWidthCssPx: 320, horizontalOverflow: false, exception: 'none' },
    { scalePercent: 200, lossOfContent: false },
    [{ selector: '#duplicate', width: 20, height: 20, exception: 'none' }],
    { complete: true, preference: 'reduce', prefersReducedMotion: true, animatedCount: 0, reducedAnimatedCount: 0 },
    true, true, true, true,
  ];
  fake.chromeApi.scripting.executeScript = async () => [{ frameId: 0, result: scriptResults.shift() }];
  const adapter = createChromeAdapter(fake.chromeApi);
  const cdpCalls = [];
  const cdp = {
    async command(method, params) {
      cdpCalls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
      if (method === 'DOM.querySelector') return { nodeId: 101 };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [101, 102] };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
      return {};
    },
  };
  const result = await adapter.runDynamicProbes(17, cdp, {});
  assert.deepEqual(result.targetSizes, [{ selector: '#duplicate', frameId: 'main-frame', width: 20, height: 20, exception: 'none' }]);
  assert.equal(cdpCalls.some(([method]) => method === 'DOM.describeNode'), false);
});
