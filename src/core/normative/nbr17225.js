import { WCAG22_LEVELS } from './wcag22.js';

const REQUIREMENT = 'requirement';
const RECOMMENDATION = 'recommendation';
const AUTOMATED = 'automated';
const ASSISTED = 'assisted';
const MANUAL = 'manual';

const HUMAN_REASON = Object.freeze({
  context: 'A finalidade, o significado ou a previsibilidade do conteúdo exige julgamento humano.',
  interaction: 'A verificação exige interação e julgamento humano sobre o comportamento observado.',
  equivalence: 'A qualidade ou equivalência da alternativa exige comparação por uma pessoa avaliadora.',
  crossPage: 'A verificação exige comparar páginas ou etapas que não estão integralmente presentes no estado observado.',
  media: 'A equivalência e a qualidade da alternativa de mídia exigem julgamento humano.',
  process: 'A verificação depende do processo completo ou de contexto não determinável no estado observado.'
});

function defineReference(reference) {
  const [id, printedLevel = WCAG22_LEVELS[id]] = Array.isArray(reference)
    ? reference
    : [reference];

  return Object.freeze({ id, level: WCAG22_LEVELS[id], printedLevel });
}

function defineItem([
  id,
  title,
  classification,
  wcag,
  evaluation,
  ruleIds,
  humanReason = '',
  printedId = id
]) {
  return Object.freeze({
    id,
    printedId,
    title,
    classification,
    wcag: Object.freeze(wcag.map(defineReference)),
    evaluation,
    ruleIds: Object.freeze([...ruleIds]),
    humanReason
  });
}

const SOURCE_ITEMS = [
  ['5.1.1', 'Indicador de foco visível', REQUIREMENT, ['2.4.7'], AUTOMATED, ['focus-visible']],
  ['5.1.2', 'Elemento em foco totalmente visível', RECOMMENDATION, ['2.4.11', '2.4.12'], AUTOMATED, ['focus-fully-visible']],
  ['5.1.3', 'Elemento em foco parcialmente visível', REQUIREMENT, ['2.4.11'], AUTOMATED, ['focus-partially-visible']],
  ['5.1.4', 'Ordem de foco previsível', REQUIREMENT, ['2.4.3'], ASSISTED, ['focus-order'], HUMAN_REASON.interaction],
  ['5.1.5', 'Uso de foco', RECOMMENDATION, ['2.1.1', '2.1.3'], ASSISTED, ['focusable-elements-interactive'], HUMAN_REASON.interaction],
  ['5.1.6', 'Armadilha de foco', REQUIREMENT, ['2.1.2'], ASSISTED, ['keyboard-focus-trap'], HUMAN_REASON.interaction],
  ['5.1.7', 'Conteúdo adicional', RECOMMENDATION, ['1.4.13'], ASSISTED, ['hover-focus-additional-content'], HUMAN_REASON.interaction],
  ['5.1.8', 'Conteúdo adicional persistente', REQUIREMENT, ['1.4.13'], ASSISTED, ['hover-focus-content-persistent'], HUMAN_REASON.interaction],
  ['5.1.9', 'Conteúdo adicional dispensável', REQUIREMENT, ['1.4.13'], ASSISTED, ['hover-focus-content-dismissible'], HUMAN_REASON.interaction],
  ['5.1.10', 'Atalhos de teclado', RECOMMENDATION, ['2.1.4'], ASSISTED, ['single-key-shortcuts'], HUMAN_REASON.interaction],
  ['5.1.11', 'Atalhos de teclado sem tecla modificadora', REQUIREMENT, ['2.1.4'], ASSISTED, ['single-key-shortcut-control'], HUMAN_REASON.interaction],
  ['5.1.12', 'Acessibilidade por teclado total', RECOMMENDATION, ['2.1.1', '2.1.3'], ASSISTED, ['full-keyboard-access'], HUMAN_REASON.interaction],
  ['5.1.13', 'Acessibilidade por teclado parcial', REQUIREMENT, ['2.1.1'], ASSISTED, ['partial-keyboard-access', 'hover-only-interactive-content'], HUMAN_REASON.interaction],
  ['5.1.14', 'Mecanismos de entrada simultâneos', RECOMMENDATION, ['2.5.6'], ASSISTED, ['concurrent-input-mechanisms'], HUMAN_REASON.interaction],
  ['5.1.15', 'Comportamento de componentes customizados', RECOMMENDATION, ['2.1.1', '2.1.3'], ASSISTED, ['custom-component-behavior'], HUMAN_REASON.interaction],
  ['5.1.16', 'Instruções para componentes customizados', REQUIREMENT, ['3.3.2'], ASSISTED, ['custom-component-instructions'], HUMAN_REASON.context],

  ['5.2.1', 'Texto alternativo para imagens de conteúdo', REQUIREMENT, ['1.1.1'], ASSISTED, ['content-image-alternative'], HUMAN_REASON.equivalence],
  ['5.2.2', 'Texto alternativo para imagens funcionais', REQUIREMENT, ['1.1.1', '2.4.4', '2.4.9'], ASSISTED, ['functional-image-alternative'], HUMAN_REASON.equivalence],
  ['5.2.3', 'Texto alternativo para imagens decorativas', REQUIREMENT, ['1.1.1'], ASSISTED, ['decorative-image-alternative'], HUMAN_REASON.context],
  ['5.2.4', 'Descrição para imagens complexas', REQUIREMENT, ['1.1.1'], ASSISTED, ['complex-image-description'], HUMAN_REASON.equivalence],
  ['5.2.5', 'Imagens de texto', REQUIREMENT, ['1.1.1', '1.4.5', '1.4.9'], ASSISTED, ['images-of-text'], HUMAN_REASON.context],
  ['5.2.6', 'Texto alternativo para mapas de imagens', REQUIREMENT, ['1.1.1'], ASSISTED, ['image-map-alternative'], HUMAN_REASON.equivalence],

  ['5.3.1', 'Semântica de cabeçalho', REQUIREMENT, ['1.3.1'], AUTOMATED, ['heading-semantics']],
  ['5.3.2', 'Uso de cabeçalhos', REQUIREMENT, ['1.3.1', '2.4.6'], ASSISTED, ['heading-purpose'], HUMAN_REASON.context],
  ['5.3.3', 'Cabeçalho principal', RECOMMENDATION, ['2.4.6', '2.4.10'], ASSISTED, ['main-heading'], HUMAN_REASON.context],
  ['5.3.4', 'Seções com cabeçalhos', RECOMMENDATION, ['2.4.10'], ASSISTED, ['section-headings'], HUMAN_REASON.context],
  ['5.3.5', 'Estrutura de cabeçalhos', REQUIREMENT, ['1.3.1', '2.4.6', '2.4.10'], ASSISTED, ['heading-order'], HUMAN_REASON.context],

  ['5.4.1', 'Semântica de região', REQUIREMENT, ['1.3.1', '1.3.6'], AUTOMATED, ['landmark-semantics']],
  ['5.4.2', 'Uso de regiões', REQUIREMENT, ['1.3.1', '1.3.6'], ASSISTED, ['landmark-purpose'], HUMAN_REASON.context],
  ['5.4.3', 'Conteúdo em regiões', RECOMMENDATION, ['1.3.6'], ASSISTED, ['content-in-landmarks'], HUMAN_REASON.context],
  ['5.4.4', 'Regiões únicas', RECOMMENDATION, ['1.3.1', '1.3.6'], AUTOMATED, ['unique-landmarks']],
  ['5.4.5', 'Regiões identificadas unicamente', REQUIREMENT, ['1.3.1', '4.1.2'], AUTOMATED, ['landmark-unique-names']],

  ['5.5.1', 'Semântica de lista', REQUIREMENT, ['1.3.1'], AUTOMATED, ['list-semantics']],
  ['5.5.2', 'Uso de listas', REQUIREMENT, ['1.3.1'], ASSISTED, ['list-purpose'], HUMAN_REASON.context],

  ['5.6.1', 'Semântica de tabela', REQUIREMENT, ['1.3.1'], AUTOMATED, ['table-semantics']],
  ['5.6.2', 'Uso de Tabelas', REQUIREMENT, ['1.3.1'], ASSISTED, ['table-purpose'], HUMAN_REASON.context],
  ['5.6.3', 'Cabeçalhos de tabela', REQUIREMENT, ['1.3.1'], ASSISTED, ['table-headers'], HUMAN_REASON.context],
  ['5.6.4', 'Título de tabela', RECOMMENDATION, ['2.4.6', '2.4.10'], ASSISTED, ['table-title'], HUMAN_REASON.context],
  ['5.6.5', 'Título de tabela associado', REQUIREMENT, ['1.3.1'], AUTOMATED, ['table-title-association']],
  ['5.6.6', 'Descrição para tabelas complexas', RECOMMENDATION, ['3.1.5'], ASSISTED, ['complex-table-description'], HUMAN_REASON.context],

  ['5.7.1', 'Semântica de link', REQUIREMENT, ['1.3.1'], AUTOMATED, ['link-semantics']],
  ['5.7.2', 'Uso de links', REQUIREMENT, ['1.3.1'], ASSISTED, ['link-purpose-as-link'], HUMAN_REASON.context],
  ['5.7.3', 'Propósito do link sem contexto', RECOMMENDATION, ['2.4.4', '2.4.9'], ASSISTED, ['link-purpose-without-context'], HUMAN_REASON.context],
  ['5.7.4', 'Propósito do link no contexto', REQUIREMENT, ['2.4.4'], ASSISTED, ['link-purpose-in-context'], HUMAN_REASON.context],
  ['5.7.5', 'Links com identificação consistente', RECOMMENDATION, ['3.2.4', '2.4.9'], MANUAL, [], HUMAN_REASON.crossPage],
  ['5.7.6', 'Links que abrem em uma nova guia ou janela', RECOMMENDATION, ['2.4.4', '2.4.9', '3.2.5'], ASSISTED, ['new-window-link-warning'], HUMAN_REASON.context],
  ['5.7.7', 'Links para arquivos (não HTML)', RECOMMENDATION, ['2.4.4', '2.4.9'], ASSISTED, ['file-link-identification'], HUMAN_REASON.context],
  ['5.7.8', 'Links para sites externos', RECOMMENDATION, ['2.4.4', '2.4.9'], ASSISTED, ['external-link-identification'], HUMAN_REASON.context],
  ['5.7.9', 'Texto complementar do link', RECOMMENDATION, ['2.4.4'], ASSISTED, ['complementary-link-text'], HUMAN_REASON.context],
  ['5.7.10', 'Links adjacentes', RECOMMENDATION, ['2.4.4'], ASSISTED, ['adjacent-links'], HUMAN_REASON.context],
  ['5.7.11', 'Links para contornar blocos de conteúdo', RECOMMENDATION, ['2.4.1'], ASSISTED, ['bypass-block-links'], HUMAN_REASON.interaction],
  ['5.7.12', 'Links para contornar blocos de conteúdo em conjunto de páginas', REQUIREMENT, ['2.4.1'], MANUAL, [], HUMAN_REASON.crossPage],
  ['5.7.13', 'Alternativas para localização', REQUIREMENT, ['2.4.5'], MANUAL, [], HUMAN_REASON.crossPage],
  ['5.7.14', 'Localização em conjunto de páginas', RECOMMENDATION, ['2.4.8'], MANUAL, [], HUMAN_REASON.crossPage],
  ['5.7.15', 'Navegação consistente', REQUIREMENT, ['3.2.3'], MANUAL, [], HUMAN_REASON.crossPage],
  ['5.7.16', 'Ajuda consistente', REQUIREMENT, ['3.2.6'], MANUAL, [], HUMAN_REASON.crossPage],

  ['5.8.1', 'Semântica de botão', REQUIREMENT, ['1.3.1'], AUTOMATED, ['button-semantics']],
  ['5.8.2', 'Uso de botões', REQUIREMENT, ['1.3.1'], ASSISTED, ['button-purpose-as-button'], HUMAN_REASON.context],
  ['5.8.3', 'Propósito do botão', REQUIREMENT, ['4.1.2', '2.4.6'], ASSISTED, ['button-purpose'], HUMAN_REASON.context],
  ['5.8.4', 'Identificação consistente na página', RECOMMENDATION, ['3.2.4'], ASSISTED, ['consistent-component-identification-page'], HUMAN_REASON.context],
  ['5.8.5', 'Identificação consistente em conjunto de páginas', REQUIREMENT, ['3.2.4'], MANUAL, [], HUMAN_REASON.crossPage],
  ['5.8.6', 'Área de acionamento (aprimorada)', RECOMMENDATION, ['2.5.8', '2.5.5'], AUTOMATED, ['target-size-enhanced']],
  ['5.8.7', 'Área de acionamento (mínima)', REQUIREMENT, ['2.5.8'], AUTOMATED, ['target-size-minimum']],
  ['5.8.8', 'Mudança de contexto previsível', RECOMMENDATION, ['3.2.1', '3.2.2', '3.2.5'], ASSISTED, ['predictable-context-change'], HUMAN_REASON.interaction],
  ['5.8.9', 'Mudança de contexto previsível no foco', REQUIREMENT, ['3.2.1'], ASSISTED, ['context-change-on-focus'], HUMAN_REASON.interaction],
  ['5.8.10', 'Mudança de contexto previsível na entrada', REQUIREMENT, ['3.2.2'], ASSISTED, ['context-change-on-input'], HUMAN_REASON.interaction],
  ['5.8.11', 'Acionamento por ponteiro único', REQUIREMENT, ['2.5.2'], ASSISTED, ['single-pointer-cancellation'], HUMAN_REASON.interaction],
  ['5.8.12', 'Operação por gestos de ponteiro', REQUIREMENT, ['2.5.1'], ASSISTED, ['pointer-gesture-alternative'], HUMAN_REASON.interaction],
  ['5.8.13', 'Operação por movimento de arrastar', REQUIREMENT, ['2.5.7'], ASSISTED, ['dragging-movement-alternative'], HUMAN_REASON.interaction],
  ['5.8.14', 'Operação por movimento', REQUIREMENT, ['2.5.4'], ASSISTED, ['motion-actuation-alternative'], HUMAN_REASON.interaction],
  ['5.8.15', 'Controles com retorno', RECOMMENDATION, ['1.3.3', '4.1.3'], ASSISTED, ['control-feedback'], HUMAN_REASON.interaction],

  ['5.9.1', 'Rótulo de campo', REQUIREMENT, ['3.3.2', '4.1.2'], AUTOMATED, ['form-field-label']],
  ['5.9.2', 'Rótulo de campo previsível', REQUIREMENT, ['1.3.2', '3.3.2'], ASSISTED, ['predictable-field-label'], HUMAN_REASON.context],
  ['5.9.3', 'Rótulo de campo associado', REQUIREMENT, ['1.3.1'], AUTOMATED, ['form-label-association']],
  ['5.9.4', 'Rótulo de campo descritivo', REQUIREMENT, [['2.4.6', 'A']], ASSISTED, ['descriptive-field-label'], HUMAN_REASON.context],
  ['5.9.5', 'Textos de ajuda previsíveis', REQUIREMENT, ['3.3.2'], ASSISTED, ['predictable-help-text'], HUMAN_REASON.context],
  ['5.9.6', 'Campos relacionados', REQUIREMENT, ['1.3.1'], AUTOMATED, ['related-fields-grouping']],
  ['5.9.7', 'Campos obrigatórios', REQUIREMENT, ['3.3.2'], AUTOMATED, ['required-field-identification']],
  ['5.9.8', 'Tipo de dado determinado', REQUIREMENT, ['1.3.5'], AUTOMATED, ['input-purpose']],
  ['5.9.9', 'Mensagem de erro descritiva', REQUIREMENT, ['3.3.1'], ASSISTED, ['descriptive-error-message'], HUMAN_REASON.context],
  ['5.9.10', 'Sugestão de correção', REQUIREMENT, ['3.3.3'], ASSISTED, ['error-correction-suggestion'], HUMAN_REASON.context],
  ['5.9.11', 'Prevenção de erro', RECOMMENDATION, ['3.3.4', '3.3.6'], MANUAL, [], HUMAN_REASON.process],
  ['5.9.12', 'Prevenção de erro para formulários críticos', REQUIREMENT, ['3.3.4'], MANUAL, [], HUMAN_REASON.process],
  ['5.9.13', 'Ajuda contextual', RECOMMENDATION, ['3.3.5'], ASSISTED, ['contextual-help'], HUMAN_REASON.context],
  ['5.9.14', 'Botão de submissão', RECOMMENDATION, ['3.2.2'], AUTOMATED, ['form-submit-button']],
  ['5.9.15', 'Reentrada de dados', REQUIREMENT, ['3.3.7'], MANUAL, [], HUMAN_REASON.process],
  ['5.9.16', 'Validação sensorial ou por movimento', REQUIREMENT, ['1.1.1', '2.5.4', '2.5.6'], ASSISTED, ['sensory-motion-validation'], HUMAN_REASON.interaction],
  ['5.9.17', 'Autenticação acessível (aprimorado)', RECOMMENDATION, ['3.3.8', '3.3.9'], MANUAL, [], HUMAN_REASON.process],
  ['5.9.18', 'Autenticação acessível (mínima)', REQUIREMENT, ['3.3.8'], MANUAL, [], HUMAN_REASON.process],

  ['5.10.1', 'Características sensoriais', REQUIREMENT, ['1.3.3'], ASSISTED, ['sensory-characteristics'], HUMAN_REASON.context],
  ['5.10.2', 'Ordem de apresentação', REQUIREMENT, ['1.3.2'], ASSISTED, ['meaningful-sequence'], HUMAN_REASON.context],
  ['5.10.3', 'Orientação de exibição', REQUIREMENT, ['1.3.4'], AUTOMATED, ['display-orientation']],
  ['5.10.4', 'Design responsivo', REQUIREMENT, ['1.4.10'], AUTOMATED, ['responsive-reflow']],
  ['5.10.5', 'Área do indicador de foco visível', RECOMMENDATION, ['2.4.13'], AUTOMATED, ['focus-indicator-area']],

  ['5.11.1', 'Uso de cores', REQUIREMENT, ['1.4.1'], ASSISTED, ['use-of-color'], HUMAN_REASON.context],
  ['5.11.2', 'Contraste para texto (aprimorado)', RECOMMENDATION, ['1.4.3', '1.4.6'], AUTOMATED, ['text-contrast-enhanced']],
  ['5.11.3', 'Contraste para texto (mínimo)', REQUIREMENT, ['1.4.3'], AUTOMATED, ['text-contrast-minimum']],
  ['5.11.4', 'Contraste para componentes', REQUIREMENT, ['1.4.11'], AUTOMATED, ['component-contrast']],
  ['5.11.5', 'Contraste para objetos gráficos', REQUIREMENT, ['1.4.11'], AUTOMATED, ['graphic-object-contrast']],
  ['5.11.6', 'Contraste para indicador de foco visível', REQUIREMENT, ['1.4.11', '2.4.13'], AUTOMATED, ['focus-indicator-contrast']],

  ['5.12.1', 'Espaçamento entre as linhas', REQUIREMENT, ['1.4.12', '1.4.8'], AUTOMATED, ['line-spacing'], '', '5.1.12'],
  ['5.12.2', 'Espaçamento entre os parágrafos', REQUIREMENT, ['1.4.12', '1.4.8'], AUTOMATED, ['paragraph-spacing']],
  ['5.12.3', 'Espaçamento entre as letras', REQUIREMENT, ['1.4.12'], AUTOMATED, ['letter-spacing']],
  ['5.12.4', 'Espaçamento entre as palavras', REQUIREMENT, ['1.4.12'], AUTOMATED, ['word-spacing']],
  ['5.12.5', 'Alinhamento de blocos de texto', RECOMMENDATION, ['1.4.8'], AUTOMATED, ['text-block-alignment']],
  ['5.12.6', 'Largura de blocos de texto', REQUIREMENT, ['1.4.10', '1.4.8'], AUTOMATED, ['text-block-width']],
  ['5.12.7', 'Texto redimensionado', REQUIREMENT, ['1.4.4', '1.4.8'], AUTOMATED, ['text-resizing']],
  ['5.12.8', 'Semântica de texto especial', REQUIREMENT, ['1.3.1'], AUTOMATED, ['special-text-semantics']],
  ['5.12.9', 'Uso de texto especial', REQUIREMENT, ['1.3.1'], ASSISTED, ['special-text-purpose'], HUMAN_REASON.context],
  ['5.12.10', 'Definições de significado', RECOMMENDATION, ['3.1.3'], ASSISTED, ['unusual-word-definitions'], HUMAN_REASON.context],
  ['5.12.11', 'Siglas e abreviaturas', RECOMMENDATION, ['3.1.4'], ASSISTED, ['abbreviation-expansion'], HUMAN_REASON.context],
  ['5.12.12', 'Nível de linguagem', RECOMMENDATION, ['3.1.5'], ASSISTED, ['reading-level'], HUMAN_REASON.context],
  ['5.12.13', 'Pronúncia identificada', RECOMMENDATION, ['3.1.6'], ASSISTED, ['pronunciation-identification'], HUMAN_REASON.context],

  ['5.13.1', 'Título da página', REQUIREMENT, ['2.4.2'], ASSISTED, ['page-title'], HUMAN_REASON.context],
  ['5.13.2', 'Idioma da página', REQUIREMENT, ['3.1.1'], ASSISTED, ['page-language'], HUMAN_REASON.context],
  ['5.13.3', 'Idioma das partes da página', REQUIREMENT, ['3.1.2'], ASSISTED, ['part-language'], HUMAN_REASON.context],
  ['5.13.4', 'Título do frame', REQUIREMENT, ['1.3.1', '4.1.2'], ASSISTED, ['frame-title'], HUMAN_REASON.context],
  ['5.13.5', 'Zoom não bloqueado', REQUIREMENT, ['1.4.4', '1.4.10'], AUTOMATED, ['zoom-not-blocked']],
  ['5.13.6', 'Ordem de leitura', REQUIREMENT, ['1.3.2'], ASSISTED, ['reading-order'], HUMAN_REASON.context],
  ['5.13.7', 'Texto visível no nome acessível', REQUIREMENT, ['2.5.3'], AUTOMATED, ['visible-label-in-name']],
  ['5.13.8', 'Mensagens de status', REQUIREMENT, ['4.1.3'], AUTOMATED, ['status-message-semantics']],
  ['5.13.9', 'Propósito identificável', RECOMMENDATION, ['1.3.6'], ASSISTED, ['programmatic-purpose'], HUMAN_REASON.context],
  // O item 5.13.10 declara duas regras: a automática de nome acessível e a leitura por Tab, que
  // pergunta, parada por parada, se o que o leitor de tela anuncia corresponde ao elemento. A
  // segunda é sempre inconclusiva (cantTell) — o anúncio só se confere ouvindo.
  ['5.13.10', 'Componentes com nome acessível', REQUIREMENT, ['4.1.2'], AUTOMATED, ['accessible-component-name', 'tab-reading-announcement']],
  ['5.13.11', 'Elementos nativos', RECOMMENDATION, ['1.3.1'], ASSISTED, ['native-elements'], HUMAN_REASON.context],
  ['5.13.12', 'Semântica de componentes customizados', REQUIREMENT, ['1.3.1', '4.1.2'], AUTOMATED, ['custom-component-semantics']],
  ['5.13.13', 'Estados, propriedades e valores de componentes customizados', REQUIREMENT, ['4.1.2'], AUTOMATED, ['custom-component-state']],

  ['5.14.1', 'Alternativa em texto para áudio', REQUIREMENT, ['1.2.1'], ASSISTED, ['audio-text-alternative'], HUMAN_REASON.media],
  ['5.14.2', 'Legendas descritivas para vídeo', REQUIREMENT, ['1.2.2'], ASSISTED, ['video-captions'], HUMAN_REASON.media],
  ['5.14.3', 'Transcrição para vídeo', RECOMMENDATION, ['1.2.1', '1.2.3', '1.2.8'], ASSISTED, ['video-transcript'], HUMAN_REASON.media],
  ['5.14.4', 'Audiodescrição para vídeo', REQUIREMENT, ['1.2.1', '1.2.3', '1.2.5'], ASSISTED, ['video-audio-description'], HUMAN_REASON.media],
  ['5.14.5', 'Audiodescrição estendida para vídeo', RECOMMENDATION, ['1.2.3', '1.2.5', '1.2.7'], ASSISTED, ['extended-audio-description'], HUMAN_REASON.media],
  ['5.14.6', 'Janela de Libras para conteúdo em áudio', RECOMMENDATION, ['1.2.6'], ASSISTED, ['sign-language-interpretation'], HUMAN_REASON.media],
  ['5.14.7', 'Controle de áudio', REQUIREMENT, ['1.4.2'], AUTOMATED, ['audio-control']],
  ['5.14.8', 'Áudio sem ruído', RECOMMENDATION, ['1.4.7'], ASSISTED, ['low-background-audio'], HUMAN_REASON.media],
  ['5.14.9', 'Legendas para áudio e vídeo ao vivo', REQUIREMENT, ['1.2.4'], ASSISTED, ['live-captions'], HUMAN_REASON.media],
  ['5.14.10', 'Transcrição para áudio ao vivo', RECOMMENDATION, ['1.2.9'], ASSISTED, ['live-audio-transcript'], HUMAN_REASON.media],

  ['5.15.1', 'Controle de animação', REQUIREMENT, ['2.2.2'], AUTOMATED, ['animation-control']],
  ['5.15.2', 'Animações acionadas por interação', RECOMMENDATION, ['2.3.3'], ASSISTED, ['interaction-animation'], HUMAN_REASON.interaction],
  ['5.15.3', 'Flash intermitente', RECOMMENDATION, ['2.3.1', '2.3.2'], AUTOMATED, ['flashing-content-enhanced']],
  ['5.15.4', 'Flash intermitente limitado', REQUIREMENT, ['2.3.1'], AUTOMATED, ['flashing-content-limit']],

  ['5.16.1', 'Limite de tempo', RECOMMENDATION, ['2.2.1', '2.2.3'], MANUAL, [], HUMAN_REASON.process],
  ['5.16.2', 'Limite de tempo ajustável', REQUIREMENT, ['2.2.1'], ASSISTED, ['adjustable-time-limit'], HUMAN_REASON.interaction],
  ['5.16.3', 'Controle de atualização', REQUIREMENT, ['2.2.2'], AUTOMATED, ['updating-content-control']],
  ['5.16.4', 'Interrupções', RECOMMENDATION, ['2.2.4'], MANUAL, [], HUMAN_REASON.process],
  ['5.16.5', 'Reautenticação', RECOMMENDATION, ['2.2.1', '2.2.5'], MANUAL, [], HUMAN_REASON.process],
  ['5.16.6', 'Tempo de inatividade', RECOMMENDATION, ['2.2.1', '2.2.6'], MANUAL, [], HUMAN_REASON.process]
];

export const NBR17225_ITEMS = Object.freeze(SOURCE_ITEMS.map(defineItem));

function defineEditorialNote(note) {
  return Object.freeze(note);
}

export const NBR17225_EDITORIAL_NOTES = Object.freeze([
  defineEditorialNote({
    itemId: '5.9.1',
    field: 'wcag',
    printed: '3.2.2 no Anexo C',
    normalized: '3.3.2 conforme a Seção 5',
    rationale: 'A Seção 5 é a fonte normativa primária; o Anexo C é informativo.'
  }),
  defineEditorialNote({
    itemId: '5.9.2',
    field: 'wcag',
    printed: '1.3.1 no Anexo C',
    normalized: '1.3.2 conforme a Seção 5',
    rationale: 'A Seção 5 é a fonte normativa primária; o Anexo C é informativo.'
  }),
  defineEditorialNote({
    itemId: '5.9.4',
    field: 'wcagLevel',
    printed: '2.4.6 nível A',
    normalized: '2.4.6 nível AA',
    rationale: 'O nível oficial do critério 2.4.6 na WCAG 2.2 é AA.'
  }),
  defineEditorialNote({
    itemId: '5.9.17',
    field: 'crossReference',
    printed: '5.8.18 no Anexo C',
    normalized: '5.9.18',
    rationale: 'O item 5.8.18 não existe e a sequência coerente aponta para 5.9.18.'
  }),
  defineEditorialNote({
    itemId: '5.12.1',
    field: 'printedId',
    printed: '5.1.12 no Anexo C',
    normalized: '5.12.1 conforme a Seção 5',
    rationale: 'A numeração da Seção 5 é usada como identificador normativo.'
  })
]);
