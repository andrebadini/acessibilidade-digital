import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { hashKeyboardMapArtifact } from '../../src/core/keyboard/keyboard-map-artifact.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { isAuditIntegrityVerified, verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import { createKeyboardMapFixture, createPristineMapSource } from './keyboard-map-fixture.js';

const ENRICH_OPTIONS = {
  now: () => '2026-08-28T12:00:00.000Z', timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
};

async function modelWithMap(options = {}) {
  const model = structuredClone(SAMPLE_AUDIT);
  model.evidence[0] = createPristineMapSource();
  model.evidence.push(await createKeyboardMapFixture(options));
  return model;
}

test('aceita um mapa exato da mesma página e proíbe vinculá-lo a ocorrências', async () => {
  const input = await modelWithMap();
  const canonical = createAuditModel(input);
  const map = canonical.evidence.find(artifact => artifact.kind === 'keyboard-map');
  assert.equal(map.pageId, 'page-1');
  assert.equal(map.stops.length, 1);
  assert.equal(canonical.evidence.filter(artifact => artifact.kind === 'announcement-map').length, 0);

  const linked = structuredClone(input);
  linked.occurrences[0].evidenceRefs.push('ev-keyboard-map');
  linked.occurrences[0].evidenceIds.push('ev-keyboard-map');
  // O modelo fecha a porta com a mensagem genérica; o par positivo acima é o que fixa o resto.
  assert.throws(() => createAuditModel(linked), /Modelo de auditoria inválido/u);
});

test('rejeita campo inventado, origem trocada e mapa duplicado por página', async () => {
  // O hash guardado não entra aqui de propósito: ele é derivado do conteúdo e o enriquecimento
  // (teste abaixo) o reescreve, então forjá-lo não é, por si só, um estado inválido.
  const base = await modelWithMap();
  for (const mutate of [
    value => { value.evidence.at(-1).privateValue = 'PRIVATE-SENTINEL'; },
    value => { value.evidence.at(-1).stops[0].x = 1; },
    value => { value.evidence.at(-1).derivation.extra = 1; },
    value => { value.evidence.at(-1).limitations.push('limitação-inventada'); },
    value => { value.evidence.at(-1).derivation.sourceHash = 'e'.repeat(64); },
    value => { value.evidence[0].state = 'derived'; },
    value => { value.evidence.push({ ...structuredClone(value.evidence.at(-1)), evidenceId: 'ev-keyboard-map-2' }); },
  ]) {
    const forged = structuredClone(base);
    mutate(forged);
    assert.throws(() => createAuditModel(forged), /mapa|origem|pristine|hash|duplicad|parada|inválid/iu);
  }
});

test('exige o diagnóstico KEYBOARD_MAP_PARTIAL exatamente quando o mapa é parcial', async () => {
  // O modelo fecha a porta com uma mensagem genérica; o par positivo/negativo abaixo é o que fixa a
  // equivalência entre mapa parcial e o diagnóstico.
  const partial = await modelWithMap({ status: 'partial' });
  assert.throws(() => createAuditModel(partial), /Modelo de auditoria inválido/u);

  partial.pages[0].diagnostics.push({
    code: 'KEYBOARD_MAP_PARTIAL',
    message: 'O mapa do teclado foi gerado com cobertura parcial e limitações explícitas.',
    at: '2026-08-26T14:00:31.000Z', recoverable: true,
  });
  partial.session.diagnostics.push({
    code: 'KEYBOARD_MAP_PARTIAL',
    message: 'O mapa do teclado foi gerado com cobertura parcial e limitações explícitas.',
    at: '2026-08-26T14:00:31.000Z', recoverable: true,
  });
  assert.equal(createAuditModel(partial).evidence.find(artifact => artifact.kind === 'keyboard-map').status, 'partial');

  // O caminho inverso: diagnóstico sem mapa parcial também é incoerente.
  const complete = await modelWithMap();
  complete.pages[0].diagnostics.push({
    code: 'KEYBOARD_MAP_PARTIAL',
    message: 'O mapa do teclado foi gerado com cobertura parcial e limitações explícitas.',
    at: '2026-08-26T14:00:31.000Z', recoverable: true,
  });
  complete.session.diagnostics.push({
    code: 'KEYBOARD_MAP_PARTIAL',
    message: 'O mapa do teclado foi gerado com cobertura parcial e limitações explícitas.',
    at: '2026-08-26T14:00:31.000Z', recoverable: true,
  });
  assert.throws(() => createAuditModel(complete), /Modelo de auditoria inválido/u);
});

test('recomputa o hash do mapa no enriquecimento sem depender do hash guardado', async () => {
  const input = await modelWithMap();
  const enriched = await enrichAuditForReport(input, ENRICH_OPTIONS);
  const map = enriched.evidence.find(artifact => artifact.kind === 'keyboard-map');
  assert.match(map.hash, /^[a-f0-9]{64}$/u);
  assert.equal(map.hash, await hashKeyboardMapArtifact(map, {
    sourceArtifact: enriched.evidence.find(artifact => artifact.kind === 'full-page'),
  }));
  const verified = await verifyAuditIntegritySnapshot(enriched);
  assert.equal(isAuditIntegrityVerified(verified), true);

  // O hash guardado não é fonte de verdade: um mapa com hash inventado é reescrito pelo conteúdo.
  const stale = await modelWithMap();
  stale.evidence.at(-1).hash = 'a'.repeat(64);
  const repaired = await enrichAuditForReport(stale, ENRICH_OPTIONS);
  assert.equal(repaired.evidence.find(artifact => artifact.kind === 'keyboard-map').hash, map.hash);
});

test('auditoria anterior sem mapa do teclado continua abrindo e declarando a ausência', async () => {
  const legacy = structuredClone(SAMPLE_AUDIT);
  const model = createAuditModel(legacy);
  assert.equal(model.evidence.some(artifact => artifact.kind === 'keyboard-map'), false);
  const enriched = await enrichAuditForReport(legacy, ENRICH_OPTIONS);
  assert.equal(isAuditIntegrityVerified(await verifyAuditIntegritySnapshot(enriched)), true);
});
