import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';

export function reportInput(overrides = {}) {
  const itemResults = NBR17225_ITEMS.map(item => {
    const linked = item.ruleIds.filter(ruleId => ['focus-visible', 'focus-order'].includes(ruleId));
    return {
      ...item,
      wcag: item.wcag.map(reference => ({ ...reference })),
      ruleIds: [...item.ruleIds],
      outcome: linked.includes('focus-visible') ? 'passed' : 'cantTell',
      ruleResults: linked,
    };
  });
  return {
    schemaVersion: 1,
    auditId: 'audit-report-1',
    requestedUrl: 'https://example.test/path?token=REMOVE&view=public',
    finalUrl: 'https://example.test/final?session=REMOVE&view=public',
    timestamps: {
      startedAt: '2026-08-26T14:00:00.000Z',
      endedAt: '2026-08-26T14:01:00.000Z',
      generatedAt: '2026-08-26T14:01:01.000Z',
    },
    timezone: 'America/Cuiaba',
    versions: { extension: '0.1.0', rules: '1.0.0', browser: 'Chrome/147.0.0.0' },
    environment: { chromeVersion: 'Chrome/147.0.0.0', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } },
    scope: { kind: 'single-page', description: 'Página e estado observado após carregamento.' },
    methodology: { name: 'Audita Acessibilidade — ABNT NBR 17225 e WCAG 2.2', version: '1.0.0', ruleCount: 130, itemCount: 146 },
    session: { status: 'partial', diagnostics: [{ code: 'FRAME_LIMITED', message: 'Um frame não pôde ser lido.', at: '2026-08-26T14:00:30.000Z', recoverable: true }], partial: true },
    limitations: ['A auditoria cobre somente a página e o estado observados.'],
    ruleResults: [
      { ruleId: 'focus-visible', outcome: 'passed', mode: 'automated', nbrItems: ['5.1.1'], targets: [], summary: 'Verificação concluída.', limitations: [] },
      { ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nbrItems: ['5.1.4'], targets: ['n-1'], summary: 'Exige revisão humana.', limitations: [] },
    ],
    itemResults,
    occurrences: [{
      occurrenceId: 'occ-1', itemId: '5.1.4', ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nodeId: 'n-1',
      evidenceIds: ['ev-1'], justification: 'A ordem precisa ser confirmada por uma pessoa.',
    }],
    evidence: { stateCount: 1, artifacts: [{ evidenceId: 'ev-1', kind: 'element', nodeId: 'n-1', selector: { css: '#conteudo' }, snippet: '<button>Continuar</button>', hash: 'sha-evidence' }] },
    manualReview: [{ occurrenceId: 'occ-1', itemId: '5.1.4', ruleId: 'focus-order', mode: 'assisted', status: 'unanswered', question: 'A ordem de foco é previsível?', reason: 'Exige julgamento humano.' }],
    reviewDecisions: [],
    progress: [],
    report: { status: 'review-ready', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
    reproducibility: { methodologyVersion: '1.0.0', snapshotHash: 'snapshot-hash', ruleResultsHash: 'rules-hash', evidenceHash: 'evidence-hash', capturedStateCount: 1 },
    ...overrides,
  };
}
