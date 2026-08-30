import assert from 'node:assert/strict';
import test from 'node:test';

let runtimeModule = {};
try { runtimeModule = await import('../../src/background/persona-runtime.js'); } catch { /* RED */ }

const target = Object.freeze({
  tabId: 7,
  windowId: 3,
  documentId: 'document-main',
  urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
});
const LEASE = `lease-${'L'.repeat(22)}`;

function createRuntime(options = {}) {
  assert.equal(
    typeof runtimeModule.createPersonaInjectionRuntime,
    'function',
    'o runtime de injeção precisa existir',
  );
  const calls = [];
  const results = [...(options.results || [])];
  const chromeApi = {
    scripting: {
      async executeScript(details) {
        calls.push(['execute', details]);
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next ?? [{ frameId: 0, documentId: target.documentId, result: true }];
      },
      async insertCSS(details) {
        calls.push(['insertCSS', details]);
        if (options.insertError) throw options.insertError;
      },
      async removeCSS(details) {
        calls.push(['removeCSS', details]);
        if (options.removeError) throw options.removeError;
      },
    },
  };
  return {
    runtime: runtimeModule.createPersonaInjectionRuntime({ chromeApi }),
    calls,
    remaining: results,
  };
}

function injection(result, overrides = {}) {
  return [{ frameId: 0, documentId: target.documentId, result, ...overrides }];
}

test('install probes the exact document, injects classic files in order, adds local CSS and activates', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: false, mode: null }),
    injection(undefined),
    injection({ ok: true, mode: 'reader' }),
  ] });
  assert.deepEqual(await fixture.runtime.apply({ target, op: 'install', mode: 'reader', leaseId: LEASE }), {
    ok: true, documentId: target.documentId, frameId: 0, mode: 'reader',
  });
  assert.equal(fixture.calls.length, 4);
  const [probe, files, css, command] = fixture.calls;
  for (const [, details] of [probe, files, css, command]) {
    assert.deepEqual(details.target, { tabId: 7, documentIds: ['document-main'] });
    assert.equal(Object.hasOwn(details.target, 'frameIds'), false);
  }
  assert.deepEqual(files[1].files, [
    'src/core/accessibility/accessible-preview-runtime.classic.js',
    'src/personas/screen-reader-module.js',
    'src/personas/content.js',
  ]);
  assert.deepEqual(css[1].files, ['src/personas/personas.css']);
  assert.equal(css[1].origin, 'AUTHOR');
  assert.deepEqual(command[1].args, [{ version: 1, op: 'install', mode: 'reader', leaseId: LEASE }]);
});

test('an already-present runtime is reused without reinjecting files', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, mode: 'motor' }),
  ] });
  assert.equal((await fixture.runtime.apply({ target, op: 'install', mode: 'motor', leaseId: LEASE })).mode, 'motor');
  assert.deepEqual(fixture.calls.map(call => call[0]), ['execute', 'insertCSS', 'execute']);
});

test('inspect treats a missing namespace as inactive and never installs files or CSS', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: false, mode: null }),
  ] });
  assert.deepEqual(await fixture.runtime.apply({ target, op: 'inspect' }), {
    ok: true, documentId: target.documentId, frameId: 0, mode: null,
  });
  assert.deepEqual(fixture.calls.map(call => call[0]), ['execute']);
});

test('clear removes the exact CSS and confirms inactive state with a second inspect', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, mode: null }),
    injection({ ok: true, mode: null }),
  ] });
  assert.deepEqual(await fixture.runtime.apply({ target, op: 'clear' }), {
    ok: true, documentId: target.documentId, frameId: 0, mode: null,
  });
  assert.deepEqual(fixture.calls.map(call => call[0]), ['execute', 'execute', 'removeCSS', 'execute']);
  assert.deepEqual(fixture.calls[3][1].args, [{ version: 1, op: 'inspect' }]);
  assert.deepEqual(fixture.calls[2][1], {
    target: { tabId: 7, documentIds: ['document-main'] },
    files: ['src/personas/personas.css'],
    origin: 'AUTHOR',
  });
});

test('clear also removes orphan CSS when the namespace is already absent', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: false, mode: null }),
    injection({ ok: true, present: false, mode: null }),
  ] });
  assert.deepEqual(await fixture.runtime.apply({ target, op: 'clear' }), {
    ok: true, documentId: target.documentId, frameId: 0, mode: null,
  });
  assert.deepEqual(fixture.calls.map(call => call[0]), ['execute', 'removeCSS', 'execute']);
});

test('clear fails closed if a runtime becomes active between the first probe and CSS removal', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: false, mode: null }),
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, mode: 'reader' }),
  ] });
  assert.deepEqual(await fixture.runtime.apply({ target, op: 'clear' }), {
    ok: false, reason: 'cleanup-unconfirmed',
  });
  assert.deepEqual(fixture.calls.map(call => call[0]), ['execute', 'removeCSS', 'execute', 'execute']);
});

test('rejects multiple frames, wrong documents and malformed command results', async () => {
  const cases = [
    [[], 'result-mismatch'],
    [[
      { frameId: 0, documentId: target.documentId, result: { ok: true, present: false, mode: null } },
      { frameId: 2, documentId: 'child', result: { ok: true, present: false, mode: null } },
    ], 'result-mismatch'],
    [injection({ ok: true, present: false, mode: null }, { documentId: 'other' }), 'result-mismatch'],
    [injection({ ok: true, present: false, mode: null, extra: true }), 'result-mismatch'],
    [injection({ ok: true, present: false, mode: 'unknown' }), 'result-mismatch'],
  ];
  for (const [probe, reason] of cases) {
    const fixture = createRuntime({ results: [probe] });
    assert.deepEqual(await fixture.runtime.apply({ target, op: 'inspect' }), { ok: false, reason });
  }
});

test('maps a missing exact document separately from other Chrome/runtime failures', async () => {
  const missing = createRuntime({ results: [new Error('No document with id document-main')] });
  assert.deepEqual(await missing.runtime.apply({ target, op: 'inspect' }), {
    ok: false, reason: 'document-missing',
  });

  const runtimeFailure = createRuntime({ results: [new Error('internal scripting failure')] });
  assert.deepEqual(await runtimeFailure.runtime.apply({ target, op: 'inspect' }), {
    ok: false, reason: 'runtime-error',
  });
});

test('maps bridge-only diagnostics to the closed public runtime reasons', async () => {
  for (const op of ['inspect', 'install']) {
    const fixture = createRuntime({ results: [
      injection({ ok: true, present: true, mode: null }),
      injection({ ok: false, reason: 'runtime-brand-mismatch' }),
    ] });
    const input = op === 'install' ? { target, op, mode: 'reader', leaseId: LEASE } : { target, op };
    assert.deepEqual(await fixture.runtime.apply(input), { ok: false, reason: 'runtime-error' });
  }
});

test('a failed or unconfirmed clear stays fail-closed even after best-effort CSS removal', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: false, reason: 'cleanup-unconfirmed' }),
    injection({ ok: true, mode: 'reader' }),
  ] });
  assert.deepEqual(await fixture.runtime.apply({ target, op: 'clear' }), {
    ok: false, reason: 'cleanup-unconfirmed',
  });
  assert.equal(fixture.calls.some(call => call[0] === 'removeCSS'), true);
});

test('validates the closed apply schema without reading target accessors', async () => {
  const fixture = createRuntime();
  const invalid = [
    null,
    { target, op: 'inspect', mode: null },
    { target, op: 'install' },
    { target, op: 'install', mode: 'reader' },
    { target, op: 'install', mode: 'unknown' },
    { target, op: 'install', mode: 'reader', leaseId: 'short' },
    { target: { ...target, extra: true }, op: 'inspect' },
    { target: { ...target, tabId: 0 }, op: 'inspect' },
  ];
  for (const value of invalid) {
    await assert.rejects(() => fixture.runtime.apply(value), /PERSONA_RUNTIME_INPUT_INVALID/u);
  }

  let reads = 0;
  const hostileTarget = { ...target };
  Object.defineProperty(hostileTarget, 'tabId', {
    enumerable: true,
    get() { reads += 1; return 7; },
  });
  await assert.rejects(
    () => fixture.runtime.apply({ target: hostileTarget, op: 'inspect' }),
    /PERSONA_RUNTIME_INPUT_INVALID/u,
  );
  assert.equal(reads, 0);
});

test('reader state probes and commands only the exact leased document with a closed result', async () => {
  const state = {
    version: 1,
    playback: 'playing',
    index: 0,
    total: 2,
    caption: 'Início, título nível 1',
    canPrevious: false,
    canNext: true,
    speechAvailability: 'available',
    voiceId: 'local-a',
    rate: 1.25,
  };
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, kind: 'state', state }),
  ] });

  assert.deepEqual(await fixture.runtime.reader({
    target,
    command: { version: 1, op: 'state' },
  }), {
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'state',
    state,
  });
  assert.equal(fixture.calls.length, 2);
  for (const [, details] of fixture.calls) {
    assert.deepEqual(details.target, { tabId: 7, documentIds: ['document-main'] });
    assert.equal(Object.hasOwn(details.target, 'frameIds'), false);
    assert.equal(details.world, 'ISOLATED');
  }
  assert.deepEqual(fixture.calls[1][1].args, [{ version: 1, op: 'reader-state' }]);
});

test('reader actions and preferences use the dedicated bridge without invoking persona clear', async () => {
  const idle = {
    version: 1,
    playback: 'idle',
    index: -1,
    total: 0,
    caption: '',
    canPrevious: false,
    canNext: false,
    speechAvailability: 'available',
    voiceId: 'local-a',
    rate: 1.5,
  };
  for (const [command, expectedBridge, actionStatus] of [
    [
      { version: 1, op: 'action', action: 'stop' },
      { version: 1, op: 'reader-action', action: 'stop' },
      'accepted',
    ],
    [
      { version: 1, op: 'preferences', voiceId: 'local-a', rate: 1.5 },
      { version: 1, op: 'reader-preferences', voiceId: 'local-a', rate: 1.5 },
    ],
  ]) {
    const fixture = createRuntime({ results: [
      injection({ ok: true, present: true, mode: 'reader' }),
      injection({
        ok: true,
        kind: 'state',
        ...(actionStatus ? { actionStatus } : {}),
        state: idle,
      }),
    ] });
    const result = await fixture.runtime.reader({ target, command });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'state');
    assert.equal(result.actionStatus, actionStatus);
    assert.deepEqual(fixture.calls[1][1].args, [expectedBridge]);
    assert.equal(fixture.calls.some(call => call[0] === 'removeCSS'), false);
  }
});

test('reader runtime preserves only exact closed action dispositions', async () => {
  for (const actionStatus of ['rejected', 'terminal']) {
    const fixture = createRuntime({ results: [
      injection({ ok: true, present: true, mode: 'reader' }),
      injection({ ok: true, kind: 'state', actionStatus, state: {
        version: 1,
        playback: 'playing', index: 0, total: 1, caption: 'Único, botão',
        canPrevious: false, canNext: false, speechAvailability: 'error',
        voiceId: 'local-a', rate: 1,
      } }),
    ] });
    assert.equal((await fixture.runtime.reader({
      target,
      command: { version: 1, op: 'action', action: 'next' },
    })).actionStatus, actionStatus);
  }

  for (const malformed of [
    { ok: true, kind: 'state', state: {
      version: 1, playback: 'playing', index: 0, total: 1, caption: 'Único, botão',
      canPrevious: false, canNext: false, speechAvailability: 'available',
      voiceId: 'local-a', rate: 1,
    } },
    { ok: true, kind: 'state', actionStatus: 'unknown', state: {
      version: 1, playback: 'playing', index: 0, total: 1, caption: 'Único, botão',
      canPrevious: false, canNext: false, speechAvailability: 'available',
      voiceId: 'local-a', rate: 1,
    } },
  ]) {
    const fixture = createRuntime({ results: [
      injection({ ok: true, present: true, mode: 'reader' }),
      injection(malformed),
    ] });
    assert.deepEqual(await fixture.runtime.reader({
      target,
      command: { version: 1, op: 'action', action: 'next' },
    }), { ok: false, reason: 'result-mismatch' });
  }
});

test('reader voice inventory requires an explicit gesture and returns only minimal local metadata', async () => {
  const noGesture = createRuntime();
  assert.deepEqual(await noGesture.runtime.reader({
    target,
    command: { version: 1, op: 'voices', explicitUserGesture: false },
  }), { ok: false, reason: 'gesture-required' });
  assert.deepEqual(noGesture.calls, []);

  const voices = [
    { id: 'local-a', label: 'Voz local A', lang: 'pt-BR' },
    { id: 'local-b', label: 'Voz local B', lang: '' },
  ];
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, kind: 'voices', status: 'available', voices }),
  ] });
  assert.deepEqual(await fixture.runtime.reader({
    target,
    command: { version: 1, op: 'voices', explicitUserGesture: true },
  }), {
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'voices',
    status: 'available',
    voices,
  });
  assert.deepEqual(fixture.calls[1][1].args, [
    { version: 1, op: 'reader-voices', explicitUserGesture: true },
  ]);

  const unavailable = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, kind: 'voices', status: 'unavailable', voices: [] }),
  ] });
  assert.deepEqual(await unavailable.runtime.reader({
    target,
    command: { version: 1, op: 'voices', explicitUserGesture: true },
  }), {
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'voices',
    status: 'unavailable',
    voices: [],
  });

  const failed = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: false, reason: 'runtime-error' }),
  ] });
  assert.deepEqual(await failed.runtime.reader({
    target,
    command: { version: 1, op: 'voices', explicitUserGesture: true },
  }), { ok: false, reason: 'runtime-error' });
});

test('reader commands fail closed for inactive, malformed, cross-document and accessor inputs', async () => {
  for (const probe of [
    { ok: true, present: false, mode: null },
    { ok: true, present: true, mode: 'motor' },
  ]) {
    const fixture = createRuntime({ results: [injection(probe)] });
    assert.deepEqual(await fixture.runtime.reader({
      target,
      command: { version: 1, op: 'state' },
    }), { ok: false, reason: 'reader-inactive' });
    assert.equal(fixture.calls.length, 1);
  }

  const malformed = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, kind: 'state', state: { playback: 'playing' }, extra: true }),
  ] });
  assert.deepEqual(await malformed.runtime.reader({
    target,
    command: { version: 1, op: 'state' },
  }), { ok: false, reason: 'result-mismatch' });

  const crossDocument = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, kind: 'state', state: {} }, { documentId: 'other-document' }),
  ] });
  assert.deepEqual(await crossDocument.runtime.reader({
    target,
    command: { version: 1, op: 'state' },
  }), { ok: false, reason: 'result-mismatch' });

  const invalid = createRuntime();
  for (const command of [
    { version: 1, op: 'voices' },
    { version: 1, op: 'action', action: 'clear' },
    { version: 1, op: 'preferences', voiceId: 'local-a', rate: 2.1 },
    { version: 1, op: 'state', extra: true },
  ]) {
    await assert.rejects(
      () => invalid.runtime.reader({ target, command }),
      /PERSONA_RUNTIME_INPUT_INVALID/u,
    );
  }

  let reads = 0;
  const hostileCommand = { version: 1, op: 'state' };
  Object.defineProperty(hostileCommand, 'op', {
    enumerable: true,
    get() { reads += 1; return 'state'; },
  });
  await assert.rejects(
    () => invalid.runtime.reader({ target, command: hostileCommand }),
    /PERSONA_RUNTIME_INPUT_INVALID/u,
  );
  assert.equal(reads, 0);
});
