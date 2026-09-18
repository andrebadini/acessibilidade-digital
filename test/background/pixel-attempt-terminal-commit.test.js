import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createPixelAttemptLifecycleV1 } from '../../src/background/service-worker.js';
import {
  createPixelAttemptCorrelationV1, createPixelAttemptStoreBindingV1,
} from '../../src/background/pixel-attempt-correlation.js';
import { createSessionPixelAttemptDigestAuthority } from '../../src/core/privacy/session-url-digest.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';

// INVARIANTE 4 DO BRIEFING, no ponto exato do achado D2 da revisão da 1.1.37: "captura do documento B
// nunca atribuída à auditoria de A" é promessa de CONSTRUÇÃO, e a construção é o companheiro durável que
// o commit terminal grava ao lado do modelo (`pixelAttemptCompanion`). Enquanto o commit aceitava a alça
// nula, um modelo com raster entrava no armazenamento sem esse companheiro — a correlação passava a
// depender de o chamador lembrar de mandar a alça. Os três casos abaixo medem a fronteira inteira:
// raster sem alça é RECUSADO, modelo sem raster sem alça é aceito, e raster COM alça grava o companheiro.

const CONSENT_ID = `${'A'.repeat(21)}Q`;

async function terminalGraph(auditId, { raster = true } = {}) {
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  // O raster sai ANTES do enriquecimento: os hashes de integridade são recalculados depois, e um modelo
  // alterado à mão depois disso é recusado pelo próprio armazenamento (não é o caso que se quer medir).
  if (!raster) for (const artifact of draft.evidence ?? []) delete artifact.dataUrl;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = {
    version: 1,
    auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [],
    })),
  };
  const latestState = {
    version: 1, auditId, status: model.session.status, percent: 100,
    message: 'Avaliação concluída com limitações.', failureCode: null,
    modelRevision: 1, updatedAt: '2026-08-29T12:00:00.000Z',
  };
  return { auditId, model, checkpoint, latestState };
}

function rasterCount(model) {
  return (model.evidence ?? []).filter(artifact => typeof artifact?.dataUrl === 'string').length;
}

function sessionArea() {
  const values = {};
  return {
    values,
    // `chrome.storage.session.get(null)` devolve a área inteira: o `scanMarker` do ciclo de vida depende
    // disso para achar o marcador por prefixo de auditId (é o caminho da tentativa DIRETA, sem consentId).
    async get(key) {
      if (key === null) return structuredClone(values);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) { delete values[key]; },
  };
}

async function lifecycleFixture(store) {
  const area = sessionArea();
  const binding = createPixelAttemptStoreBindingV1(store, area);
  const coordinator = createPixelAttemptCorrelationV1({
    sessionArea: area,
    attemptAuthority: createSessionPixelAttemptDigestAuthority({
      sessionArea: area, subtle: webcrypto.subtle,
      randomBytes: length => new Uint8Array(length).fill(9), now: () => 10,
    }),
    now: () => 100,
    storeBinding: binding,
  });
  const lifecycle = createPixelAttemptLifecycleV1({
    sessionArea: area,
    auditStore: store,
    attemptAuthority: createSessionPixelAttemptDigestAuthority({
      sessionArea: area, subtle: webcrypto.subtle,
      randomBytes: length => new Uint8Array(length).fill(9), now: () => 10,
    }),
    attemptCorrelation: coordinator,
    modelNow: () => '2026-08-29T12:00:00.000Z',
  });
  const handle = await lifecycle.prepareResume({
    auditId: 'audit-terminal-correlation', consentId: CONSENT_ID, pageId: null, ownershipId: null, expiresAt: 200,
  });
  return { lifecycle, handle, coordinator };
}

async function bareLifecycle(store) {
  const area = sessionArea();
  const binding = createPixelAttemptStoreBindingV1(store, area);
  const authority = createSessionPixelAttemptDigestAuthority({
    sessionArea: area, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(9), now: () => 10,
  });
  const coordinator = createPixelAttemptCorrelationV1({
    sessionArea: area, attemptAuthority: authority, now: () => 100, storeBinding: binding,
  });
  const lifecycle = createPixelAttemptLifecycleV1({
    sessionArea: area,
    auditStore: store,
    attemptAuthority: authority,
    attemptCorrelation: coordinator,
    modelNow: () => '2026-08-29T12:00:00.000Z',
  });
  const markers = () => Object.keys(area.values ?? {}).filter(key => key.startsWith('audita:pixel-attempt:v1:'));
  return { lifecycle, area, markers, coordinator, authority };
}

// ACHADO A-1 DA REVISÃO DO CONSERTO: a página pode revelar sinal sensível DEPOIS de o portão armar sem pausa
// (SPA que renderiza o formulário tarde, modal de login). Nesse caso existem, em sequência, a tentativa DIRETA
// e a CONSENTIDA para o MESMO auditId — e `scanMarker` fica `blocked` com dois marcadores, o que mataria a
// auditoria já consentida e deixaria resíduo. A consentida só entra depois de a direta sair.
test('a tentativa direta é aposentada quando o consentimento chega depois (achado A-1)', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-terminal-correlation';
  const graph = await terminalGraph(auditId);
  assert.ok(rasterCount(graph.model) > 0, 'a fixture precisa CONTER raster, senão o caso é vazio');
  const { lifecycle, markers, coordinator, authority } = await bareLifecycle(store);
  const direta = await lifecycle.prepareDirect({ auditId, expiresAt: 200 });
  assert.deepEqual(Object.keys(direta), []);
  assert.equal(markers().length, 1);
  const digestoDireto = (await authority.digestDirectAttempt({ auditId })).slice('hmac-sha256:'.length);
  const digestoConsentido = (await authority.digestAttempt({ auditId, consentId: CONSENT_ID })).slice('hmac-sha256:'.length);
  assert.equal(markers()[0], `audita:pixel-attempt:v1:${auditId}:${digestoDireto}`);
  assert.equal(
    (await lifecycle.classify({ auditId, consentId: null, pageId: null, ownershipId: null })).state, 'prepared',
  );
  const consentida = await lifecycle.prepareResume({
    auditId, consentId: CONSENT_ID, pageId: null, ownershipId: null, expiresAt: 200,
  });
  assert.equal(markers().length, 1, 'direta e consentida não podem conviver no mesmo auditId');
  assert.equal(
    (await lifecycle.classify({ auditId, consentId: CONSENT_ID, pageId: null, ownershipId: null })).state, 'prepared',
    'o marcador que fica é o consentido',
  );
  assert.equal(markers()[0], `audita:pixel-attempt:v1:${auditId}:${digestoConsentido}`,
    'o marcador que fica é o consentido, não o direto');
  assert.equal(await coordinator.markerMatches({
    auditId, attemptDigest: `hmac-sha256:${digestoDireto}`, pageId: null, ownershipId: null,
  }), false, 'a direta aposentada não pode mais ser lida');
  const committed = await lifecycle.commitTerminal({ ...graph, expectedRevision: 1, attemptHandle: consentida });
  assert.equal(committed.revision, 1, 'a auditoria consentida conclui depois de a direta ser aposentada');
  assert.equal(
    (await lifecycle.classify({ auditId, consentId: CONSENT_ID, pageId: null, ownershipId: null })).state, 'terminal',
  );
  assert.equal(await lifecycle.cleanup({
    auditId, consentId: CONSENT_ID, pageId: null, ownershipId: null, expected: 'post-finish',
  }), true);
  assert.equal(markers().length, 0, 'não pode sobrar marcador depois da limpeza');
});

test('raster sem a alça da tentativa não é persistido e o store nem é chamado', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-terminal-correlation';
  const graph = await terminalGraph(auditId);
  assert.ok(rasterCount(graph.model) > 0, 'a fixture precisa CONTER raster, senão o caso é vazio');
  let calls = 0;
  const guarded = {
    ...store,
    async commitAuditWithCheckpointIfAbsent(...args) { calls += 1; return store.commitAuditWithCheckpointIfAbsent(...args); },
  };
  const { lifecycle } = await lifecycleFixture(guarded);
  await assert.rejects(
    () => lifecycle.commitTerminal({ ...graph, expectedRevision: 1, attemptHandle: null }),
    /TERMINAL_COMMIT_DENIED/u,
  );
  assert.equal(calls, 0, 'sem correlação durável o commit não pode nem chegar ao armazenamento');
  assert.equal(await store.getReportRevision(auditId), null);
});

test('modelo sem raster continua commitando sem alça (modo no-pixels)', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-terminal-correlation';
  const graph = await terminalGraph(auditId, { raster: false });
  assert.equal(rasterCount(graph.model), 0, 'o caso sem raster precisa ser vazio de pixels');
  const { lifecycle } = await lifecycleFixture(store);
  const committed = await lifecycle.commitTerminal({ ...graph, expectedRevision: 1, attemptHandle: null });
  assert.equal(committed.revision, 1);
  assert.match(committed.modelHash, /^[a-f0-9]{64}$/u);
  assert.equal((await store.getReportRevision(auditId))?.modelRevision, 1);
});

test('raster COM alça grava o companheiro durável da tentativa', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-terminal-correlation';
  const graph = await terminalGraph(auditId);
  const { lifecycle, handle } = await lifecycleFixture(store);
  const committed = await lifecycle.commitTerminal({ ...graph, expectedRevision: 1, attemptHandle: handle });
  assert.equal(committed.revision, 1);
  const classification = await lifecycle.classify({ auditId, consentId: CONSENT_ID, pageId: null, ownershipId: null });
  assert.equal(classification.state, 'terminal', 'a correlação durável precisa ser legível depois do commit');
});
