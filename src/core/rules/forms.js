import { createRuleRegistry } from './registry.js';
import {
  ancestorNodes,
  attribute,
  domIdIndex,
  hasAttribute,
  hasOwn,
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

function formResult(snapshot, evaluate) {
  const parts = snapshotParts(snapshot);
  if (!parts) return missingSnapshotResult();
  const value = evaluate(parts);
  return { ...value, targets: orderTargets(value.targets, parts.nodes) };
}

function fieldsOf(nodes) {
  return nodes.filter(isFormField);
}

function isNativeLabelable(node) {
  const tag = tagOf(node);
  return ['button', 'meter', 'output', 'progress', 'select', 'textarea'].includes(tag) ||
    (tag === 'input' && normalizeText(attribute(node, 'type')).toLowerCase() !== 'hidden');
}

// A geometria e o texto no DOM não provam percepção: o revisor demonstrou no Chrome que um
// label totalmente recortado por clip-path:inset(50%) mantém hasRenderedBox=true e visibleText
// preenchido. O que a medição pode afirmar com segurança é o inverso — quando o recorte está
// aplicado, o rótulo não está visível —, e é isso que este predicado detecta. Ele é deliberadamente
// conservador: só reconhece o recorte declarado nas folhas de estilo, nunca "parece escondido".
// A sintaxe inset aceita de um a quatro valores e os expande como as margens: um valor vale para
// os quatro lados, dois valem para vertical e horizontal, três para topo, horizontal e base. Uma
// tentativa anterior exigia 49% ou mais em todos os tokens e por isso deixava passar
// `inset(50% 0%)` (50% na vertical já colapsa a altura) e `inset(50% round 10px)` (o `round` no
// fim quebrava a expressão regular). Ambos foram encontrados por uma sondagem feita para refutar
// a detecção, e ambos são recortes totais.
function insetSides(argument) {
  const parts = normalizeText(argument).split(/\s+/u).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;
  const percents = parts.map(part => {
    const number = /^(-?\d+(?:\.\d+)?)%$/u.exec(part);
    return number ? Number(number[1]) : null;
  });
  if (percents.some(percent => percent === null)) return null;
  const [first, second = first, third = first, fourth = second] = percents;
  return { top: first, right: second, bottom: third, left: fourth };
}

/** Colapsa quando o recorte fecha um eixo inteiro. Não é uma prova de invisibilidade: um eixo
 *  fechado num elemento com a outra dimensão ainda positiva não o esconde por completo. */
function collapsedInsets(value) {
  const match = /^inset\(\s*([^)]*?)\s*(?:round\s[^)]*)?\)$/iu.exec(normalizeText(value));
  if (!match) return false;
  const sides = insetSides(match[1]);
  if (!sides) return false;
  return (sides.top >= 49 && sides.bottom >= 49) || (sides.left >= 49 && sides.right >= 49);
}

function clippedAway(node) {
  const styles = node?.styles;
  if (!styles || typeof styles !== 'object') return false;
  const clipPath = normalizeText(styles['clip-path']);
  if (/^inset\(/iu.test(clipPath)) return collapsedInsets(clipPath);
  return /^rect\(\s*(?:0(?:px)?[\s,]+){3}0(?:px)?\s*\)$/iu.test(normalizeText(styles.clip));
}

function labelsForField(field, nodes, ids, index) {
  const own = normalizeText(attribute(field, 'id'));
  return nodes.filter(node => labelAssociatedWithField(node, field, ids, index) ||
    (own !== '' && tagOf(node) === 'label' && normalizeText(attribute(node, 'for')) === own));
}

function formFieldLabel(snapshot) {
  return formResult(snapshot, ({ nodes }) => {
    const inputRoles = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton']);
    const fields = nodes.filter(node => {
      if (node.hasRenderedBox === false || (node.hasRenderedBox !== true && isHidden(node))) return false;
      const tag = tagOf(node);
      const native = ['select', 'textarea'].includes(tag) || (tag === 'input' &&
        !['button', 'hidden', 'image', 'reset', 'submit'].includes(normalizeText(attribute(node, 'type')).toLowerCase()));
      return native || inputRoles.has(normalizeText(node.axRole).toLowerCase() || roleOf(node));
    });
    if (fields.length === 0) return result('inapplicable', 'Não há campos de formulário aplicáveis.');
    // Um rótulo que existe e está recortado não identifica visualmente nada. Isso é observável,
    // então vira alvo por campo em vez de pendência agregada — mas continua em revisão, porque a
    // norma admite propósito visualmente evidente e o recorte não prova ausência de percepção.
    const index = nodeIndex(nodes);
    const ids = domIdIndex(nodes);
    const clippedFields = fields.filter(field =>
      labelsForField(field, nodes, ids, index).some(clippedAway));
    if (clippedFields.length === 0) {
      return result('cantTell', 'Há campos cuja identificação visual precisa ser confirmada. O nome acessível, sozinho, não demonstra atendimento nem falha do item 5.9.1.', [], [
        'Confirme um rótulo que identifique cada campo ou, como alternativa, um propósito visualmente evidente acompanhado de nome acessível. Caixa e texto no DOM não provam percepção visual: podem estar recortados ou ocultos. Esta pendência é agregada, não uma ocorrência de erro para cada campo.',
        'Associação programática, nome acessível e descrição do propósito são verificados separadamente. Não conclua ausência de rótulo visual apenas porque o nome acessível está vazio ou não foi coletado.'
      ]);
    }
    return result('cantTell',
      `Há ${clippedFields.length} campo(s) cujo rótulo associado está recortado e não pode ser visto. Isso não confirma falha do item 5.9.1: confirme se o campo tem propósito visualmente evidente ou outro rótulo visível antes de concluir.`,
      clippedFields.map(field => target(field,
        'O rótulo associado a este campo está recortado na página e não identifica o campo visualmente. Ofereça um rótulo visível ou torne o propósito do campo visualmente evidente.',
        { reason: 'clipped-label' })),
      ['A revisão é necessária porque a norma admite propósito visualmente evidente com nome acessível: recorte não prova ausência de percepção.',
        'O nome acessível e a associação programática são verificados separadamente neste mesmo relatório.']);
  });
}

function nestedLabel(field, index, ids) {
  const chain = ancestorNodes(field, index);
  return chain.complete && chain.ancestors.some(node => labelAssociatedWithField(node, field, ids, index));
}

const documentKey = node => JSON.stringify([node.frameId ?? 'main', node.framePath ?? []]);

function labelAssociatedWithField(label, field, ids, index) {
  if (tagOf(label) !== 'label' || documentKey(label) !== documentKey(field)) return false;
  if (hasAttribute(label, 'for')) {
    const matches = ids.get(normalizeText(attribute(label, 'for'))) ?? [];
    return matches.length === 1 && matches[0] === field;
  }
  const chain = ancestorNodes(field, index);
  if (!chain.complete || !chain.ancestors.includes(label)) return false;
  const first = [...index.values()].find(node => isNativeLabelable(node) &&
    documentKey(node) === documentKey(label) && ancestorNodes(node, index).ancestors.includes(label));
  return first === field;
}

function formLabelAssociation(snapshot) {
  return formResult(snapshot, ({ nodes }) => {
    const fields = fieldsOf(nodes);
    const labels = nodes.filter(node => !isHidden(node) && tagOf(node) === 'label');
    if (fields.length === 0 && labels.length === 0) {
      return result('inapplicable', 'Não há campos ou rótulos de formulário aplicáveis.');
    }
    const nodesByDocument = new Map();
    for (const node of nodes) {
      const key = documentKey(node);
      if (!nodesByDocument.has(key)) nodesByDocument.set(key, []);
      nodesByDocument.get(key).push(node);
    }
    const idsByDocument = new Map([...nodesByDocument].map(([key, values]) => [key, domIdIndex(values)]));
    const index = nodeIndex(nodes);
    const labelsByTarget = new Map();
    const failures = [];

    for (const label of labels) {
      if (!hasAttribute(label, 'for')) continue;
      const ids = idsByDocument.get(documentKey(label));
      const forId = normalizeText(attribute(label, 'for'));
      const matches = ids.get(forId) ?? [];
      if (matches.length === 0) {
        failures.push(target(label, 'Corrija a referência for deste rótulo.', {
          reason: 'missing-idref', attribute: 'for'
        }));
      } else if (!matches.every(isNativeLabelable)) {
        failures.push(target(label, 'Associe este rótulo a um campo rotulável.', {
          reason: 'invalid-label-target', attribute: 'for'
        }));
      } else {
        const key = `${documentKey(label)}:${forId}`;
        const bucket = labelsByTarget.get(key) ?? [];
        bucket.push(label);
        labelsByTarget.set(key, bucket);
      }
    }

    for (const field of fields) {
      const ids = idsByDocument.get(documentKey(field));
      const ariaLabels = normalizeText(attribute(field, 'aria-labelledby')).split(/\s+/u).filter(Boolean);
      const ariaAssociated = ariaLabels.length > 0 && ariaLabels.every(id =>
        (ids.get(id) ?? []).length === 1);
      const id = normalizeText(attribute(field, 'id'));
      const referencedLabels = id ? labelsByTarget.get(`${documentKey(field)}:${id}`) ?? [] : [];
      let explicitLabelsValid = false;
      let explicitFailure = null;
      if (hasOwn(field, 'labels')) {
        if (!Array.isArray(field.labels)) {
          explicitFailure = 'invalid-label-reference';
        } else if (field.labels.length > 0) {
          explicitLabelsValid = true;
          for (const labelId of field.labels) {
            if (typeof labelId !== 'string' && !Number.isSafeInteger(labelId)) {
              explicitFailure = 'invalid-label-reference';
              break;
            }
            const label = index.get(String(labelId));
            if (!label) {
              explicitFailure = 'missing-label-reference';
              break;
            }
            if (tagOf(label) !== 'label') {
              explicitFailure = 'invalid-label-reference';
              break;
            }
            if (!labelAssociatedWithField(label, field, ids, index)) {
              explicitFailure = 'label-associated-to-other-field';
              break;
            }
          }
        }
      }
      if (explicitFailure) {
        failures.push(target(field, 'Corrija a referência de rótulo normalizada deste campo.', {
          reason: explicitFailure, attribute: 'labels'
        }));
        continue;
      }
      if (id && (ids.get(id)?.length ?? 0) > 1 && referencedLabels.length > 0) {
        failures.push(target(field, 'Use um ID único para associar o rótulo a este campo.', {
          reason: 'ambiguous-idref', attribute: 'for'
        }));
      } else if (referencedLabels.length > 0 || explicitLabelsValid || ariaAssociated || nestedLabel(field, index, ids) ||
          normalizeText(attribute(field, 'aria-label'))) {
        continue;
      } else {
        failures.push(target(field, 'Associe programaticamente um rótulo a este campo.', {
          reason: 'missing-association'
        }));
      }
    }
    return failures.length > 0
      ? result('failed', 'Há rótulos com associação ausente, inválida ou ambígua.', failures)
      : result('passed', 'Todos os campos observados possuem rótulo associado.');
  });
}

function relatedFieldsGrouping(snapshot) {
  return formResult(snapshot, ({ nodes }) => {
    const index = nodeIndex(nodes);
    let incomplete = false;
    const groupedTypes = fieldsOf(nodes).filter(node => {
      const type = normalizeText(attribute(node, 'type')).toLowerCase();
      return ['checkbox', 'radio'].includes(type) && normalizeText(attribute(node, 'name'));
    });
    const groups = new Map();
    for (const field of groupedTypes) {
      const chain = ancestorNodes(field, index);
      if (!chain.complete || chain.ancestors.some(node => node.shadowHost === true)) {
        incomplete = true;
        continue;
      }
      let owner = chain.ancestors.find(node => tagOf(node) === 'form')?.nodeId ?? null;
      if (hasAttribute(field, 'form')) {
        const reference = attribute(field, 'form');
        const matches = reference === '' ? [] : nodes.filter(node => documentKey(node) === documentKey(field) &&
          attribute(node, 'id') === reference);
        if (matches.length > 1) { incomplete = true; continue; }
        owner = matches.length === 1 && tagOf(matches[0]) === 'form' ? matches[0].nodeId : null;
      }
      const key = JSON.stringify([documentKey(field), owner,
        normalizeText(attribute(field, 'type')).toLowerCase(), normalizeText(attribute(field, 'name'))]);
      const group = groups.get(key) ?? [];
      group.push(field);
      groups.set(key, group);
    }
    const applicable = [...groups.values()].filter(group => group.length > 1);
    if (applicable.length === 0) return incomplete
      ? result('cantTell', 'A observação não permite determinar o formulário proprietário de todos os campos.')
      : result('inapplicable', 'Não há conjuntos de campos relacionados aplicáveis.');
    const failures = [];
    for (const group of applicable) {
      for (const field of group) {
        const chain = ancestorNodes(field, index);
        if (!chain.complete) {
          incomplete = true;
          continue;
        }
        const container = chain.ancestors.find(node =>
          tagOf(node) === 'fieldset' || ['group', 'radiogroup'].includes(roleOf(node))
        );
        if (!container || !normalizeText(container.accessibleName)) {
          failures.push(target(field, 'Agrupe e nomeie programaticamente estes campos relacionados.', {
            reason: 'missing-related-fields-group'
          }));
        }
      }
    }
    if (failures.length > 0) return result('failed', 'Há campos relacionados sem grupo identificado.', failures);
    if (incomplete) return result('cantTell', 'A ancestralidade de campos relacionados não foi coletada.', [], [
      'Colete a árvore ancestral completa dos campos.'
    ]);
    return result('passed', 'Os campos relacionados estão em grupos identificados.');
  });
}

function requiredDeclaration(node) {
  if (hasAttribute(node, 'required')) return { required: true, valid: true };
  if (!hasAttribute(node, 'aria-required')) return { required: false, valid: true };
  const value = normalizeText(attribute(node, 'aria-required')).toLowerCase();
  if (!['false', 'true'].includes(value)) return { required: true, valid: false };
  return { required: value === 'true', valid: true };
}

function requiredFieldIdentification(snapshot) {
  return formResult(snapshot, ({ nodes }) => {
    const declared = fieldsOf(nodes).filter(node => {
      const declaration = requiredDeclaration(node);
      return !declaration.valid || declaration.required || node?.required === true;
    });
    if (declared.length === 0) return result('inapplicable', 'Não há campos obrigatórios observáveis.');
    const failures = [];
    let incomplete = false;
    for (const field of declared) {
      const declaration = requiredDeclaration(field);
      if (!declaration.valid) {
        failures.push(target(field, 'Use um valor válido para o estado obrigatório.', {
          reason: 'invalid-required-state'
        }));
      } else if (!hasOwn(field, 'required')) {
        incomplete = true;
      } else if (declaration.required !== field.required) {
        failures.push(target(field, 'Mantenha o estado obrigatório programático consistente.', {
          reason: 'required-state-mismatch'
        }));
      } else if (!hasOwn(field, 'requiredIndicator')) {
        incomplete = true;
      } else if (!normalizeText(field.requiredIndicator)) {
        failures.push(target(field, 'Identifique de modo perceptível que este campo é obrigatório.', {
          reason: 'missing-required-identification'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há campos com identificação ou estado obrigatório inválido.', failures);
    if (incomplete) return result('cantTell', 'Faltam dados do estado ou da identificação de campo obrigatório.', [], [
      'Colete o estado calculado e o indicador associado de cada campo obrigatório.'
    ]);
    return result('passed', 'Os campos obrigatórios possuem estado e identificação observáveis.');
  });
}

const AUTOCOMPLETE_PURPOSES = new Set([
  'additional-name', 'address-level1', 'address-level2', 'address-level3', 'address-level4',
  'address-line1', 'address-line2', 'address-line3', 'bday', 'bday-day', 'bday-month',
  'bday-year', 'cc-additional-name', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  'cc-family-name', 'cc-given-name', 'cc-name', 'cc-number', 'cc-type', 'country',
  'country-name', 'current-password', 'email', 'family-name', 'given-name', 'honorific-prefix',
  'honorific-suffix', 'impp', 'language', 'name', 'new-password', 'nickname', 'one-time-code',
  'organization', 'organization-title', 'photo', 'postal-code', 'sex', 'street-address',
  'tel', 'tel-area-code', 'tel-country-code', 'tel-extension', 'tel-local',
  'tel-local-prefix', 'tel-local-suffix', 'tel-national', 'transaction-amount',
  'transaction-currency', 'url', 'username'
]);

function validAutocomplete(value, purpose) {
  const tokens = normalizeText(value).toLowerCase().split(' ').filter(Boolean);
  if (tokens.length === 0) return false;
  let index = 0;
  if (tokens[index]?.startsWith('section-') && tokens[index].length > 8) index += 1;
  if (['billing', 'shipping'].includes(tokens[index])) index += 1;
  const hasContactType = ['fax', 'home', 'mobile', 'pager', 'work'].includes(tokens[index]);
  if (hasContactType) index += 1;
  const fieldToken = tokens[index];
  index += 1;
  if (tokens[index] === 'webauthn') index += 1;
  const contactPurpose = fieldToken === 'email' || fieldToken === 'impp' || fieldToken?.startsWith('tel');
  return tokens.length === index && AUTOCOMPLETE_PURPOSES.has(fieldToken) &&
    fieldToken === purpose && (!hasContactType || contactPurpose);
}

// The declared purpose is read only from the field's own autocomplete declaration. An
// undeclared purpose is unobserved (null) and keeps the requirement under review; a
// declared but malformed token resolves to an empty purpose the consumer can contradict.
const AUTOCOMPLETE_STRUCTURE = new Set(['billing', 'shipping', 'home', 'work', 'mobile', 'fax', 'pager', 'webauthn']);

function declaredPurpose(field) {
  const tokens = normalizeText(attribute(field, 'autocomplete')).toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  if (['on', 'off'].includes(tokens[0])) return '';
  const last = tokens[tokens.length - 1];
  if (last !== 'webauthn') return last;
  // "webauthn" is a credential qualifier that follows the purpose token, as in
  // "username webauthn". Only a declaration made of structural tokens alone states the
  // purpose as username.
  const purposeTokens = tokens.slice(1).filter(token => !AUTOCOMPLETE_STRUCTURE.has(token) &&
    !(token.startsWith('section-') && token.length > 8));
  return purposeTokens.length === 0 ? 'username' : purposeTokens[purposeTokens.length - 1];
}

function inputPurpose(snapshot) {
  return formResult(snapshot, ({ nodes }) => {
    const fields = fieldsOf(nodes);
    if (fields.length === 0) return result('inapplicable', 'Não há campos de entrada aplicáveis.');
    // The only observed source of a field purpose is the autocomplete declaration of the
    // field itself. Name, input type, surrounding text and page context are never used as
    // evidence of a personal-data purpose, so a field that declares nothing keeps the
    // requirement under review instead of becoming a failure.
    const declared = fields.map(field => ({ field, purpose: declaredPurpose(field) }))
      .filter(candidate => candidate.purpose !== null);
    if (declared.length === 0) {
      return result('cantTell', 'A determinação programática do tipo de dado não foi observada em nenhum campo.', [], [
        'A finalidade observável vem da declaração autocomplete do próprio campo; nome, tipo de entrada e texto ao redor não são usados como prova.'
      ]);
    }
    const failures = [];
    let incomplete = declared.length !== fields.length;
    for (const { field, purpose } of declared) {
      if (!purpose) incomplete = true;
      else if (!validAutocomplete(attribute(field, 'autocomplete'), purpose)) {
        failures.push(target(field, 'Use autocomplete válido e compatível com a finalidade deste campo.', {
          reason: 'invalid-or-missing-autocomplete'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há campos com finalidade sem autocomplete válido.', failures);
    if (incomplete) {
      return result('cantTell', 'A determinação programática do tipo de dado não foi observada em todos os campos.', [], [
        'Declare a finalidade com um autocomplete válido ou registre por que o campo não tem finalidade de dado pessoal a determinar.'
      ]);
    }
    return result('passed', 'Os campos aplicáveis possuem autocomplete compatível com sua finalidade.');
  });
}

function statusMessageSemantics(snapshot) {
  return formResult(snapshot, ({ document, nodes }) => {
    if (!hasOwn(document, 'statusMessageNodeIds') || !Array.isArray(document.statusMessageNodeIds)) {
      return result('cantTell', 'A observação de mensagens de status não foi coletada.', [], [
        'Observe as mensagens produzidas durante as interações auditadas.'
      ]);
    }
    if (document.statusMessageNodeIds.length === 0) {
      return result('inapplicable', 'Nenhuma mensagem de status foi observada.');
    }
    const index = nodeIndex(nodes);
    const failures = [];
    let incomplete = false;
    for (const id of document.statusMessageNodeIds) {
      const node = index.get(String(id));
      if (!node) {
        incomplete = true;
        continue;
      }
      const live = normalizeText(attribute(node, 'aria-live')).toLowerCase();
      const hasExplicitLive = ['assertive', 'polite'].includes(live);
      const hasImplicitLive = ['alert', 'log', 'status'].includes(roleOf(node));
      if (live === 'off' || (!hasExplicitLive && !hasImplicitLive)) {
        failures.push(target(node, 'Exponha esta mensagem com uma função de status adequada.', {
          reason: 'missing-status-role'
        }));
      }
    }
    if (failures.length > 0) return result('failed', 'Há mensagens observadas sem semântica de status.', failures);
    if (incomplete) return result('cantTell', 'Uma mensagem observada não está presente no snapshot.', [], [
      'Colete o nó correspondente a cada mensagem de status observada.'
    ]);
    return result('passed', 'As mensagens de status observadas possuem semântica adequada.');
  });
}

export const FORM_RULES = createRuleRegistry([
  { id: 'form-field-label', mode: 'automated', nbrItems: ['5.9.1'], wcag: ['3.3.2', '4.1.2'], evaluate: formFieldLabel },
  { id: 'form-label-association', mode: 'automated', nbrItems: ['5.9.3'], wcag: ['1.3.1'], evaluate: formLabelAssociation },
  { id: 'related-fields-grouping', mode: 'automated', nbrItems: ['5.9.6'], wcag: ['1.3.1'], evaluate: relatedFieldsGrouping },
  { id: 'required-field-identification', mode: 'automated', nbrItems: ['5.9.7'], wcag: ['3.3.2'], evaluate: requiredFieldIdentification },
  { id: 'input-purpose', mode: 'automated', nbrItems: ['5.9.8'], wcag: ['1.3.5'], evaluate: inputPurpose },
  { id: 'status-message-semantics', mode: 'automated', nbrItems: ['5.13.8'], wcag: ['4.1.3'], evaluate: statusMessageSemantics }
]);
