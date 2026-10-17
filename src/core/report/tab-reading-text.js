// Textos da leitura por Tab, sem nenhuma dependência.
//
// A seção própria da verificação guiada e a página de conferência por Tab dizem exatamente a mesma
// pergunta e o mesmo aviso. Como a página de conferência só carrega o que precisa (e não o motor de
// regras), os textos ficam neste módulo mínimo: uma frase escrita em dois lugares divergiria na
// primeira revisão de texto.

export const TAB_READING_SECTION_TITLE = 'Leitura por Tab — o que o leitor de tela fala';
export const TAB_READING_INTRO = 'O leitor de tela fala o nome e a função de cada item onde a tecla Tab para. Aqui você confere, um por um, se o que ele fala corresponde ao que o item é e faz.';
export const TAB_READING_QUESTION = 'O que o leitor de tela fala corresponde a este elemento (o que ele é e o que faz)?';
export const TAB_READING_READER_NOTICE = 'Para registrar as respostas no relatório, use a seção “Leitura por Tab” da verificação guiada.';
export const TAB_READING_HINT_LABEL = 'Pista da extensão';
export const TAB_READING_LISTEN_LABEL = 'Ouvir';
export const TAB_READING_NO_VOICE_MESSAGE = 'Este sistema não tem voz local em português. A leitura em voz alta ficaria sem áudio, e a extensão não envia texto para serviços de voz on-line.';
export const TAB_READING_ANSWERS = Object.freeze([
  Object.freeze({ answer: 'conforme', label: 'Sim', tone: 'sim' }),
  Object.freeze({ answer: 'não conforme', label: 'Não', tone: 'nao' }),
  Object.freeze({ answer: 'não foi possível determinar', label: 'Não sei', tone: 'nao-sei' }),
]);

/**
 * O que a pessoa lê depois de responder, com as palavras da própria pergunta.
 *
 * É a frase que a caixa colorida da verificação guiada mostra e a que a linha da seção no arquivo
 * entregue mostra: a resposta registrada é a mesma pergunta ("o que o leitor de tela fala corresponde a
 * este elemento?") e o rótulo técnico — "Não conforme (não atende ao item)" — é justamente o jargão que
 * ela não tem como interpretar. Como o módulo acima existe para as duas superfícies não divergirem, a
 * frase mora aqui, e não em cada uma.
 */
export const TAB_READING_ANSWER_TEXT = Object.freeze({
  conforme: 'Sua resposta: Sim — corresponde.',
  'não conforme': 'Sua resposta: Não — o que o leitor de tela fala não corresponde a este elemento.',
  'não foi possível determinar': 'Sua resposta: Não sei.',
});
