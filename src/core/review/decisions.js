import { captureAuditInput } from '../report/audit-input.js';
import { canonicalStringify } from '../report/canonical-json.js';
import { canonicalEvaluatorSummary } from '../report/text-policy.js';

// "não se aplica" (revisão leiga): a situação do item não existe na página observada.
const ANSWERS = Object.freeze(['conforme', 'não conforme', 'não foi possível determinar', 'não se aplica']);
const MODES = Object.freeze(['assisted', 'manual']);
const MAX_REVIEW_DECISIONS = 10_000;
const MAX_EVALUATOR_CODEPOINTS = 160;
const MAX_NOTE_CODEPOINTS = 4_000;
// Uma decisão revista guarda, em ordem, as respostas que substituiu. A trilha nunca é apagada.
const MAX_REVISIONS = 20;
const DECISION_FIELDS = new Set([
  'decisionId', 'auditId', 'itemId', 'occurrenceId', 'answer', 'evaluator', 'decidedAt', 'mode', 'note', 'revisions',
]);
const REVISION_FIELDS = new Set(['answer', 'evaluator', 'decidedAt', 'note']);

function decisionBoundaryError(message = 'Decisão de revisão inválida.') {
  return new TypeError(message);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(record, key, label) {
  const descriptor = isPlainRecord(record) ? Object.getOwnPropertyDescriptor(record, key) : null;
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${label} deve ser uma propriedade própria.`);
  return descriptor.value;
}

function assertJsonData(value, label = 'valor', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError(`${label} não é JSON-safe.`);
  if (ancestors.has(value)) throw new TypeError(`${label} contém referência circular.`);
  if (!Array.isArray(value) && !isPlainRecord(value)) throw new TypeError(`${label} deve conter apenas objetos de dados simples.`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} contém propriedade inválida.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${label}.${key} deve ser uma propriedade de dados.`);
    assertJsonData(descriptor.value, `${label}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function required(value, label) {
  if (typeof value !== 'string' || value !== value.trim() ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw new TypeError(`${label} deve ser um identificador canônico válido.`);
  }
  return value;
}

function ruleReference(value, label) {
  return value === null ? null : required(value, label);
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('A data da decisão é obrigatória.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError('A data da decisão deve ser ISO canônica.');
  }
  return value;
}

function boundedHumanText(value, maximum, message, { optional = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(message);
  // A canonical value can use at most two UTF-16 code units per codepoint.
  // Bound the raw envelope before trim/iteration so padding cannot force a
  // large intermediate allocation at this public input boundary.
  if (value.length > maximum * 2 + 2) throw new TypeError(message);
  const canonical = value.trim();
  if ((!optional && !canonical) || canonical.length > maximum * 2) throw new TypeError(message);
  let codepoints = 0;
  for (const _character of canonical) {
    codepoints += 1;
    if (codepoints > maximum) throw new TypeError(message);
  }
  return canonical;
}

function canonicalRevisions(value, decidedAt) {
  const list = snapshotDecisionList(value, 'As revisões da decisão');
  if (list.length > MAX_REVISIONS) throw new TypeError('A decisão excede o limite de revisões.');
  let previous = '';
  return list.map(entry => {
    if (!isPlainRecord(entry)) throw new TypeError('Revisão de decisão inválida.');
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key !== 'string' || !REVISION_FIELDS.has(key)) throw new TypeError('Revisão de decisão inválida.');
    }
    const answer = ownValue(entry, 'answer', 'A resposta revista');
    if (!ANSWERS.includes(answer)) throw new TypeError('Resposta revista inválida.');
    const evaluator = boundedHumanText(ownValue(entry, 'evaluator', 'O avaliador revisto'), MAX_EVALUATOR_CODEPOINTS,
      'Avaliador da revisão inválido.');
    const at = canonicalInstant(ownValue(entry, 'decidedAt', 'A data revista'));
    if (at <= previous || at >= decidedAt) throw new TypeError('As revisões devem anteceder a decisão vigente, em ordem.');
    previous = at;
    const noteValue = Object.hasOwn(entry, 'note') ? ownValue(entry, 'note', 'A nota revista') : undefined;
    const note = noteValue === undefined ? ''
      : boundedHumanText(noteValue, MAX_NOTE_CODEPOINTS, 'Nota da revisão inválida.', { optional: true });
    return { answer, evaluator, decidedAt: at, ...(note ? { note } : {}) };
  });
}

/**
 * Monta a decisão que substitui `existing`, preservando a trilha: a resposta anterior entra em
 * `revisions`. A substituição só é aceita quando a nova decisão é posterior à vigente.
 */
export function reviseReviewDecision(existing, input) {
  const prior = createReviewDecision(existing);
  const { revisions: _ignored, ...rest } = captureAuditInput(input);
  const trail = [...(prior.revisions ?? []), {
    answer: prior.answer, evaluator: prior.evaluator, decidedAt: prior.decidedAt, ...(prior.note ? { note: prior.note } : {}),
  }];
  const next = createReviewDecision({ ...rest, revisions: trail });
  if (next.occurrenceId !== prior.occurrenceId || next.itemId !== prior.itemId || next.auditId !== prior.auditId ||
    next.mode !== prior.mode) {
    throw new TypeError('A revisão deve tratar da mesma ocorrência.');
  }
  return next;
}

function isRevisionOf(existing, candidate) {
  const prior = existing.revisions ?? [];
  const trail = candidate.revisions ?? [];
  if (trail.length !== prior.length + 1 || candidate.decidedAt <= existing.decidedAt) return false;
  if (canonicalStringify(trail.slice(0, -1)) !== canonicalStringify(prior)) return false;
  const last = trail.at(-1);
  return canonicalStringify(last) === canonicalStringify({
    answer: existing.answer, evaluator: existing.evaluator, decidedAt: existing.decidedAt,
    ...(existing.note ? { note: existing.note } : {}),
  }) && candidate.itemId === existing.itemId && candidate.mode === existing.mode;
}

/** Resultado do item depois da revisão humana. Compartilhado com a validação do modelo. */
export function deriveReviewedItemOutcome(originalOutcome, occurrences, decisions) {
  if (originalOutcome === 'failed' || decisions.some(decision => decision.answer === 'não conforme')) return 'failed';
  if (decisions.length === occurrences.length && decisions.length > 0) {
    if (decisions.every(decision => decision.answer === 'não se aplica')) return 'inapplicable';
    if (decisions.every(decision => ['conforme', 'não se aplica'].includes(decision.answer))) return 'passed';
  }
  return 'cantTell';
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

export function createReviewDecision(input) {
  let captured;
  try {
    captured = captureAuditInput(input);
  } catch {
    throw decisionBoundaryError();
  }
  if (!isPlainRecord(captured)) throw decisionBoundaryError('Decisão de revisão deve ser um objeto de dados simples.');
  for (const key of Reflect.ownKeys(captured)) {
    if (typeof key !== 'string' || !DECISION_FIELDS.has(key)) throw decisionBoundaryError();
  }
  const auditId = required(ownValue(captured, 'auditId', 'O identificador da auditoria'), 'O identificador da auditoria');
  const itemId = required(ownValue(captured, 'itemId', 'O identificador do item'), 'O identificador do item');
  const occurrenceId = required(ownValue(captured, 'occurrenceId', 'O identificador da ocorrência'), 'O identificador da ocorrência');
  const answer = ownValue(captured, 'answer', 'A resposta de revisão');
  if (!ANSWERS.includes(answer)) throw new TypeError('Resposta de revisão inválida.');
  const evaluator = boundedHumanText(
    ownValue(captured, 'evaluator', 'O avaliador'),
    MAX_EVALUATOR_CODEPOINTS,
    'Avaliador da decisão inválido.',
  );
  const decidedAt = canonicalInstant(ownValue(captured, 'decidedAt', 'A data da decisão'));
  const mode = ownValue(captured, 'mode', 'O modo de revisão');
  if (!MODES.includes(mode)) throw new TypeError('Modo de revisão inválido.');
  const noteValue = Object.hasOwn(captured, 'note') ? ownValue(captured, 'note', 'A nota da decisão') : undefined;
  const note = noteValue === undefined
    ? ''
    : boundedHumanText(noteValue, MAX_NOTE_CODEPOINTS, 'Nota da decisão inválida.', { optional: true });
  const revisions = Object.hasOwn(captured, 'revisions')
    ? canonicalRevisions(ownValue(captured, 'revisions', 'As revisões da decisão'), decidedAt)
    : [];
  const canonical = {
    auditId, itemId, occurrenceId, answer, evaluator, decidedAt, mode, ...(note ? { note } : {}),
    ...(revisions.length ? { revisions } : {}),
  };
  assertJsonData(canonical, 'Decisão de revisão');
  const decisionId = occurrenceId;
  if (Object.hasOwn(captured, 'decisionId') && ownValue(captured, 'decisionId', 'O identificador da decisão') !== decisionId) {
    throw new TypeError('Identificador canônico da decisão de revisão inválido.');
  }
  return Object.freeze({ decisionId, ...canonical });
}

function requireArray(record, key, label) {
  const value = ownValue(record, key, label);
  if (!Array.isArray(value)) throw new TypeError(`${label} deve ser uma lista.`);
  return value;
}

function snapshotDecisionList(value, label) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > MAX_REVIEW_DECISIONS || keys.length !== length.value + 1) {
      throw new TypeError();
    }
    const captured = new Array(length.value);
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      captured[index] = descriptor.value;
    }
    return captured;
  } catch {
    throw decisionBoundaryError(`${label} deve ser uma lista densa, limitada e formada por propriedades de dados.`);
  }
}

export function applyReviewDecisions(auditModel, decisions) {
  let capturedModel;
  try {
    capturedModel = captureAuditInput(auditModel);
  } catch {
    throw new TypeError('Modelo de auditoria inválido.');
  }
  if (!isPlainRecord(capturedModel)) throw new TypeError('Modelo de auditoria inválido.');
  assertJsonData(capturedModel, 'Modelo de auditoria');
  const auditId = required(ownValue(capturedModel, 'auditId', 'O identificador da auditoria'), 'O identificador da auditoria');
  const decisionInputs = snapshotDecisionList(decisions, 'As decisões');
  const sourceItems = requireArray(capturedModel, 'itemResults', 'Os resultados de itens');
  const sourceOccurrences = requireArray(capturedModel, 'occurrences', 'As ocorrências');
  const sourceRules = requireArray(capturedModel, 'ruleResults', 'Os resultados de regras');
  const sourceManualReview = requireArray(capturedModel, 'manualReview', 'A fila de revisão');
  const sourcePrior = requireArray(capturedModel, 'reviewDecisions', 'O histórico de decisões');

  const itemIds = new Set();
  for (const item of sourceItems) {
    const id = required(ownValue(item, 'id', 'O identificador do item'), 'O identificador do item');
    if (itemIds.has(id)) throw new TypeError('Inventário de itens duplicado ou ambíguo.');
    itemIds.add(id);
  }
  const sourceRuleById = new Map();
  for (const rule of sourceRules) {
    const ruleId = required(ownValue(rule, 'ruleId', 'O identificador da regra'), 'O identificador da regra');
    const mode = ownValue(rule, 'mode', 'O modo da regra');
    if (!MODES.includes(mode) && mode !== 'automated') throw new TypeError('A regra possui modo inválido.');
    if (sourceRuleById.has(ruleId)) throw new TypeError('O inventário de regras é duplicado ou ambíguo.');
    sourceRuleById.set(ruleId, { mode });
  }
  const occurrenceIds = new Set();
  const sourceOccurrenceById = new Map();
  for (const occurrence of sourceOccurrences) {
    const id = required(ownValue(occurrence, 'occurrenceId', 'O identificador da ocorrência'), 'O identificador da ocorrência');
    const itemId = required(ownValue(occurrence, 'itemId', 'O vínculo da ocorrência'), 'O vínculo da ocorrência');
    const ruleId = ruleReference(ownValue(occurrence, 'ruleId', 'A regra da ocorrência'), 'A regra da ocorrência');
    const mode = ownValue(occurrence, 'mode', 'O modo da ocorrência');
    if (!MODES.includes(mode) && mode !== 'automated') throw new TypeError('A ocorrência possui modo inválido.');
    if (occurrenceIds.has(id)) throw new TypeError('Inventário de ocorrências duplicado ou ambíguo.');
    occurrenceIds.add(id);
    sourceOccurrenceById.set(id, { occurrence, itemId, ruleId, mode });
  }
  const reviewQueueByOccurrence = new Map();
  for (const entry of sourceManualReview) {
    const occurrenceId = required(ownValue(entry, 'occurrenceId', 'O vínculo da fila'), 'O vínculo da fila');
    const itemId = required(ownValue(entry, 'itemId', 'O item da fila'), 'O item da fila');
    const source = sourceOccurrenceById.get(occurrenceId);
    if (!source || source.itemId !== itemId) {
      throw new TypeError('A fila de revisão referencia item ou ocorrência desconhecidos.');
    }
    if (ownValue(source.occurrence, 'outcome', 'O resultado da ocorrência') !== 'cantTell') {
      throw new TypeError('A revisão humana exige ocorrência originalmente cantTell.');
    }
    const ruleId = ruleReference(ownValue(entry, 'ruleId', 'A regra da fila'), 'A regra da fila');
    if (ruleId !== source.ruleId) throw new TypeError('A fila de revisão referencia regra incoerente.');
    const sourceRule = ruleId === null ? null : sourceRuleById.get(ruleId);
    if (ruleId !== null && (!sourceRule || sourceRule.mode !== source.mode)) {
      throw new TypeError('A ocorrência da fila não corresponde ao inventário original de regras.');
    }
    const mode = ownValue(entry, 'mode', 'O modo da fila');
    const expectedMode = source.mode === 'manual' ? 'manual' : 'assisted';
    if (mode !== expectedMode) throw new TypeError('A fila de revisão possui modo incoerente.');
    const status = ownValue(entry, 'status', 'O status da fila');
    if (status !== 'unanswered' && status !== 'answered') throw new TypeError('A fila de revisão possui status inválido.');
    if (Object.hasOwn(entry, 'auditId') && ownValue(entry, 'auditId', 'A auditoria da fila') !== auditId) {
      throw new TypeError('A fila de revisão pertence a outra auditoria.');
    }
    const decisionId = Object.hasOwn(entry, 'decisionId')
      ? required(ownValue(entry, 'decisionId', 'A decisão da fila'), 'A decisão da fila')
      : undefined;
    if (reviewQueueByOccurrence.has(occurrenceId)) throw new TypeError('A fila de revisão é duplicada ou ambígua.');
    reviewQueueByOccurrence.set(occurrenceId, { itemId, ruleId, mode, status, decisionId });
  }

  const normalized = [];
  for (const input of decisionInputs) normalized.push(createReviewDecision(input));
  const prior = [];
  for (const input of snapshotDecisionList(sourcePrior, 'O histórico de decisões')) {
    const canonical = createReviewDecision(input);
    if (canonicalStringify(input) !== canonicalStringify(canonical)) {
      throw new TypeError('O histórico contém decisão não canônica ou alterada.');
    }
    prior.push(canonical);
  }
  const priorByOccurrence = new Map();
  for (const decision of prior) {
    if (priorByOccurrence.has(decision.occurrenceId)) {
      throw new TypeError('Histórico de decisões duplicado ou ambíguo.');
    }
    priorByOccurrence.set(decision.occurrenceId, decision);
  }
  const normalizedByOccurrence = new Map();
  for (const decision of normalized) {
    if (normalizedByOccurrence.has(decision.occurrenceId)) {
      throw new TypeError('Lista de novas decisões duplicada ou ambígua.');
    }
    normalizedByOccurrence.set(decision.occurrenceId, decision);
  }
  // From here onward only the inert snapshot crosses another traversal. Any
  // decision Proxy trap may mutate its source graph, never this captured model.
  const cloned = structuredClone(capturedModel);
  const itemById = new Map(cloned.itemResults.map(item => [item.id, item]));
  const occurrenceById = new Map(cloned.occurrences.map(occurrence => [occurrence.occurrenceId, occurrence]));
  for (const decision of [...prior, ...normalized]) {
    if (decision.auditId !== auditId) throw new TypeError('A decisão pertence a outra auditoria.');
    if (!itemById.has(decision.itemId)) throw new TypeError('Decisão referencia item de revisão desconhecido.');
    const occurrence = occurrenceById.get(decision.occurrenceId);
    if (!occurrence) throw new TypeError('Decisão referencia ocorrência de revisão desconhecida.');
    if (occurrence.itemId !== decision.itemId) throw new TypeError('A ocorrência não pertence ao item informado.');
    const queue = reviewQueueByOccurrence.get(decision.occurrenceId);
    if (occurrence.outcome !== 'cantTell' || !queue) {
      throw new TypeError('A decisão humana exige ocorrência originalmente cantTell presente na fila.');
    }
    if (queue.itemId !== decision.itemId || queue.mode !== decision.mode) {
      throw new TypeError('A decisão não corresponde exatamente à fila de revisão.');
    }
  }
  for (const [occurrenceId, queue] of reviewQueueByOccurrence) {
    const priorDecision = priorByOccurrence.get(occurrenceId);
    if (queue.status === 'answered') {
      if (!priorDecision || queue.decisionId !== priorDecision.decisionId) {
        throw new TypeError('A fila respondida não corresponde ao histórico de decisões.');
      }
    } else if (priorDecision || queue.decisionId !== undefined) {
      throw new TypeError('A fila não respondida não pode conter uma decisão anterior.');
    }
  }

  const combinedByOccurrence = new Map(priorByOccurrence);
  let addedDecisionCount = 0;
  for (const decision of normalized) {
    const existing = combinedByOccurrence.get(decision.occurrenceId);
    if (existing) {
      if (canonicalStringify(existing) === canonicalStringify(decision)) continue;
      // A decisão só é substituída por uma revisão explícita, que carrega a anterior na trilha.
      if (!isRevisionOf(existing, decision)) {
        throw new TypeError('A decisão imutável da ocorrência não pode ser substituída.');
      }
      combinedByOccurrence.set(decision.occurrenceId, decision);
      addedDecisionCount += 1;
      continue;
    }
    // Uma primeira decisão não pode trazer trilha: revisões só nascem substituindo uma decisão existente.
    if (decision.revisions?.length) {
      throw new TypeError('Uma decisão nova não pode carregar respostas anteriores.');
    }
    combinedByOccurrence.set(decision.occurrenceId, decision);
    addedDecisionCount += 1;
  }
  const combined = [...combinedByOccurrence.values()];
  const reviewableByItem = new Map();
  for (const occurrence of cloned.occurrences) {
    const list = reviewableByItem.get(occurrence.itemId) || [];
    list.push(occurrence);
    reviewableByItem.set(occurrence.itemId, list);
  }

  cloned.itemResults = cloned.itemResults.map(item => {
    const occurrences = reviewableByItem.get(item.id) || [];
    const itemDecisions = occurrences.map(occurrence => combinedByOccurrence.get(occurrence.occurrenceId)).filter(Boolean);
    if (itemDecisions.length === 0) return item;
    const originalOutcome = item.originalOutcome ?? item.outcome;
    const reviewedOutcome = deriveReviewedItemOutcome(originalOutcome, occurrences, itemDecisions);
    const evaluators = [...new Set(itemDecisions.map(decision => decision.evaluator))];
    const modes = [...new Set(itemDecisions.map(decision => decision.mode))];
    const latest = [...itemDecisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).at(-1);
    return {
      ...item,
      originalOutcome,
      reviewedOutcome,
      outcome: reviewedOutcome,
      review: {
        mode: modes.length === 1 ? modes[0] : 'manual',
        evaluator: canonicalEvaluatorSummary(evaluators),
        decidedAt: latest.decidedAt,
        decisionIds: itemDecisions.map(decision => decision.decisionId),
      },
    };
  });
  cloned.manualReview = sourceManualReview.map((_, index) => {
    const entry = cloned.manualReview[index];
    const decision = combinedByOccurrence.get(entry.occurrenceId);
    return decision ? { ...entry, status: 'answered', decisionId: decision.decisionId } : entry;
  });
  cloned.reviewDecisions = combined;
  if (addedDecisionCount > 0 && cloned.integrity?.algorithm === 'SHA-256') {
    cloned.integrity = { ...cloned.integrity, canonicalModelHash: 'pending' };
  }
  if (addedDecisionCount > 0 && cloned.report?.artifact) {
    cloned.report = {
      ...cloned.report,
      status: 'review-ready',
      artifact: { status: 'pending', formats: [] },
    };
  }
  assertJsonData(cloned, 'Modelo revisado');
  return freeze(cloned);
}

export { ANSWERS as REVIEW_ANSWERS, MODES as REVIEW_MODES };
