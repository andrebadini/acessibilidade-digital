# Revisão normativa para produção

> Execução incremental local com Superpowers, TDD e verificação antes de conclusão. Não substituir a revisão completa por aprovação de um subconjunto.

## Estado atual consolidado (12/09, após 5284fb3)

Integrados e revisados em escopos limitados: estrutura d3b9355, controles a4f43a1, aplicabilidade/tabelas 21755af, axe 8c5d003, legendas 635c180, formulários 7e062f3, imagens 5284fb3. Registros abaixo são históricos; textos antigos “em revisão” não reabrem esses checkpoints.

Ativo: execução passiva da página atual, plano `2026-09-12-observed-page-passive.md`. Primeiro incremento integrado em 742ca45, com 164 testes focados verdes e revisão independente C=0/I=0/M=0 (mais 17 verificações do revisor). Starter ainda usa cópia: próximo incremento é o roteamento, não anunciar mudança no painel nem nova versão.

Revisão visual independente identificou cinco grupos Important adicionais, registrados na matriz de cobertura. Permanecem pendentes; não são motivos teóricos nem melhorias cosméticas. Conferência dos 146 itens e vínculos com o corpo da norma passou, mas não encerra validação dos algoritmos. Produção ainda não aprovada; sem novo ZIP ou versão.

## Objetivo e especificação

Entregar versão de produção confiável da extensão com foco nos requisitos obrigatórios da ABNT NBR 17225:2025, automação pertinente e revisão humana didática para leigos. A especificação é a solicitação ativa do usuário e a norma local; o parecer `entregas/analise-comparativa-2026-09-12/parecer.html` registra defeitos novos reproduzíveis. Base inicial: fc1974d.

## Restrições

- Preservar código e entregas válidos; nenhuma reabertura sem evidência.
- Separar requisito, recomendação, suspeita concreta e checklist não avaliado.
- Não concluir acessibilidade integral por nota, ausência de achados ou testes de funcionamento.
- Preservar autorização de pixels, correlação de evidências, sanitização e cleanup.
- Testes focados durante incrementos; suíte ampla e Chrome real no candidato integrado, com ambiente confirmado; ZIP somente na entrega.

## Incrementos e critérios

- [ ] 1. Contrato de cabeçalhos: `src/core/normalize-snapshot.js`, `src/core/rules/structure.js`, teste `test/integration/heading-observation-contract.test.js`. Entrada: DOMSnapshot + AX; saída: papel/nível preservados e classificação correta. Reproduzir falso positivo com cabeçalho nativo e ARIA; executar teste RED; corrigir; verificar testes de normalização e estrutura. Não confundir nível AX ausente com falha do autor.
- [ ] 2. Semântica de listas/menus e aplicabilidade de cabeçalho principal: casos válidos e inválidos, ausência de main não elimina recomendação global. Mesmos módulos estruturais, testes de regras e integração; revisar redação ABNT e relações ARIA.
- [ ] 3. Integração axe: adapter, crosswalk e normalização. Matriz de regras incluídas/excluídas; filhos/pais ARIA, bypass e demais regras pertinentes. Cada inclusão com evidência de mapeamento e testes; inconclusivos não afirmam violação.
- [ ] 4. Revisão de cobertura dos 146 itens, priorizando todos os requisitos obrigatórios: matriz item → proposição → pré-condições → observações realmente coletadas → regra → teste conforme/não conforme → limitações → orientação humana. Auditar estrutura, imagens, links, componentes, formulários, cores, mídia, teclado, tempo, apresentação e texto. Classificar lacunas, corrigir automatização viável e evitar falsos não aplicáveis. A matriz deve indicar quais itens não são automatizáveis integralmente e por quê.
- [ ] 5. Estado observado: permitir análise não destrutiva do estado atual; identificar recarga/cópia e estados não cobertos. Revisar contrato de captura sem perder privacidade nem automatizar ações destrutivas em sites. Testes de estado inicial/menu/formulário, identidade e correspondência do relatório.
- [ ] 6. Relatório e assistência: requisito obrigatório como referência principal; evidência da aplicabilidade, explicações condicionais corretas, checklist separado, orientação executável por leigos, métricas sem falsa certificação e preservação de destaques/legendas/exportações.
- [ ] 7. Validação transversal: fixtures independentes positivas e negativas, páginas simples e complexas, formulários, menus, tabelas, mídia, interfaces dinâmicas; avaliação manual visual/AX e leitor assistivo onde necessário. Comparar candidatos no mesmo estado; revisar falsos positivos/negativos em vez de igualar totais de motores.
- [ ] 8. Candidato de produção: revisão independente sobre diff congelado, sem Critical/Important conhecido; suíte lógica, verify, E2E Chrome, PDF/HTML/CSV/JSON visualmente conferidos; versão/ZIP íntegros, instruções de atualização e limitações documentadas. Só então declarar produção e completar a meta.

## Registro de execução

- Diagnóstico anterior: progresso verificável, duas reproduções de falsos positivos e teste real de menu em dois endereços. Não implica correção.
- Incremento ativo: 1. Os demais permanecem pendentes; a meta não foi reduzida aos defeitos do Google.
- 12/09: RED inicial confirmado (4 falhas/2 passes), correção de papel/nível AX e nível ARIA acima de 6. RED adicional de recuperação automática do navegador (5 falhas/6 passes): nível substituto não pode aprovar atributo obrigatório ausente ou inválido. GREEN focado final: 52/52, normalização + contrato do coletor + estrutura + novo contrato de cabeçalhos; `git diff --check` aprovado. Alterações ainda sem commit; revisão do incremento e validação transversal pendentes. Nenhum pacote gerado.
- Continuação: RED listas 3 falhas/12 passes; correção de papéis efetivos e item sob menu. RED cabeçalho principal 3 falhas/14 passes; recomendação agora independe de tag main e exige revisão de pertinência quando há um único H1. GREEN conjunto estrutural 57/57. Diff desses arquivos congelado e enviado à revisão independente `normative_structure_review`.
- Redação axe inconclusiva: RED reproduziu frase categórica indevida; normalizador e validador usam texto curado de incerteza. RED adicional preservou leitura de registros históricos (sem alterar outcome). GREEN 53/53 nos testes de normalização axe, validação e deduplicação; diff-check aprovado. Seleção/crosswalk de regras axe ainda não corrigidos. Nenhuma alegação de produção nem ZIP novo.
- Continuação: RED 3/3 para sinais descartados `aria-required-children`, `aria-required-parent`, `bypass`; incluídos no adapter/crosswalk com 5.13.12 (requisito) e 5.7.11 (recomendação), respectivamente. Mantida necessidade de comprovação da aplicabilidade. GREEN 71/71 em normalização, validação, adapter e crosswalk. Metadados do bundle axe 4.13.0 conferidos via getRules: WCAG 1.3.1 para parent/children e 2.4.1 para bypass. Restam revisão independente, expansão de comprovação automática onde viável e demais regras do inventário. Diff-check aprovado.
- Revisão estrutural recebida: dois Important reproduzíveis (contagem de H1 cruzava frames; lista ARIA com aria-owns válida era rejeitada). RED confirmou duas falhas. Correção limita a contagem ao documento externo e aceita ownership de lista no mesmo documento. RED adicional reproduziu aprovação indevida de referência ambígua; múltiplos IDs/owners agora exigem revisão. GREEN 60/60 em estrutura, integração de cabeçalhos, normalização e contrato do coletor; diff-check aprovado. Diff novamente congelado para validação pelo mesmo revisor. Sem revisão ampla, commit ou pacote nesta rodada.

## Backlog não bloqueante

- Mídia: após deixar ausência de track como revisão, array failures e retorno failed em videoCaptions ficaram inalcançáveis. Minor de manutenção aprovado como não bloqueante; remover em limpeza posterior sem mudar resultados.

Revisão estrutural final: aprovada pelo mesmo revisor após reprodução pelo normalizador real. Zero Critical/Important conhecido nesse incremento; Minor abaixo preservado. Testes focados reexecutados: 60/60. Checkpoint estrutural d3b9355 usa apenas os quatro arquivos autorizados, sem node_modules nem arquivos axe/interações. Incrementos 1 e 2 integrados nesse escopo; a matriz completa e validação transversal continuam pendentes.

Interações em andamento: fonte oficial ARIA in HTML conferida (https://www.w3.org/TR/html-aria/#el-button e #el-a). RED duas falhas: substituições legais tratadas como erros e papel AX de componentes customizados ignorado. Correção local em interactive.js; GREEN 25/25 com interactive.test.js e collector-rule-contract.test.js. Mantidos erros de interação sem papel e substituição inválida; ainda pendente revisão independente e checagem de nomes para componentes customizados.

Interações, continuação: RED adicional mostrou componente AX-only sem nome ignorado; inclusão nas checagens de nome e semântica. GREEN 26/26, diff-check aprovado. Dois arquivos congelados e enviados ao revisor independente, sem alterar o incremento estrutural aprovado.

Interações, revisão recebida: dois Important confirmados por RED (links DPub válidos e exceção combobox em input image). Correção agrupada preserva DPub como link sujeito a checagem de nome e não aceita a substituição vedada de input image. GREEN 27/27; diff congelado para validação pelo mesmo revisor. Revisão independente axe iniciada em paralelo, sem edição concorrente. Regressões diretamente relacionadas de apresentação normativa, linguagem didática, classificação e overview: 41/41 aprovadas. Não substituem E2E do candidato.

Interações aprovadas: revisor confirmou ambas as correções e ausência de regressões diretas C/I/M. Checkpoint a4f43a1, somente interactive.js e interactive.test.js. Incremento manual-review enviado ao mesmo revisor, congelado; axe segue com revisor separado. Não há alteração de versão nem pacote de produção.

- Minor estrutural: aria-level positivo acima de Number.MAX_SAFE_INTEGER é tratado como inválido. WAI-ARIA define inteiro positivo sem esse limite. Tratar validade lexical separadamente da observação numérica em atualização posterior; não alegar cobertura desse caso. Fonte: https://www.w3.org/TR/wai-aria-1.2/#aria-level .

## Próximo domínio a investigar

- Imagens, revisão: RED2 dos casos sem AX (aria-label válido rejeitado; alt indevido em div aceito), mais RED1 para nome referenciado/SVG não coletado. Fallback agora respeita mecanismos nativos/ARIA, preserva incerteza de referências/SVG e resumo sem alegar presença concluída. GREEN52/52; congelado para revalidação.
- Fidelidade do estado atual: leitura confirmou prepareAttachedCopyPlan em service-worker.js1280 chama snapshotAttachedCopySource, troca autorização para attached-copy e guarda rawURL em vault; não copia DOM/estado em memória. runAttachedAuditExecution já existe, mas adapter expõe runDynamicProbes separado (chrome-adapter.js1678). Próximo contrato precisa permitir observação passiva do documento original sem executar probes que alteram foco/layout e declarar cobertura ausente. Não basta remover aviso de cópia; manter autorização/identidade/evidências. Nenhuma mudança nessa fronteira nesta rodada.

- Conferência transversal do catálogo: extraídos 146 cabeçalhos do corpo do PDF (sem usar o catálogo como oráculo), comparadas natureza normativa e referências WCAG com todos os146itens do código. Zero ausências/diferenças nos dois conjuntos; registro em docs/qa/2026-09-12-normative-coverage-review.md. Não equivale a validar algoritmos.
- Formulários, revisão recebida: Important cruzamento for/documentos. RED1, índices e associações particionados por frameId/framePath, GREEN22/22 e diffcheck. Novo congelamento enviado ao mesmo revisor; mantém alvo local apesar de ID estrangeiro e rejeita rótulo emprestado de outro documento.

- Mídia integrada em635c180 após C0/I0, Minor acima registrado e GREEN52/52 reexecutado. Imagens: RED2 para SVG/roleimg omitido e alt vazio prevalecendo sobre nome AX válido. Correção de candidato e precedência; GREEN49/49 media/collector/plain-language. AccName1.1 §4.3 conferido (https://www.w3.org/TR/accname-1.1/); AccName1.2 consultado apenas como draft, não fundamento definitivo. Dois arquivos congelados para revisão independente.

- Imagens (somente diagnóstico enquanto media.js está congelado): SVG role=img/AX=image com nome retorna inapplicable em content-image-alternative; img com alt vazio mas nome acessível ARIA não vazio e finalidade content retorna failed por priorizar alt. Reproduções locais confirmadas; confrontar precedência AccName e produtor de mediaPurpose antes de ajustar. Não editar mídia até terminar sua revisão atual; esses casos não são cobertura validada.

- Axe fechado: revisão da correção C0/I0/M0; 73 testes reexecutados e diff-check. Integrado em8c5d003, sete arquivos exatos. Esse checkpoint não equivale à revisão de todas as regras axe possíveis.
- Formulários: RED2 para aria-labelledby válido ignorado e label de elemento HTML labelable rejeitado. Correção local inclui associação por IDs do mesmo documento e tipos nativos labelable; regressões para referência ausente/ambígua/estrangeira. GREEN21/21 forms+collector, diff-check. Dois arquivos congelados e enviados ao revisor; fonte W3C ARIA16 e HTML Standard labelable. Estado de mídia continua em revisão independente, sem edições concorrentes.

- 12/09 continuação: revisão manual apontou content-in-landmarks ainda ignorando AX no ramo especial. RED1, correção mínima em dois pontos, GREEN20/20 e revisão aprovada C0/I0/M0 no escopo. Integrado em21755af.
- Mídia: norma impressa32–33 conferida. RED1 timing desconhecido indevidamente inaplicável; RED2 ausência de track indevidamente failed (legendas incorporadas/alternativas não excluídas). Novos reasons canônicos unknown-media-timing e captions-not-determined com validação de inventário e textos abaixo do limite200. GREEN52/52 em media/finding-kind/plain-language/collector. Incremento de três arquivos congelado e enviado para revisão independente. Históricos mantidos, sem falsificar conclusão antiga.
- Axe: revisão apontou resumo híbrido/ordem de frames. RED2 confirmado. Normalizador deriva resumo após agregação; validador reconcilia texto com ocorrências e permite representação histórica completa. GREEN73/73 adapter/crosswalk/normalize/validate, diff-check. Congelado para revalidação pelo mesmo revisor.

- Mídia, próximo incremento obrigatório: reprodução local com vídeo visível sem mediaTiming retorna inapplicable para video-captions, video-transcript e live-captions. Ausência desse dado não prova categoria inaplicável. Conferir produtor real de mediaTiming e preservar revisão de aplicabilidade, sem criar falha. Examinar também inferência de ausência de legendas apenas por captionTracks vazio: legendas incorporadas à imagem ou mecanismos externos precisam ser considerados antes de concluir falha normativa. Sem alteração em media.js nesta rodada; não tratar esses pontos como cobertura aprovada.

- Aplicabilidade assistida: RED reproduziu papel AX de heading ignorado; incluídos heading/list/table/landmark observados e DL (listas de definições, explicitamente contempladas em 5.5.1, p.16). Sem promoção de suspeita a falha: somente preserva a tarefa humana com alvo concreto. GREEN 19/19 (manual-review + contrato de coletor), diff-check. Incremento manual-review.js/test agora congelado; revisão independente ainda pendente, após interações.

- Tabelas 5.6.5: corpo da norma p.17 conferido. `hasTableTitle` não é produzido pelo coletor (busca src); valor ausente era confundido com não aplicabilidade. RED 3 falhas: informação ausente, caption nativo, tabela ARIA. Implementação em manual-review.js agora reconhece caption direto não vazio/visível com tabela sem papel substituído; informação ausente vira cantTell com instrução didática. Regressões vazio/oculto/apresentação e observação explícita sem título; GREEN 18/18 com manual-review + contrato de coletor. Ainda sem revisão independente deste incremento. Não é aprovação da correspondência semântica de todos os títulos visuais possíveis.

- Interações: reprodução local de `button-semantics` com `button[role=menuitem]`, axRole=menuitem e nome acessível presente retorna failed/missing-button-semantics. Conferir permissão de substituição de papel e escopo do requisito antes de corrigir; não incluir essa alteração no diff estrutural congelado. Verificar também regras que usam roleOf sem consumir axRole realmente coletado.
