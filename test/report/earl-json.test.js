import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import {
  canonicalBatchRuleSummary,
  canonicalScope,
  derivePageLimitations,
  deriveSystemLimitations,
} from '../../src/core/report/text-policy.js';
import { reportInput } from './helpers.js';

const EARL = 'http://www.w3.org/ns/earl#';

test('technical JSON exports one assertion per ABNT item and maps every EARL outcome', () => {
  const model = createAuditModel(SAMPLE_AUDIT);
  const document = JSON.parse(renderTechnicalJson(model));
  assert.equal(document.assertions.length, 146);
  assert.deepEqual(new Set(document.assertions.map(assertion => assertion.result.outcome)), new Set([
    `${EARL}passed`, `${EARL}failed`, `${EARL}cantTell`, `${EARL}inapplicable`, `${EARL}untested`,
  ]));
  assert.deepEqual(document.audit, model);
  assert.equal(document.schemaVersion, 2);
});

test('EARL serialization maps internal assisted only at the boundary and preserves evidence pointers', () => {
  const model = createAuditModel(reportInput());
  const document = JSON.parse(renderTechnicalJson(model));
  const assertion = document.assertions.find(value => value.test.id === 'urn:abnt:nbr17225:5.1.4');
  assert.equal(model.itemResults.find(item => item.id === '5.1.4').evaluation, 'assisted');
  assert.equal(assertion.mode, `${EARL}semiAuto`);
  assert.equal(assertion.assertor.id, 'urn:audita-mt:software');
  assert.equal(assertion.subject.id, 'https://example.test/final?view=public');
  assert.equal(assertion.pointer[0].occurrenceId, 'occ-1');
  assert.equal(assertion.pointer[0].pageId, 'page-1');
  assert.equal(assertion.pointer[0].selector, '#conteudo');
  assert.deepEqual(assertion.evidenceIds, ['ev-1']);
  assert.match(assertion.info, /ordem|pessoa/i);
});

test('technical JSON is deterministic and replaces hostile legacy scope prose with the canonical local scope', () => {
  const hostile = '</script><img src=x onerror=alert(1)>';
  const input = reportInput({ scope: { kind: 'single-page', description: hostile } });
  const first = renderTechnicalJson(createAuditModel(input));
  const second = renderTechnicalJson(createAuditModel({ ...input, scope: { description: hostile, kind: 'single-page' } }));
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first).audit.scope, canonicalScope('single', 1));
  assert.doesNotMatch(first, /onerror|<img|<\/script>/u);
});

test('multipage EARL keeps 146 ABNT assertions against an explicit consolidated subject', () => {
  const input = structuredClone(createAuditModel(reportInput()));
  input.requestedScope = {
    mode: 'batch', urls: [...input.requestedScope.urls, 'https://second.example.test/'],
  };
  input.scope = canonicalScope('batch', 2);
  delete input.snapshot;
  input.pages[0].coverage = {};
  input.pages[0].timestamps = {
    startedAt: '2026-08-26T14:00:00.000Z',
    endedAt: '2026-08-26T14:00:30.000Z',
    generatedAt: input.timestamps.generatedAt,
  };
  const failedPage = {
    pageId: 'page-2', requestedUrl: 'https://second.example.test/',
    finalUrl: 'https://second.example.test/final', status: 'failed',
    attempted: true, finalUrlObserved: true, axeStatus: 'not-run',
    timestamps: {
      startedAt: '2026-08-26T14:00:40.000Z', endedAt: '2026-08-26T14:00:50.000Z',
      generatedAt: '2026-08-26T14:01:00.000Z',
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
    coverage: {},
    warnings: [],
    limitations: [],
    diagnostics: [
      {
        code: 'ENVIRONMENT_UNAVAILABLE', message: 'Os metadados públicos do ambiente não puderam ser lidos.',
        at: '2026-08-26T14:00:49.000Z', recoverable: true,
      },
      {
        code: 'CORE_AUDIT_FAILED', message: 'O núcleo de regras não pôde concluir a auditoria.',
        at: '2026-08-26T14:00:50.000Z', recoverable: false,
      },
    ],
  };
  input.pages.push(failedPage);
  const secondPristine = structuredClone(input.evidence.find(entry => entry.evidenceId === 'ev-full'));
  secondPristine.evidenceId = 'ev-full-page-2';
  secondPristine.pageId = 'page-2';
  input.evidence.push(secondPristine);
  input.evidenceStateCount = 2;
  input.reproducibility.capturedStateCount = 2;
  input.session.diagnostics.push(...structuredClone(failedPage.diagnostics));
  for (const rule of input.ruleResults) {
    if (rule.source?.engine === 'audita-core') {
      rule.summary = canonicalBatchRuleSummary(rule.outcome, 1, 2);
    }
  }
  input.limitations = deriveSystemLimitations(input);
  for (const page of input.pages) page.limitations = derivePageLimitations(input, page);

  const document = JSON.parse(renderTechnicalJson(input));
  assert.equal(document.assertions.length, 146);
  assert.ok(document.assertions.every(assertion =>
    assertion.test.id.startsWith('urn:abnt:nbr17225:')));
  assert.ok(document.assertions.every(assertion =>
    assertion.subject.id === 'urn:audita-mt:audit:audit-report-1:scope'));
  assert.deepEqual(document.assertions[0].subject.pages, [
    { pageId: 'page-1', id: 'https://example.test/final?view=public' },
    { pageId: 'page-2', id: 'https://second.example.test/final' },
  ]);
});
