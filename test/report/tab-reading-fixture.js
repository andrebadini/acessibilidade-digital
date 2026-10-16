/**
 * Fixture da leitura por Tab: um modelo com paradas de Tab, o mapa do teclado que as numera e as
 * respostas de revisão já registradas.
 *
 * A construção segue o caminho real do produto, e não um atalho: as paradas viram alvos da regra
 * `tab-reading-announcement`, o item 5.13.10 é reagregado com `aggregateItems`, as ocorrências nascem
 * com o mesmo formato que `src/background/run-audit.js` produz e a fila de revisão é a mesma que a
 * revisão guiada consome. Só assim o teste prova o que a pessoa vê no relatório, e não uma cópia.
 */
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';
import { buildReportView } from '../../src/review/report-view.js';
import { canonicalCoreRuleLimitations, canonicalCoreRuleSummary, canonicalReviewQuestion } from '../../src/core/report/text-policy.js';
import { hashKeyboardMapArtifact, KEYBOARD_MAP_ALGORITHM, KEYBOARD_MAP_LIMITS, KEYBOARD_MAP_VERSION } from '../../src/core/keyboard/keyboard-map-artifact.js';
import { coreRuleImpact } from '../../src/core/rules/impact-policy.js';
import { section508ReferencesForWcag } from '../../src/core/normative/section508.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { canonicalCoreRemediation } from '../../src/core/report/remediation-policy.js';
import { TAB_READING_MESSAGE, TAB_READING_REASON, TAB_READING_RULE_ID } from '../../src/core/rules/tab-reading.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import { createPristineMapSource, TEST_PAGE_CSS, TEST_PAGE_PIXELS, TEST_PNG, TEST_PNG_HASH } from './annotation-map-fixture.js';

export { TEST_PNG };

/** Paradas padrão: um botão com nome, um campo sem nome e um link com nome diferente do texto visível. */
export const DEFAULT_STOPS = Object.freeze([
  Object.freeze({
    nodeId: 'n-tab-1', tag: 'button', role: 'button', name: 'Buscar', nameSource: 'contents',
    visibleText: 'Buscar', announcement: 'Buscar, botão', bounds: { x: 10, y: 8, width: 100, height: 24 },
  }),
  Object.freeze({
    nodeId: 'n-tab-2', tag: 'input', role: 'textbox', name: '', nameSource: null,
    visibleText: '', announcement: 'caixa de texto', bounds: { x: 10, y: 40, width: 120, height: 22 },
  }),
  Object.freeze({
    nodeId: 'n-tab-3', tag: 'a', role: 'link', name: 'Pesquisar', nameSource: 'aria-label',
    visibleText: 'Saiba mais', announcement: 'Pesquisar, link', bounds: { x: 10, y: 70, width: 90, height: 20 },
  }),
]);

function elementArtifact(stop) {
  return {
    evidenceId: `ev-${stop.nodeId}`,
    pageId: 'page-1',
    kind: 'element',
    nodeId: stop.nodeId,
    backendNodeId: 700,
    selector: { css: `#${stop.nodeId}`, framePath: [] },
    snippet: `<${stop.tag} id="${stop.nodeId}">${stop.visibleText}</${stop.tag}>`,
    dataUrl: TEST_PNG,
    // A ficha do elemento diz qual é o quadro da imagem e onde o elemento está dentro dele: é essa
    // caixa que o recorte contorna. Sem ela a tela mostraria a miniatura crua, sem contorno.
    metadata: {
      width: TEST_PAGE_PIXELS.width, height: TEST_PAGE_PIXELS.height,
      highlightBox: { ...stop.bounds, coordinateSpace: 'capture-css-px' },
    },
    fullPageEvidenceId: 'ev-full',
    hash: 'sha256-element-fixture',
    accessibility: {
      name: stop.name || null,
      nameSource: stop.nameSource ?? null,
      description: null,
      descriptionSource: null,
      role: stop.role,
      states: [],
      visibleText: stop.visibleText || null,
      announcementPreview: stop.announcement,
    },
  };
}

/** Mapa do teclado com uma parada por ponto, na mesma ordem: é ele que numera as linhas da seção. */
export async function tabKeyboardMap(stops = DEFAULT_STOPS) {
  const artifact = {
    evidenceId: 'ev-keyboard-map',
    pageId: 'page-1',
    kind: 'keyboard-map',
    state: 'derived',
    fullPageEvidenceId: 'ev-full',
    derivation: {
      type: 'annotated-keyboard-map',
      algorithm: KEYBOARD_MAP_ALGORITHM,
      version: KEYBOARD_MAP_VERSION,
      sourceEvidenceId: 'ev-full',
      sourceHash: TEST_PNG_HASH,
      geometry: {
        coordinateSpace: 'document-css-px',
        sourceCssSize: { ...TEST_PAGE_CSS },
        sourcePixelSize: { ...TEST_PAGE_PIXELS },
        scaleX: 1,
        scaleY: 1,
        deviceScaleFactor: 1,
      },
    },
    status: 'complete',
    segments: [{
      segmentId: 'ev-keyboard-map-segment-1', index: 1, count: 1, role: 'image',
      sourceCssClip: { x: 0, y: 0, ...TEST_PAGE_CSS },
      width: TEST_PAGE_PIXELS.width, height: TEST_PAGE_PIXELS.height,
      dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
    }],
    stops: stops.map((stop, index) => ({
      number: index + 1,
      nodeId: stop.nodeId,
      tag: stop.tag,
      kind: stop.role === 'link' ? 'link' : stop.role === 'textbox' ? 'field' : 'button',
      tabIndex: 0,
      name: stop.name,
      nameSource: stop.nameSource ?? 'none',
      nameStatus: 'projected',
      bounds: { ...stop.bounds },
      segmentIndex: 1,
    })),
    suspects: [],
    counts: {
      eligible: stops.length, stops: stops.length, suspects: 0,
      omittedNotVisible: 0, omittedNoRect: 0, omittedClipped: 0, omittedFrame: 0, omittedLimit: 0,
    },
    limits: { ...KEYBOARD_MAP_LIMITS },
    limitations: ['tab-order-estimated-not-observed', 'top-document-open-shadow-only'],
    hash: '0'.repeat(64),
  };
  artifact.hash = await hashKeyboardMapArtifact(artifact);
  return artifact;
}

function tabOccurrence(stop, evidenceIds) {
  return {
    occurrenceId: `occ-tab-${stop.nodeId}`,
    itemId: '5.13.10',
    nbrItemRef: '5.13.10',
    ruleId: TAB_READING_RULE_ID,
    outcome: 'cantTell',
    mode: 'automated',
    nodeId: stop.nodeId,
    pageId: 'page-1',
    source: { engine: 'audita-core', ruleId: TAB_READING_RULE_ID, version: '1.0.0' },
    target: { nodeId: stop.nodeId, selector: null, framePath: [] },
    equivalenceKey: `audita:${TAB_READING_RULE_ID}`,
    presentationTargetKey: `node:${stop.nodeId}`,
    evidenceIds,
    evidenceRefs: [...evidenceIds],
    itemWcagRefs: ['4.1.2'],
    sourceWcagRefs: ['4.1.2'],
    testedWcagRefs: [],
    wcagRefs: [],
    foreignBenchmarkRefs: [],
    // O texto que a pessoa lê é o do alvo da regra; a justificativa guardada no modelo é a canônica do
    // item, como em toda ocorrência do motor próprio (o pipeline V1 a reescreve ao fechar o modelo).
    justification: canonicalCoreRuleSummary(TAB_READING_RULE_ID, 'cantTell'),
    impact: coreRuleImpact(TAB_READING_RULE_ID),
    classification: 'requirement',
    confidence: 'low',
    accessiblePreview: stop.announcement,
    legalAnalysis: null,
  };
}

function ruleWithTabTargets(draft, stops, { tabRule = true, nameFailures = [] } = {}) {
  const targets = stops.map(stop => ({
    nodeId: stop.nodeId,
    data: { reason: TAB_READING_REASON },
    message: TAB_READING_MESSAGE,
  }));
  return draft.ruleResults
    .filter(rule => tabRule || rule.ruleId !== TAB_READING_RULE_ID)
    .map(rule => {
      if (rule.ruleId === 'accessible-component-name' && nameFailures.length) {
        return {
          ...rule,
          outcome: 'failed',
          targets: nameFailures.map(nodeId => ({
            nodeId,
            data: { reason: 'missing-accessible-name' },
            message: canonicalCoreRemediation('accessible-component-name', { reason: 'missing-accessible-name' }),
          })),
          summary: canonicalCoreRuleSummary('accessible-component-name', 'failed'),
          limitations: [...canonicalCoreRuleLimitations('failed')],
        };
      }
      if (rule.ruleId !== TAB_READING_RULE_ID) return rule;
      return {
        ...rule,
        outcome: 'cantTell',
        targets,
        summary: canonicalCoreRuleSummary(TAB_READING_RULE_ID, 'cantTell'),
        limitations: [...canonicalCoreRuleLimitations('cantTell')],
      };
    });
}

/**
 * Ocorrência de falha automática de nome acessível no mesmo nó de uma parada: é ela que vira pista na
 * pergunta, porque fala justamente do nome que o leitor de tela anuncia.
 */
function nameFailureOccurrence(nodeId) {
  return {
    occurrenceId: `occ-name-${nodeId}`,
    itemId: '5.13.10',
    nbrItemRef: '5.13.10',
    ruleId: 'accessible-component-name',
    outcome: 'failed',
    mode: 'automated',
    nodeId,
    pageId: 'page-1',
    source: { engine: 'audita-core', ruleId: 'accessible-component-name', version: '1.0.0' },
    target: { nodeId, selector: null, framePath: [] },
    equivalenceKey: 'audita:accessible-component-name',
    presentationTargetKey: `node:${nodeId}`,
    evidenceIds: ['ev-full', `ev-${nodeId}`],
    evidenceRefs: ['ev-full', `ev-${nodeId}`],
    itemWcagRefs: ['4.1.2'],
    sourceWcagRefs: ['4.1.2'],
    testedWcagRefs: ['4.1.2'],
    wcagRefs: ['4.1.2'],
    foreignBenchmarkRefs: section508ReferencesForWcag(['4.1.2']).map(reference => ({ ...reference })),
    justification: canonicalCoreRuleSummary('accessible-component-name', 'failed'),
    impact: coreRuleImpact('accessible-component-name'),
    classification: 'requirement',
    confidence: 'high',
    accessiblePreview: null,
    legalAnalysis: { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id },
  };
}

function withItems(ruleResults) {
  return aggregateItems(ruleResults, NBR17225_ITEMS).map(item => ({
    ...item,
    wcag: item.wcag.map(reference => ({ ...reference })),
    ruleIds: [...item.ruleIds],
    ruleResults: item.ruleResults.map(rule => rule.ruleId),
  }));
}

/**
 * Rascunho de auditoria com os pontos de Tab da fixture: é ele que alimenta tanto o modelo fechado
 * (`createAuditModel`) quanto o caminho de exportação (`enrichAuditForReport`), para que os dois testes
 * falem da mesma auditoria.
 */
export async function tabReadingDraft({
  stops = DEFAULT_STOPS, map = true, mapStops = null, tabRule = true, nameFailures = [],
} = {}) {
  const draft = structuredClone(SAMPLE_AUDIT);
  const ruleResults = ruleWithTabTargets(draft, stops, { tabRule, nameFailures });
  draft.ruleResults = ruleResults;
  // Sem a regra da leitura por Tab o modelo é o de uma auditoria gravada na 1.1.61: o inventário da
  // própria versão (131 regras próprias) continua abrindo, sem reescrever nada.
  if (!tabRule) draft.methodology = { ...draft.methodology, coreRuleCount: 131, ruleCount: 131 };
  draft.itemResults = withItems(ruleResults);
  draft.evidence = [createPristineMapSource(), ...draft.evidence.slice(1), ...stops.map(elementArtifact)];
  if (map) draft.evidence.push(await tabKeyboardMap(mapStops ?? stops));
  draft.occurrences = [
    ...draft.occurrences,
    ...stops.map(stop => tabOccurrence(stop, ['ev-full', `ev-${stop.nodeId}`])),
    ...nameFailures.map(nameFailureOccurrence),
  ];
  const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  draft.manualReview = [
    ...draft.manualReview,
    ...stops.map(stop => ({
      occurrenceId: `occ-tab-${stop.nodeId}`,
      itemId: '5.13.10',
      ruleId: TAB_READING_RULE_ID,
      mode: 'assisted',
      status: 'unanswered',
      question: canonicalReviewQuestion(itemById.get('5.13.10')),
      reason: canonicalCoreRuleSummary(TAB_READING_RULE_ID, 'cantTell'),
    })),
  ];
  return draft;
}

function tabDecisions(model, answers, stops) {
  const stopById = new Map(stops.map(stop => [stop.nodeId, stop]));
  return answers.map(({ nodeId, answer, note, evaluator = 'Fiscal Ana', decidedAt = '2026-08-27T12:00:00.000Z' }) => {
    const decision = createReviewDecision({
      auditId: model.auditId,
      itemId: '5.13.10',
      occurrenceId: `occ-tab-${nodeId}`,
      answer,
      ...(note === undefined ? {} : { note }),
      evaluator,
      decidedAt,
      mode: 'assisted',
    });
    assertStop(decision, stopById);
    return decision;
  });
}

/** Respostas da fixture aplicadas ao rascunho, antes de a auditoria ser fechada para o relatório. */
export function answerTabDraft(draft, answers, stops = DEFAULT_STOPS) {
  if (answers.length === 0) return draft;
  return structuredClone(applyReviewDecisions(draft, tabDecisions(draft, answers, stops)));
}

/** Respostas da fixture aplicadas a um modelo já fechado, pelo mesmo `applyReviewDecisions` da revisão. */
export function answerTabRows(model, answers, stops = DEFAULT_STOPS) {
  if (answers.length === 0) return model;
  return applyReviewDecisions(model, tabDecisions(model, answers, stops));
}

/**
 * Modelo com os pontos de Tab da fixture.
 *
 * `answers` é a lista de respostas por `nodeId` (`[{ nodeId, answer, note }]`), aplicada pelo mesmo
 * `applyReviewDecisions` que a revisão guiada usa — inclusive a trilha de revisão, quando `revise`.
 */
export async function tabReadingModel({ answers = [], ...options } = {}) {
  const stops = options.stops ?? DEFAULT_STOPS;
  const model = createAuditModel(await tabReadingDraft({ ...options, stops }));
  return { model: answerTabRows(model, answers, stops), stops };
}

/**
 * A auditoria pelo caminho de entrega: `enrichAuditForReport`, resumo do painel e `ReportView`. É esse
 * par (modelo enriquecido + ReportView) que o HTML e o PDF entregues consomem.
 */
export async function tabReadingReport({ answers = [], ...options } = {}) {
  const inventory = await createInstalledCoreRuleInventory();
  const stops = options.stops ?? DEFAULT_STOPS;
  const draft = answerTabDraft(await tabReadingDraft({ ...options, stops }), answers, stops);
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba', manifestVersion: '1.0.1',
    rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/151.0.0.0',
  });
  const executionCheckpoint = {
    version: 1, auditId: model.auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: [{ ruleId: 'focus-fully-visible', outcome: 'passed' }, { ruleId: 'keyboard-focus-trap', outcome: 'untested' }],
    })),
  };
  const summary = await buildPanelSummary({ model, executionCheckpoint, inventory });
  const view = buildReportView({
    model, summary, modelRevision: 1, modelHash: model.integrity.canonicalModelHash,
  });
  return { model, summary, view, inventory, draft };
}

function assertStop(decision, stopById) {
  const nodeId = decision.occurrenceId.replace(/^occ-tab-/u, '');
  if (!stopById.has(nodeId)) throw new TypeError(`A fixture não tem a parada ${nodeId}.`);
}
