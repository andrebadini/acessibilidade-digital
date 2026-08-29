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
  assert.deepEqual(calls[1].args, [adapter.AXE_RUN_CONFIG, adapter.AXE_FRAME_PROJECTION_POLICY]);
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
  assert.deepEqual(adapter.AXE_RUN_CONFIG.rules, { 'target-size': { enabled: true } });
  assert.deepEqual(adapter.AXE_RUN_CONFIG.resultTypes, ['violations', 'incomplete', 'passes', 'inapplicable']);
  assert.equal(adapter.AXE_RUN_CONFIG.preload, false);
  assert.equal(adapter.AXE_RUN_CONFIG.iframes, false);
  assert.doesNotMatch(JSON.stringify(adapter.AXE_RUN_CONFIG), /experimental|section508/iu);
});

test('projects and sanitizes axe results inside runAxeInFrame before they cross the isolated-world boundary', async t => {
  const originalAxe = globalThis.axe;
  const originalDocument = globalThis.document;
  t.after(() => {
    if (originalAxe === undefined) delete globalThis.axe;
    else globalThis.axe = originalAxe;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  const html = { localName: 'html', parentElement: null, children: [] };
  const body = { localName: 'body', parentElement: html, children: [] };
  const main = { localName: 'main', parentElement: body, children: [] };
  const first = { localName: 'button', parentElement: main, children: [] };
  const second = { localName: 'button', parentElement: main, children: [] };
  html.children = [body];
  body.children = [main];
  main.children = [first, second];
  const structural = 'html > body > main > button:nth-of-type(2)';
  globalThis.document = {
    documentElement: html,
    querySelectorAll(selector) {
      if (selector === '#private-customer-42' || selector === structural) return [second];
      if (selector === '.ambiguous-customer') return [first, second];
      return [];
    },
  };
  globalThis.axe = {
    version: '4.13.0',
    async run() {
      return {
        violations: [{
          id: 'target-size', impact: 'serious', tags: ['wcag258', 'PRIVATE-TAG'],
          helpUrl: 'https://private.invalid/TOPSECRET',
          nodes: [
            { impact: 'serious', target: ['#private-customer-42'], html: '<button>Cliente Alfa</button>', failureSummary: 'TOPSECRET', any: [{ id: 'PRIVATE-CHECK', message: 'TOPSECRET' }] },
            { impact: 'serious', target: ['.ambiguous-customer'], html: '<button>Cliente Beta</button>' },
            { impact: 'serious', target: [['#shadow-private']], html: '<button>Cliente Gama</button>' },
          ],
        }, {
          id: 'private-rule-not-in-catalog', impact: 'critical',
          nodes: [{ impact: 'critical', target: ['#private-customer-42'], html: '<p>TOPSECRET</p>' }],
        }],
        incomplete: [], passes: [], inapplicable: [],
        url: 'https://private.invalid/?token=TOPSECRET', arbitrarySecret: 'TOPSECRET',
      };
    },
  };

  const projected = await adapter.runAxeInFrame(adapter.AXE_RUN_CONFIG, adapter.AXE_FRAME_PROJECTION_POLICY);

  assert.equal(projected.ok, true);
  assert.equal(projected.version, '4.13.0');
  assert.deepEqual(Object.keys(projected.results).sort(), ['inapplicable', 'incomplete', 'passes', 'truncation', 'violations']);
  assert.equal(projected.results.violations.length, 1, 'unknown rule IDs are dropped in-frame');
  assert.deepEqual(Object.keys(projected.results.violations[0]).sort(), ['id', 'impact', 'nodes', 'truncation']);
  assert.deepEqual(Object.keys(projected.results.violations[0].nodes[0]).sort(), ['impact', 'target']);
  assert.equal(projected.results.violations[0].nodes[0].target, structural);
  assert.equal(projected.results.violations[0].nodes[1].target, adapter.AXE_TARGET_UNAVAILABLE);
  assert.equal(projected.results.violations[0].nodes[2].target, adapter.AXE_TARGET_UNAVAILABLE);
  assert.deepEqual(projected.results.truncation.violations, { original: 1, retained: 1, truncated: false },
    'regras fora do catálogo são removidas por política, não perdidas por truncamento');
  assert.doesNotMatch(JSON.stringify(projected), /TOPSECRET|private\.invalid|private-customer|ambiguous-customer|shadow-private|PRIVATE-TAG|PRIVATE-CHECK|Cliente/iu);
});

test('drops sparse or accessor-backed axe nodes in-frame without executing page-controlled getters', async t => {
  const originalAxe = globalThis.axe;
  const originalDocument = globalThis.document;
  t.after(() => {
    if (originalAxe === undefined) delete globalThis.axe;
    else globalThis.axe = originalAxe;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let getterCalls = 0;
  const nodes = [];
  Object.defineProperty(nodes, '0', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('private getter must not execute'); },
  });
  nodes.length = 1;
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.axe = {
    version: '4.13.0',
    async run() {
      return {
        violations: [{ id: 'image-alt', impact: 'critical', nodes }],
        incomplete: [], passes: [], inapplicable: [],
      };
    },
  };

  const projected = await adapter.runAxeInFrame(adapter.AXE_RUN_CONFIG, adapter.AXE_FRAME_PROJECTION_POLICY);

  assert.equal(getterCalls, 0);
  assert.deepEqual(projected.results.violations[0].nodes, []);
  assert.deepEqual(projected.results.violations[0].truncation.nodes, { original: 1, retained: 0, truncated: true });
});

test('diagnostic canonicalization distinguishes a readable empty array from invalid and unreadable collections', () => {
  const revokedPair = Proxy.revocable([], {});
  revokedPair.revoke();
  const unreadableLength = new Proxy([], {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'length') throw new Error('diagnostics length unavailable');
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const invalidLength = new Proxy([], {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      return property === 'length' ? { ...descriptor, value: '0' } : descriptor;
    },
  });

  assert.deepEqual(adapter.canonicalizeAxeDiagnosticsWithMetadata([]), {
    diagnostics: [], truncated: false, valid: true, readable: true,
  });
  for (const [label, value, readable] of [
    ['null', null, true],
    ['ordinary object', {}, true],
    ['revoked', revokedPair.proxy, false],
    ['unreadable length', unreadableLength, false],
    ['invalid length descriptor', invalidLength, true],
  ]) {
    assert.deepEqual(adapter.canonicalizeAxeDiagnosticsWithMetadata(value), {
      diagnostics: [], truncated: false, valid: false, readable,
    }, label);
  }
});

test('records the exact browser proof before enabling the coupled production gate', () => {
  assert.deepEqual(adapter.AXE_MV3_CSP_GATE, {
    enabled: true,
    targetSizeEnabled: true,
    code: 'AXE_MV3_CSP_E2E_PASSED',
    testedBrowser: 'Google Chrome 151.0.7922.174',
  });
  assert.equal(Object.isFrozen(adapter.AXE_MV3_CSP_GATE), true);
});

test('rejects every non-boolean or inconsistent production gate state', () => {
  assert.equal(adapter.resolveAxeGateState({ enabled: false, targetSizeEnabled: false }), 'disabled');
  assert.equal(adapter.resolveAxeGateState({ enabled: true, targetSizeEnabled: true }), 'enabled');
  for (const gate of [
    { enabled: 1, targetSizeEnabled: 1 },
    { enabled: 0, targetSizeEnabled: 0 },
    { enabled: 'true', targetSizeEnabled: 'true' },
    { enabled: null, targetSizeEnabled: null },
    { enabled: undefined, targetSizeEnabled: undefined },
    { enabled: true, targetSizeEnabled: false },
    { enabled: false, targetSizeEnabled: true },
  ]) {
    assert.throws(() => adapter.resolveAxeGateState(gate), {
      name: 'TypeError',
      message: 'A configuração do gate axe é inválida.',
    });
  }
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

test('marks a run-only frame and runtime-unavailable result as a partial topology change', async () => {
  let phase = 0;
  const executeScript = async () => {
    phase += 1;
    if (phase === 1) return [{ frameId: 0 }];
    return [
      { frameId: 0, result: { ok: true, version: '4.13.0', results: { violations: [], incomplete: [], passes: [], inapplicable: [] } } },
      { frameId: 7, result: { ok: false, code: 'AXE_RUNTIME_UNAVAILABLE' } },
    ];
  };

  const result = await adapter.probeAxeInTab(12, { executeScript, timeoutMs: 100 });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.frames.map(frame => [frame.frameId, frame.status]), [[0, 'success'], [7, 'failed']]);
  assert.deepEqual(result.diagnostics, [
    { code: 'AXE_FRAME_TOPOLOGY_CHANGED', frameId: 7 },
    { code: 'AXE_FRAME_RUNTIME_UNAVAILABLE', frameId: 7 },
  ]);
});

test('never starts the run phase when a timed-out injection resolves late', async () => {
  let releaseInjection;
  const injection = new Promise(resolve => { releaseInjection = resolve; });
  let timeoutCallback;
  const timers = {
    set(callback) { timeoutCallback = callback; return 1; },
    clear() {},
  };
  const calls = [];
  const promise = adapter.probeAxeInTab(13, {
    executeScript: async options => {
      calls.push(options);
      return options.files ? injection : [];
    },
    timeoutMs: 10,
    timers,
  });
  await Promise.resolve();
  assert.equal(calls.length, 1);

  timeoutCallback();
  const result = await promise;
  assert.deepEqual(result.diagnostics, [{ code: 'AXE_TIMEOUT', frameId: null }]);
  releaseInjection([{ frameId: 0 }]);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.length, 1, 'a segunda chamada executeScript não pode iniciar após o deadline');
});

test('revalidates the projected frame envelope with a closed catalog and saturated bounds', async () => {
  const hostileNode = {
    impact: 'serious',
    html: '<input value="password=TOPSECRET">',
    target: [
      'main > button:nth-of-type(2)',
      'article section > p:nth-of-type(3)',
      '#alice-smith',
      '#patient-hiv-positive',
      '#project-phoenix',
      '.ordinary-class',
      'main > form.customer-form > button:nth-of-type(2)',
      '#customer-4111111111111111',
      'javascript:alert(1)',
      'javascript:alert(document.cookie)',
      'input[value="person@example.com"]',
      '#cpf-12345678901',
      '#user-a8F3kP9zR2mQ7wX4tN6v',
      'button\n#control',
    ],
    failureSummary: 'javascript:alert(document.cookie) customer 4111111111111111',
    any: [{ id: 'label-title-only', impact: 'serious', message: 'customer@example.com token=TOPSECRET', data: { password: 'TOPSECRET' } }],
    all: [],
    none: [],
    unknown: 'TOPSECRET',
  };
  const rules = Array.from({ length: 120 }, () => ({
    id: 'image-alt',
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
  assert.deepEqual(Object.keys(raw).sort(), ['inapplicable', 'incomplete', 'passes', 'truncation', 'violations']);
  assert.deepEqual(Object.keys(raw.violations[0]).sort(), ['id', 'impact', 'nodes', 'truncation']);
  assert.deepEqual(Object.keys(raw.violations[0].nodes[0]).sort(), ['impact', 'target']);
  assert.equal(raw.violations[0].nodes[0].target, adapter.AXE_TARGET_UNAVAILABLE);
  assert.doesNotMatch(JSON.stringify(raw), /TOPSECRET|private\.invalid|remote\.invalid|<input|alice-smith|patient-hiv-positive|project-phoenix|ordinary-class|customer-form|customer-411|javascript:|document\.cookie|person@example|12345678901|a8F3kP9z|failureSummary|description|help|message|"data"/iu);
  assert.deepEqual(raw.truncation.violations, { original: 101, retained: 100, truncated: true });
  assert.deepEqual(raw.violations[0].truncation.nodes, { original: 101, retained: 100, truncated: true });
});
