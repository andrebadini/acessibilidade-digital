import { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { section508ReferencesForWcag } from '../../src/core/normative/section508.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { NORMATIVE_SOURCE_LEDGER } from '../../src/core/normative/source-ledger.js';
import { unknownAccessibilityWidgetInventory } from '../../src/core/detection/accessibility-widgets.js';
import { REPORT_HASH_BASE } from '../../src/core/report/integrity-chain.js';
import {
  canonicalCoreRuleLimitations,
  canonicalCoreRuleSummary,
  canonicalReviewQuestion,
  canonicalScope,
} from '../../src/core/report/text-policy.js';
import { CORE_RULES } from '../../src/core/audit.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const SAMPLE_RULE_OUTCOMES = Object.freeze(new Map([
  ['focus-visible', 'failed'],
  ['focus-fully-visible', 'passed'],
  ['focus-partially-visible', 'inapplicable'],
  ['focus-order', 'cantTell'],
  ['keyboard-focus-trap', 'untested'],
]));

const RULE_TARGETS = Object.freeze(new Map([
  ['focus-visible', ['n-1']],
  ['focus-order', ['n-1']],
]));

const ruleResults = CORE_RULES.map(rule => {
  const outcome = SAMPLE_RULE_OUTCOMES.get(rule.id) ?? 'inapplicable';
  return {
    ruleId: rule.id, outcome, mode: rule.mode, nbrItems: [...rule.nbrItems], wcag: [...rule.wcag],
    targets: [...(RULE_TARGETS.get(rule.id) ?? [])],
    summary: canonicalCoreRuleSummary(rule.id, outcome),
    limitations: [...canonicalCoreRuleLimitations(outcome)],
    source: { engine: 'audita-core', ruleId: rule.id, version: '1.0.0' },
  };
});

const itemResults = aggregateItems(ruleResults, NBR17225_ITEMS).map(item => ({
  ...item,
  wcag: item.wcag.map(reference => ({ ...reference })),
  ruleIds: [...item.ruleIds],
  ruleResults: item.ruleResults.map(rule => rule.ruleId),
}));

const TIMESTAMPS = {
  startedAt: '2026-08-26T14:00:00.000Z',
  endedAt: '2026-08-26T14:02:00.000Z',
  generatedAt: '2026-08-26T14:02:01.000Z',
};

const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 };

const EVIDENCE = [
  { evidenceId: 'ev-full', pageId: 'page-1', kind: 'full-page', state: 'pristine', dataUrl: PNG, metadata: { width: 1280, height: 1600 }, hash: 'sha256-full-page-sample' },
  {
    evidenceId: 'ev-control', pageId: 'page-1', kind: 'element', nodeId: 'n-1', backendNodeId: 41,
    selector: { css: '#continuar', framePath: [] }, snippet: '<button id="continuar" aria-label="Continuar">Avançar</button>',
    dataUrl: PNG, fullPageEvidenceId: 'ev-full', mediaUrl: 'https://servico.exemplo.test/assets/controle.png', hash: 'sha256-element-sample',
    accessibility: {
      name: 'Continuar', nameSource: 'aria-label', description: 'Avança para a próxima etapa', descriptionSource: 'aria-describedby',
      role: 'button', states: ['habilitado'], visibleText: 'Avançar', announcementPreview: 'Continuar, botão, Avança para a próxima etapa',
    },
  },
];

const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
const evidenceById = new Map(EVIDENCE.map(evidence => [evidence.evidenceId, evidence]));

function canonicalOccurrence(legacy) {
  const item = itemById.get(legacy.itemId);
  const targetEvidence = legacy.evidenceIds.map(id => evidenceById.get(id)).find(evidence => evidence?.nodeId === legacy.nodeId)
    ?? legacy.evidenceIds.map(id => evidenceById.get(id)).find(Boolean);
  const itemWcagRefs = legacy.ruleId === null ? [] : item.wcag.map(reference => reference.id);
  const sourceWcagRefs = legacy.ruleId === null ? [] : [...itemWcagRefs];
  const testedWcagRefs = legacy.outcome === 'failed' ? [...sourceWcagRefs] : [];
  return {
    ...legacy,
    pageId: 'page-1',
    classification: item.classification,
    impact: 'moderate',
    confidence: legacy.outcome === 'failed' ? 'high' : 'low',
    source: legacy.ruleId === null
      ? { engine: 'audita-manual-review', ruleId: `manual:${item.id}`, version: '1.0.0' }
      : { engine: 'audita-core', ruleId: legacy.ruleId, version: '1.0.0' },
    nbrItemRef: item.id,
    itemWcagRefs, sourceWcagRefs, testedWcagRefs,
    wcagRefs: [...testedWcagRefs],
    foreignBenchmarkRefs: [...section508ReferencesForWcag(testedWcagRefs)],
    target: {
      nodeId: legacy.nodeId,
      selector: null,
      framePath: [],
    },
    accessiblePreview: targetEvidence?.accessibility?.announcementPreview ?? null,
    evidenceRefs: [...legacy.evidenceIds],
    legalAnalysis: legacy.outcome === 'failed'
      ? { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id }
      : null,
  };
}

export const SAMPLE_AUDIT = createAuditModel({
  schemaVersion: 2,
  auditId: 'audit-sample-20260826',
  requestedScope: { mode: 'single', urls: ['https://servico.exemplo.test/consulta'] },
  pages: [{
    pageId: 'page-1',
    requestedUrl: 'https://servico.exemplo.test/consulta',
    finalUrl: 'https://servico.exemplo.test/consulta/inicio',
    status: 'partial', attempted: true, finalUrlObserved: true, axeStatus: 'not-run',
    timestamps: TIMESTAMPS,
    viewport: VIEWPORT,
    warnings: [],
    diagnostics: [{
      code: 'DYNAMIC_PROBES_INCOMPLETE', message: 'As verificações dinâmicas atingiram o tempo limite.',
      at: '2026-08-26T14:00:30.000Z', recoverable: true,
    }],
  }],
  requestedUrl: 'https://servico.exemplo.test/consulta',
  finalUrl: 'https://servico.exemplo.test/consulta/inicio',
  timestamps: TIMESTAMPS,
  timezone: 'America/Cuiaba',
  versions: { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' },
  environment: { chromeVersion: 'Chrome/147.0.0.0', viewport: VIEWPORT },
  scope: canonicalScope('single', 1),
  methodology: { name: 'Audita Acessibilidade — ABNT NBR 17225 e WCAG 2.2', version: '1.0.0', coreRuleCount: 131, supplementalRuleCount: 0, ruleCount: 131, itemCount: 146 },
  session: {
    status: 'partial', partial: true,
    diagnostics: [{
      code: 'DYNAMIC_PROBES_INCOMPLETE', message: 'As verificações dinâmicas atingiram o tempo limite.',
      at: '2026-08-26T14:00:30.000Z', recoverable: true,
    }],
  },
  limitations: [
    'O relatório cobre somente uma página e o estado observado; não constitui declaração de conformidade do site inteiro.',
    'A auditoria foi concluída parcialmente e contém limitações técnicas registradas nos diagnósticos.',
  ],
  ruleResults,
  itemResults,
  occurrences: [
    { occurrenceId: 'occ-focus-failed', itemId: '5.1.1', ruleId: 'focus-visible', outcome: 'failed', mode: 'automated', nodeId: 'n-1', evidenceIds: ['ev-full', 'ev-control'], justification: canonicalCoreRuleSummary('focus-visible', 'failed') },
    { occurrenceId: 'occ-focus-review', itemId: '5.1.4', ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nodeId: 'n-1', evidenceIds: ['ev-full', 'ev-control'], justification: canonicalCoreRuleSummary('focus-order', 'cantTell') },
    { occurrenceId: 'occ-cross-page', itemId: '5.7.5', ruleId: null, outcome: 'cantTell', mode: 'manual', nodeId: null, evidenceIds: ['ev-full'], justification: itemById.get('5.7.5').humanReason },
  ].map(canonicalOccurrence),
  evidence: EVIDENCE,
  evidenceStateCount: 1,
  accessibilityWidgets: unknownAccessibilityWidgetInventory(),
  manualReview: [
    { occurrenceId: 'occ-focus-review', itemId: '5.1.4', ruleId: 'focus-order', mode: 'assisted', status: 'unanswered', question: canonicalReviewQuestion(itemById.get('5.1.4')), reason: canonicalCoreRuleSummary('focus-order', 'cantTell') },
    { occurrenceId: 'occ-cross-page', itemId: '5.7.5', ruleId: null, mode: 'manual', status: 'unanswered', question: canonicalReviewQuestion(itemById.get('5.7.5')), reason: itemById.get('5.7.5').humanReason },
  ],
  reviewDecisions: [],
  progress: [],
  report: { status: 'review-ready', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
  reproducibility: { methodologyVersion: '1.0.0', snapshotHash: 'snapshot-hash-sample', ruleResultsHash: 'rules-hash-sample', evidenceHash: 'evidence-hash-sample', capturedStateCount: 1 },
  integrity: { algorithm: 'SHA-256', canonicalModelHash: 'pending', evidenceManifestHash: 'pending', hashBase: REPORT_HASH_BASE },
  normative: {
    edition: 'ABNT NBR 17225:2025', wcag: 'WCAG 2.2',
    editorialNotes: NBR17225_EDITORIAL_NOTES.map(note => ({ ...note })),
    sources: structuredClone(NORMATIVE_SOURCE_LEDGER),
  },
});
