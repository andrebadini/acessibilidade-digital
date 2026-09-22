# Audita Acessibilidade 2.0 — motor híbrido, personas e auditoria multipáginas

Data: 27 de agosto de 2026  
Estado: aprovado por instrução permanente do responsável pelo produto  
Complementa: `2026-08-26-auditoria-acessibilidade-design.md`

## 1. Objetivo

Evoluir a extensão para uma suíte local de auditoria que combine o catálogo completo da ABNT NBR 17225:2025, WCAG 2.2, axe-core, correspondência técnica com Section 508, simulações de personas, lote explícito de URLs e relatórios mais acionáveis. A extensão continuará sem conta, login, assinatura, servidor, telemetria ou envio de dados.

Esta versão não promete “detectar todas as não conformidades” em sentido absoluto. Ela automatiza tudo que for conclusivamente observável e sinaliza com transparência o que depende de contexto, tarefa, equivalência ou avaliação humana.

## 2. Princípios obrigatórios

1. **Autoridade preservada.** O registro ABNT e o motor próprio continuam sendo a autoridade de agregação. axe-core é um scanner suplementar.
2. **Proveniência explícita.** Cada resultado informa motor, regra, versão, configuração e método.
3. **Sem extrapolação.** `passes` de uma regra não comprovam conformidade integral; simulações não substituem tecnologia assistiva real.
4. **Privacidade local.** Nenhum dado é transmitido. Todo executável é empacotado.
5. **Evidência original preservada.** Capturas anotadas são derivadas; a imagem original e seu hash permanecem separados.
6. **Reversibilidade.** Personas e alterações temporárias têm saída segura e são removidas ao desativar, navegar ou fechar a aba.
7. **Conservadorismo jurídico.** O relatório descreve desconformidade técnica e base para análise; não declara automaticamente infração, responsabilidade ou sanção.

## 3. Arquitetura escolhida

### 3.1 Motor híbrido

A auditoria de cada página ocorrerá nesta ordem:

1. navegação e estabilização com orçamento de tempo;
2. captura integral original e metadados do estado;
3. execução local do axe-core no estado pristino, antes de sondagens que alterem foco, viewport ou estilos;
4. coleta DOM, CSS e árvore AX pelo pipeline existente;
5. normalização em um contrato canônico V2;
6. execução das regras próprias e sondagens dinâmicas;
7. normalização dos resultados axe;
8. mapeamento curado por `axeRuleId` para item ABNT, quando existente;
9. deduplicação de ocorrências visualmente equivalentes sem apagar a proveniência de cada motor;
10. captura de evidências e agregação normativa.

axe-core será fixado em `4.13.0`. O pacote de distribuição conterá `vendor/axe/axe.js` (build não minificado, legível por humano), licença MPL-2.0 e avisos de terceiros. Não haverá CDN, import remoto, `unsafe-eval` ou alteração da CSP para contornar incompatibilidades. A integração só será ativada depois de um gate E2E em Chromium MV3; se falhar, a extensão continuará com o motor próprio e registrará a limitação.

Configuração inicial do axe:

- WCAG A/AA por tags aplicáveis;
- regra `target-size` habilitada explicitamente após o gate E2E;
- regras experimentais desabilitadas;
- boas práticas separadas dos resultados normativos;
- coleta de `violations` e `incomplete`; `passes` e `inapplicable` somente em resumo técnico para limitar tamanho;
- execução em todos os frames tecnicamente acessíveis;
- timeout e falha parcial por frame.

### 3.2 Contrato de coleta V2

Antes de novas funcionalidades, testes de caracterização devem alinhar os dados produzidos pelo navegador às regras. O contrato V2 inclui:

- nomes AX vazios como observação válida, distintos de “não coletado”;
- mídia normalizada com autoplay, áudio, duração, controles e faixas;
- estilos derivados para contraste, tamanho do texto, bloco de texto e `text-align`;
- alvo de sondagem ligado ao nó canônico por seletor, frame e backend node ID;
- dimensões e geometria do alvo;
- origem do nome/descrição acessível;
- IDs estáveis entre DOM, AX, axe, probes e evidências.

### 3.3 Modelo canônico V2

O modelo raiz contém uma auditoria consolidada e uma ou mais páginas:

```js
{
  schemaVersion: 2,
  auditId,
  requestedScope: { mode: 'single' | 'batch', urls: [] },
  pages: [{ pageId, requestedUrl, finalUrl, status, timestamps, viewport }],
  occurrences: [{
    occurrenceId,
    pageId,
    outcome,
    classification,
    impact,
    confidence,
    source: { engine, ruleId, version },
    nbrItemRef,
    wcagRefs: [],
    foreignBenchmarkRefs: [],
    target: { nodeId, selector, framePath },
    accessiblePreview,
    evidenceRefs: [],
    legalAnalysis
  }],
  evidence: [],
  integrity: {},
  limitations: []
}
```

`classification` distingue `requirement`, `recommendation`, `best-practice` e `editorial`. Impacto usa `critical`, `serious`, `moderate` e `minor`, com origem registrada. Achados próprios recebem impacto definido em catálogo; achados axe preservam o impacto do motor.

## 4. Base normativa e jurídica

### 4.1 ABNT e WCAG

O item da NBR permanece a unidade principal de agregação. Cada ocorrência deve referenciar um item existente, salvo boas práticas suplementares. Mapeamentos axe serão curados por ID de regra, nunca inferidos apenas pela tag WCAG.

Uma falha axe afeta um item ABNT somente quando:

- o ID de regra consta no crosswalk revisado;
- a aplicabilidade do item foi confirmada;
- o resultado é `violation` e a evidência foi vinculada ao alvo;
- requisito e recomendação são preservados como categorias distintas.

`incomplete` torna-se `cantTell`. `passes` não torna item ABNT aprovado. Boas práticas e alertas editoriais não recebem fundamento normativo ou jurídico que não possuam.

### 4.2 Section 508

Section 508 fica em `foreignBenchmarks`, separada de `brazilianLegalBasis`. A versão revisada será representada pela correspondência com critérios WCAG 2.0 A/AA e por notas sobre requisitos específicos. A tag `section508` do axe, referente ao padrão antigo, não será usada.

O relatório exibirá “correspondência técnica com Section 508” e jamais concluirá conformidade integral por derivação.

### 4.3 Bloco consumerista imutável

O catálogo jurídico contém um único objeto versionado:

```js
{
  id: 'br.consumer.accessibility.fixed.v1',
  label: 'Base consumerista padronizada para análise',
  display: 'Arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c art. 12, IX, “a”, do Decreto nº 2.181/1997.',
  qualification: 'A referência padronizada não constitui conclusão automática de infração, responsabilidade ou sanção; a incidência depende da qualificação jurídica do alvo e dos fatos do caso concreto.',
  currentTextCaveatRef: 'br.law13874.art3.vi'
}
```

Toda desconformidade técnica conclusiva referencia esse mesmo ID. O item ABNT é o único fundamento técnico variável. O modelo não terá campos `violatedLaw`, `illegal`, `liability` ou `sanction`.

O bloco não aparece como incidência em `cantTell`, `untested` ou `inapplicable`. Uma recomendação não atendida é rotulada como tal e não como infração automática.

## 5. Regras complementares

### 5.1 Links genéricos

Textos como “clique aqui”, “saiba mais”, “veja mais” e equivalentes geram candidato de revisão quando o nome acessível isolado não identifica a finalidade. O algoritmo examina contexto próximo e nome acessível; não produz falha automática quando o contexto pode tornar a finalidade clara.

### 5.2 Nova aba sem aviso

Links com `target="_blank"` ou comportamento equivalente são verificados quanto a aviso no nome acessível ou texto adjacente. Ausência observável produz resultado ligado ao item NBR 5.7.6, preservando sua classificação normativa.

### 5.3 Texto justificado

O coletor passa a registrar `text-align`. Blocos com texto corrido e `justify` alimentam a regra já existente, com seletor, trecho e captura.

### 5.4 Conteúdo provisório

“Lorem ipsum” e padrões inequivocamente provisórios geram alerta editorial, sem alegação automática de WCAG, ABNT ou infração legal.

### 5.5 VLibras e Hand Talk

A extensão detecta localmente assinaturas de widgets, scripts, elementos, atributos e objetos globais já presentes na página. O resultado é inventário `present`, `absent` ou `unknown`. Presença não demonstra qualidade; ausência não é desconformidade. Conteúdo audiovisual pertinente continua encaminhado à revisão humana de Libras.

## 6. Suíte de personas

As personas são iniciadas pelo painel da extensão para a aba de conteúdo explicitamente registrada como alvo. O painel nunca usa a própria aba `chrome-extension://` como alvo implícito. O estado é isolado por aba e nunca é incluído como resultado normativo automático.

### 6.1 Prévia de leitor de tela

O modo será um módulo dedicado chamado **Leitura simulada**, e não apenas um filtro da persona. Ele:

- aplica camada escura sem remover a página da árvore de acessibilidade;
- oferece controles locais de iniciar, pausar/continuar, parar, repetir, anterior e próximo;
- acompanha o foco e anuncia localmente por `speechSynthesis` a prévia calculada;
- percorre uma fila determinística de elementos significativos na ordem de foco/documento, sem acionar controles ou enviar formulários;
- calcula essa ordem sem mover o foco para descobrir elementos: primeiro `tabindex` positivo em ordem numérica e, depois, elementos focalizáveis nativos/`tabindex="0"` em ordem documental, com desempate estável;
- mostra marcador visível do elemento atual e legenda textual sincronizada para quem acompanha o teste;
- usa nome, função, descrição, valor não sensível e estados coletados;
- permite escolher uma voz disponibilizada pelo navegador e ajustar a velocidade dentro de limites seguros, mantendo preferências apenas localmente;
- cancela fala anterior somente quando o módulo controla uma elocução ativa; como `speechSynthesis` compartilha uma fila com a própria página, essa limitação é declarada e o módulo não chama `cancel()` preventivamente ao iniciar;
- continua utilizável pela legenda quando `speechSynthesis` estiver ausente, `speak()` falhar, `voiceschanged` chegar tarde ou a voz preferida deixar de existir;
- invalida callbacks assíncronos antigos para que término, erro ou mudança de voz de uma fala anterior não sobrescreva o item atual;
- nunca lê, armazena ou transmite senha, OTP, token, valor de campo sensível, `textarea`/`contenteditable` privado ou conteúdo de subárvore marcada como privada; somente identificador de voz e velocidade podem ser persistidos localmente, fora de relatórios e evidências;
- exclui da fila conteúdo oculto, `aria-hidden`, `inert`, desabilitado ou sem geometria útil, sem retirar a página real da árvore de acessibilidade;
- percorre Shadow DOM aberto. Frames same-origin podem ser coordenados quando comprovados; frame inacessível, sandboxed, Shadow DOM fechado ou cobertura parcial gera limitação explícita, nunca aprovação silenciosa;
- oferece saída de emergência por três `Escape` discretos, ignorando repetição automática da tecla, e restaura foco/estilos ao encerrar;
- remove fala própria, listeners, observadores, camadas, marcadores, CSS e estado em parada, navegação, recarga, fechamento da aba e mutação SPA que invalide a fila; reiniciar não duplica artefatos;
- usa artefatos visuais `aria-hidden`, não focalizáveis, e mensagens estritamente tipadas/correlacionadas à persona, aba e frame ativos;
- a injeção local do módulo precisa ser provada em E2E sob MV3/CSP. Como `chrome.scripting.executeScript({ files })` carrega script clássico, módulos ESM só podem ser usados após empacotamento local comprovado, sem código remoto ou relaxamento da CSP;
- informa permanentemente: “Simulação baseada na árvore de acessibilidade; não substitui VoiceOver, NVDA, JAWS ou teste com pessoas”.

### 6.2 Simulação de acromatopsia

- aplica filtro de escala de cinza à página, sem alterar a extensão;
- preserva contraste relativo e não gera aprovação/reprovação;
- rótulo: “Simulação visual qualitativa de acromatopsia”.

### 6.3 Modo motor/teclado

- bloqueia `mousedown`, `mouseup`, `click` de origem apontadora, `pointer*`, `touch*`, `wheel` e menu de contexto no conteúdo;
- não bloqueia eventos de teclado nem cliques sintetizados por teclado;
- oculta o cursor no conteúdo;
- mostra instrução de saída e permite `Escape` três vezes;
- é removido automaticamente em navegação, recarregamento, desativação ou fechamento da aba.

## 7. Entradas de auditoria

### 7.1 Menu de contexto

O manifesto adiciona `contextMenus`. Na instalação, a extensão cria:

- “Auditar esta página com Audita Acessibilidade” em páginas HTTP/HTTPS;
- “Auditar este link com Audita Acessibilidade” em links HTTP/HTTPS.

Ambas as ações abrem o painel com o escopo preenchido e exigem apenas o clique final de início quando necessário para preservar clareza de estado.

### 7.2 Lote explícito de URLs

O painel aceita até 20 URLs HTTP/HTTPS, uma por linha. A extensão:

- normaliza e deduplica preservando ordem;
- informa URLs inválidas antes de iniciar;
- executa uma página por vez em aba descartável;
- continua após falha de uma página;
- permite cancelar o lote;
- grava progresso persistente suficiente para explicar interrupção, sem prometer retomada automática completa;
- consolida achados por página, item, impacto e fonte.

Não haverá crawler autônomo por descoberta de links nesta versão. “Multipáginas” significa lista fornecida pelo usuário, evitando escopo ilimitado, risco de autenticação e crescimento não controlado das evidências.

## 8. Transcrição visual anotada

Para cada página, o produto cria uma figura derivada da captura integral:

1. seleciona elementos significativos na ordem de leitura observada;
2. atribui números sequenciais estáveis;
3. posiciona marcadores junto aos retângulos dos elementos;
4. acrescenta abaixo da imagem uma área branca de legenda;
5. lista `número — seletor resumido — prévia de anúncio`;
6. divide legendas longas em linhas sem encobrir a página;
7. registra algoritmo, versão e limitações.

A figura é rotulada “Mapa visual da prévia de anúncios”. Não será chamada de transcrição literal. A captura integral original sem marcações e seu SHA-256 continuam preservados e referenciados.

Quando a página exceder limites práticos, a legenda será paginada ou dividida em segmentos com a mesma numeração, sem truncamento silencioso.

## 9. Relatório e experiência

### 9.1 Hierarquia

O HTML começa por:

1. identidade neutra e escopo;
2. resumo executivo e limitações críticas;
3. ações e filtros;
4. não conformidades priorizadas;
5. mapa de prévias de anúncio;
6. revisão humana pendente;
7. matriz completa dos 146 itens;
8. metodologia, fontes, integridade e anexos.

Os avisos de independência e integridade continuam visíveis, mas compactos. A matriz integral não bloqueia o acesso às ocorrências.

### 9.2 Filtros

O relatório HTML permite filtrar por:

- impacto;
- nível WCAG A, AA ou AAA;
- resultado;
- requisito, recomendação, boa prática ou editorial;
- página;
- motor de origem;
- item ABNT.

O JavaScript é autocontido e progressivo. Sem JavaScript, todas as ocorrências permanecem legíveis. A impressão/PDF ignora filtros ativos e contém o conjunto completo, com sumário estático.

### 9.3 Card de ocorrência

Cada card agrupa, nesta ordem:

- título humano e impacto;
- página, estado e instante;
- desconformidade técnica: item ABNT, WCAG e correspondência 508;
- explicação e como reproduzir;
- prévia de anúncio e origem do nome;
- seletor, trecho e propriedades relevantes;
- captura do elemento e referência à captura integral;
- base consumerista padronizada para análise;
- qualificação jurídica constante;
- motor, regra, versão, confiança e hashes.

Detalhes técnicos extensos usam `details/summary`, mantendo o conteúdo acessível e imprimível.

## 10. Exportações

O conjunto passa a ter HTML, PDF, JSON-LD e CSV.

O CSV terá uma linha por ocorrência, UTF-8 com BOM, regras RFC 4180 e colunas estáveis para auditoria, página, URL, instante, resultado, classificação, impacto, item ABNT, WCAG, Section 508, título, descrição, seletor, prévia de anúncio, origem, evidências, base jurídica fixa e hashes.

Valores iniciados por `=`, `+`, `-`, `@`, tabulação ou retorno de carro serão neutralizados para evitar execução de fórmula em planilhas. A representação original continuará disponível no JSON sanitizado.

## 11. Armazenamento, retenção e limites

- máximo de 20 páginas por lote;
- uma página auditada por vez;
- timeout configurado e registrado por etapa;
- limite de passos de teclado e de nós anotados, sempre declarado no relatório;
- limites para captura, snippet e resultado bruto axe antes de persistência;
- sanitização de `html`, `target` e `failureSummary` oriundos do axe;
- botão “Excluir auditoria” e ação “Excluir todas as auditorias” com confirmação;
- retenção padrão local de 30 dias, com limpeza na abertura e opção “não reter após exportar”;
- nenhum cookie, senha, token ou cabeçalho de autenticação persistido;
- URLs e pixels podem conter dados pessoais; o painel exibe aviso antes de iniciar.

## 12. Falhas e estados parciais

Falhas de axe, frame, screenshot, PDF ou uma URL do lote não cancelam evidências válidas de outras etapas. A página recebe `complete`, `partial`, `failed` ou `cancelled`; o lote agrega esses estados sem ocultar a causa.

O motor registra:

- código estável;
- etapa;
- página/frame;
- mensagem para leigos;
- detalhe técnico sanitizado;
- efeito sobre a cobertura;
- ação recomendada.

## 13. Testes e gates

Implementação seguirá TDD. Gates obrigatórios:

1. testes de caracterização do contrato real coletor → normalizador → regra;
2. catálogo jurídico imutável e associação somente a falhas conclusivas;
3. mapeamento Section 508 sem uso da tag antiga;
4. axe-core em Chromium MV3 com CSP `script-src 'self'`, sem rede e sem `unsafe-eval`;
5. páginas com Shadow DOM aberto, iframe same-origin, cross-origin e sandbox;
6. sanitização e limites de resultados axe;
7. personas reversíveis e saída segura por teclado;
8. lote com URL inválida, duplicada, timeout, cancelamento e falha intermediária;
9. CSV contra injeção de fórmula e correlação com JSON/HTML;
10. relatório com filtros acessíveis e fallback sem JavaScript;
11. PDF completo independentemente do filtro ativo;
12. captura anotada correlacionada à original e hashes distintos;
13. build reproduzível com licenças e sem código remoto;
14. E2E oficial em Chromium, não apenas script ignorado;
15. auditoria da própria interface e revisão visual desktop/impressão.

## 14. Critérios de aceitação

1. O uso continua sem login, conta ou rede de aplicação.
2. axe-core 4.13.0 executa localmente ou falha de modo explícito sem impedir o motor próprio.
3. Nenhum resultado axe apaga a proveniência ou promove indevidamente conformidade ABNT.
4. Toda falha técnica conclusiva apresenta o mesmo bloco consumerista e varia apenas o item ABNT.
5. Recomendações, revisões e alertas editoriais não são apresentados como infrações automáticas.
6. A extensão audita uma página por painel e por menu de contexto.
7. Um lote de até 20 URLs gera um relatório consolidado e identifica falhas individuais.
8. As três personas funcionam, são reversíveis e declaram seus limites; o módulo Leitura simulada oferece iniciar, pausar/continuar, parar, repetir, anterior/próximo, legenda sincronizada e voz/velocidade locais.
9. O relatório HTML filtra por impacto e nível sem perder conteúdo no fallback ou no PDF.
10. HTML, PDF, JSON-LD e CSV são gerados localmente.
11. O mapa visual une marcadores e prévias de anúncio, preservando a captura original.
12. VLibras/Hand Talk são detectados apenas como inventário local.
13. Auditorias podem ser excluídas e a retenção é limitada.
14. Testes unitários, de contrato, integração, E2E, relatório e build passam.
15. O pacote contém avisos de licença do axe e nenhum executável remoto.

## 15. Fora do escopo desta versão

- spider automático que descobre e segue todo link de um domínio;
- autenticação automatizada ou armazenamento de credenciais;
- equivalência a VoiceOver, NVDA, JAWS ou testes com pessoas;
- simulação médica completa de todos os tipos de daltonismo;
- certificação WCAG, ABNT ou Section 508;
- conclusão jurídica automática, cálculo de sanção ou parecer;
- armazenamento em nuvem, painel de equipe ou telemetria;
- publicação automática de uma nova versão na Chrome Web Store sem a confirmação final exigida pela plataforma de navegador.
