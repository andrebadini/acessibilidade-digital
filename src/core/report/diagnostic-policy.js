const ALL_TERMINAL_STATUSES = Object.freeze(['complete', 'partial', 'failed', 'cancelled']);
const INCOMPLETE_STATUSES = Object.freeze(['partial', 'failed', 'cancelled']);
const BOTH_MODES = Object.freeze(['single', 'batch']);

export const ATTACHED_COPY_RELOADED_MESSAGE =
  'A auditoria foi executada em uma cópia temporária recarregada da URL da aba escolhida; alterações não salvas e estado mantido apenas em memória na aba original não foram observados.';

// Medido em 18/09/2026 (revisão adversarial da 1.1.49, achado N-1): a captura de elementos usa
// `Page.captureScreenshot` com `captureBeyondViewport: true`, e no Chrome 152 isso leva o viewport do
// documento observado a 1x1 por um instante e o restaura (até ~250 eventos de `resize` numa fixture de 240
// controles). Numa página que reaja a `resize` escrevendo no DOM, o documento TERMINA diferente do inicial —
// o oráculo de fonte intocada do próprio projeto reprova esse caso. A mensagem anterior ("sem alterar foco,
// rolagem ou layout") era, por isso, falsa para páginas reativas, e a frase foi corrigida para declarar o
// efeito em vez de negá-lo. No modo sem imagens não há captura e nenhum evento é observado.
export const DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE =
  'A página foi observada sem navegação e sem alterar foco, rolagem ou o layout final. Nas verificações com imagens, a captura de elementos pode redimensionar a área de captura por um instante e restaurá-la; páginas que reagem a redimensionamento podem registrar essa mudança. Testes interativos de teclado, redimensionamento e movimento não foram executados; revise esses aspectos manualmente.';

// Páginas hostis (1.1.53): vitrines e catálogos com dezenas de milhares de px de altura ou milhares de
// elementos. A auditoria continua completa nas regras; o que tem teto é só a quantidade de pixels, para a
// captura não travar o navegador nem estourar o armazenamento.
export const FULL_PAGE_CAPTURE_TRUNCATED_MESSAGE =
  'A página é mais alta que o limite seguro de captura; a captura integral e o mapa visual cobrem apenas a parte superior. Todas as regras continuaram avaliando a página inteira.';
export const ELEMENT_CAPTURE_BUDGET_MESSAGE =
  'O limite de evidências por página foi atingido; as demais ocorrências continuam no relatório com seletor e descrição, sem miniatura própria e, em páginas muito grandes, sem trecho de código.';

export const EXPORT_ISSUE_MESSAGES = Object.freeze({
  REPORT_PDF_UNAVAILABLE: 'O PDF não foi gerado devido a uma limitação técnica local.',
  REPORT_CSV_UNAVAILABLE: 'O CSV não foi gerado devido a uma limitação técnica local.',
  REPORT_PDF_TAGGING_UNSUPPORTED: 'O PDF foi gerado sem marcação estrutural adicional e sem outline porque o navegador não aceitou esses parâmetros.',
  REPORT_PRINT_TAB_TIMEOUT: 'A criação da aba temporária de impressão excedeu o tempo limite.',
  REPORT_PRINT_TAB_FAILED: 'A aba temporária de impressão não pôde ser criada.',
  REPORT_PRINT_LOAD_TIMEOUT: 'O carregamento da página de impressão excedeu o tempo limite.',
  REPORT_PRINT_LOAD_FAILED: 'A página de impressão não pôde ser preparada.',
  REPORT_PRINT_CDP_TIMEOUT: 'A conexão local de impressão excedeu o tempo limite.',
  REPORT_PRINT_CDP_FAILED: 'A conexão local de impressão não pôde ser estabelecida.',
  REPORT_PRINT_ASSETS_TIMEOUT: 'A preparação local de fontes e imagens excedeu o tempo limite.',
  REPORT_PRINT_ASSETS_FAILED: 'Fontes e imagens do relatório não puderam ser confirmadas.',
  REPORT_PRINT_CLEANUP_LIMITED: 'A limpeza de um recurso temporário de impressão não pôde ser confirmada.',
  REPORT_DOWNLOAD_START_FAILED: 'Um artefato não pôde iniciar o download.',
  REPORT_DOWNLOAD_TIMEOUT: 'Um artefato excedeu o tempo limite de download.',
  REPORT_DOWNLOAD_INTERRUPTED: 'Um artefato teve o download interrompido.',
  REPORT_DOWNLOAD_CLEANUP_LIMITED: 'A liberação de um endereço temporário de download não pôde ser confirmada.',
  REPORT_EXPORT_PREPARATION_FAILED: 'Não foi possível preparar os artefatos do relatório.',
});

export const PDF_GENERATION_FAILURE_CODES = Object.freeze([
  'REPORT_PRINT_TAB_TIMEOUT', 'REPORT_PRINT_TAB_FAILED',
  'REPORT_PRINT_LOAD_TIMEOUT', 'REPORT_PRINT_LOAD_FAILED',
  'REPORT_PRINT_CDP_TIMEOUT', 'REPORT_PRINT_CDP_FAILED',
  'REPORT_PRINT_ASSETS_TIMEOUT', 'REPORT_PRINT_ASSETS_FAILED',
  'REPORT_PDF_UNAVAILABLE',
]);

export const REPORT_GENERATION_ISSUE_CODES = Object.freeze([
  ...PDF_GENERATION_FAILURE_CODES,
  'REPORT_CSV_UNAVAILABLE',
  'REPORT_PDF_TAGGING_UNSUPPORTED',
]);

const REPORT_MODEL_ISSUE_CODES = Object.freeze([
  ...REPORT_GENERATION_ISSUE_CODES,
  'REPORT_EXPORT_PREPARATION_FAILED',
]);

const page = ({ code, message, modes = BOTH_MODES, statuses = INCOMPLETE_STATUSES,
  stages = ['true:true'], recoverable = true, cardinality = 'page', details = 'none',
  fact = null, group = null, causePartial = recoverable, timestampScope = 'page' }) => Object.freeze({
  code, message, recoverable, roles: Object.freeze(['page']), modes: Object.freeze([...modes]),
  statuses: Object.freeze([...statuses]), stages: Object.freeze([...stages]),
  placement: 'page-root-copy', cardinality, details, fact, group, causePartial, timestampScope, max: 1,
});

const session = ({ code, message, modes = BOTH_MODES, statuses = ALL_TERMINAL_STATUSES, group = null }) => Object.freeze({
  code, message, recoverable: true, roles: Object.freeze(['session']), modes: Object.freeze([...modes]),
  statuses: Object.freeze([...statuses]), stages: Object.freeze([]),
  placement: 'session-only', cardinality: 'generation', details: 'none', fact: 'report-generation',
  group, causePartial: false, timestampScope: 'generation', max: 1,
});

const technicalPageDiagnostics = [
  page({ code: 'FULL_PAGE_CAPTURE_FAILED', message: 'Não foi possível capturar a página completa no estado original.', fact: 'full-page-absent' }),
  page({
    code: 'FULL_PAGE_CAPTURE_NOT_ATTEMPTED',
    message: 'A captura integral não foi tentada porque a execução terminou antes da etapa de pixels.',
    statuses: ['failed', 'cancelled'], fact: 'full-page-not-attempted', causePartial: false,
  }),
  page({
    code: 'PIXEL_CAPTURE_OMITTED', message: 'Nenhuma captura raster foi coletada no modo sem imagens.',
    statuses: ALL_TERMINAL_STATUSES, fact: 'pixels-omitted-policy', causePartial: false,
  }),
  page({
    code: 'FULL_PAGE_CAPTURE_OMITTED',
    message: 'A captura integral e o mapa anotado foram omitidos pela política; miniaturas de elementos permaneceram permitidas.',
    statuses: ALL_TERMINAL_STATUSES, fact: 'full-page-omitted-policy', causePartial: false,
  }),
  page({ code: 'ENVIRONMENT_UNAVAILABLE', message: 'Os metadados públicos do ambiente não puderam ser lidos.', fact: 'environment-unavailable' }),
  page({ code: 'BROWSER_VERSION_UNAVAILABLE', message: 'A versão do navegador não pôde ser lida; as dimensões observadas foram preservadas.', fact: 'browser-version-unavailable' }),
  page({ code: 'DYNAMIC_PROBES_INCOMPLETE', message: 'As verificações dinâmicas atingiram o tempo limite.', fact: 'dynamic-probes-incomplete', group: 'dynamic-probes' }),
  page({ code: 'DYNAMIC_PROBES_FAILED', message: 'As verificações dinâmicas não puderam ser concluídas.', fact: 'dynamic-probes-failed', group: 'dynamic-probes' }),
  page({ code: 'DYNAMIC_PROBES_OMITTED_PASSIVE', message: DYNAMIC_PROBES_OMITTED_PASSIVE_MESSAGE,
    statuses: ALL_TERMINAL_STATUSES, fact: 'dynamic-probes-omitted-passive', group: 'dynamic-probes', causePartial: false }),
  page({ code: 'AXE_EXECUTION_FAILED', message: 'O motor suplementar axe-core teve cobertura parcial; o motor próprio continuou normalmente.', fact: 'axe-partial', group: 'axe' }),
  page({ code: 'FULL_PAGE_CAPTURE_TRUNCATED', message: FULL_PAGE_CAPTURE_TRUNCATED_MESSAGE, fact: 'full-page-truncated' }),
  page({ code: 'ELEMENT_CAPTURE_BUDGET_REACHED', message: ELEMENT_CAPTURE_BUDGET_MESSAGE, fact: 'element-capture-budget' }),
  page({ code: 'ELEMENT_CAPTURE_SKIPPED_NO_FULL_PAGE', message: 'As miniaturas de elementos não foram tentadas porque a captura original da página falhou.', fact: 'element-capture-skipped' }),
  page({ code: 'ANNOTATION_MAP_PARTIAL', message: 'O mapa visual foi gerado com cobertura parcial e limitações explícitas.', fact: 'annotation-partial', group: 'annotation' }),
  page({ code: 'CDP_DISCONNECT_FAILED', message: 'A sessão de depuração não pôde ser encerrada automaticamente.', fact: 'cleanup-cdp', timestampScope: 'root' }),
];

const occurrencePageDiagnostics = [
  ['EVIDENCE_NODE_MISSING', 'Um elemento relacionado à ocorrência não estava mais disponível.', 'evidence-node-missing'],
  ['SNIPPET_CAPTURE_FAILED', 'O trecho de código do elemento não pôde ser capturado.', 'snippet-missing'],
  ['ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.', 'element-pixels-missing'],
  ['EVIDENCE_CAPTURE_FAILED', 'As evidências de uma ocorrência não puderam ser preparadas.', 'evidence-artifact-missing'],
].map(([code, message, fact]) => page({
  code, message, cardinality: 'occurrence', details: 'occurrence', fact,
}));

const annotationFailureCodes = Object.freeze([
  'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE',
  'ANNOTATION_MAP_SOURCE_INVALID',
  'ANNOTATION_MAP_SOURCE_HASH_MISMATCH',
  'ANNOTATION_MAP_SOURCE_LIMIT',
  'ANNOTATION_MAP_GEOMETRY_INVALID',
  'ANNOTATION_MAP_SEGMENT_LIMIT',
  'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT',
  'ANNOTATION_MAP_LEGEND_PRINT_LIMIT',
  'ANNOTATION_MAP_LEGEND_WIDTH_LIMIT',
  'ANNOTATION_MAP_DERIVED_BYTES_LIMIT',
  'ANNOTATION_MAP_OUTPUT_INVALID',
  'ANNOTATION_MAP_TIMEOUT',
]);

const annotationFailureDiagnostics = annotationFailureCodes.map(code => page({
  code,
  message: 'O mapa visual derivado não pôde ser gerado localmente; a captura original foi preservada.',
  fact: 'annotation-failed', group: 'annotation',
}));

const terminalPageDiagnostics = [
  page({
    code: 'NAVIGATION_FAILED', message: 'O site não pôde ser aberto de forma estável.',
    statuses: ['failed'], stages: ['false:false', 'true:false', 'true:true'], recoverable: false,
    fact: 'navigation-failed', causePartial: false,
  }),
  page({
    code: 'NAVIGATION_FAILED', message: 'A auditoria foi cancelada.',
    statuses: ['cancelled'], stages: ['false:false', 'true:false', 'true:true'], recoverable: false,
    fact: 'navigation-cancelled', causePartial: false,
  }),
  page({
    code: 'COLLECTION_FAILED', message: 'A estrutura da página não pôde ser coletada com segurança.',
    statuses: ['failed'], stages: ['true:true'], recoverable: false,
    fact: 'collection-failed', causePartial: false,
  }),
  page({
    code: 'CORE_AUDIT_FAILED', message: 'O núcleo de regras não pôde concluir a auditoria.',
    statuses: ['failed'], stages: ['true:true'], recoverable: false,
    fact: 'core-failed', causePartial: false,
  }),
  page({
    code: 'BATCH_PAGE_FAILED', message: 'A página não pôde ser auditada.',
    modes: ['batch'], statuses: ['failed'], stages: ['true:false'], recoverable: false,
    fact: 'batch-page-failed', causePartial: false,
  }),
  page({
    code: 'BATCH_PAGE_TIMEOUT', message: 'A página excedeu o tempo limite da auditoria.',
    modes: ['batch'], statuses: ['failed'], stages: ['true:false'], recoverable: false,
    fact: 'batch-page-timeout', causePartial: false,
  }),
  page({
    code: 'BATCH_PAGE_MODEL_INVALID', message: 'O resultado da página não pôde ser validado para o lote.',
    modes: ['batch'], statuses: ['failed'], stages: ['true:false'], recoverable: false,
    fact: 'batch-page-invalid', causePartial: false,
  }),
  page({
    code: 'BATCH_PAGE_CLEANUP_UNCONFIRMED',
    message: 'A limpeza da página excedeu o prazo; o lote foi interrompido para evitar sobreposição.',
    modes: ['batch'], statuses: ['failed'], stages: ['true:false'], recoverable: false,
    fact: 'batch-cleanup-barrier', causePartial: false,
  }),
  page({
    code: 'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED',
    message: 'A página não foi iniciada porque a limpeza anterior não foi confirmada.',
    modes: ['batch'], statuses: ['failed'], stages: ['false:false'], recoverable: false,
    fact: 'batch-cleanup-suffix', causePartial: false,
  }),
  page({
    code: 'BATCH_CANCELLED', message: 'A página ativa foi cancelada e limpa antes do encerramento do lote.',
    modes: ['batch'], statuses: ['cancelled'], stages: ['true:false'], recoverable: false,
    fact: 'batch-cancel-active', causePartial: false,
  }),
  page({
    code: 'BATCH_CANCELLED', message: 'A página não foi iniciada porque o lote foi cancelado.',
    modes: ['batch'], statuses: ['cancelled'], stages: ['false:false'], recoverable: false,
    fact: 'batch-cancel-pending', causePartial: false,
  }),
];

export const SYSTEM_DIAGNOSTIC_POLICY = Object.freeze([
  ...terminalPageDiagnostics,
  ...technicalPageDiagnostics,
  ...occurrencePageDiagnostics,
  ...annotationFailureDiagnostics,
  page({
    code: 'ATTACHED_COPY_RELOADED',
    message: ATTACHED_COPY_RELOADED_MESSAGE,
    statuses: ALL_TERMINAL_STATUSES,
    recoverable: true,
    fact: 'attached-copy-reloaded',
    causePartial: false,
  }),
  page({
    code: 'REPORT_HANDOFF_FAILED', message: 'A fila de revisão não pôde ser preparada.',
    modes: ['single'], fact: 'report-handoff',
  }),
  page({
    code: 'AXE_FEATURE_DISABLED',
    message: 'O motor suplementar axe-core permaneceu desativado pelo gate MV3/CSP; o motor próprio continuou normalmente.',
    statuses: ALL_TERMINAL_STATUSES, fact: 'axe-disabled', group: 'axe', causePartial: false,
  }),
  page({
    code: 'TAB_CLOSE_FAILED', message: 'A aba descartável não pôde ser fechada automaticamente.',
    statuses: INCOMPLETE_STATUSES, stages: ['false:false', 'true:false', 'true:true'],
    fact: 'cleanup-tab', timestampScope: 'root',
  }),
  page({
    code: 'BATCH_EVIDENCE_BUDGET_EXCEEDED',
    message: 'O orçamento total de 256 MiB de PNGs foi atingido; novos pixels foram omitidos, preservando metadados e hashes de conteúdo.',
    modes: ['batch'], statuses: INCOMPLETE_STATUSES, stages: ['true:true'], fact: 'evidence-budget',
  }),
  ...REPORT_MODEL_ISSUE_CODES.map(code => session({
    code, message: EXPORT_ISSUE_MESSAGES[code],
    group: PDF_GENERATION_FAILURE_CODES.includes(code) ? 'pdf-generation' : null,
  })),
]);

export const SYSTEM_DIAGNOSTIC_MESSAGES = Object.freeze([
  ...new Set(SYSTEM_DIAGNOSTIC_POLICY.map(entry => entry.message)),
]);

export function diagnosticPolicyEntry(diagnostic, context) {
  const stage = context.role === 'page'
    ? `${context.attempted}:${context.finalUrlObserved}`
    : null;
  return SYSTEM_DIAGNOSTIC_POLICY.find(entry =>
    entry.code === diagnostic?.code && entry.message === diagnostic?.message &&
    entry.recoverable === diagnostic?.recoverable && entry.roles.includes(context.role) &&
    entry.modes.includes(context.mode) && entry.statuses.includes(context.status) &&
    (context.role !== 'page' || entry.stages.includes(stage))) ?? null;
}

export function canonicalExportIssueMessage(code) {
  return typeof code === 'string' && Object.hasOwn(EXPORT_ISSUE_MESSAGES, code)
    ? EXPORT_ISSUE_MESSAGES[code]
    : null;
}
