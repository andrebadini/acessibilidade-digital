/**
 * Política fechada de impacto das regras do motor próprio (source.engine 'audita-core').
 *
 * Critério explícito (a pessoa leiga precisa saber onde começar a corrigir):
 * - critical — impede totalmente uma tarefa para algum grupo: controle, link ou botão sem nome
 *   acessível; imagem de conteúdo sem alternativa; campo sem rótulo; armadilha de teclado;
 *   conteúdo que só aparece com o mouse e não tem caminho pelo teclado; risco de convulsão.
 * - serious — dificulta muito, mas há caminho alternativo ou a barreira atinge parte do conteúdo:
 *   contraste de texto, indicador de foco invisível, ordem de foco, idioma ausente, mídia sem
 *   alternativa equivalente, mudança inesperada de contexto.
 * - moderate — estrutura e semântica: títulos, listas, regiões, tabelas, agrupamento de campos,
 *   identificação de finalidade que não chega a bloquear a tarefa.
 * - minor — recomendações e avisos: identificações complementares, ajudas de leitura (nível AAA no
 *   WCAG) e boas práticas que orientam a melhoria sem barreira confirmada.
 *
 * Coerência com o axe (src/core/normative/axe-nbr-crosswalk.js): quando existe regra equivalente
 * mapeada, o impacto do axe orienta a escolha — nome de controle e alternativa de imagem ficam
 * 'critical'; idioma, título do documento, contraste, indicador de foco e tamanho mínimo de alvo
 * ficam 'serious'; contorno de blocos fica 'moderate'. Divergência documentada: o axe classifica
 * 'list'/'listitem'/'definition-list' como 'serious'; aqui a semântica de lista é 'moderate' por
 * ser estrutura (não bloqueia a tarefa), conforme o critério acima.
 *
 * O impacto não muda entre 'failed' e 'cantTell': a suspeita preserva a graduação da regra e a
 * interface diz "Impacto se confirmado". Auditorias antigas guardadas mantêm o impacto do registro
 * original — esta tabela só vale para ocorrências novas do motor próprio.
 */
export const CORE_IMPACT_POLICY_VERSION = 'CoreRuleImpactPolicyV1';

export const CORE_IMPACT_LEVELS = Object.freeze(['critical', 'serious', 'moderate', 'minor']);

/** Impacto usado se uma regra do motor próprio não constar da tabela (cobertura é verificada em teste). */
export const DEFAULT_CORE_IMPACT = 'minor';

const TABLE = Object.freeze({
  // Nome acessível e rótulo: sem eles o controle não é identificado nem operado.
  'accessible-component-name': 'critical',
  // Leitura por Tab: um anúncio que não corresponde ao elemento bloqueia a tarefa de quem usa
  // leitor de tela tanto quanto um controle sem nome — o item normativo é o mesmo (5.13.10).
  'tab-reading-announcement': 'critical',
  'form-field-label': 'critical',
  'form-label-association': 'critical',

  // Imagem: conteúdo sem alternativa, alternativa funcional ausente e mapa de imagem.
  'content-image-alternative': 'critical',
  'functional-image-alternative': 'critical',
  'image-map-alternative': 'critical',
  'complex-image-description': 'critical',
  'images-of-text': 'serious',
  // Imagem decorativa que ainda expõe texto: gera ruído, não bloqueia a tarefa.
  'decorative-image-alternative': 'moderate',

  // Teclado e interação sem ponteiro.
  'keyboard-focus-trap': 'critical',
  'hover-only-interactive-content': 'critical',
  'partial-keyboard-access': 'critical',
  'full-keyboard-access': 'critical',
  'focus-order': 'serious',
  'custom-component-behavior': 'serious',
  'focusable-elements-interactive': 'moderate',
  'single-key-shortcuts': 'serious',
  'single-key-shortcut-control': 'serious',
  'hover-focus-content-persistent': 'serious',
  'hover-focus-content-dismissible': 'serious',
  'hover-focus-additional-content': 'moderate',
  'custom-component-instructions': 'moderate',
  'concurrent-input-mechanisms': 'minor',

  // Ponteiro alternativo: barreira para quem não usa ponteiro preciso.
  'single-pointer-cancellation': 'serious',
  'pointer-gesture-alternative': 'serious',
  'dragging-movement-alternative': 'serious',
  'motion-actuation-alternative': 'serious',

  // Indicador de foco.
  'focus-visible': 'serious',
  'focus-fully-visible': 'serious',
  'focus-partially-visible': 'serious',
  'focus-indicator-contrast': 'serious',
  'focus-indicator-area': 'moderate',

  // Contraste e uso de cor.
  'text-contrast-minimum': 'serious',
  'component-contrast': 'serious',
  'graphic-object-contrast': 'serious',
  'use-of-color': 'serious',
  'text-contrast-enhanced': 'moderate',

  // Ampliação, reflow e ajuste do texto.
  'zoom-not-blocked': 'serious',
  'responsive-reflow': 'serious',
  'display-orientation': 'serious',
  'text-resizing': 'serious',
  'text-block-width': 'moderate',
  'line-spacing': 'moderate',
  'paragraph-spacing': 'moderate',
  'letter-spacing': 'moderate',
  'word-spacing': 'moderate',
  'text-block-alignment': 'minor',

  // Estrutura e semântica da página.
  'heading-semantics': 'moderate',
  'heading-purpose': 'moderate',
  'heading-order': 'moderate',
  'main-heading': 'moderate',
  'section-headings': 'moderate',
  'landmark-semantics': 'moderate',
  'landmark-purpose': 'moderate',
  'unique-landmarks': 'moderate',
  'landmark-unique-names': 'moderate',
  'content-in-landmarks': 'moderate',
  'list-semantics': 'moderate',
  'list-purpose': 'moderate',
  'table-semantics': 'moderate',
  'table-purpose': 'moderate',
  'table-title': 'moderate',
  'table-title-association': 'moderate',
  'complex-table-description': 'moderate',
  'table-headers': 'serious',
  'special-text-semantics': 'moderate',
  'special-text-purpose': 'moderate',
  'meaningful-sequence': 'serious',
  'reading-order': 'serious',
  'programmatic-purpose': 'minor',

  // Identificação da página e do frame.
  'page-title': 'serious',
  'page-language': 'serious',
  'part-language': 'serious',
  'frame-title': 'serious',

  // Semântica de componentes: o controle perde função ou estado, mas segue acionável.
  'custom-component-semantics': 'serious',
  'custom-component-state': 'serious',
  'visible-label-in-name': 'serious',
  'link-semantics': 'moderate',
  'button-semantics': 'moderate',
  'native-elements': 'moderate',
  'button-purpose': 'serious',
  'button-purpose-as-button': 'moderate',

  // Links: finalidade e identificação.
  'link-purpose-as-link': 'moderate',
  'link-purpose-without-context': 'serious',
  'link-purpose-in-context': 'moderate',
  'bypass-block-links': 'moderate',
  'new-window-link-warning': 'minor',
  'file-link-identification': 'minor',
  'external-link-identification': 'minor',
  'complementary-link-text': 'minor',
  'adjacent-links': 'minor',
  'consistent-component-identification-page': 'minor',

  // Previsibilidade e contexto.
  'predictable-context-change': 'serious',
  'context-change-on-focus': 'serious',
  'context-change-on-input': 'serious',

  // Formulários.
  'required-field-identification': 'serious',
  'status-message-semantics': 'serious',
  'descriptive-error-message': 'serious',
  'error-correction-suggestion': 'serious',
  'predictable-field-label': 'moderate',
  'descriptive-field-label': 'moderate',
  'related-fields-grouping': 'moderate',
  'input-purpose': 'moderate',
  'predictable-help-text': 'moderate',
  'form-submit-button': 'moderate',
  'control-feedback': 'moderate',
  'sensory-motion-validation': 'moderate',
  'sensory-characteristics': 'moderate',
  'contextual-help': 'minor',

  // Mídia: a barreira atinge o conteúdo de mídia e costuma ter alternativa em outro formato.
  'audio-text-alternative': 'critical',
  'video-captions': 'critical',
  'video-audio-description': 'serious',
  'video-transcript': 'serious',
  'live-captions': 'serious',
  'audio-control': 'serious',
  'extended-audio-description': 'minor',
  'sign-language-interpretation': 'minor',
  'low-background-audio': 'minor',
  'live-audio-transcript': 'minor',

  // Movimento, tempo e atualização.
  'flashing-content-limit': 'critical',
  'flashing-content-enhanced': 'serious',
  'animation-control': 'serious',
  'updating-content-control': 'serious',
  'adjustable-time-limit': 'serious',
  'interaction-animation': 'minor',

  // Linguagem e leitura.
  'unusual-word-definitions': 'minor',
  'abbreviation-expansion': 'minor',
  'reading-level': 'minor',
  'pronunciation-identification': 'minor',

  // Área de acionamento.
  'target-size-minimum': 'serious',
  'target-size-enhanced': 'moderate',
});

const BY_RULE_ID = new Map(Object.entries(TABLE).map(([ruleId, impact]) => [ruleId, Object.freeze({ ruleId, impact })]));

/** Impacto graduado de uma regra do motor próprio. Regra desconhecida cai em DEFAULT_CORE_IMPACT. */
export function coreRuleImpact(ruleId) {
  return BY_RULE_ID.get(ruleId)?.impact ?? DEFAULT_CORE_IMPACT;
}

/** Entrada imutável da tabela, ou null quando a regra não está na política. */
export function coreImpactEntry(ruleId) {
  return BY_RULE_ID.get(ruleId) ?? null;
}

/** Ids do inventário instalado que não têm entrada na tabela, em ordem estável. */
export function uncoveredCoreRuleIds(ruleIds) {
  if (!Array.isArray(ruleIds)) throw new TypeError('Os ids de regra devem ser uma lista.');
  return ruleIds
    .filter(ruleId => typeof ruleId === 'string' && !BY_RULE_ID.has(ruleId))
    .sort((left, right) => left.localeCompare(right));
}

/** Mesma verificação, com lista de mensagens pronta para teste ou diagnóstico. */
export function validateCoreImpactPolicy(ruleIds) {
  return uncoveredCoreRuleIds(ruleIds).map(ruleId => `Regra sem impacto na política: ${ruleId}`);
}

export { TABLE as CORE_RULE_IMPACTS };
