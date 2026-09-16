import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { SYSTEM_DIAGNOSTIC_MESSAGES } from './diagnostic-policy.js';

export const RETAINED_TEXT_POLICY = Object.freeze({
  ruleSummary: Object.freeze({ maxCodepoints: 640 }),
  occurrenceJustification: Object.freeze({ maxCodepoints: 640 }),
  reviewQuestion: Object.freeze({ maxCodepoints: 640 }),
  reviewReason: Object.freeze({ maxCodepoints: 640 }),
  evaluatorSummary: Object.freeze({ maxCodepoints: 640 }),
  structuredTargetText: Object.freeze({ maxCodepoints: 200 }),
  systemicText: Object.freeze({ maxCodepoints: 640 }),
});

const ITEM_BY_RULE_ID = new Map(NBR17225_ITEMS.flatMap(item =>
  item.ruleIds.map(ruleId => [ruleId, item])));

const CORE_OUTCOME_TEXT = Object.freeze({
  passed: 'conformidade técnica observada',
  failed: 'não conformidade técnica identificada',
  cantTell: 'conclusão dependente de revisão humana',
  inapplicable: 'requisito não aplicável ao estado observado',
  untested: 'verificação técnica não concluída',
});

const BATCH_OUTCOME_TEXT = Object.freeze({
  failed: 'falha confirmada',
  cantTell: 'não foi possível concluir',
  untested: 'não testado',
  passed: 'verificação aprovada',
  inapplicable: 'não aplicável',
});

const SINGLE_SCOPE = Object.freeze({
  kind: 'single-page-observed-state',
  description: 'Página única e estado observado no instante da coleta; outras páginas, etapas e estados não foram inferidos.',
});

const ROOT_LIMITATIONS = Object.freeze([
  'O relatório cobre somente uma página e o estado observado; não constitui declaração de conformidade do site inteiro.',
  'O relatório cobre somente a lista explícita de URLs e os estados observados; não constitui declaração de conformidade do site inteiro.',
  'A auditoria foi concluída parcialmente e contém limitações técnicas registradas nos diagnósticos.',
  'A auditoria falhou antes de ser concluída; resultados disponíveis devem ser interpretados como parciais.',
  'A auditoria foi cancelada; resultados disponíveis permanecem incompletos.',
  'A cobertura estrutural contém avisos ou frames que não puderam ser observados integralmente.',
  'Não foi possível registrar o viewport; dimensões e escala permanecem não disponíveis, sem valores estimados.',
  'O instante de término da auditoria não estava disponível; o instante de geração foi usado somente para fechar o registro temporal do relatório.',
  'O motor suplementar axe-core está desativado pelo gate MV3/CSP; o motor próprio Audita continuou sem sondar o axe.',
  'O motor suplementar axe-core teve cobertura parcial; somente resultados vinculados a frames concluídos foram considerados.',
  'Os resultados axe excederam limites locais de segurança; contagens e achados publicados são truncados.',
  'A proveniência do resultado axe não corresponde ao pacote verificado; nenhum achado foi publicado.',
]);

const SCOPE_LIMITATION = Object.freeze({
  single: ROOT_LIMITATIONS[0],
  batch: ROOT_LIMITATIONS[1],
});

const STATUS_LIMITATION = Object.freeze({
  partial: ROOT_LIMITATIONS[2],
  failed: ROOT_LIMITATIONS[3],
  cancelled: ROOT_LIMITATIONS[4],
});

const STRUCTURAL_LIMITATION = ROOT_LIMITATIONS[5];
const VIEWPORT_LIMITATION = ROOT_LIMITATIONS[6];

const SYSTEM_LIMITATION_SET = new Set([...ROOT_LIMITATIONS, ...SYSTEM_DIAGNOSTIC_MESSAGES]);

const REVIEW_LIMITATION = 'A conclusão depende de revisão humana conforme o modo da regra e a justificativa normativa do item.';
const UNTESTED_LIMITATION = 'A regra não produziu conclusão técnica; execute novamente e revise os insumos.';

export function boundedRetainedText(value, policyName, label = policyName) {
  const policy = RETAINED_TEXT_POLICY[policyName];
  if (!policy || typeof value !== 'string' || value !== value.trim() || !value) {
    throw new TypeError(`${label} deve ser texto canônico limitado.`);
  }
  if (value.length > policy.maxCodepoints * 2) {
    throw new TypeError(`${label} excede o limite de retenção.`);
  }
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > policy.maxCodepoints) throw new TypeError(`${label} excede o limite de retenção.`);
  }
  return value;
}

export function canonicalCoreRuleSummary(ruleId, outcome) {
  const item = ITEM_BY_RULE_ID.get(ruleId);
  const result = CORE_OUTCOME_TEXT[outcome];
  if (!item || !result) return null;
  if (item.classification === 'recommendation') {
    const recommendationResult = outcome === 'inapplicable'
      ? 'recomendação não aplicável ao estado observado' : result;
    return `Recomendação “${item.title}”: ${recommendationResult}.`;
  }
  return `Requisito “${item.title}”: ${result}.`;
}

// Exact historical text remains valid without rewriting a saved model or its hash.
export function isCanonicalCoreRuleSummary(value, ruleId, outcome) {
  const item = ITEM_BY_RULE_ID.get(ruleId);
  const result = CORE_OUTCOME_TEXT[outcome];
  if (!item || !result) return false;
  return value === canonicalCoreRuleSummary(ruleId, outcome) ||
    value === `Requisito “${item.title}”: ${result}.`;
}

export function canonicalBatchRuleSummary(outcome) {
  const result = BATCH_OUTCOME_TEXT[outcome];
  return result ? `Resultado consolidado do lote: ${result}.` : null;
}

export function isCanonicalBatchRuleSummary(value, outcome) {
  return value === canonicalBatchRuleSummary(outcome);
}

export function canonicalCoreRuleLimitations(outcome) {
  if (outcome === 'cantTell') return Object.freeze([REVIEW_LIMITATION]);
  if (outcome === 'untested') return Object.freeze([UNTESTED_LIMITATION]);
  return Object.freeze([]);
}

export function canonicalReviewQuestion(item) {
  if (!item || typeof item.title !== 'string') return null;
  if (item.classification === 'recommendation') {
    return `A recomendação “${item.title}” está atendida no contexto apresentado?`;
  }
  return `O requisito “${item.title}” está conforme no contexto apresentado?`;
}

export function isCanonicalReviewQuestion(value, item) {
  if (!item || typeof item.title !== 'string') return false;
  return value === canonicalReviewQuestion(item) ||
    value === `O requisito “${item.title}” está conforme no contexto apresentado?`;
}

export function canonicalScope(mode, pageCount = 1) {
  if (mode === 'single' && pageCount === 1) return { ...SINGLE_SCOPE };
  if (mode !== 'batch' || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 20) return null;
  return {
    kind: 'explicit-url-batch',
    description: `${pageCount} páginas correspondentes à lista explícita de ${pageCount} URLs; páginas e estados não solicitados não foram inferidos.`,
  };
}

export function isCanonicalScope(scope, mode, pageCount) {
  const expected = canonicalScope(mode, pageCount);
  return Boolean(expected && scope && scope.kind === expected.kind && scope.description === expected.description &&
    Object.keys(scope).length === 2);
}

export function isCanonicalSystemLimitation(value) {
  return typeof value === 'string' && SYSTEM_LIMITATION_SET.has(value);
}

export function filterCanonicalSystemLimitations(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(isCanonicalSystemLimitation))];
}

export function deriveSystemLimitations(model) {
  const output = [];
  output.push(SCOPE_LIMITATION[model.requestedScope?.mode] ?? SCOPE_LIMITATION.single);
  if (STATUS_LIMITATION[model.session?.status]) output.push(STATUS_LIMITATION[model.session.status]);
  const structuralPartial = model.snapshot && (
    Object.values(model.snapshot.coverage ?? {}).some(channel => channel?.outcome === 'partial') ||
    (model.snapshot.warnings?.length ?? 0) > 0
  ) || (model.pages ?? []).some(page =>
    Object.values(page.coverage ?? {}).some(channel => channel?.outcome === 'partial') ||
    (page.warnings?.length ?? 0) > 0);
  if (structuralPartial) output.push(STRUCTURAL_LIMITATION);
  if ((model.pages ?? []).some(page => page.finalUrlObserved === true &&
    Object.values(page.viewport ?? {}).every(value => value === null))) {
    output.push(VIEWPORT_LIMITATION);
  }
  const axeLimitations = model.requestedScope?.mode === 'batch'
    ? (model.axePages ?? []).flatMap(entry => entry.result?.limitations ?? [])
    : model.axe?.limitations ?? [];
  output.push(...axeLimitations);
  for (const diagnostic of model.session?.diagnostics ?? []) {
    const policy = SYSTEM_DIAGNOSTIC_MESSAGES.includes(diagnostic.message) &&
      (diagnostic.code.startsWith('REPORT_') ||
        ['ATTACHED_COPY_RELOADED', 'DYNAMIC_PROBES_OMITTED_PASSIVE', 'PIXEL_CAPTURE_OMITTED', 'FULL_PAGE_CAPTURE_OMITTED', 'FULL_PAGE_CAPTURE_NOT_ATTEMPTED']
          .includes(diagnostic.code));
    if (policy) output.push(diagnostic.message);
  }
  return [...new Set(output)];
}

/**
 * What the details list shows, and therefore what its headline counts.
 *
 * A limitation sentence that is also a policy diagnostic is stated in plain language by
 * `deriveSystemLimitations` and again with the code in front by the report projection. The list keeps
 * the coded form for traceability and does not repeat the plain sentence next to it. Measured in the
 * delivered 1.1.19 report: 8 entries for 6 distinct sentences on the first page of the PDF.
 */
export function listedLimitations(limitations) {
  if (!Array.isArray(limitations)) return [];
  const codedMessages = new Set();
  for (const value of limitations) {
    const match = /^[A-Z][A-Z0-9_]{3,}: ([\s\S]+)$/u.exec(typeof value === 'string' ? value : '');
    if (match) codedMessages.add(match[1]);
  }
  return limitations.filter(value => !codedMessages.has(value));
}

export function derivePageLimitations(model, page) {
  const output = [];
  if (Object.values(page.coverage ?? {}).some(channel => channel?.outcome === 'partial') ||
    (page.warnings?.length ?? 0) > 0) {
    output.push(STRUCTURAL_LIMITATION);
  }
  if (page.finalUrlObserved === true && Object.values(page.viewport ?? {}).every(value => value === null)) {
    output.push(VIEWPORT_LIMITATION);
  }
  const axe = model.requestedScope?.mode === 'batch'
    ? model.axePages?.find(entry => entry.pageId === page.pageId)?.result
    : model.axe;
  output.push(...(axe?.limitations ?? []));
  return [...new Set(output)];
}

export function canonicalEvaluatorSummary(evaluators) {
  const unique = [...new Set(evaluators)];
  const joined = unique.join(', ');
  if ([...joined].length <= RETAINED_TEXT_POLICY.evaluatorSummary.maxCodepoints) return joined;
  return `${unique.length} avaliadores registrados; nomes completos disponíveis no histórico de decisões.`;
}
