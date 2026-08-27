import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from '../normative/nbr17225.js';
import { OUTCOMES, TEST_MODES } from '../result.js';
import { createReviewDecision, REVIEW_MODES } from '../review/decisions.js';
import { canonicalStringify } from './canonical-json.js';

const SESSION_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const REVIEW_STATUSES = new Set(['unanswered', 'answered']);
const METHODOLOGY_NAME = 'Audita MT — ABNT NBR 17225 e WCAG 2.2';
const EXPECTED_RULE_COUNT = 130;

export function createAuditModel(input) {
  const model = JSON.parse(canonicalStringify(input));
  if (model.schemaVersion !== 1) throw new TypeError('schemaVersion de relatório inválida.');
  requiredId(model.auditId, 'auditId');
  model.requestedUrl = reportUrl(model.requestedUrl, 'requestedUrl');
  model.finalUrl = reportUrl(model.finalUrl, 'finalUrl');
  validateTimestamps(model.timestamps);
  requiredText(model.timezone, 'timezone');
  validateVersions(model.versions);
  validateMethodology(model.methodology, model.versions, model.reproducibility);
  validateEnvironment(model.environment);
  validateScope(model.scope);
  validateSession(model.session);
  validateLimitations(model.limitations);
  model.itemResults = validateItems(model.itemResults);
  const ruleById = validateRules(model.ruleResults, new Set(model.itemResults.map(item => item.id)));
  const graph = validateEvidenceAndOccurrences(model, ruleById);
  validateReview(model, graph);
  validateNormative(model.normative);
  return deepFreeze(model);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} deve ser texto não vazio.`);
  return value.trim();
}

function requiredId(value, label) {
  const id = requiredText(value, label);
  if (id !== value) throw new TypeError(`${label} deve estar em forma canônica, sem espaços externos.`);
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(id)) throw new TypeError(`${label} inválido.`);
  return id;
}

function canonicalText(value, label) {
  const text = requiredText(value, label);
  if (text !== value) throw new TypeError(`${label} deve estar em forma canônica, sem espaços externos.`);
  return text;
}

function reportUrl(value, label) {
  requiredText(value, label);
  const sanitized = sanitizeResourceUrl(value);
  if (!/^https?:\/\//u.test(sanitized)) throw new TypeError(`${label} deve ser URL HTTP(S) segura.`);
  return sanitized;
}

function validateTimestamps(timestamps) {
  if (!timestamps || typeof timestamps !== 'object' || Array.isArray(timestamps)) throw new TypeError('timestamps inválidos.');
  for (const key of ['startedAt', 'endedAt', 'generatedAt']) {
    const value = requiredText(timestamps[key], `timestamps.${key}`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`timestamps.${key} deve ser ISO canônico.`);
  }
}

function validateVersions(versions) {
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) throw new TypeError('versions inválido.');
  for (const key of ['extension', 'rules', 'browser']) requiredText(versions[key], `versions.${key}`);
}

function validateMethodology(methodology, versions, reproducibility) {
  if (!methodology || typeof methodology !== 'object' || Array.isArray(methodology)) throw new TypeError('methodology inválida.');
  if (canonicalText(methodology.name, 'methodology.name') !== METHODOLOGY_NAME) throw new TypeError('Nome da metodologia inválido.');
  const version = canonicalText(methodology.version, 'methodology.version');
  if (version !== versions.rules) throw new TypeError('Versão da metodologia incoerente com a versão das regras.');
  if (!Number.isSafeInteger(methodology.ruleCount) || methodology.ruleCount !== EXPECTED_RULE_COUNT) throw new TypeError('methodology.ruleCount deve registrar as 130 regras esperadas.');
  if (!Number.isSafeInteger(methodology.itemCount) || methodology.itemCount !== NBR17225_ITEMS.length) throw new TypeError('methodology.itemCount deve registrar os 146 itens oficiais.');
  if (reproducibility?.methodologyVersion !== undefined && reproducibility.methodologyVersion !== version) {
    throw new TypeError('Versão reprodutível da metodologia incoerente.');
  }
}

function validateEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('environment inválido.');
  const viewport = environment.viewport;
  if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)) throw new TypeError('viewport inválido.');
  for (const key of ['width', 'height', 'deviceScaleFactor']) {
    if (!Number.isFinite(viewport[key]) || viewport[key] <= 0) throw new TypeError(`viewport.${key} inválido.`);
  }
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('scope inválido.');
  requiredText(scope.kind, 'scope.kind');
  requiredText(scope.description, 'scope.description');
}

function validateSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session) || !SESSION_STATUSES.has(session.status)) throw new TypeError('session inválida.');
  if (!Array.isArray(session.diagnostics)) throw new TypeError('session.diagnostics deve ser lista.');
}

function validateLimitations(limitations) {
  if (!Array.isArray(limitations) || limitations.some(value => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('limitations deve conter textos não vazios.');
  }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length !== NBR17225_ITEMS.length) throw new TypeError('O modelo deve conter exatamente 146 resultados de item.');
  const byId = new Map();
  for (const item of items) {
    const id = requiredId(item?.id, 'item.id');
    if (byId.has(id)) throw new TypeError(`Item duplicado: ${id}.`);
    byId.set(id, item);
    if (!OUTCOMES.includes(item.outcome)) throw new TypeError(`Resultado inválido no item ${id}.`);
    for (const field of ['originalOutcome', 'reviewedOutcome']) {
      if (item[field] !== undefined && !OUTCOMES.includes(item[field])) throw new TypeError(`${field} inválido no item ${id}.`);
    }
  }
  for (const expected of NBR17225_ITEMS) {
    const item = byId.get(expected.id);
    if (!item) throw new TypeError(`Catálogo normativo não contém o item oficial ${expected.id}.`);
    for (const field of ['id', 'printedId', 'title', 'classification', 'evaluation', 'humanReason']) {
      if (item[field] !== expected[field]) throw new TypeError(`Metadado normativo adulterado em ${expected.id}.${field}.`);
    }
    if (canonicalStringify(item.wcag) !== canonicalStringify(expected.wcag)
      || canonicalStringify(item.ruleIds) !== canonicalStringify(expected.ruleIds)) {
      throw new TypeError(`Referências normativas adulteradas no item ${expected.id}.`);
    }
  }
  return NBR17225_ITEMS.map(expected => byId.get(expected.id));
}

function validateRules(rules, itemIds) {
  if (!Array.isArray(rules)) throw new TypeError('ruleResults deve ser lista.');
  const byId = new Map();
  for (const rule of rules) {
    const id = requiredId(rule?.ruleId, 'ruleId');
    if (byId.has(id)) throw new TypeError(`Regra duplicada: ${id}.`);
    if (!OUTCOMES.includes(rule.outcome) || !TEST_MODES.includes(rule.mode)) throw new TypeError(`Regra ${id} inválida.`);
    if (!Array.isArray(rule.nbrItems) || !rule.nbrItems.length) throw new TypeError(`Regra ${id} não referencia itens.`);
    const linked = new Set();
    for (const itemId of rule.nbrItems) {
      const canonicalItemId = requiredId(itemId, `Regra ${id}.nbrItems`);
      if (!itemIds.has(canonicalItemId)) throw new TypeError(`Regra ${id} referencia item desconhecido.`);
      if (linked.has(canonicalItemId)) throw new TypeError(`Regra ${id} contém vínculo de item duplicado.`);
      linked.add(canonicalItemId);
    }
    byId.set(id, rule);
  }
  return byId;
}

function validateEvidenceAndOccurrences(model, ruleById) {
  if (!model.evidence || typeof model.evidence !== 'object' || !Array.isArray(model.evidence.artifacts)) throw new TypeError('Store de evidências inválido.');
  const evidenceIds = new Set();
  const artifactById = new Map();
  for (const artifact of model.evidence.artifacts) {
    const id = requiredId(artifact?.evidenceId, 'evidenceId');
    if (evidenceIds.has(id)) throw new TypeError(`Evidência duplicada: ${id}.`);
    evidenceIds.add(id);
    artifactById.set(id, artifact);
  }
  for (const artifact of model.evidence.artifacts) {
    if (artifact.fullPageEvidenceId !== undefined) {
      const fullPageId = requiredId(artifact.fullPageEvidenceId, `Evidência ${artifact.evidenceId}.fullPageEvidenceId`);
      if (artifactById.get(fullPageId)?.kind !== 'full-page') throw new TypeError(`Evidência ${artifact.evidenceId} referencia captura integral desconhecida.`);
    }
  }
  if (!Array.isArray(model.occurrences)) throw new TypeError('occurrences deve ser lista.');
  const itemIds = new Set(model.itemResults.map(item => item.id));
  const occurrenceById = new Map();
  for (const occurrence of model.occurrences) {
    const id = requiredId(occurrence?.occurrenceId, 'occurrenceId');
    if (occurrenceById.has(id)) throw new TypeError(`Ocorrência duplicada: ${id}.`);
    if (!itemIds.has(occurrence.itemId)) throw new TypeError(`Ocorrência ${id} referencia item desconhecido.`);
    if (!OUTCOMES.includes(occurrence.outcome) || !TEST_MODES.includes(occurrence.mode)) throw new TypeError(`Ocorrência ${id} inválida.`);
    if (occurrence.ruleId === null) {
      if (occurrence.mode !== 'manual') throw new TypeError(`Ocorrência ${id} sem regra deve ser manual.`);
    } else {
      const ruleId = requiredId(occurrence.ruleId, `Ocorrência ${id}.ruleId`);
      const rule = ruleById.get(ruleId);
      if (!rule) throw new TypeError(`Ocorrência ${id} referencia regra desconhecida.`);
      if (!rule.nbrItems.includes(occurrence.itemId) || rule.mode !== occurrence.mode) {
        throw new TypeError(`Ocorrência ${id} possui vínculo de regra incoerente.`);
      }
    }
    if (!Array.isArray(occurrence.evidenceIds)) throw new TypeError(`Ocorrência ${id} deve listar evidências.`);
    const links = new Set();
    for (const evidenceId of occurrence.evidenceIds) {
      const canonicalEvidenceId = requiredId(evidenceId, `Ocorrência ${id}.evidenceIds`);
      if (!evidenceIds.has(canonicalEvidenceId)) throw new TypeError(`Ocorrência ${id} referencia evidência desconhecida.`);
      if (links.has(canonicalEvidenceId)) throw new TypeError(`Ocorrência ${id} contém evidência duplicada.`);
      links.add(canonicalEvidenceId);
    }
    occurrenceById.set(id, occurrence);
  }
  return { itemIds, ruleById, occurrenceById, evidenceIds };
}

function validateReview(model, { itemIds, occurrenceById }) {
  if (!Array.isArray(model.manualReview) || !Array.isArray(model.reviewDecisions)) throw new TypeError('Fila e decisões de revisão devem ser listas.');
  const queueByOccurrence = new Map();
  for (const entry of model.manualReview) {
    const occurrenceId = requiredId(entry?.occurrenceId, 'manualReview.occurrenceId');
    if (queueByOccurrence.has(occurrenceId)) throw new TypeError(`Fila de revisão duplicada para ${occurrenceId}.`);
    const occurrence = occurrenceById.get(occurrenceId);
    if (!occurrence) throw new TypeError(`Fila de revisão referencia ocorrência desconhecida: ${occurrenceId}.`);
    if (!itemIds.has(entry.itemId) || entry.itemId !== occurrence.itemId) throw new TypeError(`Fila de revisão ${occurrenceId} referencia item incoerente.`);
    if (entry.ruleId !== occurrence.ruleId) throw new TypeError(`Fila de revisão ${occurrenceId} referencia regra incoerente.`);
    if (!REVIEW_MODES.includes(entry.mode)) throw new TypeError(`Modo inválido na fila de revisão ${occurrenceId}.`);
    const expectedMode = occurrence.mode === 'manual' ? 'manual' : 'assisted';
    if (entry.mode !== expectedMode) throw new TypeError(`Modo incoerente na fila de revisão ${occurrenceId}.`);
    if (!REVIEW_STATUSES.has(entry.status)) throw new TypeError(`Status inválido na fila de revisão ${occurrenceId}.`);
    canonicalText(entry.question, `manualReview ${occurrenceId}.question`);
    canonicalText(entry.reason, `manualReview ${occurrenceId}.reason`);
    if (entry.auditId !== undefined && entry.auditId !== model.auditId) throw new TypeError(`Fila de revisão ${occurrenceId} pertence a outra auditoria.`);
    queueByOccurrence.set(occurrenceId, entry);
  }

  const decisionIds = new Set();
  const decisionByOccurrence = new Map();
  for (const decision of model.reviewDecisions) {
    const normalized = createReviewDecision(decision);
    const decisionId = requiredId(decision.decisionId, 'reviewDecision.decisionId');
    if (decisionId !== normalized.decisionId) throw new TypeError(`Identificador de decisão incoerente: ${decisionId}.`);
    if (decisionIds.has(decisionId) || decisionByOccurrence.has(normalized.occurrenceId)) throw new TypeError('Decisão de revisão duplicada ou ambígua.');
    if (normalized.auditId !== model.auditId) throw new TypeError('Decisão pertence a outra auditoria.');
    const occurrence = occurrenceById.get(normalized.occurrenceId);
    if (!occurrence || occurrence.itemId !== normalized.itemId) throw new TypeError('Decisão referencia item ou ocorrência desconhecidos.');
    const queue = queueByOccurrence.get(normalized.occurrenceId);
    if (!queue || queue.mode !== normalized.mode) throw new TypeError('Decisão não corresponde à fila de revisão.');
    for (const field of ['auditId', 'itemId', 'occurrenceId', 'answer', 'evaluator', 'decidedAt', 'mode', 'note']) {
      if (decision[field] !== normalized[field]) throw new TypeError(`Decisão ${decisionId} não está em forma canônica.`);
    }
    decisionIds.add(decisionId);
    decisionByOccurrence.set(normalized.occurrenceId, normalized);
  }
  for (const [occurrenceId, entry] of queueByOccurrence) {
    const decision = decisionByOccurrence.get(occurrenceId);
    if (entry.status === 'answered') {
      if (!decision || entry.decisionId !== decision.decisionId) throw new TypeError(`Fila respondida ${occurrenceId} não referencia sua decisão.`);
    } else if (decision || entry.decisionId !== undefined) {
      throw new TypeError(`Fila não respondida ${occurrenceId} não pode conter decisão.`);
    }
  }
}

function validateNormative(normative) {
  if (normative === undefined) return;
  if (!normative || typeof normative !== 'object' || Array.isArray(normative)) throw new TypeError('Registro normativo inválido.');
  if (normative.edition !== 'ABNT NBR 17225:2025' || normative.wcag !== 'WCAG 2.2') throw new TypeError('Fundamentação normativa adulterada.');
  if (normative.editorialNotes !== undefined
    && canonicalStringify(normative.editorialNotes) !== canonicalStringify(NBR17225_EDITORIAL_NOTES)) {
    throw new TypeError('Notas editoriais normativas adulteradas.');
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
