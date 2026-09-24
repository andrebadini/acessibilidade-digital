/**
 * Textos explicativos dos motivos (códigos) registrados pela inspeção de leitura por Tab.
 * O relatório guarda o texto; a camada de linguagem simples usa `hasReason` para reconhecer tanto o
 * código quanto o texto já explicado.
 */
export const READING_REASON_TEXT = Object.freeze({
  'estimated-order-not-literal-screen-reader': 'A ordem de Tab e os anúncios são estimados a partir do HTML e de ARIA. Não são uma transcrição de leitor de tela.',
  'top-document-open-shadow-only': 'Inspeção do documento principal e dos componentes com Shadow DOM aberto.',
  'closed-shadow-not-inspected': 'Componentes com Shadow DOM fechado não podem ser inspecionados.',
  'editable-values-omitted': 'Valores de campos, seleções de texto e conteúdo editável foram omitidos por privacidade.',
  'observed-state-may-change': 'Scripts, interações e alterações da página podem mudar a ordem e os anúncios. Atualize a inspeção depois de mudar o estado.',
  'open-shadow-order-estimated': 'A ordem dentro de componentes Shadow DOM é aproximada; confirme com Tab na página.',
  'slot-content-unavailable': 'Parte do conteúdo distribuído em componentes não pôde ser inspecionada.',
  'node-limit-reached': 'O limite de 5.000 nós foi atingido; parte da página não foi inspecionada.',
  'entry-limit-reached': 'O limite de 1.000 elementos foi atingido; o inventário está parcial.',
  'text-limit-reached': 'Parte do texto excedeu o limite da prévia e foi resumida. Confira o conteúdo completo na página.',
  'private-content-omitted': 'Conteúdo marcado como privado foi omitido. Isso não significa que ele esteja invisível para leitores de tela.',
  'credential-content-omitted': 'Texto relacionado a credenciais foi omitido por privacidade; confira o rótulo diretamente na página.',
  'frame-content-not-inspected': 'O conteúdo interno deste frame não foi inspecionado. Ele pode conter outras paradas de Tab.',
  'visual-capture-unavailable': 'A captura de tela não ficou disponível nesta inspeção.',
  'full-page-capture-unavailable': 'A captura da página inteira não ficou disponível.',
  'element-crop-failed': 'Não foi possível recortar a imagem de alguns elementos.',
  'not-rendered': 'Não está visível neste estado da página.',
  inert: 'Elemento inerte: não participa da interação nem da leitura acessível neste estado.',
  'aria-hidden': 'Oculto da árvore de acessibilidade por aria-hidden. Se recebe Tab, o foco pode ficar sem anúncio adequado.',
  'native-disabled': 'Controle desabilitado pelo HTML; normalmente não recebe Tab neste estado.',
  'aria-disabled-remains-focusable': 'Marcado indisponível por ARIA; essa marcação sozinha não impede receber Tab.',
  'negative-tabindex': 'tabindex negativo: pode receber foco por script, mas está fora da sequência normal de Tab.',
  'control-outside-tab': 'Controle fora da sequência de Tab. Confira se há uma forma adequada de operá-lo por teclado.',
  'structural-reading-not-tab': 'Conteúdo de leitura estrutural: normalmente lido por outros comandos, sem parada de Tab.',
  'accessible-name-unavailable': 'Nome acessível não identificado. Confira se o propósito do controle pode ser entendido.',
  'radio-group-arrow-navigation': 'Outro botão de opção representa este grupo no Tab. As opções normalmente são percorridas com as setas.',
  'implicit-editing-host': 'Área editável: recebe Tab mesmo sem um atributo tabindex explícito. O conteúdo digitado foi omitido.',
});

/** Verdadeiro quando a entrada traz o motivo, seja pelo código, seja pelo texto explicado. */
export function hasReason(entry, code) {
  const reasons = Array.isArray(entry?.reasons) ? entry.reasons : [];
  return reasons.includes(code) || (Object.hasOwn(READING_REASON_TEXT, code) && reasons.includes(READING_REASON_TEXT[code]));
}
