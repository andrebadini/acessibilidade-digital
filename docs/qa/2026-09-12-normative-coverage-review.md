# Matriz de revisão normativa — controle de cobertura

Esta matriz é inventário de trabalho, não prova de validação. Fonte inicial: catálogo da extensão em 12/09/2026. Cada linha precisa ser confrontada com o corpo da ABNT e com observações reais do coletor, testes positivos/negativos e instruções humanas. O modo declarado não demonstra que a automação esteja implementada ou correta.

96 requisitos e 50 recomendações. Antes da entrega, registrar por item a evidência de aplicabilidade, limitações, casos de teste e resultado da revisão. Classificação e vínculo normativo também precisam de confirmação; não aceitar o catálogo como oráculo independente.

## Conferência independente do catálogo (12/09)

Pendência reproduzida de integração — 5.13.5: corpo do PDF, página impressa 30, confirma requisito de não bloquear o zoom do agente de usuário. A regra `zoom-not-blocked` consome `document.metaViewport`, mas o normalizador columnar não projeta esse dado do DOM observado. RED local `normalization preserves a top-document zoom restriction for the ABNT zoom rule` em `test/integration/collector-rule-contract.test.js`: meta viewport do documento principal com user-scalable=no resulta em propriedade ausente. Não confundir essa perda de entrada com impossibilidade de automação. Correção ainda não implementada; requer preservar isolamento entre documentos e tratar sintaxe ambígua, ausência observada versus coleta incompleta e limitações de inferir bloqueio efetivo só pela diretiva. O teste não afirma que navegadores que ignoram a diretiva estejam efetivamente bloqueados.

Atualização 5.13.5 — correção local em revisão: normalizador deriva somente booleano/número da meta viewport do documento principal, fora de template/shadow; duas metas ou diretivas relevantes duplicadas, conteúdo extenso ou valores inválidos permanecem ambíguos. Ausência com HTML observado resulta em null, e HTML ausente não ganha alegação de ausência. Atributo content de viewport não é copiado aos atributos normalizados, inclusive em frames. A regra conserva um alvo concreto quando a declaração restringe a ampliação, mas não transforma o metadado em bloqueio comportamental comprovado. Ausência/permissão também não aprova todo o requisito; explicações indicam teste de zoom e registro do navegador. Fonte complementar primária: https://www.w3.org/WAI/standards-guidelines/act/rules/b4f0c3/ — a nota de suporte reconhece navegadores que ignoram a diretiva; resultado ACT isolado não substitui a conclusão integral ABNT.

REDs observados: perda da declaração no caminho DOM→normalização; antiga promoção de metadado a failed/passed; normalização de escala e isolamento de outro documento. GREEN focado: 62/62 em collector-rule-contract, visual, normalize-snapshot, snapshot-schema e privacy. Inclui regra real com um alvo cantTell, sintaxe ambígua, ausência, frame e template. Ajustado oráculo de seletor #send para button#send conforme mudança já aprovada em 5dd10f8. Diff-check verde; revisão pós-GREEN solicitada. Não é suporte completo a toda sintaxe CSS viewport nem teste comportamental de zoom; esses limites continuam explícitos. Nenhuma captura ou nova versão incluída neste incremento.

Revisão pós-GREEN aprovada C=0/I=0 no escopo: verificações adicionais do revisor cobriram decimal, sufixo inválido, Infinity, exponencial, duplicata idêntica, zero, shadow root e ausência de rawcontent. Checkpoint estático aprovado; comportamento real de zoom e produção global continuam não aprovados.

Confronto automatizado do corpo do PDF fornecido (`ABNT-NBR-17225-Acessibilidade-Digital.pdf`, páginas físicas 19–48, não o checklist) com `src/core/normative/nbr17225.js`: encontrados os 146 cabeçalhos, nenhum item ausente, nenhuma diferença requisito/recomendação e nenhuma diferença entre conjuntos de referências WCAG. Extração com pypdf do runtime local. Cabeçalhos delimitados por `^(5\.\d+\.\d+)` e terminados em `– Requisito` ou `– Recomendação`; referências `C. S. n.n.n` extraídas entre cabeçalhos consecutivos e comparadas como conjuntos ordenados. Resultado: 146/146 classificações e 146/146 vínculos coincidentes.

Limite: essa conferência valida o catálogo contra o corpo textual fornecido, não a implementação das regras, sua aplicabilidade, a redação do checklist anexo, a leitura visual da página ou a conformidade do site. As pendências por item abaixo continuam válidas.

## Revisão visual independente — pendências importantes

Revisão somente leitura recebida em 12/09, após 5284fb3. Nenhum Critical informado; cinco grupos Important reproduzidos, ainda não corrigidos. Os 23 testes existentes visual/collector passam, mas usam campos sintéticos e não provam a ligação entre coleta e resultado. Não liberar produção com estes pontos abertos:

- Foco (5.1.1–5.1.3, 5.10.5): sombra/outline permanente, área do componente e posição no viewport não demonstram, respectivamente, indicador de foco, área normativa e ausência de sobreposição.
- Refluxo (5.10.4): ausência de overflow não demonstra ausência de perda de informação/funcionalidade; caminho horizontal também não observado.
- Contraste textual (5.11.2–5.11.3): escopo de texto DOM não cobre imagens de texto; alternativa de componentes inativos não representada.
- Alinhamento (5.12.5): rejeitar somente justify permite aprovação de centralização LTR; direção e exceção essencial precisam ser consideradas.
- Lacunas coleta→regra: orientação, contrastes não textuais, espaçamentos, largura do bloco, redimensionamento, semântica especial e zoom esperam dados não produzidos/utilizáveis. Tamanho mínimo/aprimorado têm cobertura acoplada, descartando observação válida de alvo 30×30.

Tratar por fronteiras pequenas com RED de integração do dado real; não trocar indiscriminadamente tudo por revisão humana nem declarar validação com fixtures sintéticas. A observação passiva da página atual é incremento separado e não encerra estes achados.

| Item | Natureza | Título | Modo declarado | Regras vinculadas | Validação independente |
|---|---|---|---|---|---|
| 5.1.1 | Requisito | Indicador de foco visível | automated | focus-visible | Pendente |
| 5.1.2 | Recomendação | Elemento em foco totalmente visível | automated | focus-fully-visible | Pendente |
| 5.1.3 | Requisito | Elemento em foco parcialmente visível | automated | focus-partially-visible | Pendente |
| 5.1.4 | Requisito | Ordem de foco previsível | assisted | focus-order | Pendente |
| 5.1.5 | Recomendação | Uso de foco | assisted | focusable-elements-interactive | Pendente |
| 5.1.6 | Requisito | Armadilha de foco | assisted | keyboard-focus-trap | Pendente |
| 5.1.7 | Recomendação | Conteúdo adicional | assisted | hover-focus-additional-content | Pendente |
| 5.1.8 | Requisito | Conteúdo adicional persistente | assisted | hover-focus-content-persistent | Pendente |
| 5.1.9 | Requisito | Conteúdo adicional dispensável | assisted | hover-focus-content-dismissible | Pendente |
| 5.1.10 | Recomendação | Atalhos de teclado | assisted | single-key-shortcuts | Pendente |
| 5.1.11 | Requisito | Atalhos de teclado sem tecla modificadora | assisted | single-key-shortcut-control | Pendente |
| 5.1.12 | Recomendação | Acessibilidade por teclado total | assisted | full-keyboard-access | Pendente |
| 5.1.13 | Requisito | Acessibilidade por teclado parcial | assisted | partial-keyboard-access | Pendente |
| 5.1.14 | Recomendação | Mecanismos de entrada simultâneos | assisted | concurrent-input-mechanisms | Pendente |
| 5.1.15 | Recomendação | Comportamento de componentes customizados | assisted | custom-component-behavior | Pendente |
| 5.1.16 | Requisito | Instruções para componentes customizados | assisted | custom-component-instructions | Pendente |
| 5.2.1 | Requisito | Texto alternativo para imagens de conteúdo | assisted | content-image-alternative | Pendente |
| 5.2.2 | Requisito | Texto alternativo para imagens funcionais | assisted | functional-image-alternative | Pendente |
| 5.2.3 | Requisito | Texto alternativo para imagens decorativas | assisted | decorative-image-alternative | Pendente |
| 5.2.4 | Requisito | Descrição para imagens complexas | assisted | complex-image-description | Pendente |
| 5.2.5 | Requisito | Imagens de texto | assisted | images-of-text | Pendente |
| 5.2.6 | Requisito | Texto alternativo para mapas de imagens | assisted | image-map-alternative | Pendente |
| 5.3.1 | Requisito | Semântica de cabeçalho | automated | heading-semantics | Contrato DOM/AX revisado em d3b9355; testes positivos/negativos em heading-observation-contract. Falta validar identificação visual de títulos sem marcação na revisão transversal. |
| 5.3.2 | Requisito | Uso de cabeçalhos | assisted | heading-purpose | Pendente |
| 5.3.3 | Recomendação | Cabeçalho principal | assisted | main-heading | Contagem do documento principal revisada em d3b9355; zero/um/múltiplos, ausência de main e isolamento de iframe testados. Identificação do assunto permanece humana. |
| 5.3.4 | Recomendação | Seções com cabeçalhos | assisted | section-headings | Pendente |
| 5.3.5 | Requisito | Estrutura de cabeçalhos | assisted | heading-order | Pendente |
| 5.4.1 | Requisito | Semântica de região | automated | landmark-semantics | Pendente |
| 5.4.2 | Requisito | Uso de regiões | assisted | landmark-purpose | Pendente |
| 5.4.3 | Recomendação | Conteúdo em regiões | assisted | content-in-landmarks | Pendente |
| 5.4.4 | Recomendação | Regiões únicas | automated | unique-landmarks | Pendente |
| 5.4.5 | Requisito | Regiões identificadas unicamente | automated | landmark-unique-names | Pendente |
| 5.5.1 | Requisito | Semântica de lista | automated | list-semantics | Listas/menus e aria-owns revisados em d3b9355, com positivos, negativos e ambiguidade. Falta validação completa de listas de definições e agrupamentos visuais sem marcação. |
| 5.5.2 | Requisito | Uso de listas | assisted | list-purpose | Pendente |
| 5.6.1 | Requisito | Semântica de tabela | automated | table-semantics | Pendente |
| 5.6.2 | Requisito | Uso de Tabelas | assisted | table-purpose | Pendente |
| 5.6.3 | Requisito | Cabeçalhos de tabela | assisted | table-headers | Pendente |
| 5.6.4 | Recomendação | Título de tabela | assisted | table-title | Pendente |
| 5.6.5 | Requisito | Título de tabela associado | automated | table-title-association | Pendente |
| 5.6.6 | Recomendação | Descrição para tabelas complexas | assisted | complex-table-description | Pendente |
| 5.7.1 | Requisito | Semântica de link | automated | link-semantics | Pendente |
| 5.7.2 | Requisito | Uso de links | assisted | link-purpose-as-link | Pendente |
| 5.7.3 | Recomendação | Propósito do link sem contexto | assisted | link-purpose-without-context | Pendente |
| 5.7.4 | Requisito | Propósito do link no contexto | assisted | link-purpose-in-context | Pendente |
| 5.7.5 | Recomendação | Links com identificação consistente | manual |  | Pendente |
| 5.7.6 | Recomendação | Links que abrem em uma nova guia ou janela | assisted | new-window-link-warning | Pendente |
| 5.7.7 | Recomendação | Links para arquivos (não HTML) | assisted | file-link-identification | Pendente |
| 5.7.8 | Recomendação | Links para sites externos | assisted | external-link-identification | Pendente |
| 5.7.9 | Recomendação | Texto complementar do link | assisted | complementary-link-text | Pendente |
| 5.7.10 | Recomendação | Links adjacentes | assisted | adjacent-links | Pendente |
| 5.7.11 | Recomendação | Links para contornar blocos de conteúdo | assisted | bypass-block-links | Pendente |
| 5.7.12 | Requisito | Links para contornar blocos de conteúdo em conjunto de páginas | manual |  | Pendente |
| 5.7.13 | Requisito | Alternativas para localização | manual |  | Pendente |
| 5.7.14 | Recomendação | Localização em conjunto de páginas | manual |  | Pendente |
| 5.7.15 | Requisito | Navegação consistente | manual |  | Pendente |
| 5.7.16 | Requisito | Ajuda consistente | manual |  | Pendente |
| 5.8.1 | Requisito | Semântica de botão | automated | button-semantics | Pendente |
| 5.8.2 | Requisito | Uso de botões | assisted | button-purpose-as-button | Pendente |
| 5.8.3 | Requisito | Propósito do botão | assisted | button-purpose | Pendente |
| 5.8.4 | Recomendação | Identificação consistente na página | assisted | consistent-component-identification-page | Pendente |
| 5.8.5 | Requisito | Identificação consistente em conjunto de páginas | manual |  | Pendente |
| 5.8.6 | Recomendação | Área de acionamento (aprimorada) | automated | target-size-enhanced | Pendente |
| 5.8.7 | Requisito | Área de acionamento (mínima) | automated | target-size-minimum | Pendente |
| 5.8.8 | Recomendação | Mudança de contexto previsível | assisted | predictable-context-change | Pendente |
| 5.8.9 | Requisito | Mudança de contexto previsível no foco | assisted | context-change-on-focus | Pendente |
| 5.8.10 | Requisito | Mudança de contexto previsível na entrada | assisted | context-change-on-input | Pendente |
| 5.8.11 | Requisito | Acionamento por ponteiro único | assisted | single-pointer-cancellation | Pendente |
| 5.8.12 | Requisito | Operação por gestos de ponteiro | assisted | pointer-gesture-alternative | Pendente |
| 5.8.13 | Requisito | Operação por movimento de arrastar | assisted | dragging-movement-alternative | Pendente |
| 5.8.14 | Requisito | Operação por movimento | assisted | motion-actuation-alternative | Pendente |
| 5.8.15 | Recomendação | Controles com retorno | assisted | control-feedback | Pendente |
| 5.9.1 | Requisito | Rótulo de campo | automated | form-field-label | Pendente |
| 5.9.2 | Requisito | Rótulo de campo previsível | assisted | predictable-field-label | Pendente |
| 5.9.3 | Requisito | Rótulo de campo associado | automated | form-label-association | Pendente |
| 5.9.4 | Requisito | Rótulo de campo descritivo | assisted | descriptive-field-label | Pendente |
| 5.9.5 | Requisito | Textos de ajuda previsíveis | assisted | predictable-help-text | Pendente |
| 5.9.6 | Requisito | Campos relacionados | automated | related-fields-grouping | Pendente |
| 5.9.7 | Requisito | Campos obrigatórios | automated | required-field-identification | Pendente |
| 5.9.8 | Requisito | Tipo de dado determinado | automated | input-purpose | Pendente |
| 5.9.9 | Requisito | Mensagem de erro descritiva | assisted | descriptive-error-message | Pendente |
| 5.9.10 | Requisito | Sugestão de correção | assisted | error-correction-suggestion | Pendente |
| 5.9.11 | Recomendação | Prevenção de erro | manual |  | Pendente |
| 5.9.12 | Requisito | Prevenção de erro para formulários críticos | manual |  | Pendente |
| 5.9.13 | Recomendação | Ajuda contextual | assisted | contextual-help | Pendente |
| 5.9.14 | Recomendação | Botão de submissão | automated | form-submit-button | Pendente |
| 5.9.15 | Requisito | Reentrada de dados | manual |  | Pendente |
| 5.9.16 | Requisito | Validação sensorial ou por movimento | assisted | sensory-motion-validation | Pendente |
| 5.9.17 | Recomendação | Autenticação acessível (aprimorado) | manual |  | Pendente |
| 5.9.18 | Requisito | Autenticação acessível (mínima) | manual |  | Pendente |
| 5.10.1 | Requisito | Características sensoriais | assisted | sensory-characteristics | Pendente |
| 5.10.2 | Requisito | Ordem de apresentação | assisted | meaningful-sequence | Pendente |
| 5.10.3 | Requisito | Orientação de exibição | automated | display-orientation | Pendente |
| 5.10.4 | Requisito | Design responsivo | automated | responsive-reflow | Pendente |
| 5.10.5 | Recomendação | Área do indicador de foco visível | automated | focus-indicator-area | Pendente |
| 5.11.1 | Requisito | Uso de cores | assisted | use-of-color | Pendente |
| 5.11.2 | Recomendação | Contraste para texto (aprimorado) | automated | text-contrast-enhanced | Pendente |
| 5.11.3 | Requisito | Contraste para texto (mínimo) | automated | text-contrast-minimum | Pendente |
| 5.11.4 | Requisito | Contraste para componentes | automated | component-contrast | Pendente |
| 5.11.5 | Requisito | Contraste para objetos gráficos | automated | graphic-object-contrast | Pendente |
| 5.11.6 | Requisito | Contraste para indicador de foco visível | automated | focus-indicator-contrast | Pendente |
| 5.12.1 | Requisito | Espaçamento entre as linhas | automated | line-spacing | Pendente |
| 5.12.2 | Requisito | Espaçamento entre os parágrafos | automated | paragraph-spacing | Pendente |
| 5.12.3 | Requisito | Espaçamento entre as letras | automated | letter-spacing | Pendente |
| 5.12.4 | Requisito | Espaçamento entre as palavras | automated | word-spacing | Pendente |
| 5.12.5 | Recomendação | Alinhamento de blocos de texto | automated | text-block-alignment | Pendente |
| 5.12.6 | Requisito | Largura de blocos de texto | automated | text-block-width | Pendente |
| 5.12.7 | Requisito | Texto redimensionado | automated | text-resizing | Pendente |
| 5.12.8 | Requisito | Semântica de texto especial | automated | special-text-semantics | Pendente |
| 5.12.9 | Requisito | Uso de texto especial | assisted | special-text-purpose | Pendente |
| 5.12.10 | Recomendação | Definições de significado | assisted | unusual-word-definitions | Pendente |
| 5.12.11 | Recomendação | Siglas e abreviaturas | assisted | abbreviation-expansion | Pendente |
| 5.12.12 | Recomendação | Nível de linguagem | assisted | reading-level | Pendente |
| 5.12.13 | Recomendação | Pronúncia identificada | assisted | pronunciation-identification | Pendente |
| 5.13.1 | Requisito | Título da página | assisted | page-title | Pendente |
| 5.13.2 | Requisito | Idioma da página | assisted | page-language | Pendente |
| 5.13.3 | Requisito | Idioma das partes da página | assisted | part-language | Pendente |
| 5.13.4 | Requisito | Título do frame | assisted | frame-title | Pendente |
| 5.13.5 | Requisito | Zoom não bloqueado | automated | zoom-not-blocked | Pendente |
| 5.13.6 | Requisito | Ordem de leitura | assisted | reading-order | Pendente |
| 5.13.7 | Requisito | Texto visível no nome acessível | automated | visible-label-in-name | Pendente |
| 5.13.8 | Requisito | Mensagens de status | automated | status-message-semantics | Pendente |
| 5.13.9 | Recomendação | Propósito identificável | assisted | programmatic-purpose | Pendente |
| 5.13.10 | Requisito | Componentes com nome acessível | automated | accessible-component-name | Pendente |
| 5.13.11 | Recomendação | Elementos nativos | assisted | native-elements | Pendente |
| 5.13.12 | Requisito | Semântica de componentes customizados | automated | custom-component-semantics | Pendente |
| 5.13.13 | Requisito | Estados, propriedades e valores de componentes customizados | automated | custom-component-state | Pendente |
| 5.14.1 | Requisito | Alternativa em texto para áudio | assisted | audio-text-alternative | Pendente |
| 5.14.2 | Requisito | Legendas descritivas para vídeo | assisted | video-captions | Pendente |
| 5.14.3 | Recomendação | Transcrição para vídeo | assisted | video-transcript | Pendente |
| 5.14.4 | Requisito | Audiodescrição para vídeo | assisted | video-audio-description | Pendente |
| 5.14.5 | Recomendação | Audiodescrição estendida para vídeo | assisted | extended-audio-description | Pendente |
| 5.14.6 | Recomendação | Janela de Libras para conteúdo em áudio | assisted | sign-language-interpretation | Pendente |
| 5.14.7 | Requisito | Controle de áudio | automated | audio-control | Pendente |
| 5.14.8 | Recomendação | Áudio sem ruído | assisted | low-background-audio | Pendente |
| 5.14.9 | Requisito | Legendas para áudio e vídeo ao vivo | assisted | live-captions | Pendente |
| 5.14.10 | Recomendação | Transcrição para áudio ao vivo | assisted | live-audio-transcript | Pendente |
| 5.15.1 | Requisito | Controle de animação | automated | animation-control | Pendente |
| 5.15.2 | Recomendação | Animações acionadas por interação | assisted | interaction-animation | Pendente |
| 5.15.3 | Recomendação | Flash intermitente | automated | flashing-content-enhanced | Pendente |
| 5.15.4 | Requisito | Flash intermitente limitado | automated | flashing-content-limit | Pendente |
| 5.16.1 | Recomendação | Limite de tempo | manual |  | Pendente |
| 5.16.2 | Requisito | Limite de tempo ajustável | assisted | adjustable-time-limit | Pendente |
| 5.16.3 | Requisito | Controle de atualização | automated | updating-content-control | Pendente |
| 5.16.4 | Recomendação | Interrupções | manual |  | Pendente |
| 5.16.5 | Recomendação | Reautenticação | manual |  | Pendente |
| 5.16.6 | Recomendação | Tempo de inatividade | manual |  | Pendente |
