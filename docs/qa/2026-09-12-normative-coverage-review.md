# Matriz de revisão normativa — controle de cobertura

Esta matriz é inventário de trabalho, não prova de validação. Fonte inicial: catálogo da extensão em 12/09/2026. Cada linha precisa ser confrontada com o corpo da ABNT e com observações reais do coletor, testes positivos/negativos e instruções humanas. O modo declarado não demonstra que a automação esteja implementada ou correta.

96 requisitos e 50 recomendações. Antes da entrega, registrar por item a evidência de aplicabilidade, limitações, casos de teste e resultado da revisão. Classificação e vínculo normativo também precisam de confirmação; não aceitar o catálogo como oráculo independente.

## Conferência independente do catálogo (12/09)

### Medição de área de acionamento separada dos limiares — 5.8.6/5.8.7

A recomendação ampliada (44×44 CSS px, 5.8.6) e o requisito mínimo (24×24, 5.8.7) precisam de conclusões independentes. RED de integração demonstrou alvo observado 30×30 com exceção desconhecida: mínimo normalizado passed e aprimorado cantTell, mas a cobertura conjunta descartava a medida no merge e tornava o mínimo inconclusivo.

Correção limitada: disponibilidade de medidas projetadas é separada dos outcomes dos limiares. Coleções inválidas continuam descartadas integralmente; runtime parcial continua bloqueando anexação; a regra percorre todos os candidatos e mantém inconclusivo quando faltam medidas. Um alvo 20×20 com exceção desconhecida tem sua medida preservada, sem se tornar falha. O caso com falha comprovada e outro alvo desconhecido é guarda do comportamento anterior, não segundo RED. A mudança só atua onde uma medição foi efetivamente coletada; não declara cobertura dos probes omitidos na auditoria passiva.

GREEN 74/74 (normalização de probes, visual e contrato de coletor), diff-check verde e revisão independente sem bloqueadores. Revisor não repetiu os testes. Ressalva preexistente para investigação: IDs duplicados no merge usam a última observação; não foi demonstrado produtor real emitindo duplicatas contraditórias neste incremento. Não prometer preservação de todas as falhas para identidades ambíguas. Nenhuma mudança de permissão, captura ou interação.

### Reorganização do conteúdo: medição não equivale a conformidade — 5.10.4

Corpo da norma, página impressa 26: os ramos de adaptação a 320 CSS px de largura (fluxo vertical) ou 256 CSS px de altura (fluxo horizontal) também exigem preservação de informação e funcionalidade. O produtor `measureReflow` mede apenas transbordamento horizontal. Dois REDs reproduziram aprovação indevida: `normalizeProbes` convertia ausência de transbordamento em passed; `responsive-reflow` também aprovava uma observação direta sem rolagem, sem prova de preservação do conteúdo.

Correção: essa medida isolada retorna cantTell nas duas rotas. Largura e transbordamento continuam disponíveis em `document.dynamicProbes`; não há nova interação ou nova flag artificial de completude. Mantida a detecção negativa com evidência de transbordamento e ausência de exceção comprovada no contrato existente. Orientação não foi alterada. A exceção final explicitamente observada de leiaute bidimensional essencial permanece: é um ramo OU independente no texto da ABNT, não deve ser eliminado por uma inferência de requisitos cumulativos. O produtor atual não infere essa essencialidade, e raw essential permanece inconclusivo.

GREEN 60/60 em regras visuais e normalização de probes, incluindo preservação da medida no merge, exceções raw, observação direta com cobertura marcada completa e regressão da orientação. Diff-check verde; revisão independente sem bloqueadores, com os 60 testes repetidos. Sugestão editorial incorporada: a instrução também pede verificar a essencialidade do leiaute bidimensional. Ainda não implementa prova automática de ausência de perdas nem o teste do fluxo horizontal; são limites explícitos, não conformidades presumidas.

### Espaçamento inicial e alternativa de ajuste — 5.12.1 a 5.12.4

Texto normativo conferido nas páginas impressas 27–28: cada item admite o espaçamento inicial suficiente OU mecanismo de configuração sem perda de conteúdo/funcionalidade. A função compartilhada anterior ignorava o primeiro caminho e consumia `textSpacingObservation`, que não possui produtor em `src`. Também atribuía a mesma perda conjunta aos quatro itens sem demonstrar a dimensão responsável.

RED: baseline suficiente resultava em cantTell, texto de controle inativo suficiente também, e observação sintética conjunta resultava em failed nos quatro itens. Nova verificação usa estilos calculados dos proprietários de texto direto, preservando fonte própria de spans: linha ≥1,5×fonte; letra ≥0,12×fonte; palavra ≥0,16×fonte. Comprimentos devem ser pixels válidos e fonte positiva. Valores insuficientes, normal, ausentes ou ambíguos exigem revisão da alternativa; não causam falha automática. A exceção de inatividade do contraste não é transferida para espaçamento. A aprovação se limita ao valor inicial observado, não afirma teste de ajustes nem ausência de perdas em outros estados. Distância entre parágrafos ainda exige geometria/revisão e não recebe aprovação a partir das outras dimensões.

GREEN 43/43 nos testes focados de regras visuais e contratos de integração, com limiares exatos, fontes internas maiores, privacidade/ocultação, separação entre dimensões e rejeição de flags sintéticas como prova. Diff-check verde; revisão independente dos três arquivos aprovada sem C/I concreto, com os 43 testes repetidos pelo revisor. O reaproveitamento da fixture columnar de contraste evita outra representação simulada do mesmo protocolo; não altera o normalizador neste incremento.

### Contraste textual: origem da amostra e inatividade — 5.11.2/5.11.3

A definição 3.56 (página impressa 9) inclui texto de componente inativo em plano secundário, exceção de 5.11.2/5.11.3 (páginas 26–27). Não se trata apenas da exceção de contraste não textual em 5.11.4.

RED de integração CDP/normalizador/regra: texto de botão inativo resultava em falhas, inclusive nos ancestrais com texto agregado; cenário misto gerava cinco alvos onde apenas o texto de instrução era aplicável; link ativo interno e label externo geravam sete alvos em vez de dois. A origem era a avaliação de `descendantText` de cada nó usando a cor daquele nó, repetindo texto e aplicando cores que podiam pertencer ao ancestral, não ao trecho.

Correção limitada: entrada columnar identifica, após redaction, elementos com nós `#text` diretos. Sinal finito `textContrastScope` distingue a amostra direta do agregado, sem novo conteúdo textual. A regra mede o elemento proprietário do texto e aplica a exceção somente no componente nativo inativo mais próximo; um componente ativo interno interrompe a propagação. `node.text` permanece intacto para outras regras. Primeira legend, labels, instruções e atributos disabled em elementos genéricos não são isentos. Entrada simplificada/legada sem proveniência não ganha uma inferência de exclusão por igualdade de strings.

GREEN focado 58/58 (normalizador, regras visuais e dois contratos de integração), diff-check verde. Inclui texto privado removido antes da derivação e cores de filho diferentes das do ancestral. Revisão independente dos três arquivos congelados sem C/I identificado; o revisor repetiu os sete testes novos de integração. Permanecem pendentes imagens de texto, demais exceções contextuais e confirmação integrada no candidato Chrome; não é encerramento de toda a regra de contraste.

### Semântica de texto especial — 5.12.8

Corpo da norma, página impressa 29: identificar programaticamente a semântica de ênfases, citações, abreviaturas e outros textos especiais; a adequação do uso à finalidade é o requisito separado 5.12.9. Referência técnica complementar: [W3C H49](https://www.w3.org/WAI/WCAG22/Techniques/html/H49.html), consultada em 12/09/2026. H49 exige examinar também a informação transmitida pela apresentação; encontrar algumas tags não demonstra cobertura integral.

Causa reproduzida: a regra consumia `specialTextKind`/`specialTextSemantic`, sem produtor no normalizador. Cinco REDs de integração mostraram `inapplicable` até para `<em>` observado. A correção elimina essas flags como prova e inventaria marcações no snapshot já redigido. Retorna `cantTell` sem alvos de problema: uma pendência geral de checklist, não falha nem suspeita concreta por trecho. CSS negrito/itálico não gera infração. Marcações existentes não comprovam exposição efetiva, identificação de todos os trechos ou finalidade correta. Não há novo campo que atravesse a fronteira de privacidade.

Verificação focada: 25/25 testes (7 integração + 18 regras visuais), incluindo DOM columnar com texto filho, agregação ABNT indeterminada, ausência de dados, flags fabricadas, 400 trechos sem multiplicação de alvos e exclusão de texto privado/executável/oculto. Revisão independente do diff congelado aprovada C=0/I=0/M=0, com os 25 testes repetidos pelo revisor. Este incremento corrige conclusão indevida, não implementa um detector exaustivo de intenção textual nem encerra a revisão de produção.

### Exceção de componente inativo — 5.11.4

Corpo do PDF, página impressa 27: componente em estado inativo é exceção explícita do contraste de componentes. REDs reproduziram button disabled sendo failed a 1:1 e ARIA-disabled não confirmado sendo tratado como falha certa. Correção local restringe a exceção a controles nativos com estado/atributo próprio confirmado; atributo HTML disabled="false" continua presença, enquanto representação booleana false não comprova desabilitação. Um disabled arbitrário em div não cria exceção. ARIA-disabled isolado gera alvo cantTell com instrução de confirmar operação. Gráficos e foco não recebem a exceção de componentes.

Coletor agora observa `:disabled` para button/input/select/textarea, em vez de inferir herança. Chrome152 real (`native-disabled-collector.test.mjs`, 1/1) confirmou controles de fieldset inativo, primeira legend ainda ativa, disabled próprio, controle ativo e custom ARIA. Coleta preserva essa observação como booleano e exclui controle nativamente desabilitado da lista de focáveis. GREEN regra/integração: 29/29; collect-page: 2/2. Revisão independente pós-GREEN solicitada. Isso não encerra o restante das medições de contraste entre estados ou de objetos gráficos.

Pendência independente encontrada nas regressões: `contextual-link-collector.test.js` tem dois casos com link-semantics retornando passed onde se espera inapplicable. Mesmas duas falhas reproduzidas usando as fontes de visual.js e page-collector.js do HEAD f96a426 por loader Node somente leitura (`git show`), sem alterar checkout; portanto não introduzidas pelo incremento de inatividade. Registrar para revisão própria da semântica/aplicabilidade dos links, não apagar os testes nem trocar seus oráculos apenas para obter GREEN.

Reinvestigação dos dois testes: a função de semântica já retorna inapplicable sem candidatos. A fixture, porém, fornecia AX role=link inclusive para a âncora sem href; desde a integração dos papéis AX esse é um candidato real, contradizendo o caso descrito. Prova independente em Chrome152 (`link-role-observation.test.mjs`, 1/1): âncora sem href não tem papel link; link com href mantém esse papel, inclusive em contenteditable próprio ou ancestral. Corrigida a fixture sem href para não fabricar entrada AX link. Para os casos privados, preservado AX role seguro: link-semantics passed verifica exclusivamente esse papel; três regras de finalidade continuam cantTell porque o nome foi omitido; aviso de nova janela inapplicable sem alvo observado. Nenhuma regra produtiva foi alterada. 26/26 testes contextual/interactive passaram; revisão independente dos dois arquivos de teste solicitada. Essa distinção evita confundir semântica comprovada com qualidade textual não examinada, sem mascarar erro por troca arbitrária de expectativa.

Revisão dos testes aprovada C=0/I=0, com 26/26 repetidos pelo revisor. Minor opcional: representar também a entrada AX não-link da âncora na fixture, em vez de omiti-la; o E2E já exige entrada observada não-link. Registrado sem bloquear checkpoint e sem declarar produção aprovada.

Checkpoint 5.11.4 aprovado: revisão independente C=0/I=0 no diff; execução final conjunta 31/31 nos testes focados, Chrome real 1/1 e diff-check verde. A revisão não repetiu Chrome nem declarou pronta a produção global.

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
