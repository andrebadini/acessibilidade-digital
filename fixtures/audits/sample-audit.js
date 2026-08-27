import { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { section508ReferencesForWcag } from '../../src/core/normative/section508.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const CYCLE = ['failed', 'cantTell', 'inapplicable', 'untested'];

const itemResults = NBR17225_ITEMS.map((item, index) => ({
  ...item,
  wcag: item.wcag.map(reference => ({ ...reference })),
  ruleIds: [...item.ruleIds],
  outcome: item.id === '5.1.1' ? 'failed' : item.id === '5.1.2' ? 'passed' :
    ['5.1.4', '5.7.5'].includes(item.id) ? 'cantTell' : CYCLE[index % CYCLE.length],
  ruleResults: item.ruleIds,
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
      role: 'button', value: '', states: ['habilitado'], visibleText: 'Avançar', announcementPreview: 'Continuar, botão, Avança para a próxima etapa',
    },
  },
];

const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
const evidenceById = new Map(EVIDENCE.map(evidence => [evidence.evidenceId, evidence]));

function canonicalOccurrence(legacy) {
  const item = itemById.get(legacy.itemId);
  const targetEvidence = legacy.evidenceIds.map(id => evidenceById.get(id)).find(evidence => evidence?.nodeId === legacy.nodeId)
    ?? legacy.evidenceIds.map(id => evidenceById.get(id)).find(Boolean);
  const wcagRefs = item.wcag.map(reference => reference.id);
  return {
    ...legacy,
    pageId: 'page-1',
    classification: item.classification,
    impact: 'moderate',
    confidence: legacy.outcome === 'failed' ? 'high' : 'low',
    source: { engine: 'audita-core', ruleId: legacy.ruleId, version: '1.0.0' },
    nbrItemRef: item.id,
    wcagRefs,
    foreignBenchmarkRefs: [...section508ReferencesForWcag(wcagRefs)],
    target: {
      nodeId: legacy.nodeId,
      selector: targetEvidence?.selector?.css ?? null,
      framePath: [...(targetEvidence?.selector?.framePath ?? [])],
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
    status: 'partial',
    timestamps: TIMESTAMPS,
    viewport: VIEWPORT,
  }],
  requestedUrl: 'https://servico.exemplo.test/consulta',
  finalUrl: 'https://servico.exemplo.test/consulta/inicio',
  timestamps: TIMESTAMPS,
  timezone: 'America/Cuiaba',
  versions: { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' },
  environment: { chromeVersion: 'Chrome/147.0.0.0', viewport: VIEWPORT },
  scope: { kind: 'single-page', description: 'Página final e estado observado após o carregamento; não inclui outras etapas do serviço.' },
  methodology: { name: 'Audita Acessibilidade — ABNT NBR 17225 e WCAG 2.2', version: '1.0.0', coreRuleCount: 130, supplementalRuleCount: 0, ruleCount: 130, itemCount: 146 },
  session: {
    status: 'partial', partial: true,
    diagnostics: [{ code: 'FRAME_LIMITED', message: 'Um frame de terceiro não pôde ser coletado.', at: '2026-08-26T14:00:30.000Z', recoverable: true }],
  },
  limitations: [
    'A auditoria cobre somente a página e o estado observados.',
    'Itens de contexto, processos completos e equivalência de mídia exigem revisão humana.',
  ],
  ruleResults: [
    { ruleId: 'focus-visible', outcome: 'failed', mode: 'automated', nbrItems: ['5.1.1'], targets: ['n-1'], summary: 'O foco não foi distinguido visualmente.', limitations: [] },
    { ruleId: 'focus-fully-visible', outcome: 'passed', mode: 'automated', nbrItems: ['5.1.2'], targets: [], summary: 'O foco permaneceu totalmente visível.', limitations: [] },
    { ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nbrItems: ['5.1.4'], targets: ['n-1'], summary: 'A previsibilidade depende do fluxo da tarefa.', limitations: [] },
    { ruleId: 'consistent-link-identification', outcome: 'untested', mode: 'manual', nbrItems: ['5.7.5'], targets: [], summary: 'São necessárias outras páginas.', limitations: ['Escopo de página única.'] },
  ],
  itemResults,
  occurrences: [
    { occurrenceId: 'occ-focus-failed', itemId: '5.1.1', ruleId: 'focus-visible', outcome: 'failed', mode: 'automated', nodeId: 'n-1', evidenceIds: ['ev-full', 'ev-control'], justification: 'O indicador de foco observado não tem contraste suficiente.' },
    { occurrenceId: 'occ-focus-review', itemId: '5.1.4', ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nodeId: 'n-1', evidenceIds: ['ev-full', 'ev-control'], justification: 'A ordem precisa ser confirmada no contexto da tarefa.' },
    { occurrenceId: 'occ-cross-page', itemId: '5.7.5', ruleId: 'consistent-link-identification', outcome: 'cantTell', mode: 'manual', nodeId: null, evidenceIds: ['ev-full'], justification: 'É necessário comparar o componente em outras páginas.' },
  ].map(canonicalOccurrence),
  evidence: EVIDENCE,
  evidenceStateCount: 1,
  manualReview: [
    { occurrenceId: 'occ-focus-review', itemId: '5.1.4', ruleId: 'focus-order', mode: 'assisted', status: 'unanswered', question: 'A ordem de foco acompanha a sequência esperada da tarefa?', reason: 'A finalidade da sequência exige julgamento humano.' },
    { occurrenceId: 'occ-cross-page', itemId: '5.7.5', ruleId: 'consistent-link-identification', mode: 'manual', status: 'unanswered', question: 'Links com a mesma função são identificados de forma consistente nas páginas?', reason: 'É preciso comparar páginas.' },
  ],
  reviewDecisions: [],
  progress: [],
  report: { status: 'review-ready', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
  reproducibility: { methodologyVersion: '1.0.0', snapshotHash: 'snapshot-hash-sample', ruleResultsHash: 'rules-hash-sample', evidenceHash: 'evidence-hash-sample', capturedStateCount: 1 },
  integrity: { algorithm: 'SHA-256', canonicalModelHash: 'model-hash-pending-export', evidenceManifestHash: 'evidence-hash-sample' },
  normative: {
    edition: 'ABNT NBR 17225:2025', wcag: 'WCAG 2.2',
    editorialNotes: NBR17225_EDITORIAL_NOTES.map(note => ({ ...note })),
  },
});
