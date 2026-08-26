import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { FORM_RULES } from './forms.js';
import { INTERACTIVE_RULES } from './interactive.js';
import { MEDIA_RULES } from './media.js';
import { createRuleRegistry } from './registry.js';
import {
  ancestorNodes,
  attribute,
  documentTarget,
  isComponent,
  isFormField,
  isHidden,
  missingSnapshotResult,
  nodeIndex,
  normalizeText,
  orderTargets,
  result,
  roleOf,
  snapshotParts,
  tagOf,
  target
} from './snapshot.js';
import { STRUCTURE_RULES } from './structure.js';
import { VISUAL_RULES } from './visual.js';

function definition(item, evaluate) {
  return {
    id: item.ruleIds[0],
    mode: item.evaluation,
    nbrItems: [item.id],
    wcag: [...new Set(item.wcag.map(reference => reference.id))],
    evaluate
  };
}

function reviewResult(snapshot, evaluate) {
  const parts = snapshotParts(snapshot);
  if (!parts) return missingSnapshotResult();
  const value = evaluate(parts);
  return { ...value, targets: orderTargets(value.targets, parts.nodes) };
}

function tableTitleAssociation(snapshot) {
  return reviewResult(snapshot, ({ nodes }) => {
    const tables = nodes.filter(node => !isHidden(node) && tagOf(node) === 'table');
    if (tables.length === 0) return result('inapplicable', 'Não há tabelas observáveis.');
    const applicable = tables.filter(node => node?.hasTableTitle === true);
    if (applicable.length === 0) return result('inapplicable', 'Não há título de tabela identificado.');
    const failures = [];
    let incomplete = false;
    for (const table of applicable) {
      if (typeof table.tableTitleAssociated !== 'boolean') incomplete = true;
      else if (!table.tableTitleAssociated) failures.push(target(table, 'Associe programaticamente o título a esta tabela.', { reason: 'table-title-not-associated' }));
    }
    if (failures.length > 0) return result('failed', 'Há título de tabela sem associação programática.', failures);
    if (incomplete) return result('cantTell', 'A associação do título da tabela não foi coletada.', [], ['Colete a relação programática entre tabela e título.']);
    return result('passed', 'Todos os títulos de tabela identificados estão associados.');
  });
}

function formSubmitButton(snapshot) {
  return reviewResult(snapshot, ({ nodes }) => {
    const forms = nodes.filter(node => !isHidden(node) && tagOf(node) === 'form');
    if (forms.length === 0) return result('inapplicable', 'Não há formulários observáveis.');
    const failures = [];
    let incomplete = false;
    for (const form of forms) {
      if (typeof form.hasSubmitControl !== 'boolean') incomplete = true;
      else if (!form.hasSubmitControl) failures.push(target(form, 'Forneça um botão explícito para submeter este formulário.', { reason: 'missing-submit-button' }));
    }
    if (failures.length > 0) return result('failed', 'Há formulário sem botão de submissão explícito.', failures);
    if (incomplete) return result('cantTell', 'Os controles de submissão do formulário não foram coletados.', [], ['Colete a associação entre formulário e controles de submissão.']);
    return result('passed', 'Todos os formulários observados possuem botão de submissão.');
  });
}

function customComponentState(snapshot) {
  return reviewResult(snapshot, ({ nodes }) => {
    const candidates = nodes.filter(node => !isHidden(node) && isComponent(node) &&
      !['a', 'button', 'input', 'select', 'textarea'].includes(tagOf(node)));
    if (candidates.length === 0) return result('inapplicable', 'Não há componentes customizados aplicáveis.');
    const failures = [];
    let incomplete = false;
    for (const node of candidates) {
      if (!Array.isArray(node.requiredStates) || !node.exposedStates || typeof node.exposedStates !== 'object') {
        incomplete = true;
        continue;
      }
      const missing = node.requiredStates.filter(state => typeof state === 'string' && !Object.hasOwn(node.exposedStates, state));
      if (missing.length > 0) failures.push(target(node, 'Exponha os estados, propriedades e valores necessários deste componente.', {
        reason: 'missing-custom-component-state', states: missing
      }));
    }
    if (failures.length > 0) return result('failed', 'Há componente customizado sem estados necessários expostos.', failures);
    if (incomplete) return result('cantTell', 'Os estados necessários de um componente não foram coletados.', [], ['Colete estados requeridos e expostos de cada componente customizado.']);
    return result('passed', 'Os estados necessários dos componentes customizados estão expostos.');
  });
}

const TARGET_GROUPS = Object.freeze({
  focus: new Set(['focus-order', 'focusable-elements-interactive', 'keyboard-focus-trap', 'full-keyboard-access', 'partial-keyboard-access', 'single-key-shortcuts', 'single-key-shortcut-control', 'concurrent-input-mechanisms']),
  hover: new Set(['hover-focus-additional-content', 'hover-focus-content-persistent', 'hover-focus-content-dismissible']),
  component: new Set(['custom-component-behavior', 'custom-component-instructions', 'consistent-component-identification-page', 'predictable-context-change', 'context-change-on-focus', 'context-change-on-input', 'single-pointer-cancellation', 'pointer-gesture-alternative', 'dragging-movement-alternative', 'motion-actuation-alternative', 'control-feedback']),
  heading: new Set(['heading-purpose']),
  landmark: new Set(['landmark-purpose', 'content-in-landmarks']),
  list: new Set(['list-purpose']),
  table: new Set(['table-purpose', 'table-title', 'complex-table-description']),
  link: new Set(['new-window-link-warning', 'file-link-identification', 'external-link-identification', 'complementary-link-text', 'adjacent-links', 'bypass-block-links']),
  field: new Set(['predictable-field-label', 'descriptive-field-label', 'predictable-help-text', 'descriptive-error-message', 'error-correction-suggestion', 'contextual-help', 'sensory-motion-validation'])
});

const LANDMARK_ROLES = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search']);
const PAGE_LEVEL_WHEN_EMPTY = new Set([
  'hover-focus-additional-content', 'hover-focus-content-persistent',
  'hover-focus-content-dismissible', 'single-key-shortcuts',
  'single-key-shortcut-control', 'full-keyboard-access',
  'partial-keyboard-access', 'concurrent-input-mechanisms'
]);

function scopedCandidates(ruleId, nodes) {
  if (ruleId === 'focusable-elements-interactive') return nodes.filter(isComponent);
  if (ruleId === 'content-in-landmarks') {
    const index = nodeIndex(nodes);
    return nodes.filter(node => {
      if (isHidden(node) || (!normalizeText(node?.text) && !isComponent(node))) return false;
      if (LANDMARK_ROLES.has(roleOf(node)) || ['main', 'nav', 'aside'].includes(tagOf(node))) return false;
      const chain = ancestorNodes(node, index);
      return !chain.complete || !chain.ancestors.some(ancestor =>
        LANDMARK_ROLES.has(roleOf(ancestor)) || ['main', 'nav', 'aside'].includes(tagOf(ancestor))
      );
    });
  }
  if (TARGET_GROUPS.focus.has(ruleId)) return nodes.filter(node => !isHidden(node) && node?.focusable === true);
  if (TARGET_GROUPS.hover.has(ruleId)) return nodes.filter(node => !isHidden(node) && (node?.hoverContent === true || node?.focusContent === true));
  if (TARGET_GROUPS.component.has(ruleId)) return nodes.filter(isComponent);
  if (TARGET_GROUPS.heading.has(ruleId)) return nodes.filter(node => !isHidden(node) && (/^h[1-6]$/u.test(tagOf(node)) || roleOf(node) === 'heading'));
  if (TARGET_GROUPS.landmark.has(ruleId)) return nodes.filter(node => !isHidden(node) && (LANDMARK_ROLES.has(roleOf(node)) || ['main', 'nav', 'aside'].includes(tagOf(node))));
  if (TARGET_GROUPS.list.has(ruleId)) return nodes.filter(node => !isHidden(node) && ['ol', 'ul'].includes(tagOf(node)));
  if (TARGET_GROUPS.table.has(ruleId)) return nodes.filter(node => !isHidden(node) && tagOf(node) === 'table');
  if (TARGET_GROUPS.link.has(ruleId)) return nodes.filter(node => !isHidden(node) && ((tagOf(node) === 'a' && normalizeText(attribute(node, 'href'))) || roleOf(node) === 'link'));
  if (TARGET_GROUPS.field.has(ruleId)) return nodes.filter(isFormField);
  return null;
}

function assistedReview(snapshot, item) {
  return reviewResult(snapshot, ({ document, nodes }) => {
    const candidates = scopedCandidates(item.ruleIds[0], nodes);
    if (Array.isArray(candidates) && candidates.length === 0) {
      if (!PAGE_LEVEL_WHEN_EMPTY.has(item.ruleIds[0])) {
        return result('inapplicable', `Não há alvos observáveis para revisar: ${item.title}.`);
      }
      return result('cantTell', `A coleta de alvos para “${item.title}” é insuficiente para concluir a aplicabilidade.`, [
        documentTarget(document, `Revise a página e suas interações quanto a: ${item.title}.`, {
          reason: 'page-level-insufficient-observation', itemId: item.id
        })
      ], [item.humanReason]);
    }
    const targets = Array.isArray(candidates)
      ? candidates.map(node => target(node, `Revise manualmente: ${item.title}.`, { reason: 'human-judgment-required', itemId: item.id }))
      : [documentTarget(document, `Revise a página e o processo quanto a: ${item.title}.`, { reason: 'page-level-human-judgment', itemId: item.id })];
    return result('cantTell', `A verificação de “${item.title}” exige revisão humana.`, targets, [item.humanReason]);
  });
}

const IMPLEMENTED_IDS = new Set([
  ...STRUCTURE_RULES, ...INTERACTIVE_RULES, ...FORM_RULES, ...VISUAL_RULES, ...MEDIA_RULES
].map(rule => rule.id));

const REMAINING_ITEMS = NBR17225_ITEMS.filter(item => item.ruleIds.length === 1 && !IMPLEMENTED_IDS.has(item.ruleIds[0]));
const AUTOMATED_EVALUATORS = Object.freeze({
  'table-title-association': tableTitleAssociation,
  'form-submit-button': formSubmitButton,
  'custom-component-state': customComponentState
});

export const MANUAL_REVIEW_RULES = createRuleRegistry(REMAINING_ITEMS.map(item =>
  definition(item, AUTOMATED_EVALUATORS[item.ruleIds[0]] ?? (snapshot => assistedReview(snapshot, item)))
));

function manualEvidenceRequest(item) {
  if (item.humanReason.includes('comparar páginas')) return 'Forneça páginas ou etapas equivalentes, escopo de comparação e evidências de navegação.';
  if (item.humanReason.includes('processo completo')) return 'Execute o processo completo e registre estados, decisões, erros, tempo e recuperação.';
  return 'Forneça a interação ou o contexto necessário e registre a conclusão da pessoa avaliadora.';
}

export const MANUAL_ITEMS = Object.freeze(NBR17225_ITEMS.filter(item => item.evaluation === 'manual').map(item => Object.freeze({
  itemId: item.id,
  reason: item.humanReason,
  evidenceRequest: manualEvidenceRequest(item)
})));
