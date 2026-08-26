import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { OUTCOMES, TEST_MODES } from '../result.js';
import { canonicalStringify } from './canonical-json.js';

const SESSION_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);

export function createAuditModel(input) {
  const model = JSON.parse(canonicalStringify(input));
  requiredId(model.auditId, 'auditId');
  model.requestedUrl = reportUrl(model.requestedUrl, 'requestedUrl');
  model.finalUrl = reportUrl(model.finalUrl, 'finalUrl');
  validateTimestamps(model.timestamps);
  requiredText(model.timezone, 'timezone');
  validateVersions(model.versions);
  validateEnvironment(model.environment);
  validateScope(model.scope);
  validateSession(model.session);
  validateLimitations(model.limitations);
  validateItems(model.itemResults);
  validateRules(model.ruleResults);
  validateEvidenceAndOccurrences(model);
  if (!Array.isArray(model.manualReview) || !Array.isArray(model.reviewDecisions)) {
    throw new TypeError('Fila e decisões de revisão devem ser listas.');
  }
  return deepFreeze(model);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} deve ser texto não vazio.`);
  return value.trim();
}

function requiredId(value, label) {
  const id = requiredText(value, label);
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(id)) throw new TypeError(`${label} inválido.`);
  return id;
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
  if (!Array.isArray(items) || items.length !== 146) throw new TypeError('O modelo deve conter exatamente 146 resultados de item.');
  const ids = new Set();
  for (const item of items) {
    const id = requiredId(item?.id, 'item.id');
    if (ids.has(id)) throw new TypeError(`Item duplicado: ${id}.`);
    ids.add(id);
    requiredText(item.title, `item ${id}.title`);
    if (!OUTCOMES.includes(item.outcome)) throw new TypeError(`Resultado inválido no item ${id}.`);
    if (!TEST_MODES.includes(item.evaluation)) throw new TypeError(`Modo inválido no item ${id}.`);
    if (!Array.isArray(item.wcag)) throw new TypeError(`WCAG inválida no item ${id}.`);
  }
}

function validateRules(rules) {
  if (!Array.isArray(rules)) throw new TypeError('ruleResults deve ser lista.');
  const ids = new Set();
  for (const rule of rules) {
    const id = requiredId(rule?.ruleId, 'ruleId');
    if (ids.has(id)) throw new TypeError(`Regra duplicada: ${id}.`);
    ids.add(id);
    if (!OUTCOMES.includes(rule.outcome) || !TEST_MODES.includes(rule.mode)) throw new TypeError(`Regra ${id} inválida.`);
  }
}

function validateEvidenceAndOccurrences(model) {
  if (!model.evidence || typeof model.evidence !== 'object' || !Array.isArray(model.evidence.artifacts)) throw new TypeError('Store de evidências inválido.');
  const evidenceIds = new Set();
  for (const artifact of model.evidence.artifacts) {
    const id = requiredId(artifact?.evidenceId, 'evidenceId');
    if (evidenceIds.has(id)) throw new TypeError(`Evidência duplicada: ${id}.`);
    evidenceIds.add(id);
  }
  if (!Array.isArray(model.occurrences)) throw new TypeError('occurrences deve ser lista.');
  const itemIds = new Set(model.itemResults.map(item => item.id));
  const occurrenceIds = new Set();
  for (const occurrence of model.occurrences) {
    const id = requiredId(occurrence?.occurrenceId, 'occurrenceId');
    if (occurrenceIds.has(id)) throw new TypeError(`Ocorrência duplicada: ${id}.`);
    occurrenceIds.add(id);
    if (!itemIds.has(occurrence.itemId)) throw new TypeError(`Ocorrência ${id} referencia item desconhecido.`);
    if (!OUTCOMES.includes(occurrence.outcome) || !TEST_MODES.includes(occurrence.mode)) throw new TypeError(`Ocorrência ${id} inválida.`);
    if (!Array.isArray(occurrence.evidenceIds) || occurrence.evidenceIds.some(evidenceId => !evidenceIds.has(evidenceId))) {
      throw new TypeError(`Ocorrência ${id} referencia evidência desconhecida.`);
    }
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
