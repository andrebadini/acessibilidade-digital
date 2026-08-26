import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditModel } from '../../src/core/report/audit-model.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { reportInput } from './helpers.js';

const EARL = 'http://www.w3.org/ns/earl#';

test('technical JSON exports one assertion per ABNT item and maps every EARL outcome', () => {
  const model = createAuditModel(reportInput());
  const document = JSON.parse(renderTechnicalJson(model));
  assert.equal(document.assertions.length, 146);
  assert.deepEqual(new Set(document.assertions.map(assertion => assertion.result.outcome)), new Set([
    `${EARL}passed`, `${EARL}failed`, `${EARL}cantTell`, `${EARL}inapplicable`, `${EARL}untested`,
  ]));
  assert.deepEqual(document.audit, model);
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
  assert.equal(assertion.pointer[0].selector, '#conteudo');
  assert.deepEqual(assertion.evidenceIds, ['ev-1']);
  assert.match(assertion.info, /ordem|pessoa/i);
});

test('technical JSON is deterministic and keeps hostile text inert JSON data', () => {
  const hostile = '</script><img src=x onerror=alert(1)>';
  const input = reportInput({ scope: { kind: 'single-page', description: hostile } });
  const first = renderTechnicalJson(createAuditModel(input));
  const second = renderTechnicalJson(createAuditModel({ ...input, scope: { description: hostile, kind: 'single-page' } }));
  assert.equal(first, second);
  assert.equal(JSON.parse(first).audit.scope.description, hostile);
});
