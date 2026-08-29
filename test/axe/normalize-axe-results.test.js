import assert from 'node:assert/strict';
import test from 'node:test';

import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { SECTION508_REVISED_CROSSWALK } from '../../src/core/normative/section508.js';
import { normalizeAxeResults } from '../../src/core/axe/normalize-axe-results.js';
import { validateNormalizedAxeSupplemental } from '../../src/core/axe/validate-supplemental.js';

const PROVENANCE = AXE_PROVENANCE;
const PARTIAL_LIMITATION = 'O motor suplementar axe-core teve cobertura parcial; somente resultados vinculados a frames concluídos foram considerados.';
const PROVENANCE_LIMITATION = 'A proveniência do resultado axe não corresponde ao pacote verificado; nenhum achado foi publicado.';

function emptySuccessfulRun() {
  return {
    status: 'complete', provenance: PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [], incomplete: [], passes: [], inapplicable: [],
    } }],
  };
}

function runResult() {
  return {
    status: 'complete', provenance: PROVENANCE, diagnostics: [],
    frames: [{
      frameId: 0, status: 'success', result: {
        violations: [
          {
            id: 'image-alt', impact: 'critical', tags: ['wcag2a', 'wcag111', 'section508'],
            nodes: [{
              impact: 'critical', target: ['img:nth-of-type(1)'],
              html: '<img src="https://example.test/a.png?token=TOPSECRET" onerror="steal()">',
              failureSummary: 'Corrija https://user:pass@example.test/a?token=TOPSECRET&view=public token=TOPSECRET',
              any: [{ id: 'non-empty-alt', message: 'TOPSECRET' }], all: [], none: [],
            }],
          },
          {
            id: 'html-has-lang', impact: 'serious', tags: ['wcag2a', 'wcag311', 'section508'],
            nodes: [{ impact: 'serious', target: ['html'], html: '<html data-private="Cliente Alfa">', failureSummary: 'Idioma ausente para Cliente Alfa.' }],
          },
          {
            id: 'custom-unknown', impact: 'minor', tags: ['best-practice'],
            nodes: [{ impact: 'minor', target: ['main:nth-of-type(1)'], html: '<main onclick="x()">Texto</main>', failureSummary: 'Revisar.' }],
          },
        ],
        incomplete: [{
          id: 'button-name', impact: 'serious', tags: ['wcag2a'],
          nodes: [{ impact: 'serious', target: ['button:nth-of-type(1)'], html: '<button>?</button>', failureSummary: 'Requer revisão.' }],
        }],
        passes: [{ id: 'document-title', impact: null, tags: ['wcag2a'], nodes: [] }],
        inapplicable: [{ id: 'video-caption', impact: null, tags: ['wcag2a'], nodes: [] }],
      },
    }],
  };
}

function targetSizeRun({ frameId = 0, selector = 'html > body > button' } = {}) {
  return {
    status: 'complete', provenance: PROVENANCE, diagnostics: [],
    frames: [{ frameId, status: 'success', result: {
      violations: [{
        id: 'target-size', impact: 'serious',
        nodes: [{ impact: 'serious', target: selector }],
      }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  };
}

function targetSizeSnapshot() {
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', language: 'pt-BR' },
    nodes: [
      { nodeId: 'n-html', parentId: null, children: ['n-body'], tagName: 'html', attributes: {}, framePath: [] },
      { nodeId: 'n-body', parentId: 'n-html', children: ['n-button'], tagName: 'body', attributes: {}, framePath: [] },
      { nodeId: 'n-button', parentId: 'n-body', children: [], tagName: 'button', attributes: {}, framePath: [] },
    ],
  };
}

function targetSizeCore({ outcome = 'failed', targets = [{ nodeId: 'n-button' }] } = {}) {
  return {
    ruleId: 'target-size-minimum', outcome, mode: 'automated',
    targets, summary: 'Há alvos abaixo do tamanho mínimo aplicável.', limitations: [],
    nbrItems: ['5.8.7'], wcag: ['2.5.8'],
    source: { engine: 'audita-core', ruleId: 'target-size-minimum', version: '1.0.0' },
  };
}

test('normalizes confirmed mapped violations and drops rule IDs outside the closed adapter catalog', () => {
  const normalized = normalizeAxeResults(runResult(), {
    pageId: 'page-1',
    snapshot: { document: { language: '' }, nodes: [] },
    rulesVersion: '1.0.0',
  });
  const mapped = normalized.occurrences.find(item => item.engineRuleId === 'html-has-lang');
  const unmapped = normalized.occurrences.find(item => item.engineRuleId === 'custom-unknown');

  assert.equal(normalized.status, 'complete');
  assert.equal(mapped.outcome, 'failed');
  assert.equal(mapped.itemId, '5.13.2');
  assert.equal(mapped.classification, 'requirement');
  assert.deepEqual(mapped.legalAnalysis, { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id });
  assert.equal(mapped.applicabilityEvidence.source.ruleId, 'page-language');
  assert.deepEqual(mapped.foreignBenchmarkRefs, [{
    benchmarkId: SECTION508_REVISED_CROSSWALK.id,
    criterionId: '3.1.1',
    level: 'A',
  }]);
  assert.deepEqual(mapped.source, {
    engine: 'axe-core', ruleId: 'axe.html-has-lang', version: '4.13.0', engineRuleId: 'html-has-lang',
  });
  assert.equal(unmapped, undefined);
  assert.equal(normalized.ruleResults.some(rule => rule.ruleId === 'axe.custom-unknown'), false);
});

test('concludes target-size only from one top-frame structural node and one authoritative failed core target', () => {
  const coreRuleResults = [targetSizeCore()];
  const normalized = normalizeAxeResults(targetSizeRun(), {
    pageId: 'page-1', snapshot: targetSizeSnapshot(), coreRuleResults, rulesVersion: '1.0.0',
  });
  const occurrence = normalized.occurrences[0];

  assert.equal(occurrence.engineRuleId, 'target-size');
  assert.equal(occurrence.outcome, 'failed');
  assert.equal(occurrence.itemId, '5.8.7');
  assert.equal(occurrence.nodeId, 'n-button');
  assert.deepEqual(occurrence.target, {
    nodeId: 'n-button', selector: 'html > body > button', framePath: [],
  });
  assert.equal(occurrence.equivalenceKey, 'minimum-target-size');
  assert.equal(occurrence.presentationTargetKey, 'node:n-button');
  assert.deepEqual(occurrence.testedWcagRefs, ['2.5.8']);
  assert.deepEqual(occurrence.applicabilityEvidence, {
    confirmed: true, pageId: 'page-1', frameId: 0, target: 'html > body > button', nodeId: 'n-button', nbrItemRef: '5.8.7',
    source: { engine: 'audita-core', ruleId: 'target-size-minimum', version: '1.0.0' },
  });
  assert.deepEqual(validateNormalizedAxeSupplemental(normalized, {
    rulesVersion: '1.0.0', coreRuleResults,
  }).errors, []);
});

test('keeps target-size inconclusive while retaining only a unique top-frame snapshot-node correlation', () => {
  const snapshot = targetSizeSnapshot();
  const cases = [
    ['child frame', targetSizeRun({ frameId: 7 }), [targetSizeCore()], null],
    ['missing core result', targetSizeRun(), [], 'n-button'],
    ['duplicate core result', targetSizeRun(), [targetSizeCore(), targetSizeCore()], 'n-button'],
    ['non-failed core result', targetSizeRun(), [targetSizeCore({ outcome: 'cantTell', targets: [] })], 'n-button'],
    ['different core node', targetSizeRun(), [targetSizeCore({ targets: [{ nodeId: 'n-body' }] })], 'n-button'],
    ['duplicate correlated target', targetSizeRun(), [targetSizeCore({ targets: [{ nodeId: 'n-button' }, { nodeId: 'n-button' }] })], 'n-button'],
    ['unavailable selector', targetSizeRun({ selector: '[target-unavailable]' }), [targetSizeCore()], null],
    ['non-canonical selector', targetSizeRun({ selector: 'body > button' }), [targetSizeCore()], null],
  ];

  for (const [label, input, coreRuleResults, expectedNodeId] of cases) {
    const normalized = normalizeAxeResults(input, {
      pageId: 'page-1', snapshot, coreRuleResults, rulesVersion: '1.0.0',
    });
    const occurrence = normalized.occurrences[0];
    assert.equal(occurrence.outcome, 'cantTell', label);
    assert.equal(occurrence.nodeId, expectedNodeId, label);
    assert.equal(occurrence.target.nodeId, expectedNodeId, label);
    assert.equal(occurrence.presentationTargetKey,
      expectedNodeId === null ? `selector:${input.frames[0].frameId}:${occurrence.selector}` : `node:${expectedNodeId}`, label);
    assert.deepEqual(occurrence.testedWcagRefs, [], label);
    assert.deepEqual(occurrence.foreignBenchmarkRefs, [], label);
    assert.equal(occurrence.legalAnalysis, null, label);
    assert.equal(occurrence.applicabilityEvidence, null, label);
    assert.deepEqual(validateNormalizedAxeSupplemental(normalized, {
      rulesVersion: '1.0.0', coreRuleResults,
    }).errors, [], label);
  }
});

test('derives applicability internally and scopes it to the exact top-frame normalized target', () => {
  const input = runResult();
  input.frames[0].result.violations[1].nodes.push({
    impact: 'serious', target: ['body'], html: '<body>', failureSummary: 'Alvo diferente.',
  });
  input.frames.push({ frameId: 2, status: 'success', result: {
    violations: [{ id: 'html-has-lang', impact: 'serious', tags: ['wcag2a'], nodes: [{ impact: 'serious', target: ['html'] }] }],
    incomplete: [], passes: [], inapplicable: [],
  } });
  const normalized = normalizeAxeResults(input, {
    pageId: 'page-1',
    snapshot: { document: { language: '' }, nodes: [] },
    rulesVersion: '1.0.0',
    // Caller assertions are hostile input and must not authorize a failure.
    applicabilityEvidence: [{
      axeRuleId: 'image-alt', nbrItemRef: '5.2.1', pageId: 'wrong-page', frameId: 2,
      target: 'img:nth-of-type(99)', confirmed: true,
      source: { engine: 'audita-core', ruleId: 'unrelated-rule', version: '99.0.0' },
    }],
  });
  const language = normalized.occurrences.filter(item => item.engineRuleId === 'html-has-lang');
  const image = normalized.occurrences.find(item => item.engineRuleId === 'image-alt');

  assert.equal(language[0].outcome, 'failed');
  assert.equal(language[1].outcome, 'cantTell');
  assert.equal(language[2].outcome, 'cantTell');
  assert.equal(language[1].legalAnalysis, null);
  assert.equal(language[2].applicabilityEvidence, null);
  assert.equal(image.outcome, 'cantTell');
  assert.equal(image.legalAnalysis, null);
});

test('does not manufacture an ABNT failure from a curated ID mapping without applicability evidence', () => {
  const normalized = normalizeAxeResults(runResult(), { pageId: 'page-1' });
  const ambiguous = normalized.occurrences.find(item => item.engineRuleId === 'image-alt');

  assert.equal(ambiguous.outcome, 'cantTell');
  assert.equal(ambiguous.itemId, '5.2.1');
  assert.equal(ambiguous.legalAnalysis, null);
  assert.equal(ambiguous.applicabilityEvidence, null);
  assert.match(ambiguous.justification, /aplicabilidade|confirm/i);
});

test('turns incomplete into cantTell, summarizes passes only and never grants ABNT approval', () => {
  const normalized = normalizeAxeResults(runResult(), { pageId: 'page-1' });
  const incomplete = normalized.occurrences.find(item => item.engineRuleId === 'button-name');

  assert.equal(incomplete.outcome, 'cantTell');
  assert.equal(incomplete.itemId, '5.13.10');
  assert.equal(incomplete.legalAnalysis, null);
  assert.equal(normalized.ruleResults.some(rule => rule.outcome === 'passed'), false);
  assert.deepEqual(normalized.technicalSummary, {
    violations: { groups: 2, nodes: 2 },
    incomplete: { groups: 1, nodes: 1 },
    passes: { groups: 1, nodes: 0 },
    inapplicable: { groups: 0, nodes: 0 },
  });
});

test('drops hostile axe page text, sanitizes target and applies deterministic bounds', () => {
  const input = runResult();
  const node = input.frames[0].result.violations[0].nodes[0];
  node.target = ['img#private.customer-name'];
  node.html = `${node.html}${'A'.repeat(10_000)}`;
  node.failureSummary = `${node.failureSummary}${'B'.repeat(10_000)}`;
  node.html += 'Dados particulares da família Oliveira';
  node.failureSummary += ' Dados particulares da família Oliveira';
  input.frames[0].result.violations[0].nodes.push(...Array.from({ length: 300 }, () => ({
    impact: 'critical', target: ['img:nth-of-type(2)'], html: '<img>', failureSummary: 'Falha',
  })));

  const normalized = normalizeAxeResults(input, { pageId: 'page-1' });
  const mapped = normalized.occurrences.find(item => item.engineRuleId === 'image-alt');

  assert.equal(mapped.selector, '[target-unavailable]');
  assert.equal(Object.hasOwn(mapped, 'html'), false);
  assert.equal(Object.hasOwn(mapped, 'failureSummary'), false);
  assert.doesNotMatch(JSON.stringify(normalized), /TOPSECRET|user:pass|onerror|section508|customer-name|família Oliveira|Cliente Alfa/iu);
  assert.ok(normalized.occurrences.length <= 256);
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_RESULTS_TRUNCATED'));
});

test('represents a disabled production gate as an explicit bounded limitation', () => {
  const normalized = normalizeAxeResults({
    status: 'disabled', provenance: PROVENANCE, frames: [], diagnostics: [{ code: 'AXE_FEATURE_DISABLED', detail: 'X'.repeat(20_000) }],
  }, { pageId: 'page-1' });

  assert.equal(normalized.status, 'disabled');
  assert.deepEqual(normalized.ruleResults, []);
  assert.deepEqual(normalized.occurrences, []);
  assert.equal(normalized.diagnostics[0].code, 'AXE_FEATURE_DISABLED');
  assert.equal(Object.hasOwn(normalized.diagnostics[0], 'detail'), false);
  assert.match(normalized.limitations[0], /desativad|gate|CSP|MV3/i);
  assert.ok(JSON.stringify(normalized).length < 8_000);
});

test('rejects mismatched provenance without publishing normative findings', () => {
  const input = runResult();
  input.provenance = { ...PROVENANCE, version: '99.0.0' };
  const normalized = normalizeAxeResults(input, { pageId: 'page-1' });

  assert.equal(normalized.status, 'partial');
  assert.deepEqual(normalized.ruleResults, []);
  assert.deepEqual(normalized.occurrences, []);
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_PROVENANCE_INVALID'));
});

test('collapses unknown or private diagnostic codes to the fixed catalog without leaking them', () => {
  const input = runResult();
  input.status = 'partial';
  input.diagnostics = [{ code: 'AXE_PATIENT_HIV_POSITIVE', frameId: null, detail: 'Família Oliveira' }];

  const normalized = normalizeAxeResults(input, { pageId: 'page-1' });

  assert.deepEqual(normalized.diagnostics, [{ code: 'AXE_DIAGNOSTIC_UNAVAILABLE', frameId: null }]);
  assert.equal(normalized.status, 'partial');
  assert.doesNotMatch(JSON.stringify(normalized), /PATIENT|HIV|POSITIVE|Oliveira/iu);
});

test('fails closed when a successful run has no own readable diagnostics array', () => {
  let accessorCalls = 0;
  const cases = [
    ['missing', input => { delete input.diagnostics; return input; }],
    ['null', input => { input.diagnostics = null; return input; }],
    ['ordinary object', input => { input.diagnostics = {}; return input; }],
    ['ordinary scalar', input => { input.diagnostics = 'not-an-array'; return input; }],
    ['inherited array', input => {
      delete input.diagnostics;
      Object.setPrototypeOf(input, { diagnostics: [] });
      return input;
    }],
    ['accessor-backed', input => {
      Object.defineProperty(input, 'diagnostics', {
        enumerable: true,
        get() { accessorCalls += 1; throw new Error('diagnostics getter must not execute'); },
      });
      return input;
    }],
    ['throwing property descriptor', input => new Proxy(input, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'diagnostics') throw new Error('diagnostics descriptor unavailable');
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    })],
  ];

  for (const [label, makeInput] of cases) {
    const normalized = normalizeAxeResults(makeInput(emptySuccessfulRun()), { pageId: 'page-1' });

    assert.equal(normalized.status, 'partial', label);
    assert.deepEqual(normalized.diagnostics, [{ code: 'AXE_DIAGNOSTIC_UNAVAILABLE', frameId: null }], label);
    assert.deepEqual(normalized.limitations, [PARTIAL_LIMITATION], label);
    assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, [], label);
  }
  assert.equal(accessorCalls, 0);
});

test('fails closed when a successful run diagnostics array is revoked or its length is unreadable', () => {
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

  for (const [label, diagnostics] of [
    ['revoked', revokedPair.proxy],
    ['unreadable length', unreadableLength],
    ['invalid length descriptor', invalidLength],
  ]) {
    const input = emptySuccessfulRun();
    input.diagnostics = diagnostics;
    let normalized;

    assert.doesNotThrow(() => { normalized = normalizeAxeResults(input, { pageId: 'page-1' }); }, label);
    assert.equal(normalized.status, 'partial', label);
    assert.deepEqual(normalized.diagnostics, [{ code: 'AXE_DIAGNOSTIC_UNAVAILABLE', frameId: null }], label);
    assert.deepEqual(normalized.limitations, [PARTIAL_LIMITATION], label);
    assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, [], label);
  }
});

test('keeps disabled and provenance-invalid terminal states canonical with unreadable diagnostics', () => {
  const disabled = normalizeAxeResults({
    status: 'disabled', provenance: PROVENANCE, frames: [],
  }, { pageId: 'page-1' });
  const provenanceInvalid = normalizeAxeResults({
    status: 'complete', provenance: { ...PROVENANCE, version: '99.0.0' },
    frames: emptySuccessfulRun().frames,
  }, { pageId: 'page-1' });

  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(disabled.diagnostics, [{ code: 'AXE_FEATURE_DISABLED', frameId: null }]);
  assert.deepEqual(validateNormalizedAxeSupplemental(disabled, { rulesVersion: '1.0.0' }).errors, []);
  assert.equal(provenanceInvalid.status, 'partial');
  assert.deepEqual(provenanceInvalid.diagnostics, [{ code: 'AXE_PROVENANCE_INVALID', frameId: null }]);
  assert.deepEqual(provenanceInvalid.limitations, [PARTIAL_LIMITATION, PROVENANCE_LIMITATION]);
  assert.deepEqual(validateNormalizedAxeSupplemental(provenanceInvalid, { rulesVersion: '1.0.0' }).errors, []);
});

test('keeps a genuine own readable empty diagnostics array eligible for complete coverage', () => {
  const normalized = normalizeAxeResults(emptySuccessfulRun(), { pageId: 'page-1' });

  assert.equal(normalized.status, 'complete');
  assert.deepEqual(normalized.diagnostics, []);
  assert.deepEqual(normalized.limitations, []);
  assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, []);
});

test('contains hostile accessors and sparse result arrays without invoking page-controlled getters', () => {
  let getterCalls = 0;
  const violations = [];
  Object.defineProperty(violations, '0', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('page getter must not execute'); },
  });
  violations.length = 1;
  const input = {
    status: 'complete', provenance: PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations, incomplete: [], passes: [], inapplicable: [],
    } }],
  };

  const normalized = normalizeAxeResults(input, { pageId: 'page-1' });

  assert.equal(getterCalls, 0);
  assert.deepEqual(normalized.occurrences, []);
  assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, []);
});

test('normalizes reserved diagnostics from a hostile raw adapter into a self-consistent partial cluster', () => {
  for (const code of ['AXE_FEATURE_DISABLED', 'AXE_PROVENANCE_INVALID', 'AXE_RESULTS_TRUNCATED']) {
    const normalized = normalizeAxeResults({
      status: 'complete', provenance: PROVENANCE, diagnostics: [{ code, frameId: null }],
      frames: [{ frameId: 0, status: 'success', result: {
        violations: [], incomplete: [], passes: [], inapplicable: [],
      } }],
    }, { pageId: 'page-1' });

    assert.equal(normalized.status, 'partial');
    assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, [], code);
  }
});

test('marks truncation when 64 adapter diagnostics plus 64 frame diagnostics exceed the unique canonical cap', () => {
  const normalized = normalizeAxeResults({
    status: 'complete',
    provenance: PROVENANCE,
    diagnostics: Array.from({ length: 64 }, (_, index) => ({
      code: 'AXE_FRAME_RUN_FAILED', frameId: index,
    })),
    frames: Array.from({ length: 64 }, (_, frameId) => ({ frameId, status: 'failed' })),
  }, { pageId: 'page-1' });

  assert.equal(normalized.diagnostics.length, 64);
  assert.equal(normalized.diagnostics.filter(entry => entry.code === 'AXE_FRAME_RUN_FAILED').length, 63,
    'the retained marker may displace one diagnostic only after that omission is recorded');
  assert.ok(normalized.diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED'));
  assert.match(normalized.limitations.join(' '), /truncados/iu);
  assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, []);
});

test('applies the unique diagnostic cap exactly at 63, 64 and 65 entries', () => {
  for (const [count, expectedTruncated] of [[63, false], [64, false], [65, true]]) {
    const normalized = normalizeAxeResults({
      status: 'complete',
      provenance: PROVENANCE,
      diagnostics: Array.from({ length: count }, (_, index) => ({
        code: 'AXE_TIMEOUT', frameId: 1_000 + index,
      })),
      frames: [{ frameId: 0, status: 'success', result: {
        violations: [], incomplete: [], passes: [], inapplicable: [],
      } }],
    }, { pageId: 'page-1' });

    assert.equal(normalized.diagnostics.length, Math.min(count, 64), `count ${count}`);
    assert.equal(normalized.diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED'), expectedTruncated, `count ${count}`);
    assert.equal(normalized.limitations.some(limitation => /truncados/iu.test(limitation)), expectedTruncated, `count ${count}`);
    assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, [], `count ${count}`);
  }
});

test('does not infer truncation from duplicate diagnostic candidates', () => {
  const duplicateAdapterDiagnostics = normalizeAxeResults({
    status: 'complete',
    provenance: PROVENANCE,
    diagnostics: Array.from({ length: 65 }, () => ({ code: 'AXE_TIMEOUT', frameId: 7 })),
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [], incomplete: [], passes: [], inapplicable: [],
    } }],
  }, { pageId: 'page-1' });
  const duplicateDerivedDiagnostics = normalizeAxeResults({
    status: 'complete',
    provenance: PROVENANCE,
    diagnostics: Array.from({ length: 64 }, (_, frameId) => ({ code: 'AXE_FRAME_FAILED', frameId })),
    frames: Array.from({ length: 64 }, (_, frameId) => ({ frameId, status: 'failed' })),
  }, { pageId: 'page-1' });

  for (const normalized of [duplicateAdapterDiagnostics, duplicateDerivedDiagnostics]) {
    assert.equal(normalized.diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED'), false);
    assert.equal(normalized.limitations.some(limitation => /truncados/iu.test(limitation)), false);
    assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, []);
  }
});

test('bounds huge sparse arrays before allocation and never invokes a frame result accessor', () => {
  let getterCalls = 0;
  const hostileFrame = { frameId: 0, status: 'success' };
  Object.defineProperty(hostileFrame, 'result', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('frame result getter must not execute'); },
  });
  const frames = [];
  frames[0] = hostileFrame;
  frames.length = 0xffff_ffff;

  const normalized = normalizeAxeResults({
    status: 'complete', provenance: PROVENANCE, diagnostics: [], frames,
  }, { pageId: 'page-1' });

  assert.equal(getterCalls, 0);
  assert.deepEqual(normalized.occurrences, []);
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_RESULTS_TRUNCATED'));
});

test('derives partial coverage from frame topology, diagnostics, duplicates and adapter truncation', () => {
  const input = runResult();
  input.status = 'complete';
  input.diagnostics = [{ code: 'AXE_TIMEOUT', frameId: null }];
  input.frames.push({ frameId: 0, status: 'success', result: input.frames[0].result });
  input.frames.push({ frameId: 2, status: 'failed' });
  input.frames.push({ frameId: 3, status: 'missing' });
  input.frames[0].result.truncation = {
    violations: { original: 101, retained: 100, truncated: true },
  };

  const normalized = normalizeAxeResults(input, { pageId: 'page-1' });

  assert.equal(normalized.status, 'partial');
  assert.match(normalized.limitations.join(' '), /parcial|truncad|frame/i);
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_FRAME_DUPLICATE'));
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_FRAME_FAILED'));
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_FRAME_MISSING'));
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_RESULTS_TRUNCATED'));
  assert.equal(new Set(normalized.occurrences.map(item => item.occurrenceId)).size, normalized.occurrences.length);
  assert.equal(normalized.technicalSummary.violations.groups, 2, 'duplicate frame is deterministically collapsed and unknown IDs stay dropped');
});

test('derives bounded technical counts from retained collections instead of hostile original-count metadata', () => {
  const input = runResult();
  input.frames[0].result.truncation = {
    violations: { original: 10_000_000, retained: 100, truncated: true },
    incomplete: { original: 1, retained: 1, truncated: false },
    passes: { original: 1, retained: 1, truncated: false },
    inapplicable: { original: 1, retained: 1, truncated: false },
  };

  const normalized = normalizeAxeResults(input, { pageId: 'page-1' });

  assert.equal(normalized.status, 'partial');
  assert.deepEqual(normalized.technicalSummary.violations, { groups: 2, nodes: 2 });
  assert.equal(normalized.occurrences.length, 3);
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_RESULTS_TRUNCATED'));
  assert.doesNotMatch(JSON.stringify(normalized), /10000000/u);
});

test('propagates nested truncation from passes and inapplicable groups into canonical partial coverage', () => {
  for (const resultType of ['passes', 'inapplicable']) {
    const input = runResult();
    input.frames[0].result[resultType][0].truncation = {
      tags: { original: 33, retained: 32, truncated: true },
      nodes: { original: 0, retained: 0, truncated: false },
    };
    const normalized = normalizeAxeResults(input, { pageId: 'page-1' });

    assert.equal(normalized.status, 'partial', resultType);
    assert.ok(normalized.diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED'), resultType);
    assert.deepEqual(validateNormalizedAxeSupplemental(normalized, { rulesVersion: '1.0.0' }).errors, [], resultType);
  }
});

test('never invokes nested target index accessors and contains revoked proxies', () => {
  let getterCalls = 0;
  const nested = [];
  Object.defineProperty(nested, '0', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('nested page getter executed'); },
  });
  nested.length = 1;
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  const input = runResult();
  input.frames[0].result.violations[0].nodes[0].target = [nested];
  input.frames[0].result.violations[1].nodes[0].target = proxy;

  let normalized;
  assert.doesNotThrow(() => { normalized = normalizeAxeResults(input, { pageId: 'page-1' }); });
  assert.equal(getterCalls, 0);
  assert.equal(normalized.occurrences.find(item => item.engineRuleId === 'image-alt').selector, '[target-unavailable]');
  assert.equal(normalized.occurrences.find(item => item.engineRuleId === 'html-has-lang').selector, '[target-unavailable]');
});

test('treats a success frame with a missing result record as partial coverage', () => {
  const normalized = normalizeAxeResults({
    status: 'complete', provenance: PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success' }],
  }, { pageId: 'page-1' });
  assert.equal(normalized.status, 'partial');
  assert.ok(normalized.diagnostics.some(item => item.code === 'AXE_FRAME_RESULT_INVALID'));
});

test('contains revoked proxies at every top-level axe collection and provenance boundary', () => {
  function revoked(target) {
    const pair = Proxy.revocable(target, {});
    pair.revoke();
    return pair.proxy;
  }
  const cases = [
    { status: 'complete', provenance: PROVENANCE, diagnostics: [], frames: revoked([]) },
    { status: 'complete', provenance: PROVENANCE, diagnostics: revoked([]), frames: [] },
    { status: 'complete', provenance: revoked({}), diagnostics: [], frames: [] },
    ...['violations', 'incomplete', 'passes', 'inapplicable'].map(name => ({
      status: 'complete', provenance: PROVENANCE, diagnostics: [],
      frames: [{ frameId: 0, status: 'success', result: {
        violations: [], incomplete: [], passes: [], inapplicable: [], [name]: revoked([]),
      } }],
    })),
    {
      status: 'complete', provenance: PROVENANCE, diagnostics: [],
      frames: [{ frameId: 0, status: 'success', result: {
        violations: [{ id: 'image-alt', nodes: revoked([]) }], incomplete: [], passes: [], inapplicable: [],
      } }],
    },
  ];

  for (const input of cases) {
    let normalized;
    assert.doesNotThrow(() => { normalized = normalizeAxeResults(input, { pageId: 'page-1' }); });
    assert.deepEqual(normalized.occurrences, []);
  }
  assert.doesNotThrow(() => normalizeAxeResults(runResult(), {
    pageId: 'page-1', rulesVersion: '1.0.0', snapshot: revoked({}),
  }));
});
