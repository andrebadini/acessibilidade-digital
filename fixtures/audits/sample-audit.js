import { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const CYCLE = ['passed', 'failed', 'cantTell', 'inapplicable', 'untested'];

const itemResults = NBR17225_ITEMS.map((item, index) => ({
  ...item,
  wcag: item.wcag.map(reference => ({ ...reference })),
  ruleIds: [...item.ruleIds],
  outcome: item.id === '5.1.1' ? 'failed' : ['5.1.4', '5.7.5'].includes(item.id) ? 'cantTell' : CYCLE[index % CYCLE.length],
  ruleResults: item.ruleIds,
}));

export const SAMPLE_AUDIT = createAuditModel({
  schemaVersion: 1,
  auditId: 'audit-sample-20260826',
  requestedUrl: 'https://servico.exemplo.test/consulta',
  finalUrl: 'https://servico.exemplo.test/consulta/inicio',
  timestamps: {
    startedAt: '2026-08-26T14:00:00.000Z',
    endedAt: '2026-08-26T14:02:00.000Z',
    generatedAt: '2026-08-26T14:02:01.000Z',
  },
  timezone: 'America/Cuiaba',
  versions: { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' },
  environment: { chromeVersion: 'Chrome/147.0.0.0', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } },
  scope: { kind: 'single-page', description: 'Página final e estado observado após o carregamento; não inclui outras etapas do serviço.' },
  methodology: { name: 'Audita MT — ABNT NBR 17225 e WCAG 2.2', version: '1.0.0', ruleCount: 130, itemCount: 146 },
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
    { ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nbrItems: ['5.1.4'], targets: ['n-1'], summary: 'A previsibilidade depende do fluxo da tarefa.', limitations: [] },
    { ruleId: 'consistent-link-identification', outcome: 'untested', mode: 'manual', nbrItems: ['5.7.5'], targets: [], summary: 'São necessárias outras páginas.', limitations: ['Escopo de página única.'] },
  ],
  itemResults,
  occurrences: [
    { occurrenceId: 'occ-focus-failed', itemId: '5.1.1', ruleId: 'focus-visible', outcome: 'failed', mode: 'automated', nodeId: 'n-1', evidenceIds: ['ev-full', 'ev-control'], justification: 'O indicador de foco observado não tem contraste suficiente.' },
    { occurrenceId: 'occ-focus-review', itemId: '5.1.4', ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nodeId: 'n-1', evidenceIds: ['ev-full', 'ev-control'], justification: 'A ordem precisa ser confirmada no contexto da tarefa.' },
    { occurrenceId: 'occ-cross-page', itemId: '5.7.5', ruleId: 'consistent-link-identification', outcome: 'cantTell', mode: 'manual', nodeId: null, evidenceIds: ['ev-full'], justification: 'É necessário comparar o componente em outras páginas.' },
  ],
  evidence: {
    stateCount: 1,
    artifacts: [
      { evidenceId: 'ev-full', kind: 'full-page', state: 'pristine', dataUrl: PNG, metadata: { width: 1280, height: 1600 }, hash: 'sha256-full-page-sample' },
      {
        evidenceId: 'ev-control', kind: 'element', nodeId: 'n-1', backendNodeId: 41,
        selector: { css: '#continuar', framePath: [] }, snippet: '<button id="continuar" aria-label="Continuar">Avançar</button>',
        dataUrl: PNG, fullPageEvidenceId: 'ev-full', mediaUrl: 'https://servico.exemplo.test/assets/controle.png', hash: 'sha256-element-sample',
        accessibility: {
          name: 'Continuar', nameSource: 'aria-label', description: 'Avança para a próxima etapa', descriptionSource: 'aria-describedby',
          role: 'button', value: '', states: ['habilitado'], visibleText: 'Avançar', announcementPreview: 'Continuar, botão, Avança para a próxima etapa',
        },
      },
    ],
  },
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
