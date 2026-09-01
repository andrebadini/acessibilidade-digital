import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { buildPanelDetail, createPanelDetailProjector } from '../../src/panel/panel-detail.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';

function checkpointFor(inventory, model = SAMPLE_AUDIT) {
  return {
    version: 1,
    auditId: model.auditId,
    pages: [{
      pageId: 'page-1', attempted: true,
      startedAt: model.pages[0].timestamps.startedAt,
      rulesVersion: inventory.rulesVersion,
      inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: [{ ruleId: 'focus-fully-visible', outcome: 'passed' }],
    }],
  };
}

async function summaryFixture(model = SAMPLE_AUDIT) {
  const inventory = await createInstalledCoreRuleInventory();
  return buildPanelSummary({ model, executionCheckpoint: checkpointFor(inventory, model), inventory });
}

test('reuses one validated model and summary to project every requested detail', async () => {
  const summary = await summaryFixture();
  const project = createPanelDetailProjector({
    model: SAMPLE_AUDIT, summary, highlightAvailability: new Map(),
  });
  const occurrenceIds = Object.values(summary.groups).flatMap(group =>
    group.flatMap(card => card.occurrenceIds));

  assert.equal(Object.isFrozen(project), true);
  for (const occurrenceId of occurrenceIds) {
    assert.deepEqual(
      project(occurrenceId),
      buildPanelDetail({ model: SAMPLE_AUDIT, summary, occurrenceId, highlightAvailability: new Map() }),
    );
  }
});

function editorialModel() {
  const model = structuredClone(SAMPLE_AUDIT);
  model.methodology.supplementalRuleCount += 1;
  model.methodology.ruleCount += 1;
  model.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-1', selectorHint: '', message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  model.occurrences.push({
    occurrenceId: 'occ-editorial-detail', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-1', selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: [], legalAnalysis: null, itemId: null, ruleId: 'editorial.placeholder-text',
    mode: 'automated', nodeId: 'n-1', evidenceIds: [],
    justification: 'Há conteúdo provisório inequívoco na página.',
  });
  return model;
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
  assert.match(failed.legalReference.statement, /Quando aplicável a uma relação de consumo/u);
  assert.match(failed.legalReference.statement, /subsídio para avaliar possível infração/u);
  assert.doesNotMatch(failed.legalReference.statement, /A referida desconformidade infringe/u);
  assert.match(failed.legalReference.statement, /item 5\.1\.1 da ABNT NBR 17225:2025/u);
  assert.equal(failed.legalReference.qualification, CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification);
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

test('uses only correlated evidence accessibility and never falls back to occurrence accessiblePreview', async () => {
  const marker = 'PRIVATE_ACCESSIBLE_PREVIEW';
  const model = structuredClone(SAMPLE_AUDIT);
  delete model.evidence.find(value => value.evidenceId === 'ev-control').accessibility;
  model.occurrences.find(value => value.occurrenceId === 'occ-focus-failed').accessiblePreview = marker;
  const summary = await summaryFixture(model);
  const detail = buildPanelDetail({
    model, summary, occurrenceId: 'occ-focus-failed', highlightAvailability: new Map(),
  });

  assert.deepEqual(detail.accessibility, { name: null, nameSource: null, announcementPreview: null });
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(marker, 'u'));
});

for (const evidenceNodeState of ['absent', 'null']) {
  test(`does not assign ${evidenceNodeState} evidence node accessibility to an element detail`, async () => {
    const model = structuredClone(SAMPLE_AUDIT);
    const artifact = model.evidence.find(value => value.evidenceId === 'ev-control');
    if (evidenceNodeState === 'absent') delete artifact.nodeId;
    else artifact.nodeId = null;
    const summary = await summaryFixture(model);
    const detail = buildPanelDetail({
      model, summary, occurrenceId: 'occ-focus-failed', highlightAvailability: new Map(),
    });

    assert.deepEqual(detail.accessibility, {
      name: null, nameSource: null, announcementPreview: null,
    });
  });
}

test('keeps the normative trio null only without an ABNT item and rejects partial card adulteration', async () => {
  const model = editorialModel();
  const summary = await summaryFixture(model);
  const detail = buildPanelDetail({
    model, summary, occurrenceId: 'occ-editorial-detail', highlightAvailability: new Map(),
  });
  assert.equal(detail.normative.abntItem, null);
  assert.equal(detail.normative.classification, null);
  assert.equal(detail.legalReference, null);

  const forgedEditorial = structuredClone(summary);
  forgedEditorial.groups.alerts[0].abntItemIds = ['5.1.1'];
  assert.throws(() => buildPanelDetail({
    model, summary: forgedEditorial, occurrenceId: 'occ-editorial-detail', highlightAvailability: new Map(),
  }), /PANEL_DETAIL_OCCURRENCE_DENIED/u);

  const officialSummary = structuredClone(await summaryFixture());
  officialSummary.groups.failed[0].abntItemIds = [];
  assert.throws(() => buildPanelDetail({
    model: SAMPLE_AUDIT, summary: officialSummary,
    occurrenceId: 'occ-focus-failed', highlightAvailability: new Map(),
  }), /PANEL_DETAIL_OCCURRENCE_DENIED/u);
});

test('re-sanitizes the technical snippet at the detail boundary without losing public source', async () => {
  const model = structuredClone(SAMPLE_AUDIT);
  model.evidence.find(value => value.evidenceId === 'ev-control').snippet = [
    '<a href="javascript:PRIVATE_SCHEME" onclick="PRIVATE_HANDLER">Abrir</a>',
    '<a href="https://user:pass@example.test/path?token=PRIVATE_TOKEN&lang=pt#authorization=Bearer_PRIVATE_AUTHORITY">Público</a>',
    '<p>authorization=Bearer_PRIVATE_AUTHORITY token=PRIVATE_TEXT conteúdo público</p>',
  ].join('');
  const summary = await summaryFixture(model);
  const detail = buildPanelDetail({
    model, summary, occurrenceId: 'occ-focus-failed', highlightAvailability: new Map(),
  });

  assert.match(detail.technical.snippet, /<a>Abrir<\/a>/u);
  assert.match(detail.technical.snippet, /href="https:\/\/example\.test\/path\?lang=pt"/u);
  assert.match(detail.technical.snippet, /authorization=\[redacted\] token=\[redacted\]/u);
  assert.match(detail.technical.snippet, /conteúdo público/u);
  assert.doesNotMatch(detail.technical.snippet, /PRIVATE_|javascript:|onclick|user:pass|Bearer_/iu);
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
