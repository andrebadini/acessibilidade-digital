import { TEST_MODES } from '../result.js';
import { NBR17225_ITEMS } from './nbr17225.js';
import { WCAG22_LEVELS } from './wcag22.js';

const CLASSIFICATIONS = Object.freeze(['requirement', 'recommendation']);

export function validateNormativeData({
  items = NBR17225_ITEMS,
  wcagLevels = WCAG22_LEVELS
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

  return errors;
}
