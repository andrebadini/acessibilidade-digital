import assert from 'node:assert/strict';
import test from 'node:test';

import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { SECTION508_REVISED_CROSSWALK } from '../../src/core/normative/section508.js';
import { normalizeAxeResults } from '../../src/core/axe/normalize-axe-results.js';

const PROVENANCE = AXE_PROVENANCE;

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

test('normalizes confirmed mapped violations as conclusive ABNT failures and keeps unmapped findings supplemental', () => {
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
  assert.equal(unmapped.itemId, null);
  assert.equal(unmapped.classification, 'best-practice');
  assert.equal(unmapped.legalAnalysis, null);
  assert.deepEqual(normalized.ruleResults.find(rule => rule.ruleId === 'axe.custom-unknown').nbrItems, []);
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
    violations: { groups: 3, nodes: 3 },
    incomplete: { groups: 1, nodes: 1 },
    passes: { groups: 1, nodes: 0 },
    inapplicable: { groups: 1, nodes: 0 },
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
  assert.deepEqual(normalized.technicalSummary.violations, { groups: 1, nodes: 0 });
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
  assert.equal(normalized.technicalSummary.violations.groups, 3, 'duplicate frame is deterministically collapsed');
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
