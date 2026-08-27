import assert from 'node:assert/strict';
import test from 'node:test';

let decideAxeE2eExecution;
try {
  ({ decideAxeE2eExecution } = await import('../../scripts/axe-e2e-decision.mjs'));
} catch {
  decideAxeE2eExecution = null;
}

test('skips without CHROME_BIN only while both axe production gates are false', () => {
  assert.ok(decideAxeE2eExecution, 'E2E decision helper must exist');
  assert.deepEqual(decideAxeE2eExecution({
    gate: { enabled: false, targetSizeEnabled: false, code: 'AXE_MV3_CSP_E2E_UNAVAILABLE' },
    chromeBinary: '',
  }), { action: 'skip', code: 'AXE_MV3_CSP_E2E_UNAVAILABLE' });
});

test('fails closed for inconsistent gates or an enabled gate without a browser', () => {
  for (const gate of [
    { enabled: true, targetSizeEnabled: false },
    { enabled: false, targetSizeEnabled: true },
  ]) {
    assert.deepEqual(decideAxeE2eExecution({ gate, chromeBinary: '' }), {
      action: 'fail', code: 'AXE_MV3_CSP_GATE_INCONSISTENT',
    });
  }
  assert.deepEqual(decideAxeE2eExecution({
    gate: { enabled: true, targetSizeEnabled: true }, chromeBinary: '',
  }), { action: 'fail', code: 'AXE_MV3_CSP_BROWSER_REQUIRED' });
});

test('fails closed for every non-boolean gate value instead of coercing it', () => {
  for (const gate of [
    { enabled: 1, targetSizeEnabled: 1 },
    { enabled: 0, targetSizeEnabled: 0 },
    { enabled: 'true', targetSizeEnabled: 'true' },
    { enabled: null, targetSizeEnabled: null },
    { enabled: undefined, targetSizeEnabled: undefined },
    { enabled: true, targetSizeEnabled: 1 },
    { enabled: false, targetSizeEnabled: 0 },
  ]) {
    assert.deepEqual(decideAxeE2eExecution({ gate, chromeBinary: '/opt/chromium' }), {
      action: 'fail', code: 'AXE_MV3_CSP_GATE_INVALID',
    });
  }
});

test('requires the real harness whenever both production gates are enabled', () => {
  assert.deepEqual(decideAxeE2eExecution({
    gate: { enabled: true, targetSizeEnabled: true }, chromeBinary: '/opt/chromium',
  }), { action: 'run', code: 'AXE_MV3_CSP_E2E_REQUIRED' });
});
