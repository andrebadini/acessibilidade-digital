import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { CORE_RULES } from '../../src/core/audit.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function reportInput(overrides = {}) {
  const ruleResults = CORE_RULES.map(rule => ({
    ruleId: rule.id,
    outcome: rule.id === 'focus-visible' ? 'passed' : rule.id === 'focus-order' ? 'cantTell' : 'inapplicable',
    mode: rule.mode,
    nbrItems: [...rule.nbrItems],
    wcag: [...rule.wcag],
    targets: rule.id === 'focus-order' ? ['n-1'] : [],
    summary: 'Resultado canônico da fixture V1.',
    limitations: [],
  }));
  const itemResults = aggregateItems(ruleResults, NBR17225_ITEMS).map(item => ({
    ...item,
    wcag: item.wcag.map(reference => ({ ...reference })),
    ruleIds: [...item.ruleIds],
    ruleResults: item.ruleResults.map(rule => rule.ruleId),
  }));
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
    session: { status: 'partial', diagnostics: [{
      code: 'DYNAMIC_PROBES_INCOMPLETE',
      message: 'As verificações dinâmicas atingiram o tempo limite.',
      at: '2026-08-26T14:00:30.000Z',
      recoverable: true,
    }], partial: true },
    limitations: ['A auditoria cobre somente a página e o estado observados.'],
    ruleResults,
    itemResults,
    occurrences: [{
      occurrenceId: 'occ-1', itemId: '5.1.4', ruleId: 'focus-order', outcome: 'cantTell', mode: 'assisted', nodeId: 'n-1',
      evidenceIds: ['ev-1'], justification: 'A ordem precisa ser confirmada por uma pessoa.',
    }],
    evidence: { stateCount: 1, artifacts: [
      {
        evidenceId: 'ev-full', kind: 'full-page', state: 'pristine', dataUrl: PNG,
        metadata: { width: 1, height: 1 }, hash: 'sha256-full-page-fixture',
      },
      { evidenceId: 'ev-1', kind: 'element', nodeId: 'n-1', selector: { css: '#conteudo' }, snippet: '<button>Continuar</button>', hash: 'sha-evidence' },
    ] },
    manualReview: [{ occurrenceId: 'occ-1', itemId: '5.1.4', ruleId: 'focus-order', mode: 'assisted', status: 'unanswered', question: 'A ordem de foco é previsível?', reason: 'Exige julgamento humano.' }],
    reviewDecisions: [],
    progress: [],
    report: { status: 'review-ready', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
    reproducibility: { methodologyVersion: '1.0.0', snapshotHash: 'snapshot-hash', ruleResultsHash: 'rules-hash', evidenceHash: 'evidence-hash', capturedStateCount: 1 },
    ...overrides,
  };
}
