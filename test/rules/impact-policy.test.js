import test from 'node:test';
import assert from 'node:assert/strict';

import { CORE_RULES } from '../../src/core/audit.js';
import { IMPACT_LEVELS } from '../../src/core/result.js';
import {
  CORE_IMPACT_LEVELS,
  CORE_IMPACT_POLICY_VERSION,
  CORE_RULE_IMPACTS,
  DEFAULT_CORE_IMPACT,
  coreImpactEntry,
  coreRuleImpact,
  uncoveredCoreRuleIds,
  validateCoreImpactPolicy,
} from '../../src/core/rules/impact-policy.js';
import { IMPACT_LABELS, impactLabel, impactText } from '../../src/core/report/impact-labels.js';

const INSTALLED_RULE_IDS = CORE_RULES.map(rule => rule.id);

test('a política cobre todas as regras do inventário do motor próprio', () => {
  assert.equal(CORE_IMPACT_POLICY_VERSION, 'CoreRuleImpactPolicyV1');
  assert.deepEqual(uncoveredCoreRuleIds(INSTALLED_RULE_IDS), []);
  assert.deepEqual(validateCoreImpactPolicy(INSTALLED_RULE_IDS), []);
  assert.equal(Object.keys(CORE_RULE_IMPACTS).length, INSTALLED_RULE_IDS.length);
});

test('a tabela não tem regra desconhecida nem impacto fora dos níveis válidos', () => {
  for (const [ruleId, impact] of Object.entries(CORE_RULE_IMPACTS)) {
    assert.ok(INSTALLED_RULE_IDS.includes(ruleId), `Regra fora do inventário: ${ruleId}`);
    assert.ok(IMPACT_LEVELS.includes(impact), `Impacto inválido em ${ruleId}: ${impact}`);
    assert.deepEqual(CORE_IMPACT_LEVELS, IMPACT_LEVELS);
  }
  assert.ok(IMPACT_LEVELS.includes(DEFAULT_CORE_IMPACT));
  assert.equal(Object.isFrozen(CORE_RULE_IMPACTS), true);
  assert.equal(Object.isFrozen(coreImpactEntry('content-image-alternative')), true);
  assert.equal(coreRuleImpact('regra-inexistente'), DEFAULT_CORE_IMPACT);
});

test('falhas que impedem a tarefa ficam como crítico', () => {
  for (const ruleId of [
    'accessible-component-name',
    'form-field-label',
    'form-label-association',
    'content-image-alternative',
    'functional-image-alternative',
    'image-map-alternative',
    'complex-image-description',
    'keyboard-focus-trap',
    'hover-only-interactive-content',
    'partial-keyboard-access',
    'full-keyboard-access',
    'flashing-content-limit',
  ]) {
    assert.equal(coreRuleImpact(ruleId), 'critical', ruleId);
  }
});

test('barreiras que dificultam muito ficam como alto', () => {
  for (const ruleId of [
    'text-contrast-minimum',
    'component-contrast',
    'focus-visible',
    'focus-partially-visible',
    'focus-order',
    'focus-indicator-contrast',
    'page-language',
    'part-language',
    'page-title',
    'frame-title',
    'zoom-not-blocked',
    'target-size-minimum',
  ]) {
    assert.equal(coreRuleImpact(ruleId), 'serious', ruleId);
  }
});

test('estrutura e semântica ficam como moderado', () => {
  for (const ruleId of [
    'heading-semantics',
    'heading-order',
    'main-heading',
    'landmark-semantics',
    'unique-landmarks',
    'list-semantics',
    'table-semantics',
    'table-title-association',
    'decorative-image-alternative',
  ]) {
    assert.equal(coreRuleImpact(ruleId), 'moderate', ruleId);
  }
});

test('avisos e ajudas de leitura ficam como baixo', () => {
  for (const ruleId of [
    'new-window-link-warning',
    'file-link-identification',
    'external-link-identification',
    'adjacent-links',
    'contextual-help',
    'reading-level',
    'concurrent-input-mechanisms',
    'interaction-animation',
  ]) {
    assert.equal(coreRuleImpact(ruleId), 'minor', ruleId);
  }
});

test('os rótulos de impacto são os mesmos em toda a interface', () => {
  assert.deepEqual(IMPACT_LABELS, { critical: 'Crítico', serious: 'Alto', moderate: 'Moderado', minor: 'Baixo' });
  assert.equal(impactLabel('serious'), 'Alto');
  assert.equal(impactLabel('minor'), 'Baixo');
  assert.equal(impactText('critical'), 'Impacto Crítico');
  assert.equal(impactText('minor'), 'Impacto Baixo');
  assert.equal(impactText('serious', true), 'Impacto se confirmado: Alto');
  assert.equal(impactText(null), null);
  assert.equal(impactText(undefined, true), null);
});
