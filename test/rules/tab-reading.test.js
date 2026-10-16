import assert from 'node:assert/strict';
import test from 'node:test';

import { KEYBOARD_MAP_STOP_LIMIT, selectKeyboardMapStops } from '../../src/core/keyboard/keyboard-map-model.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { coreRuleImpact } from '../../src/core/rules/impact-policy.js';
import {
  TAB_READING_MESSAGE,
  TAB_READING_NBR_ITEM,
  TAB_READING_REASON,
  TAB_READING_RULES,
  TAB_READING_RULE_ID,
} from '../../src/core/rules/tab-reading.js';
import {
  canonicalCoreRemediation,
  registeredCoreRemediationReasons,
  validateCoreRuleTargetInventory,
} from '../../src/core/report/remediation-policy.js';

/** Instantâneo mínimo: as paradas saem dos mesmos campos que o mapa do teclado lê. */
function snapshot(nodes) {
  const normalized = nodes.map((node, index) => ({
    nodeId: node.nodeId ?? `n-${index + 1}`,
    parentId: null,
    children: [],
    tagName: 'button',
    attributes: {},
    framePath: [],
    hidden: false,
    hasRenderedBox: true,
    ...node,
  }));
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture', url: 'https://example.test/' },
    nodes: normalized,
  };
}

function rect(y, height = 30) {
  return { x: 10, y, width: 120, height };
}

const RULE = TAB_READING_RULES.find(rule => rule.id === TAB_READING_RULE_ID);

async function evaluate(value) {
  return (await runRules(value, {}, [RULE]))[0];
}

test('a regra existe no registro instalado e sua entrada normativa é o 5.13.10', async () => {
  assert.ok(RULE, `Regra ausente: ${TAB_READING_RULE_ID}`);
  assert.deepEqual(RULE.nbrItems, [TAB_READING_NBR_ITEM]);
  assert.equal(TAB_READING_NBR_ITEM, '5.13.10');
  assert.deepEqual(RULE.wcag, ['4.1.2']);
  const item = NBR17225_ITEMS.find(candidate => candidate.id === TAB_READING_NBR_ITEM);
  assert.equal(item.title, 'Componentes com nome acessível');
  assert.ok(item.ruleIds.includes(TAB_READING_RULE_ID), 'O item 5.13.10 declara a regra de leitura por Tab');
  // O 5.13.12 fala da semântica de componentes customizados, não do anúncio; é por isso que este tema
  // fica no 5.13.10, o item do nome e da função que o leitor de tela anuncia.
  assert.ok(!NBR17225_ITEMS.find(candidate => candidate.id === '5.13.12').ruleIds.includes(TAB_READING_RULE_ID));
});

test('gera uma pergunta por parada de Tab, na ordem do Tab', async () => {
  const value = await evaluate(snapshot([
    { nodeId: 'first', tagName: 'a', attributes: { href: '/um' }, accessibleName: 'Primeiro', axRole: 'link', rect: rect(10) },
    { nodeId: 'later', tagName: 'button', attributes: { tabindex: '2' }, accessibleName: 'Depois', axRole: 'button', rect: rect(50) },
    { nodeId: 'sooner', tagName: 'button', attributes: { tabindex: '1' }, accessibleName: 'Antes', axRole: 'button', rect: rect(90) },
  ]));
  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.targets, [
    { nodeId: 'sooner', data: { reason: TAB_READING_REASON }, message: TAB_READING_MESSAGE },
    { nodeId: 'later', data: { reason: TAB_READING_REASON }, message: TAB_READING_MESSAGE },
    { nodeId: 'first', data: { reason: TAB_READING_REASON }, message: TAB_READING_MESSAGE },
  ]);
  // Mesma lista de paradas que o mapa do teclado mostra: as duas leituras falam da mesma sequência.
  const stops = selectKeyboardMapStops(snapshot([
    { nodeId: 'first', tagName: 'a', attributes: { href: '/um' }, accessibleName: 'Primeiro', axRole: 'link', rect: rect(10) },
    { nodeId: 'later', tagName: 'button', attributes: { tabindex: '2' }, accessibleName: 'Depois', axRole: 'button', rect: rect(50) },
    { nodeId: 'sooner', tagName: 'button', attributes: { tabindex: '1' }, accessibleName: 'Antes', axRole: 'button', rect: rect(90) },
  ])).stops;
  assert.deepEqual(value.targets.map(target => target.nodeId), stops.map(stop => stop.nodeId));
  assert.equal(value.targets.length, 3);
});

test('cada alvo carrega exatamente nodeId, motivo fechado e mensagem', async () => {
  const value = await evaluate(snapshot([
    { nodeId: 'field', tagName: 'input', attributes: { type: 'text', value: 'segredo-do-formulario' }, accessibleName: 'CPF', axRole: 'textbox', rect: rect(10) },
  ]));
  assert.equal(value.targets.length, 1);
  for (const target of value.targets) {
    assert.deepEqual(Object.keys(target).sort(), ['data', 'message', 'nodeId']);
    assert.deepEqual(Object.keys(target.data), ['reason']);
  }
  assert.equal(validateCoreRuleTargetInventory(TAB_READING_RULE_ID, 'cantTell', value.targets), true);
  // O alvo pede conferência, não acusa falha: a mesma lista não vale como inventário de `failed`.
  assert.equal(validateCoreRuleTargetInventory(TAB_READING_RULE_ID, 'failed', value.targets), false);
  // Nada do que a pessoa digita entra no alvo.
  assert.ok(!JSON.stringify(value.targets).includes('segredo-do-formulario'));
});

test('o motivo fecha o par com o catálogo fechado de remediação', async () => {
  assert.deepEqual(registeredCoreRemediationReasons(TAB_READING_RULE_ID), [TAB_READING_REASON]);
  assert.equal(canonicalCoreRemediation(TAB_READING_RULE_ID, { reason: TAB_READING_REASON }), TAB_READING_MESSAGE);
  assert.equal(canonicalCoreRemediation(TAB_READING_RULE_ID, { reason: 'motivo-inexistente' }), null);
  assert.equal(coreRuleImpact(TAB_READING_RULE_ID), 'critical');
});

test('matriz de alvos por conclusão: cantTell aceita zero alvos, failed não', () => {
  for (const [outcome, targets, expected] of [
    ['cantTell', [], true],
    ['cantTell', [{ nodeId: 'n-1', data: { reason: TAB_READING_REASON }, message: TAB_READING_MESSAGE }], true],
    ['failed', [], false],
    ['passed', [], true],
    ['passed', [{ nodeId: 'n-1', data: { reason: TAB_READING_REASON }, message: TAB_READING_MESSAGE }], false],
  ]) {
    assert.equal(validateCoreRuleTargetInventory(TAB_READING_RULE_ID, outcome, targets), expected, outcome);
  }
});

test('sem parada de Tab observável a regra não inventa alvo', async () => {
  const value = await evaluate(snapshot([
    { nodeId: 'travado', tagName: 'button', attributes: { disabled: '' }, disabled: true, accessibleName: 'Travado', axRole: 'button', rect: rect(10) },
    { nodeId: 'escondido', tagName: 'button', attributes: { hidden: '' }, accessibleName: 'Escondido', axRole: 'button', rect: rect(50) },
    { nodeId: 'sem-caixa', tagName: 'button', hasRenderedBox: false, accessibleName: 'Sem caixa', axRole: 'button', rect: rect(90) },
  ]));
  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.targets, []);
  assert.match(value.summary, /Não há paradas de Tab/u);
  assert.equal(validateCoreRuleTargetInventory(TAB_READING_RULE_ID, 'cantTell', value.targets), true);
});

test('instantâneo sem sequência de Tab diz a limitação, sem alvo', async () => {
  const value = await evaluate({});
  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.targets, []);
  assert.match(value.summary, /não pôde ser calculada/u);
});

test('respeita o limite de paradas do mapa do teclado', async () => {
  const nodes = Array.from({ length: KEYBOARD_MAP_STOP_LIMIT + 20 }, (_, index) => ({
    nodeId: `n-${index + 1}`,
    accessibleName: `Botão ${index + 1}`,
    axRole: 'button',
    rect: rect(10 + index * 40),
  }));
  const value = await evaluate(snapshot(nodes));
  const stops = selectKeyboardMapStops(snapshot(nodes)).stops;
  assert.equal(value.outcome, 'cantTell');
  assert.ok(value.targets.length <= KEYBOARD_MAP_STOP_LIMIT);
  assert.equal(value.targets.length, stops.length);
  assert.ok(selectKeyboardMapStops(snapshot(nodes)).counts.omittedLimit > 0, 'A fixture precisa estourar o limite');
  assert.equal(validateCoreRuleTargetInventory(TAB_READING_RULE_ID, 'cantTell', value.targets), true);
});
