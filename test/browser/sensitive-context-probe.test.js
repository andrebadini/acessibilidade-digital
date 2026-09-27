import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SENSITIVE_CATEGORY_LABELS_V1,
  detectSensitiveCaptureSignalsV1,
  probeSensitiveContextInTab,
} from '../../src/browser/sensitive-context-probe.js';

function probeResult({ password = false, otp = false, payment = false, privateMarker = false } = {}) {
  return { password, otp, payment, privateMarker };
}

function injection(frameId, documentId, result) {
  return { frameId, documentId, result };
}

function fakeElement({ tagName = 'div', attributes = {}, shadowRoot = null, reads = null } = {}) {
  const lower = Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    tagName,
    shadowRoot,
    getAttribute(name) { return Object.hasOwn(lower, name.toLowerCase()) ? lower[name.toLowerCase()] : null; },
    hasAttribute(name) { return Object.hasOwn(lower, name.toLowerCase()); },
    get value() { reads.value += 1; throw new Error('VALUE_MUST_NOT_BE_READ'); },
    get textContent() { reads.text += 1; throw new Error('TEXT_MUST_NOT_BE_READ'); },
    get innerText() { reads.text += 1; throw new Error('TEXT_MUST_NOT_BE_READ'); },
    get innerHTML() { reads.html += 1; throw new Error('HTML_MUST_NOT_BE_READ'); },
  };
}

function fakeRoot(nodes) {
  return { querySelectorAll(selector) { assert.equal(selector, '*'); return nodes; } };
}

async function withDocument(documentValue, operation) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentValue });
  try { return await operation(); } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  }
}

test('detects only the four closed categories in canonical order', () => {
  assert.deepEqual(SENSITIVE_CATEGORY_LABELS_V1, {
    password: 'Campo de senha', otp: 'Código de uso único', payment: 'Dados de pagamento',
    'private-marker': 'Conteúdo marcado como privado',
  });
  const signals = detectSensitiveCaptureSignalsV1(probeResult({ password: true, otp: true, payment: true, privateMarker: true }));
  assert.deepEqual(signals, {
    version: 'SensitiveCaptureSignalsV1', detected: true,
    categories: ['password', 'otp', 'payment', 'private-marker'],
  });
  assert.equal(Object.isFrozen(signals), true);
  assert.equal(Object.isFrozen(signals.categories), true);
  assert.throws(() => detectSensitiveCaptureSignalsV1({ ...probeResult(), extra: true }), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
});

test('scans only structural attributes including nested open shadow roots', async () => {
  const reads = { value: 0, text: 0, html: 0 };
  const shadow = fakeRoot([
    fakeElement({ tagName: 'input', attributes: { autocomplete: '  CURRENT-password\tone-time-code cc-number cc-csc cc-exp cc-exp-month cc-exp-year cc-name cc-type ' }, reads }),
    fakeElement({ attributes: { 'data-audita-private': 'do-not-read' }, reads }),
    fakeElement({ shadowRoot: fakeRoot([fakeElement({ tagName: 'input', attributes: { type: 'PASSWORD' }, reads })]), reads }),
  ]);
  await withDocument(fakeRoot([fakeElement({ shadowRoot: shadow, reads })]), async () => {
    const signals = await probeSensitiveContextInTab(7, {
      executeScript: async options => [injection(0, 'doc-root', options.func())],
      documentIds: ['doc-root'],
    });
    assert.deepEqual(signals.categories, ['password', 'otp', 'payment', 'private-marker']);
  });
  assert.deepEqual(reads, { value: 0, text: 0, html: 0 });
});

test('unions sensitive frame results and uses an exact isolated document target', async () => {
  const calls = [];
  const signals = await probeSensitiveContextInTab(7, {
    executeScript: async options => {
      calls.push(options);
      return [
        injection(0, 'doc-top', probeResult({ otp: true })),
        injection(9, 'doc-child', probeResult({ password: true, privateMarker: true })),
      ];
    }, documentIds: ['doc-top', 'doc-child'],
  });
  assert.deepEqual(calls[0].target, { tabId: 7, documentIds: ['doc-top', 'doc-child'] });
  assert.equal(calls[0].world, 'ISOLATED');
  assert.equal(calls[0].injectImmediately, true);
  assert.equal(typeof calls[0].func, 'function');
  assert.deepEqual(signals.categories, ['password', 'otp', 'private-marker']);
});

test('requires an explicit complete document inventory instead of allFrames', async () => {
  let calls = 0;
  await assert.rejects(probeSensitiveContextInTab(7, {
    executeScript: async () => { calls += 1; return [injection(0, 'doc-top', probeResult())]; },
  }), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
  assert.equal(calls, 0);
});

test('uses exactly requested documentIds and requires a bijective result including frame zero', async () => {
  const calls = [];
  const signals = await probeSensitiveContextInTab(7, {
    executeScript: async options => {
      calls.push(options);
      return [injection(0, 'doc-top', probeResult()), injection(4, 'doc-child', probeResult({ payment: true }))];
    },
    documentIds: ['doc-top', 'doc-child'],
  });
  assert.deepEqual(calls[0].target, { tabId: 7, documentIds: ['doc-top', 'doc-child'] });
  assert.deepEqual(signals.categories, ['payment']);

  for (const output of [
    [injection(4, 'doc-child', probeResult())],
    [injection(0, 'doc-top', probeResult()), injection(4, 'doc-other', probeResult())],
    [injection(0, 'doc-top', probeResult()), injection(4, 'doc-top', probeResult())],
    [injection(0, 'doc-top', { ...probeResult(), error: true })],
  ]) {
    await assert.rejects(probeSensitiveContextInTab(7, {
      executeScript: async () => output, documentIds: ['doc-top', 'doc-child'],
    }), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
  }
});

test('fails closed for execute errors and hostile input or injection records without invoking accessors', async () => {
  let getterCalls = 0;
  const hostileOptions = { executeScript: async () => [] };
  Object.defineProperty(hostileOptions, 'documentIds', {
    enumerable: true, get() { getterCalls += 1; throw new Error('GETTER'); },
  });
  await assert.rejects(probeSensitiveContextInTab(7, hostileOptions), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
  assert.equal(getterCalls, 0);

  const hostileResult = { frameId: 0, documentId: 'doc-top' };
  Object.defineProperty(hostileResult, 'result', {
    enumerable: true, get() { getterCalls += 1; throw new Error('GETTER'); },
  });
  await assert.rejects(probeSensitiveContextInTab(7, {
    executeScript: async () => [hostileResult],
    documentIds: ['doc-top'],
  }), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
  await assert.rejects(probeSensitiveContextInTab(7, {
    executeScript: async () => { throw new Error('frame access denied secret=never'); },
    documentIds: ['doc-top'],
  }), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
  await assert.rejects(probeSensitiveContextInTab(7, {
    executeScript: async () => { const sparse = []; sparse[1] = injection(0, 'doc-top', probeResult()); return sparse; },
    documentIds: ['doc-top'],
  }), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
  const { proxy, revoke } = Proxy.revocable({ executeScript: async () => [] }, {});
  revoke();
  await assert.rejects(probeSensitiveContextInTab(7, proxy), /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u);
  assert.equal(getterCalls, 0);
});

test('aggregates the descriptor-captured probe result without reading a hostile proxy again', async () => {
  let getCalls = 0;
  const result = new Proxy(probeResult({ password: true }), {
    get() { getCalls += 1; throw new Error('RAW_RESULT_GET'); },
  });
  const signals = await probeSensitiveContextInTab(7, {
    executeScript: async () => [injection(0, 'doc-top', result)],
    documentIds: ['doc-top'],
  });
  assert.deepEqual(signals.categories, ['password']);
  assert.equal(getCalls, 0);
});

test('keeps frozen target documentIds separate from the immutable expected inventory', async () => {
  const documentIds = ['doc-top'];
  const signals = await probeSensitiveContextInTab(7, {
    documentIds,
    executeScript: async options => {
      assert.equal(Object.isFrozen(options.target.documentIds), true);
      assert.notEqual(options.target.documentIds, documentIds);
      try { options.target.documentIds[0] = 'doc-forged'; } catch { /* frozen by contract */ }
      documentIds[0] = 'doc-mutated-after-call';
      return [injection(0, 'doc-top', probeResult({ otp: true }))];
    },
  });
  assert.deepEqual(signals.categories, ['otp']);
});

test('reads type only from INPUT elements after the injected probe is serialized', async () => {
  const reads = { divType: 0, inputType: 0 };
  const div = {
    tagName: 'DIV', shadowRoot: null,
    getAttribute(name) {
      if (name === 'type') reads.divType += 1;
      return name === 'type' ? 'password' : null;
    },
    hasAttribute() { return false; },
  };
  const input = {
    tagName: 'INPUT', shadowRoot: null,
    getAttribute(name) {
      if (name === 'type') reads.inputType += 1;
      return name === 'type' ? 'password' : null;
    },
    hasAttribute() { return false; },
  };
  await withDocument(fakeRoot([div, input]), async () => {
    const signals = await probeSensitiveContextInTab(7, {
      documentIds: ['doc-top'],
      executeScript: async options => {
        const serialized = Function(`return (${options.func.toString()});`)();
        return [injection(0, 'doc-top', serialized())];
      },
    });
    assert.deepEqual(signals.categories, ['password']);
  });
  assert.deepEqual(reads, { divType: 0, inputType: 1 });
});
