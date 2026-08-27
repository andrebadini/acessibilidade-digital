import { NBR17225_ITEMS } from './nbr17225.js';

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function mapping(axeRuleId, nbrItemRef, wcagRefs, rationale, equivalence = null) {
  return deepFreeze({
    axeRuleId, nbrItemRef, wcagRefs: [...wcagRefs], rationale,
    applicability: 'confirmation-required',
    ...(equivalence ? { ...equivalence } : {}),
  });
}

/**
 * Reviewed rule-ID mappings. Tags are deliberately absent: axe tags describe
 * families and editions, but are not a sufficient ABNT applicability proof.
 */
export const AXE_NBR_CROSSWALK = deepFreeze([
  mapping('area-alt', '5.2.6', ['1.1.1'], 'Área de mapa de imagem sem alternativa textual programaticamente determinável.'),
  mapping('aria-allowed-attr', '5.13.13', ['4.1.2'], 'Estado ou propriedade ARIA incompatível com a função exposta pelo componente.'),
  mapping('aria-command-name', '5.13.10', ['4.1.2'], 'Componente de comando ARIA sem nome acessível programaticamente determinável.'),
  mapping('aria-input-field-name', '5.13.10', ['4.1.2'], 'Campo ARIA sem nome acessível programaticamente determinável.'),
  mapping('aria-meter-name', '5.13.10', ['4.1.2'], 'Medidor ARIA sem nome acessível programaticamente determinável.'),
  mapping('aria-progressbar-name', '5.13.10', ['4.1.2'], 'Barra de progresso ARIA sem nome acessível programaticamente determinável.'),
  mapping('aria-required-attr', '5.13.13', ['4.1.2'], 'Componente ARIA sem estado ou propriedade obrigatória para sua função.'),
  mapping('aria-roles', '5.13.12', ['4.1.2'], 'Função ARIA inválida ou abstrata impede semântica programática confiável.'),
  mapping('aria-toggle-field-name', '5.13.10', ['4.1.2'], 'Controle de alternância ARIA sem nome acessível programaticamente determinável.'),
  mapping('aria-tooltip-name', '5.13.10', ['4.1.2'], 'Tooltip ARIA sem nome acessível programaticamente determinável.'),
  mapping('aria-valid-attr-value', '5.13.13', ['4.1.2'], 'Valor inválido de estado ou propriedade ARIA compromete a informação programática.'),
  mapping('aria-valid-attr', '5.13.13', ['4.1.2'], 'Atributo ARIA inválido compromete estados e propriedades programáticas.'),
  mapping('button-name', '5.13.10', ['4.1.2'], 'Botão sem nome acessível programaticamente determinável.'),
  mapping('color-contrast', '5.11.3', ['1.4.3'], 'Texto observado abaixo do contraste mínimo automatizável.'),
  mapping('definition-list', '5.5.1', ['1.3.1'], 'Estrutura de lista de definições não preserva relações programáticas.'),
  mapping('dlitem', '5.5.1', ['1.3.1'], 'Item de definição fora de uma lista semanticamente associada.'),
  mapping('document-title', '5.13.1', ['2.4.2'], 'Documento sem título programático disponível para identificação.', {
    auditaRuleId: 'page-title', equivalenceKey: 'document-title', targetScope: 'document',
  }),
  mapping('frame-title', '5.13.4', ['4.1.2'], 'Frame sem nome acessível programaticamente determinável.'),
  mapping('html-has-lang', '5.13.2', ['3.1.1'], 'Documento sem idioma principal programaticamente determinado.', {
    auditaRuleId: 'page-language', equivalenceKey: 'document-language-declaration', targetScope: 'document',
  }),
  mapping('html-lang-valid', '5.13.2', ['3.1.1'], 'Idioma principal declarado com valor inválido.'),
  mapping('image-alt', '5.2.1', ['1.1.1'], 'Imagem de conteúdo sem alternativa textual programaticamente determinável.'),
  mapping('input-button-name', '5.13.10', ['4.1.2'], 'Botão de formulário sem nome acessível programaticamente determinável.'),
  mapping('input-image-alt', '5.2.2', ['1.1.1'], 'Imagem funcional de entrada sem alternativa textual programaticamente determinável.'),
  mapping('label', '5.9.3', ['1.3.1'], 'Campo de formulário sem rótulo programaticamente associado.'),
  mapping('label-content-name-mismatch', '5.13.7', ['2.5.3'], 'O nome acessível não contém o rótulo visível do controle.'),
  mapping('link-name', '5.13.10', ['4.1.2'], 'Link sem nome acessível programaticamente determinável.'),
  mapping('list', '5.5.1', ['1.3.1'], 'Estrutura visual de lista não preserva semântica de lista.'),
  mapping('listitem', '5.5.1', ['1.3.1'], 'Item de lista fora de uma lista semanticamente associada.'),
  mapping('meta-viewport', '5.13.5', ['1.4.4'], 'Configuração do viewport restringe redimensionamento ou zoom.'),
  mapping('object-alt', '5.2.1', ['1.1.1'], 'Objeto incorporado sem alternativa textual programaticamente determinável.'),
  mapping('role-img-alt', '5.2.1', ['1.1.1'], 'Elemento com função de imagem sem alternativa textual programaticamente determinável.'),
  mapping('select-name', '5.13.10', ['4.1.2'], 'Caixa de seleção sem nome acessível programaticamente determinável.'),
  mapping('svg-img-alt', '5.2.1', ['1.1.1'], 'SVG com função de imagem sem alternativa textual programaticamente determinável.'),
  mapping('td-headers-attr', '5.6.3', ['1.3.1'], 'Célula de dados referencia cabeçalhos de tabela de forma inválida.'),
  mapping('th-has-data-cells', '5.6.3', ['1.3.1'], 'Cabeçalho de tabela não está associado a células de dados.'),
]);

const BY_RULE_ID = new Map(AXE_NBR_CROSSWALK.map(entry => [entry.axeRuleId, entry]));
const BY_AUDITA_RULE_ID = new Map(AXE_NBR_CROSSWALK
  .filter(entry => entry.auditaRuleId)
  .map(entry => [entry.auditaRuleId, deepFreeze({
    axeRuleId: entry.axeRuleId,
    auditaRuleId: entry.auditaRuleId,
    equivalenceKey: entry.equivalenceKey,
    targetScope: entry.targetScope,
  })]));

export function axeNbrMappingForRule(axeRuleId) {
  return typeof axeRuleId === 'string' ? BY_RULE_ID.get(axeRuleId) ?? null : null;
}

export function axeEquivalenceForAuditaRule(auditaRuleId) {
  return typeof auditaRuleId === 'string' ? BY_AUDITA_RULE_ID.get(auditaRuleId) ?? null : null;
}

export function validateAxeNbrCrosswalk(entries = AXE_NBR_CROSSWALK) {
  if (!Array.isArray(entries)) return ['O crosswalk axe→ABNT deve ser uma lista.'];
  const errors = [];
  const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const label = `Mapeamento ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label} inválido.`);
      continue;
    }
    if (Object.hasOwn(entry, 'tags')) errors.push(`${label} não pode inferir vínculo por tag.`);
    if (typeof entry.axeRuleId !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(entry.axeRuleId)) {
      errors.push(`${label} possui axeRuleId inválido.`);
    } else if (seen.has(entry.axeRuleId)) {
      errors.push(`axeRuleId duplicado: ${entry.axeRuleId}.`);
    } else seen.add(entry.axeRuleId);
    const item = itemById.get(entry.nbrItemRef);
    if (!item) errors.push(`${label} referencia item ABNT desconhecido.`);
    if (!Array.isArray(entry.wcagRefs) || entry.wcagRefs.length === 0 ||
      entry.wcagRefs.some(id => typeof id !== 'string' || !item?.wcag.some(reference => reference.id === id))) {
      errors.push(`${label} possui referência WCAG incompatível.`);
    }
    if (typeof entry.rationale !== 'string' || !entry.rationale.trim()) errors.push(`${label} exige racional objetivo.`);
    if (entry.applicability !== 'confirmation-required') errors.push(`${label} deve exigir confirmação explícita de aplicabilidade.`);
    const equivalenceFields = ['auditaRuleId', 'equivalenceKey', 'targetScope'].filter(field => Object.hasOwn(entry, field));
    if (equivalenceFields.length > 0) {
      if (equivalenceFields.length !== 3 || !item?.ruleIds.includes(entry.auditaRuleId) ||
        typeof entry.equivalenceKey !== 'string' || !SAFE_EQUIVALENCE_KEY.test(entry.equivalenceKey) ||
        entry.targetScope !== 'document') {
        errors.push(`${label} possui equivalência entre motores inválida.`);
      }
    }
    if (/section508|experimental/iu.test(JSON.stringify(entry))) errors.push(`${label} usa marcador proibido.`);
  }
  return errors;
}

const SAFE_EQUIVALENCE_KEY = /^[a-z][a-z0-9-]{0,127}$/u;
