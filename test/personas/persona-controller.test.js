import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersonaController } from '../../src/background/persona-controller.js';

const EXPECTED_METHODS = [
  'start', 'rehydrate', 'setMode', 'stop',
  'invalidateTab', 'invalidateWindow', 'recover', 'expireDue',
];

function dependencies(overrides = {}) {
  const calls = [];
  const personaStart = {
    async start(value) { calls.push(['start', value]); return { ok: true, source: 'start' }; },
    async rehydrate(value) { calls.push(['rehydrate', value]); return { ok: true, source: 'rehydrate' }; },
  };
  const personaCoordinator = {
    async setMode(value) { calls.push(['setMode', value]); return { ok: true, source: 'setMode' }; },
    async stop(value) { calls.push(['stop', value]); return { ok: true, source: 'stop' }; },
    async invalidateTab(...value) { calls.push(['invalidateTab', ...value]); return { ok: true, source: 'invalidateTab' }; },
    async invalidateWindow(...value) { calls.push(['invalidateWindow', ...value]); return { ok: true, source: 'invalidateWindow' }; },
    async recover(...value) { calls.push(['recover', ...value]); return { ok: true, source: 'recover' }; },
    async expireDue(...value) { calls.push(['expireDue', ...value]); return { ok: true, source: 'expireDue' }; },
  };
  return {
    calls,
    value: {
      personaStart: Object.assign(personaStart, overrides.personaStart),
      personaCoordinator: Object.assign(personaCoordinator, overrides.personaCoordinator),
    },
  };
}

test('is a frozen Side Panel facade with no legacy popup port or binding surface', () => {
  const fixture = dependencies();
  const controller = createPersonaController(fixture.value);

  assert.equal(Object.isFrozen(controller), true);
  assert.deepEqual(Object.keys(controller), EXPECTED_METHODS);
  for (const removed of [
    'openPanel', 'attachPanelPort', 'issueBindingLease', 'consumeBindingLease',
    'getBinding', 'getOwnerPanel', 'handleTabUpdated', 'handleTabRemoved',
  ]) assert.equal(Object.hasOwn(controller, removed), false);

  const source = createPersonaController.toString();
  for (const forbidden of ['addListener', 'onConnect', 'storage', 'setTimeout', 'bindings', 'owners']) {
    assert.equal(source.includes(forbidden), false, `facade must not contain ${forbidden}`);
  }
});

test('delegates every public operation exactly once to the single persona owner', async () => {
  const fixture = dependencies();
  const controller = createPersonaController(fixture.value);
  const marker = Object.freeze({ marker: true });

  for (const method of ['start', 'rehydrate', 'setMode', 'stop']) {
    assert.deepEqual(await controller[method](marker), { ok: true, source: method });
  }
  assert.deepEqual(await controller.invalidateTab(17, 'navigation'), { ok: true, source: 'invalidateTab' });
  assert.deepEqual(await controller.invalidateWindow(9, 'window-removed'), { ok: true, source: 'invalidateWindow' });
  assert.deepEqual(await controller.recover(), { ok: true, source: 'recover' });
  assert.deepEqual(await controller.expireDue(), { ok: true, source: 'expireDue' });
  assert.deepEqual(fixture.calls, [
    ['start', marker],
    ['rehydrate', marker],
    ['setMode', marker],
    ['stop', marker],
    ['invalidateTab', 17, 'navigation'],
    ['invalidateWindow', 9, 'window-removed'],
    ['recover'],
    ['expireDue'],
  ]);
});

test('fails closed when either delegated boundary is incomplete and rejects the legacy constructor', () => {
  const required = {
    personaStart: ['start', 'rehydrate'],
    personaCoordinator: ['setMode', 'stop', 'invalidateTab', 'invalidateWindow', 'recover', 'expireDue'],
  };
  for (const [dependency, methods] of Object.entries(required)) {
    for (const method of methods) {
      const fixture = dependencies();
      fixture.value[dependency][method] = null;
      assert.throws(() => createPersonaController(fixture.value), /PERSONA_CONTROLLER_INVALID/u);
    }
  }
  assert.throws(() => createPersonaController(null), /PERSONA_CONTROLLER_INVALID/u);
  assert.throws(() => createPersonaController({}), /PERSONA_CONTROLLER_INVALID/u);
  assert.throws(
    () => createPersonaController({ runtime: { getURL() {} }, tabs: {}, storage: {} }, {}),
    /PERSONA_CONTROLLER_INVALID/u,
  );
});
