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
  assert.deepEqual(await fixture.runtime.apply({ target, op: 'install', mode: 'reader' }), {
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
  assert.deepEqual(command[1].args, [{ version: 1, op: 'install', mode: 'reader' }]);
});

test('an already-present runtime is reused without reinjecting files', async () => {
  const fixture = createRuntime({ results: [
    injection({ ok: true, present: true, mode: 'reader' }),
    injection({ ok: true, mode: 'motor' }),
  ] });
  assert.equal((await fixture.runtime.apply({ target, op: 'install', mode: 'motor' })).mode, 'motor');
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
    const input = op === 'install' ? { target, op, mode: 'reader' } : { target, op };
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
    { target, op: 'install', mode: 'unknown' },
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
