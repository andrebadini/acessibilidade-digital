const ANSWERS = Object.freeze(['conforme', 'não conforme', 'não foi possível determinar']);
const MODES = Object.freeze(['assisted', 'manual']);

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} deve ser um identificador não vazio.`);
  return value.trim();
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('A data da decisão é obrigatória.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('A data da decisão deve ser ISO válida.');
  return date.toISOString();
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
  if (!input || typeof input !== 'object') throw new TypeError('Decisão de revisão inválida.');
  const auditId = required(input.auditId, 'O identificador da auditoria');
  const itemId = required(input.itemId, 'O identificador do item');
  const occurrenceId = required(input.occurrenceId, 'O identificador da ocorrência');
  if (!ANSWERS.includes(input.answer)) throw new TypeError('Resposta de revisão inválida.');
  const evaluator = required(input.evaluator, 'O avaliador');
  const decidedAt = canonicalInstant(input.decidedAt);
  const mode = input.mode ?? 'assisted';
  if (!MODES.includes(mode)) throw new TypeError('Modo de revisão inválido.');
  if (input.note !== undefined && typeof input.note !== 'string') throw new TypeError('A nota da decisão deve ser texto.');
  const note = input.note?.trim() || '';
  const canonical = { auditId, itemId, occurrenceId, answer: input.answer, evaluator, decidedAt, mode, ...(note ? { note } : {}) };
  JSON.stringify(canonical);
  return Object.freeze({ decisionId: stableId(JSON.stringify(canonical)), ...canonical });
}

export function applyReviewDecisions(auditModel, decisions) {
  if (!auditModel || typeof auditModel !== 'object' || typeof auditModel.auditId !== 'string') throw new TypeError('Modelo de auditoria inválido.');
  if (!Array.isArray(decisions)) throw new TypeError('As decisões devem ser uma lista.');
  const normalized = decisions.map(createReviewDecision);
  const prior = Array.isArray(auditModel.reviewDecisions) ? auditModel.reviewDecisions.map(createReviewDecision) : [];
  const itemById = new Map((auditModel.itemResults || []).map(item => [item.id, item]));
  const occurrenceById = new Map((auditModel.occurrences || []).map(occurrence => [occurrence.occurrenceId, occurrence]));
  const seenOccurrences = new Set();
  for (const decision of [...prior, ...normalized]) {
    if (decision.auditId !== auditModel.auditId) throw new TypeError('A decisão pertence a outra auditoria.');
    if (!itemById.has(decision.itemId)) throw new TypeError(`Item de revisão desconhecido: ${decision.itemId}.`);
    const occurrence = occurrenceById.get(decision.occurrenceId);
    if (!occurrence) throw new TypeError(`Ocorrência de revisão desconhecida: ${decision.occurrenceId}.`);
    if (occurrence.itemId !== decision.itemId) throw new TypeError('A ocorrência não pertence ao item informado.');
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
  for (const occurrence of auditModel.occurrences || []) {
    const list = reviewableByItem.get(occurrence.itemId) || [];
    list.push(occurrence);
    reviewableByItem.set(occurrence.itemId, list);
  }

  const automaticFailures = new Set((auditModel.ruleResults || [])
    .filter(result => result.mode === 'automated' && result.outcome === 'failed')
    .flatMap(result => Array.isArray(result.nbrItems) ? result.nbrItems : []));
  const itemResults = (auditModel.itemResults || []).map(item => {
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
  const manualReview = (auditModel.manualReview || []).map(entry => {
    const decision = combinedByOccurrence.get(entry.occurrenceId);
    return decision ? { ...entry, status: 'answered', decisionId: decision.decisionId } : entry;
  });
  const result = {
    ...auditModel,
    itemResults,
    manualReview,
    reviewDecisions: combined,
    evidence: auditModel.evidence,
    reproducibility: auditModel.reproducibility,
  };
  JSON.stringify(result);
  return freeze(result);
}

export { ANSWERS as REVIEW_ANSWERS, MODES as REVIEW_MODES };
