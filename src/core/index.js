export { OUTCOMES, TEST_MODES, createRuleResult } from './result.js';
export { WCAG22_LEVELS } from './normative/wcag22.js';
export { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from './normative/nbr17225.js';
export { validateNormativeData } from './normative/validate-normative-data.js';
export { computeAccessibleText } from './accessibility/accessible-name.js';
export { buildAnnouncementPreview } from './accessibility/announcement.js';
export {
  SNAPSHOT_SCHEMA_VERSION,
  assertSnapshotV1,
  buildSnapshotIndexes,
  validateSnapshotV1
} from './snapshot-schema.js';
export { createRuleRegistry, registerRule } from './rules/registry.js';
export { runRules } from './rules/run-rules.js';
export { aggregateItems } from './rules/aggregate-items.js';
export { CORE_RULES, runCoreAudit, validateCoreRuleComposition } from './audit.js';
