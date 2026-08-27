import { TEST_MODES } from '../result.js';
import { BRAZILIAN_LEGAL_BASIS } from '../legal/consumer-basis.js';
import { NBR17225_ITEMS } from './nbr17225.js';
import { FOREIGN_BENCHMARKS, WCAG20_AA_CRITERIA } from './section508.js';
import { WCAG22_LEVELS } from './wcag22.js';

const CLASSIFICATIONS = Object.freeze(['requirement', 'recommendation']);

export function validateNormativeData({
  items = NBR17225_ITEMS,
  wcagLevels = WCAG22_LEVELS,
  brazilianLegalBasis = BRAZILIAN_LEGAL_BASIS,
  foreignBenchmarks = FOREIGN_BENCHMARKS
} = {}) {
  const errors = [];
  const seenIds = new Set();
  const reportedDuplicateIds = new Set();

  for (const item of items) {
    if (seenIds.has(item.id) && !reportedDuplicateIds.has(item.id)) {
      errors.push(`ID ABNT duplicado: ${item.id}`);
      reportedDuplicateIds.add(item.id);
    }
    seenIds.add(item.id);
  }

  for (const item of items) {
    if (!CLASSIFICATIONS.includes(item.classification)) {
      errors.push(`Classificação inválida em ${item.id}: ${item.classification}`);
    }

    if (!TEST_MODES.includes(item.evaluation)) {
      errors.push(`Modo de avaliação inválido em ${item.id}: ${item.evaluation}`);
    }

    for (const reference of item.wcag) {
      const officialLevel = wcagLevels[reference.id];

      if (officialLevel === undefined) {
        errors.push(`Critério WCAG inexistente em ${item.id}: ${reference.id}`);
      } else if (reference.level !== officialLevel) {
        errors.push(
          `Nível WCAG divergente em ${item.id} para ${reference.id}: ` +
          `esperado ${officialLevel}, recebido ${reference.level}`
        );
      }
    }

    if (item.evaluation === 'automated' && item.ruleIds.length === 0) {
      errors.push(`Item automatizado sem ruleIds: ${item.id}`);
    }

    if (['assisted', 'manual'].includes(item.evaluation) && item.humanReason.trim() === '') {
      errors.push(`Razão humana ausente em ${item.id}`);
    }
  }

  validateCatalogNamespace(brazilianLegalBasis, 'Base jurídica brasileira', errors);
  validateCatalogNamespace(foreignBenchmarks, 'Referencial estrangeiro', errors, { requireWcag20Criteria: true });

  return errors;
}

function validateCatalogNamespace(namespace, label, errors, { requireWcag20Criteria = false } = {}) {
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
    errors.push(`${label} inválida.`);
    return;
  }
  const ids = new Set();
  for (const [key, catalog] of Object.entries(namespace)) {
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      errors.push(`${label} inválida em ${key}.`);
      continue;
    }
    if (typeof catalog.id !== 'string' || catalog.id.trim() === '') {
      errors.push(`ID ausente em ${label}: ${key}.`);
    } else if (ids.has(catalog.id)) {
      errors.push(`ID duplicado em ${label}: ${catalog.id}.`);
    } else {
      ids.add(catalog.id);
    }
    if (typeof catalog.version !== 'string' || catalog.version.trim() === '') errors.push(`Versão ausente em ${label}: ${key}.`);
    if (typeof catalog.label !== 'string' || catalog.label.trim() === '') errors.push(`Rótulo ausente em ${label}: ${key}.`);
    validateSources(catalog.sources, label, key, errors);
    validateNoLegalConclusionFields(catalog, label, key, errors);
    if (requireWcag20Criteria) validateWcag20Criteria(catalog, label, key, errors);
  }
}

function validateSources(sources, label, key, errors) {
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push(`Fontes ausentes em ${label}: ${key}.`);
    return;
  }
  const ids = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
      typeof source.id !== 'string' || !source.id.trim() ||
      typeof source.publisher !== 'string' || !source.publisher.trim() ||
      typeof source.title !== 'string' || !source.title.trim()) {
      errors.push(`Fonte inválida em ${label}: ${key}.`);
      continue;
    }
    if (ids.has(source.id)) errors.push(`Fonte duplicada em ${label}: ${source.id}.`);
    ids.add(source.id);
  }
}

function validateNoLegalConclusionFields(value, label, key, errors) {
  const forbidden = new Set(['violatedLaw', 'illegal', 'liability', 'sanction']);
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [field, child] of Object.entries(current)) {
      if (forbidden.has(field)) errors.push(`Campo jurídico conclusivo proibido em ${label}: ${key}.${field}.`);
      if (child && typeof child === 'object') stack.push(child);
    }
  }
}

function validateWcag20Criteria(catalog, label, key, errors) {
  if (catalog.wcagVersion !== 'WCAG 2.0' || !Array.isArray(catalog.criteria) || catalog.criteria.length === 0) {
    errors.push(`Crosswalk WCAG 2.0 ausente em ${label}: ${key}.`);
    return;
  }
  const expectedLevels = new Map(WCAG20_AA_CRITERIA.map(criterion => [criterion.id, criterion.level]));
  if (catalog.criteria.length !== WCAG20_AA_CRITERIA.length) {
    errors.push(`Quantidade de critérios WCAG 2.0 divergente em ${label}: esperado ${WCAG20_AA_CRITERIA.length}, recebido ${catalog.criteria.length}.`);
  }
  const ids = new Set();
  for (const criterion of catalog.criteria) {
    if (!criterion || typeof criterion.id !== 'string' || !/^\d\.\d\.\d$/u.test(criterion.id) || !['A', 'AA'].includes(criterion.level)) {
      errors.push(`Critério WCAG 2.0 inválido em ${label}: ${key}.`);
      continue;
    }
    const expectedLevel = expectedLevels.get(criterion.id);
    if (expectedLevel === undefined) {
      errors.push(`Critério WCAG 2.0 não incorporado em ${label}: ${criterion.id}.`);
    } else if (criterion.level !== expectedLevel) {
      errors.push(`Nível WCAG 2.0 divergente em ${label} para ${criterion.id}: esperado ${expectedLevel}, recebido ${criterion.level}.`);
    }
    if (ids.has(criterion.id)) errors.push(`Critério WCAG 2.0 duplicado em ${label}: ${criterion.id}.`);
    ids.add(criterion.id);
  }
  for (const criterion of WCAG20_AA_CRITERIA) {
    if (!ids.has(criterion.id)) errors.push(`Critério WCAG 2.0 ausente em ${label}: ${criterion.id}.`);
  }
}
