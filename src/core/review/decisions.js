const ANSWERS = Object.freeze(['conforme', 'não conforme', 'não foi possível determinar']);
const MODES = Object.freeze(['assisted', 'manual']);

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
  if (!isPlainRecord(input)) throw new TypeError('Decisão de revisão deve ser um objeto de dados simples.');
  assertJsonData(input, 'Decisão de revisão');
  const auditId = required(ownValue(input, 'auditId', 'O identificador da auditoria'), 'O identificador da auditoria');
  const itemId = required(ownValue(input, 'itemId', 'O identificador do item'), 'O identificador do item');
  const occurrenceId = required(ownValue(input, 'occurrenceId', 'O identificador da ocorrência'), 'O identificador da ocorrência');
  const answer = ownValue(input, 'answer', 'A resposta de revisão');
  if (!ANSWERS.includes(answer)) throw new TypeError('Resposta de revisão inválida.');
  const evaluator = required(ownValue(input, 'evaluator', 'O avaliador'), 'O avaliador');
  const decidedAt = canonicalInstant(ownValue(input, 'decidedAt', 'A data da decisão'));
  const mode = ownValue(input, 'mode', 'O modo de revisão');
  if (!MODES.includes(mode)) throw new TypeError('Modo de revisão inválido.');
  const noteValue = Object.hasOwn(input, 'note') ? ownValue(input, 'note', 'A nota da decisão') : undefined;
  if (noteValue !== undefined && typeof noteValue !== 'string') throw new TypeError('A nota da decisão deve ser texto.');
  const note = noteValue?.trim() || '';
  const canonical = { auditId, itemId, occurrenceId, answer, evaluator, decidedAt, mode, ...(note ? { note } : {}) };
  assertJsonData(canonical, 'Decisão de revisão');
  return Object.freeze({ decisionId: stableId(JSON.stringify(canonical)), ...canonical });
}

function requireArray(record, key, label) {
  const value = ownValue(record, key, label);
  if (!Array.isArray(value)) throw new TypeError(`${label} deve ser uma lista.`);
  return value;
}

export function applyReviewDecisions(auditModel, decisions) {
  if (!isPlainRecord(auditModel)) throw new TypeError('Modelo de auditoria inválido.');
  assertJsonData(auditModel, 'Modelo de auditoria');
  const auditId = required(ownValue(auditModel, 'auditId', 'O identificador da auditoria'), 'O identificador da auditoria');
  if (!Array.isArray(decisions)) throw new TypeError('As decisões devem ser uma lista.');
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
  const occurrenceIds = new Set();
  const sourceOccurrenceById = new Map();
  for (const occurrence of sourceOccurrences) {
    const id = required(ownValue(occurrence, 'occurrenceId', 'O identificador da ocorrência'), 'O identificador da ocorrência');
    required(ownValue(occurrence, 'itemId', 'O vínculo da ocorrência'), 'O vínculo da ocorrência');
    if (occurrenceIds.has(id)) throw new TypeError(`Ocorrência duplicada ou ambígua: ${id}.`);
    occurrenceIds.add(id);
    sourceOccurrenceById.set(id, occurrence);
  }
  const reviewableOccurrenceIds = new Set();
  for (const entry of sourceManualReview) {
    const occurrenceId = required(ownValue(entry, 'occurrenceId', 'O vínculo da fila'), 'O vínculo da fila');
    const itemId = required(ownValue(entry, 'itemId', 'O item da fila'), 'O item da fila');
    const occurrence = sourceOccurrenceById.get(occurrenceId);
    if (!occurrence || ownValue(occurrence, 'itemId', 'O item da ocorrência') !== itemId) {
      throw new TypeError('A fila de revisão referencia item ou ocorrência desconhecidos.');
    }
    if (ownValue(occurrence, 'outcome', 'O resultado da ocorrência') !== 'cantTell') {
      throw new TypeError('A revisão humana exige ocorrência originalmente cantTell.');
    }
    if (reviewableOccurrenceIds.has(occurrenceId)) throw new TypeError('A fila de revisão é duplicada ou ambígua.');
    reviewableOccurrenceIds.add(occurrenceId);
  }

  const normalized = decisions.map(createReviewDecision);
  const prior = sourcePrior.map(createReviewDecision);
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
    if (occurrence.outcome !== 'cantTell' || !reviewableOccurrenceIds.has(decision.occurrenceId)) {
      throw new TypeError('A decisão humana exige ocorrência originalmente cantTell presente na fila.');
    }
    if (normalized.includes(decision)) {
      if (seenOccurrences.has(decision.occurrenceId)) throw new TypeError('Decisão duplicada ou ambígua para a ocorrência.');
      seenOccurrences.add(decision.occurrenceId);
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

  const automaticFailures = new Set(sourceRules
    .filter(result => result.mode === 'automated' && result.outcome === 'failed')
    .flatMap(result => Array.isArray(result.nbrItems) ? result.nbrItems : []));
  cloned.itemResults = cloned.itemResults.map(item => {
    const occurrences = reviewableByItem.get(item.id) || [];
    const itemDecisions = occurrences.map(occurrence => combinedByOccurrence.get(occurrence.occurrenceId)).filter(Boolean);
    if (itemDecisions.length === 0) return item;
    let reviewedOutcome = 'cantTell';
    if (automaticFailures.has(item.id)) reviewedOutcome = 'failed';
    else if (itemDecisions.some(decision => decision.answer === 'não conforme')) reviewedOutcome = 'failed';
    else if (itemDecisions.length === occurrences.length && itemDecisions.every(decision => decision.answer === 'conforme')) reviewedOutcome = 'passed';
    const evaluators = [...new Set(itemDecisions.map(decision => decision.evaluator))];
    const modes = [...new Set(itemDecisions.map(decision => decision.mode))];
    const latest = [...itemDecisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).at(-1);
    return {
      ...item,
      originalOutcome: item.originalOutcome ?? item.outcome,
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
