import { captureAuditInput } from '../report/audit-input.js';

const ANSWERS = Object.freeze(['conforme', 'não conforme', 'não foi possível determinar']);
const MODES = Object.freeze(['assisted', 'manual']);
const MAX_REVIEW_DECISIONS = 10_000;
const DECISION_FIELDS = new Set([
  'decisionId', 'auditId', 'itemId', 'occurrenceId', 'answer', 'evaluator', 'decidedAt', 'mode', 'note',
]);

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
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} deve ser um identificador não vazio.`);
  return value.trim();
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

function stableId(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `decision-${hash.toString(16).padStart(8, '0')}`;
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
  const evaluator = required(ownValue(captured, 'evaluator', 'O avaliador'), 'O avaliador');
  const decidedAt = canonicalInstant(ownValue(captured, 'decidedAt', 'A data da decisão'));
  const mode = ownValue(captured, 'mode', 'O modo de revisão');
  if (!MODES.includes(mode)) throw new TypeError('Modo de revisão inválido.');
  const noteValue = Object.hasOwn(captured, 'note') ? ownValue(captured, 'note', 'A nota da decisão') : undefined;
  if (noteValue !== undefined && typeof noteValue !== 'string') throw new TypeError('A nota da decisão deve ser texto.');
  const note = noteValue?.trim() || '';
  const canonical = { auditId, itemId, occurrenceId, answer, evaluator, decidedAt, mode, ...(note ? { note } : {}) };
  assertJsonData(canonical, 'Decisão de revisão');
  const decisionId = stableId(JSON.stringify(canonical));
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
  if (!isPlainRecord(auditModel)) throw new TypeError('Modelo de auditoria inválido.');
  assertJsonData(auditModel, 'Modelo de auditoria');
  const auditId = required(ownValue(auditModel, 'auditId', 'O identificador da auditoria'), 'O identificador da auditoria');
  const decisionInputs = snapshotDecisionList(decisions, 'As decisões');
  const sourceItems = requireArray(auditModel, 'itemResults', 'Os resultados de itens');
  const sourceOccurrences = requireArray(auditModel, 'occurrences', 'As ocorrências');
  const sourceRules = requireArray(auditModel, 'ruleResults', 'Os resultados de regras');
  const sourceManualReview = requireArray(auditModel, 'manualReview', 'A fila de revisão');
  const sourcePrior = requireArray(auditModel, 'reviewDecisions', 'O histórico de decisões');

  const itemIds = new Set();
  for (const item of sourceItems) {
    const id = required(ownValue(item, 'id', 'O identificador do item'), 'O identificador do item');
    if (itemIds.has(id)) throw new TypeError(`Item duplicado ou ambíguo: ${id}.`);
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
    if (occurrenceIds.has(id)) throw new TypeError(`Ocorrência duplicada ou ambígua: ${id}.`);
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
  for (const input of snapshotDecisionList(sourcePrior, 'O histórico de decisões')) prior.push(createReviewDecision(input));
  // Clone only after validation so accessors and exotic prototypes are never executed.
  const cloned = structuredClone(auditModel);
  const itemById = new Map(cloned.itemResults.map(item => [item.id, item]));
  const occurrenceById = new Map(cloned.occurrences.map(occurrence => [occurrence.occurrenceId, occurrence]));
  const seenOccurrences = new Set();
  for (const decision of [...prior, ...normalized]) {
    if (decision.auditId !== auditId) throw new TypeError('A decisão pertence a outra auditoria.');
    if (!itemById.has(decision.itemId)) throw new TypeError(`Item de revisão desconhecido: ${decision.itemId}.`);
    const occurrence = occurrenceById.get(decision.occurrenceId);
    if (!occurrence) throw new TypeError(`Ocorrência de revisão desconhecida: ${decision.occurrenceId}.`);
    if (occurrence.itemId !== decision.itemId) throw new TypeError('A ocorrência não pertence ao item informado.');
    const queue = reviewQueueByOccurrence.get(decision.occurrenceId);
    if (occurrence.outcome !== 'cantTell' || !queue) {
      throw new TypeError('A decisão humana exige ocorrência originalmente cantTell presente na fila.');
    }
    if (queue.itemId !== decision.itemId || queue.mode !== decision.mode) {
      throw new TypeError('A decisão não corresponde exatamente à fila de revisão.');
    }
    if (normalized.includes(decision)) {
      if (seenOccurrences.has(decision.occurrenceId)) throw new TypeError('Decisão duplicada ou ambígua para a ocorrência.');
      seenOccurrences.add(decision.occurrenceId);
    }
  }
  const priorByOccurrence = new Map(prior.map(decision => [decision.occurrenceId, decision]));
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

  const combinedByOccurrence = new Map();
  for (const decision of [...prior, ...normalized]) {
    const existing = combinedByOccurrence.get(decision.occurrenceId);
    if (existing && existing.decisionId !== decision.decisionId) throw new TypeError('Histórico contém decisão duplicada ou ambígua.');
    combinedByOccurrence.set(decision.occurrenceId, decision);
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
    let reviewedOutcome = 'cantTell';
    const originalOutcome = item.originalOutcome ?? item.outcome;
    if (originalOutcome === 'failed') reviewedOutcome = 'failed';
    else if (itemDecisions.some(decision => decision.answer === 'não conforme')) reviewedOutcome = 'failed';
    else if (itemDecisions.length === occurrences.length && itemDecisions.every(decision => decision.answer === 'conforme')) reviewedOutcome = 'passed';
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
        evaluator: evaluators.join(', '),
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
  assertJsonData(cloned, 'Modelo revisado');
  return freeze(cloned);
}

export { ANSWERS as REVIEW_ANSWERS, MODES as REVIEW_MODES };
