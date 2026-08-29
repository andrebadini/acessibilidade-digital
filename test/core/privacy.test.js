import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeWarning, sanitizeWarnings } from '../../src/core/privacy.js';

const FALLBACK_WARNING = {
  code: 'PROBE_FAILED',
  message: 'Uma medição dinâmica não pôde ser concluída.',
};

test('sanitizes warning leaves through own data descriptors without invoking accessors', () => {
  for (const field of ['code', 'frameId', 'message']) {
    const marker = `PRIVATE_WARNING_${field.toUpperCase()}_MESSAGE`;
    let getterReads = 0;
    const warning = { code: 'TIMEOUT', frameId: 'main', message: 'ignored' };
    Object.defineProperty(warning, field, {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });

    let sanitized;
    assert.doesNotThrow(() => { sanitized = sanitizeWarning(warning); }, field);
    assert.equal(getterReads, 0, field);
    assert.deepEqual(sanitized, FALLBACK_WARNING, field);
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker), field);
  }
});

test('rejects inherited, revoked, trapped, partial and ambiguous warning records', () => {
  const inherited = Object.create({ code: 'TIMEOUT', frameId: 'main' });
  const revoked = Proxy.revocable({ code: 'TIMEOUT', frameId: 'main' }, {});
  revoked.revoke();
  const marker = 'PRIVATE_WARNING_TRAP_MESSAGE';
  const trapped = new Proxy({ code: 'TIMEOUT' }, {
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });

  for (const warning of [
    inherited,
    revoked.proxy,
    trapped,
    {},
    { frameId: 'main' },
    { code: 'TIMEOUT', unexpected: 'ambiguous' },
  ]) {
    let sanitized;
    assert.doesNotThrow(() => { sanitized = sanitizeWarning(warning); });
    assert.deepEqual(sanitized, FALLBACK_WARNING);
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
  }
});

test('contains hostile warning leaves when sanitizing a collection', () => {
  const marker = 'PRIVATE_WARNING_COLLECTION_MESSAGE';
  let getterReads = 0;
  const warning = {};
  Object.defineProperty(warning, 'code', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  const revoked = Proxy.revocable({ code: 'TIMEOUT' }, {});
  revoked.revoke();

  const sanitized = sanitizeWarnings([warning, revoked.proxy]);

  assert.equal(getterReads, 0);
  assert.deepEqual(sanitized, [FALLBACK_WARNING, FALLBACK_WARNING]);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
});

test('preserves supported warning codes and bounded frame identifiers', () => {
  assert.deepEqual(sanitizeWarning({ code: ' timeout ', frameId: 'main' }), {
    code: 'TIMEOUT',
    message: 'Uma medição excedeu o tempo limite.',
    frameId: 'main',
  });
  assert.deepEqual(sanitizeWarning({ code: 'ABORTED', frameId: 7 }), {
    code: 'ABORTED',
    message: 'A medição foi cancelada.',
    frameId: 7,
  });
});

test('bounds warning leaf strings and never coerces hostile values', () => {
  const marker = 'PRIVATE_WARNING_COERCION_MESSAGE';
  let coercions = 0;
  const hostileValue = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(marker);
    },
  };

  for (const warning of [
    { code: hostileValue },
    { code: 'x'.repeat(129) },
    { code: 'TIMEOUT', message: 'x'.repeat(1_025) },
    { code: 'TIMEOUT', frameId: hostileValue },
  ]) {
    const sanitized = sanitizeWarning(warning);
    assert.deepEqual(sanitized, FALLBACK_WARNING);
    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(marker));
  }
  assert.equal(coercions, 0);
});
