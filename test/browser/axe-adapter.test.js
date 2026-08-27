import assert from 'node:assert/strict';
import test from 'node:test';

let adapter;
try {
  adapter = await import('../../src/browser/axe-adapter.js');
} catch {
  adapter = null;
}

test('injects pinned axe locally in every isolated frame before running its packaged function', async () => {
  assert.ok(adapter, 'axe adapter module must exist');
  const calls = [];
  const executeScript = async options => {
    calls.push(options);
    if (options.files) return [{ frameId: 0 }, { frameId: 7 }];
    return [
      { frameId: 0, result: { ok: true, version: '4.13.0', results: { violations: [], incomplete: [], passes: [], inapplicable: [] } } },
      { frameId: 7, result: { ok: true, version: '4.13.0', results: { violations: [], incomplete: [], passes: [], inapplicable: [] } } },
    ];
  };

  const result = await adapter.probeAxeInTab(42, { executeScript, timeoutMs: 100 });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    target: { tabId: 42, allFrames: true },
    world: 'ISOLATED',
    files: ['vendor/axe/axe.min.js'],
  });
  assert.deepEqual(calls[1].target, { tabId: 42, allFrames: true });
  assert.equal(calls[1].world, 'ISOLATED');
  assert.equal(calls[1].func, adapter.runAxeInFrame);
  assert.deepEqual(calls[1].args, [adapter.AXE_RUN_CONFIG]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.frames.map(frame => [frame.frameId, frame.status]), [[0, 'success'], [7, 'success']]);
  assert.deepEqual(result.provenance, adapter.AXE_PROVENANCE);
  assert.equal(result.provenance.version, '4.13.0');
  assert.doesNotMatch(JSON.stringify(calls), /https?:|unsafe-eval/iu);
});

test('uses a bounded explicit ruleset without legacy Section 508 or experimental tags', () => {
  assert.deepEqual(adapter.AXE_RUN_CONFIG.runOnly, {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
  });
  assert.deepEqual(adapter.AXE_RUN_CONFIG.rules, { 'target-size': { enabled: false } });
  assert.deepEqual(adapter.AXE_RUN_CONFIG.resultTypes, ['violations', 'incomplete', 'passes', 'inapplicable']);
  assert.doesNotMatch(JSON.stringify(adapter.AXE_RUN_CONFIG), /experimental|section508/iu);
});

test('keeps the production feature gate off without a successful real MV3 CSP run', async () => {
  assert.deepEqual(adapter.AXE_MV3_CSP_GATE, {
    enabled: false,
    targetSizeEnabled: false,
    code: 'AXE_MV3_CSP_E2E_UNAVAILABLE',
    testedBrowser: 'Chrome for Testing 151.0.7922.138',
  });
  let executions = 0;
  const result = await adapter.runAxeInTab(42, { executeScript: async () => { executions += 1; } });
  assert.equal(executions, 0);
  assert.deepEqual(result, {
    status: 'disabled',
    provenance: adapter.AXE_PROVENANCE,
    frames: [],
    diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }],
  });
});

test('returns a stable partial diagnostic when an injection exceeds its timeout', { timeout: 200 }, async () => {
  const result = await adapter.probeAxeInTab(9, {
    executeScript: async () => new Promise(() => {}),
    timeoutMs: 10,
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.frames, []);
  assert.deepEqual(result.diagnostics, [{ code: 'AXE_TIMEOUT', frameId: null }]);
  assert.deepEqual(result.provenance, adapter.AXE_PROVENANCE);
});

test('normalizes success, missing, failed and version-mismatched frames as partial coverage', async () => {
  let phase = 0;
  const executeScript = async () => {
    phase += 1;
    if (phase === 1) return [{ frameId: 0 }, { frameId: 2 }, { frameId: 3 }, { frameId: 4 }];
    return [
      { frameId: 0, result: { ok: true, version: '4.13.0', results: { violations: [], incomplete: [], passes: [], inapplicable: [] } } },
      { frameId: 2, result: { ok: false, code: 'AXE_RUN_FAILED' } },
      { frameId: 3, result: { ok: true, version: '4.12.0', results: { violations: [], incomplete: [], passes: [], inapplicable: [] } } },
    ];
  };

  const result = await adapter.probeAxeInTab(10, { executeScript, timeoutMs: 100 });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.frames.map(frame => [frame.frameId, frame.status]), [
    [0, 'success'], [2, 'failed'], [3, 'failed'], [4, 'missing'],
  ]);
  assert.deepEqual(result.diagnostics, [
    { code: 'AXE_FRAME_RUN_FAILED', frameId: 2 },
    { code: 'AXE_VERSION_MISMATCH', frameId: 3 },
    { code: 'AXE_FRAME_MISSING', frameId: 4 },
  ]);
});

test('bounds raw groups and nodes while stripping audited HTML, URLs, unknown data and secrets', async () => {
  const hostileNode = {
    impact: 'serious',
    html: '<input value="password=TOPSECRET">',
    target: ['#safe', 'input[data-token="token=TOPSECRET"]'],
    failureSummary: 'Fix password=TOPSECRET before continuing',
    any: [{ id: 'label', impact: 'serious', message: 'token=TOPSECRET', data: { password: 'TOPSECRET' } }],
    all: [],
    none: [],
    unknown: 'TOPSECRET',
  };
  const rules = Array.from({ length: 120 }, (_, index) => ({
    id: `rule-${index}`,
    impact: 'serious',
    tags: ['wcag2a'],
    description: 'password=TOPSECRET',
    help: 'token=TOPSECRET',
    helpUrl: 'https://remote.invalid/TOPSECRET',
    nodes: Array.from({ length: 120 }, () => hostileNode),
  }));
  let phase = 0;
  const executeScript = async () => {
    phase += 1;
    if (phase === 1) return [{ frameId: 0 }];
    return [{ frameId: 0, result: { ok: true, version: '4.13.0', results: {
      violations: rules,
      incomplete: [], passes: [], inapplicable: [],
      url: 'https://private.invalid/?token=TOPSECRET',
      arbitrarySecret: 'TOPSECRET',
    } } }];
  };

  const result = await adapter.probeAxeInTab(11, { executeScript, timeoutMs: 100 });
  const raw = result.frames[0].result;

  assert.equal(raw.violations.length, 100);
  assert.equal(raw.violations[0].nodes.length, 100);
  assert.deepEqual(Object.keys(raw).sort(), ['inapplicable', 'incomplete', 'passes', 'violations']);
  assert.deepEqual(Object.keys(raw.violations[0]).sort(), ['description', 'help', 'id', 'impact', 'nodes', 'tags']);
  assert.deepEqual(Object.keys(raw.violations[0].nodes[0]).sort(), ['all', 'any', 'failureSummary', 'impact', 'none', 'target']);
  assert.deepEqual(Object.keys(raw.violations[0].nodes[0].any[0]).sort(), ['id', 'impact', 'message']);
  assert.doesNotMatch(JSON.stringify(raw), /TOPSECRET|private\.invalid|remote\.invalid|<input|"data"/iu);
  assert.match(JSON.stringify(raw), /\[redacted\]/u);
});
