import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { buildPanelDetail } from '../../src/panel/panel-detail.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';

function checkpointFor(inventory) {
  return {
    version: 1,
    auditId: SAMPLE_AUDIT.auditId,
    pages: [{
      pageId: 'page-1', attempted: true,
      startedAt: SAMPLE_AUDIT.pages[0].timestamps.startedAt,
      rulesVersion: inventory.rulesVersion,
      inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: [{ ruleId: 'focus-fully-visible', outcome: 'passed' }],
    }],
  };
}

async function summaryFixture() {
  const inventory = await createInstalledCoreRuleInventory();
  return buildPanelSummary({ model: SAMPLE_AUDIT, executionCheckpoint: checkpointFor(inventory), inventory });
}

test('projects the ten ordered detail blocks from canonical precedence without a live highlight claim', async () => {
  const summary = await summaryFixture();
  const detail = buildPanelDetail({
    model: SAMPLE_AUDIT,
    summary,
    occurrenceId: 'occ-focus-failed',
    highlightAvailability: new Map(),
  });
  const card = Object.values(summary.groups).flat()
    .find(row => row.occurrenceIds.includes('occ-focus-failed'));

  assert.deepEqual(Object.keys(detail).slice(4), [
    'heading', 'affected', 'observed', 'correction', 'targets', 'accessibility',
    'normative', 'legalReference', 'previews', 'technical', 'action',
  ]);
  assert.deepEqual(detail.heading, {
    title: 'Indicador de foco visível', classification: card.classification,
    impact: 'moderate', context: 'top-document',
  });
  assert.deepEqual(detail.affected, {
    audience: 'Requisito “Indicador de foco visível”: não conformidade técnica identificada.',
    reason: 'Requisito “Indicador de foco visível”: não conformidade técnica identificada.',
  });
  assert.equal(detail.observed, 'Requisito “Indicador de foco visível”: não conformidade técnica identificada.');
  assert.equal(detail.correction, 'Requisito “Indicador de foco visível”: não conformidade técnica identificada.');
  assert.deepEqual(detail.targets, [{ nodeId: 'n-1', position: 1, total: 1 }]);
  assert.deepEqual(detail.accessibility, {
    name: 'Continuar', nameSource: 'aria-label',
    announcementPreview: 'Continuar, botão, Avança para a próxima etapa',
  });
  assert.deepEqual(detail.normative, {
    wcag: ['2.4.7'], level: ['AA'], abntItem: '5.1.1', classification: 'requirement',
  });
  assert.deepEqual(detail.action, {
    kind: 'consult-evidence',
    reason: 'Esta verificação não possui um elemento único destacável no estado atual.',
  });
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail.technical.hashes), true);
});

test('joins previews only through evidenceRefs, preserves safe PNG/HTTP media and projects only canonical origins', async () => {
  const summary = await summaryFixture();
  const detail = buildPanelDetail({
    model: SAMPLE_AUDIT,
    summary,
    occurrenceId: 'occ-focus-failed',
    highlightAvailability: new Map(),
  });

  assert.deepEqual(detail.previews.map(preview => preview.evidenceId), ['ev-full', 'ev-control']);
  assert.equal(detail.previews[0].dataUrl.startsWith('data:image/png;base64,'), true);
  assert.equal(detail.previews[1].mediaUrl, 'https://servico.exemplo.test/assets/controle.png');
  assert.equal(detail.previews[1].origin, 'https://servico.exemplo.test/');
  assert.equal(detail.technical.selector, '#continuar');
  assert.deepEqual(detail.technical.framePath, []);
  assert.equal(detail.technical.snippet, '<button id="continuar" aria-label="Continuar">Avançar</button>');
  assert.deepEqual(detail.technical.hashes, ['sha256-full-page-sample', 'sha256-element-sample']);
});

test('renders the qualified fixed legal basis only for an eligible failed official item', async () => {
  const summary = await summaryFixture();
  const failed = buildPanelDetail({
    model: SAMPLE_AUDIT, summary, occurrenceId: 'occ-focus-failed', highlightAvailability: new Map(),
  });
  const pending = buildPanelDetail({
    model: SAMPLE_AUDIT, summary, occurrenceId: 'occ-focus-review', highlightAvailability: new Map(),
  });

  assert.equal(failed.legalReference.basisRef, CONSUMER_ACCESSIBILITY_FIXED_BASIS.id);
  assert.equal(failed.legalReference.abntItem, '5.1.1');
  assert.match(failed.legalReference.statement, /item 5\.1\.1 da ABNT NBR 17225:2025/u);
  assert.match(failed.legalReference.qualification, /não constitui conclusão automática de infração, responsabilidade ou sanção/u);
  assert.equal(pending.legalReference, null);
});

test('uses the singular selected item in detail and the sorted unique official item list in its card', async () => {
  const summary = await summaryFixture();
  const detail = buildPanelDetail({
    model: SAMPLE_AUDIT, summary, occurrenceId: 'occ-focus-review', highlightAvailability: new Map(),
  });
  const card = Object.values(summary.groups).flat()
    .find(row => row.occurrenceIds.includes('occ-focus-review'));

  assert.deepEqual(card.abntItemIds, ['5.1.4']);
  assert.equal(detail.normative.abntItem, '5.1.4');
  assert.equal(detail.heading.title, 'Ordem de foco previsível');
  assert.equal(detail.affected.audience, 'A verificação exige interação e julgamento humano sobre o comportamento observado.');
  assert.equal(detail.observed, 'Requisito “Ordem de foco previsível”: conclusão dependente de revisão humana.');
});

test('denies detail for a checkpoint-only pass and for an occurrence not represented by exactly one card', async () => {
  const summary = await summaryFixture();
  const forged = structuredClone(summary);
  forged.groups.failed.push(structuredClone(forged.groups.failed[0]));
  const forgedContext = structuredClone(summary);
  forgedContext.groups.failed[0].context = 'mixed';

  assert.throws(
    () => buildPanelDetail({
      model: SAMPLE_AUDIT, summary, occurrenceId: 'focus-fully-visible', highlightAvailability: new Map(),
    }),
    /PANEL_DETAIL_OCCURRENCE_DENIED/u,
  );
  assert.throws(
    () => buildPanelDetail({
      model: SAMPLE_AUDIT, summary: forged, occurrenceId: 'occ-focus-failed', highlightAvailability: new Map(),
    }),
    /PANEL_DETAIL_OCCURRENCE_DENIED/u,
  );
  assert.throws(
    () => buildPanelDetail({
      model: SAMPLE_AUDIT, summary: forgedContext, occurrenceId: 'occ-focus-failed', highlightAvailability: new Map(),
    }),
    /PANEL_DETAIL_OCCURRENCE_DENIED/u,
  );
});

test('never infers highlight from presentationTargetKey, node, selector or evidence', async () => {
  const summary = await summaryFixture();
  const detail = buildPanelDetail({
    model: SAMPLE_AUDIT,
    summary,
    occurrenceId: 'occ-focus-failed',
    highlightAvailability: new Map([['occ-focus-failed', true]]),
  });
  assert.deepEqual(detail.action, {
    kind: 'consult-evidence',
    reason: 'Esta verificação não possui um elemento único destacável no estado atual.',
  });
});

test('fails closed on unsafe URL schemes and hostile detail inputs without echoing private data', async () => {
  const summary = await summaryFixture();
  for (const unsafeUrl of [
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'blob:https://servico.exemplo.test/private',
    'chrome-extension://private/evidence.png',
  ]) {
    const model = structuredClone(SAMPLE_AUDIT);
    model.evidence.find(value => value.evidenceId === 'ev-control').mediaUrl = unsafeUrl;
    assert.throws(
      () => buildPanelDetail({ model, summary, occurrenceId: 'occ-focus-failed', highlightAvailability: new Map() }),
      error => {
        assert.doesNotMatch(String(error?.message ?? error), /javascript|svg|blob|chrome-extension|private/iu);
        return true;
      },
    );
  }

  const marker = 'PRIVATE_DETAIL_PROXY_MARKER';
  const hostileSummary = new Proxy({}, { ownKeys() { throw new Error(marker); } });
  assert.throws(
    () => buildPanelDetail({
      model: SAMPLE_AUDIT,
      summary: hostileSummary,
      occurrenceId: 'occ-focus-failed',
      highlightAvailability: new Map(),
    }),
    error => {
      assert.doesNotMatch(String(error?.message ?? error), new RegExp(marker, 'u'));
      return true;
    },
  );
});

test('detail output is detached from later model, summary and availability mutations', async () => {
  const model = structuredClone(SAMPLE_AUDIT);
  const summary = structuredClone(await summaryFixture());
  const availability = new Map();
  const detail = buildPanelDetail({
    model, summary, occurrenceId: 'occ-focus-failed', highlightAvailability: availability,
  });
  model.evidence[1].accessibility.name = 'MUTATED';
  summary.groups.failed[0].title = 'MUTATED';
  availability.set('occ-focus-failed', true);

  assert.equal(detail.heading.title, 'Indicador de foco visível');
  assert.equal(detail.accessibility.name, 'Continuar');
  assert.equal(detail.action.kind, 'consult-evidence');
});
