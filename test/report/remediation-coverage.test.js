import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { FORM_RULES } from '../../src/core/rules/forms.js';
import { INTERACTIVE_RULES } from '../../src/core/rules/interactive.js';
import { MANUAL_REVIEW_RULES } from '../../src/core/rules/manual-review.js';
import { MEDIA_RULES } from '../../src/core/rules/media.js';
import { STRUCTURE_RULES } from '../../src/core/rules/structure.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { registeredCoreRemediationReasons } from '../../src/core/report/remediation-policy.js';

// Um motivo emitido por uma regra core e ausente do catálogo fechado de remediação invalida o modelo
// inteiro no fim da auditoria. Foi assim que páginas com dois h1, rótulo "só para leitor de tela" ou
// rótulo fora da tela passaram a terminar em "A auditoria foi encerrada antes de concluir" (1.1.48 a
// 1.1.55). Estes testes leem os motivos literais das regras e exigem cada um no catálogo.
const HUMAN_REASONS = new Set(['human-judgment-required', 'page-level-insufficient-observation', 'page-level-human-judgment']);
const CORE_RULES = [FORM_RULES, INTERACTIVE_RULES, MANUAL_REVIEW_RULES, MEDIA_RULES, STRUCTURE_RULES, VISUAL_RULES].flat();
const REASON_LITERAL = /reason:\s*'([a-z0-9]+(?:-[a-z0-9]+)*)'/gu;

function literalReasons(source) {
  return [...new Set([...source.matchAll(REASON_LITERAL)].map(match => match[1]))];
}

test('cada motivo literal de uma regra core está no catálogo daquela regra', () => {
  const missing = [];
  for (const rule of CORE_RULES) {
    const registered = new Set(registeredCoreRemediationReasons(rule.id));
    for (const reason of literalReasons(String(rule.evaluate))) {
      if (!HUMAN_REASONS.has(reason) && !registered.has(reason)) missing.push(`${rule.id}: ${reason}`);
    }
  }
  assert.deepEqual(missing, [], 'motivos sem remediação registrada derrubam a auditoria inteira');
});

test('nenhum motivo literal nos arquivos de regras core fica fora do catálogo', async () => {
  const directory = new URL('../../src/core/rules/', import.meta.url);
  const registered = new Set(CORE_RULES.flatMap(rule => registeredCoreRemediationReasons(rule.id)));
  const missing = [];
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.js') && file !== 'editorial.js')) {
    for (const reason of literalReasons(await readFile(new URL(name, directory), 'utf8'))) {
      if (!HUMAN_REASONS.has(reason) && !registered.has(reason)) missing.push(`${name}: ${reason}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('uma vitrine grande cabe no teto de alvos por regra', async () => {
  const { validateCoreRuleTargetInventory } = await import('../../src/core/report/remediation-policy.js');
  const targets = Array.from({ length: 12_000 }, (_, index) => ({ nodeId: `n-${index}`,
    data: { reason: 'missing-accessible-name' }, message: 'Forneça um nome acessível objetivo para este componente.' }));
  assert.equal(validateCoreRuleTargetInventory('accessible-component-name', 'failed', targets), true);
});
