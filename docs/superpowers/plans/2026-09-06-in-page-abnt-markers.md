# Conferência na própria página — referência funcional WAVE

> Execução incremental com TDD nas fronteiras de origem, mensagens e limpeza. A autorização do usuário permite decisões autônomas e trabalho paralelo em arquivos separados. Não reabrir captura, normas, modelo ou retenção aprovados sem regressão reproduzível.

## Resultado esperado

Auditar silenciosamente → ver sumário compacto → **Mostrar sinais na página** → abrir item ABNT/ocorrência ou clicar no sinal correspondente → ler explicação e consultar a evidência → ocultar sinais/refazer.

Os sinais são uma associação de apresentação pós-auditoria, não novas evidências. A página original e a cópia temporária não são o mesmo documento. Não reutilizar backendNodeId ou assinatura com documentId da cópia como identidade da original. A instalação nunca rola, foca ou aciona controles; somente a ação explícita “Ir ao elemento” pode navegar visualmente.

## Recortes congeláveis

### W1 — projeção e proveniência de apresentação

- Projeção pura de ocorrências por alvo e ABNT, reutilizando resultados/decisões canônicos. Um sinal por elemento, com quantidade e ocorrências associadas; questões gerais separadas.
- Guardar apenas a origem privada já provada em prepareAttachedCopyPlan (auditId, tabId, windowId, documentId, digest e expiração), sem URL bruta no painel/modelo/relatório.
- Novo gesto no painel autentica a sessão de resultado e exige nova prova da original; origem inválida/navegada não é reativada como autorização.
- Saída: testes focados de agrupamento, preservação de classificação, URL/sigilos ausentes, expiração e auditoria estrangeira; revisão congelada C0/I0.

### W2 — overlay de múltiplos sinais

- Componente isolado de apresentação, reaproveitando parsing de seletor, regras de geometria e tratamento de lifecycle, sem alterar o destaque de evidência existente.
- Resolver de novo o alvo na original, exigindo correspondência verificável além do seletor posicional. Ausente/ambíguo/divergente vira não localizado; iframe/Shadow DOM não resolvível não recebe caixa inventada.
- Sinais operáveis por teclado, nome claro, cores e formas; agrupamento de ocorrências no mesmo elemento. Clique emite apenas seleção, nunca auditoria/exportação/exclusão.
- Instalação sem scroll/foco, eventos de resize/scroll reposicionam, mutação invalidante/navegação/pagehide/fechamento/expiração removem somente elementos próprios.
- Saída: RED A→B com zero sinais em B; seleção estrangeira/atrasada recusada; página/overlay alheio preservados; limite explícito e lista dos não localizados.

### W3 — integração painel ↔ página

- Resumo, itens ABNT e detalhe com controles compactos; botão Mostrar/Ocultar sinais e estado compreensível.
- Clique no sinal seleciona a ocorrência/abre grupo ABNT existente; seleção no painel realça o sinal sem deslocamento automático. “Ir ao elemento” é ação separada.
- Filtros refletem nos sinais, contagens globais preservadas. Página inteira/verificações gerais não competem com elementos localizados.
- Nova auditoria, exclusão, navegação e perda da sessão removem os sinais; retomada exige nova prova.
- Saída: testes focados de controller/protocolo/reducer e uma revisão de apresentação; duas revisões independentes das fronteiras críticas no mesmo checkpoint integrado.

### W4 — percurso nativo e entrega

- Chrome real com original intocada durante auditoria e marcas visíveis apenas na conferência.
- Vários problemas no mesmo elemento; ABNT correta nos dois sentidos; teclado; filtros; ocultar; navegação A→B; original diferente da cópia; dados/evidências originais inalterados.
- Regressões diretamente afetadas e pacote somente no candidato. Não repetir toda a suíte por ajustes visuais/testes de harness.

## Áreas preservadas

Motor axe/core, mapeamento ABNT/WCAG, captura/consentimento e modelos de evidência; exportação e retenção já aprovadas. A beta 1.1.0 atual fecha A–H anteriores, mas NÃO é apresentada como contendo este novo percurso na original.

## Inventário confirmado

O destaque atual instala apenas um overlay, faz scrollIntoView, não aceita clique e pertence ao documento auditado. A troca attached→navigation-copy invalida corretamente a autorização original. Reuso permitido: autoridade de modelo verificado, autenticação de sessão de resultado, fila por alvo, seletores sanitizados, geometria/lifecycle e seleção/agrupamento ABNT do painel. O restante precisa de contrato próprio de apresentação; não ampliar HighlightBindingV1 para fingir identidade entre documentos.

## Checkpoint W1 — origem privada (implementado)

Cache síncrono privado, sem storage, URL bruta, DOM ou logs. Registro exact7; TTL máximo de 30 minutos, capacidade128, cópias congeladas e duplicatas sem renovar expiração. Reinício do worker perde a associação. Cache não autoriza captura, scripts ou marcação.

O worker registra exclusivamente a origem já provada em prepareAttachedCopyPlan, após validar troca, vault e EvidenceUrl; nenhuma nova espera foi introduzida. Recusa/erro do cache não bloqueia a auditoria. Testes comprovam original17/document-a diferente de cópia27/copy-document, falhas de preparação sem registro e modelo/relatório preservados.

RED: cache11 testes sem factory; wiring8 falhas. GREEN: cache11/11; worker14 focados/regressões pelo implementador, revalidação main11 e revisão independente12 selecionados. Diff-check limpo. Cache revisado A, wiring revisado main e manual_export_deletion_contract: C0/I0 no recorte. Não confundir este checkpoint com instalação de sinais: projeção, resolução, sessão/lifecycle e UI ainda precisam de integração e E2E.

### Contratos preservados para W2/W3

- A projeção W1 contém **candidatos**, não prova de resolução na página original. O contador interno `locatedOccurrences` não pode ser apresentado como localização confirmada antes da resposta do runtime. A integração deve traduzir para candidatos/elegíveis até então.
- A primeira resolução aceita identificador estável e tag corroborados pelo snippet sanitizado. Localizadores posicionais sem correspondência suficiente, contexto inacessível, evidência conflitante e elemento ausente devem ficar em lista explícita de não localizados. Não ignorar essas ocorrências nem reduzir os totais.
- A página original continua sendo documento diferente da cópia. O texto deve dizer “elemento correspondente na página atual” e “resultado registrado na auditoria”; não presumir que a barreira ainda existe se o conteúdo mudou. Conferir também a URL final sanitizada do modelo e a origem atual, pois a cópia pode ter redirecionado.
- Payload destinado à página só contém números, contagens, classes e IDs locais de seleção. Correlação, hash, URL, snippet e IDs de ocorrência permanecem no worker. Seletores necessários à resolução ficam no mundo isolado, nunca em atributos/texto/logs.
- Instalar somente ocorrências selecionáveis no painel (hoje até64), com contagem de omissões e acesso ao relatório completo. Não criar ícone cujo clique não abre o detalhe correspondente. Expansores e filtros ABNT permanecem o eixo; WCAG é referência complementar.
- Ao ligar o controller, acrescentar limpeza dos novos sinais e da origem nos eventos de exclusão, refazer, navegação, expiração e encerramento de sessão. Sem essa integração e prova A→B, W1 não deve ser anunciado como função utilizável nem incluído retroativamente no ZIP1.1.0.

### Checkpoint W1 — projeção privada (implementado)

Modelo verificado + revisão/hash + página → candidatos agrupados por nó/página e sinais independentes por ocorrência/check/item. Classificação individual preserva decisões humanas sem copiar o pior resultado de um card para todos os elementos. Envelope público só usa IDs locais/enums/contagens; correlação/locators ficam privados, sem reter snippet. Resultados gerais e não localizados são separados.

RED inicial8; GREEN10. Revisão A encontrou conflito de framePath abortando toda a projeção de modelo válido; RED reproduzido e correção mínima isolou exclusivamente TypeError/RESULT_CONTEXT_DENIED por ocorrência. GREEN11/11, revisor A validou C0/I0; main cache+projeção22/22. Uma rodada de correção, sem reabrir motor/captura/modelo. W2 é o próximo recorte; ainda não há sinais clicáveis no runtime.

## Task 2 — camada visual de múltiplos sinais (W2)

### Escopo e interface

Criar somente `src/browser/page-markers-overlay.js`, `test/highlight/page-markers-overlay.test.js` e, se necessário para manter legibilidade, `test/highlight/page-markers-fixture.js`. Não alterar W1, painel, worker, captura, modelo, normas ou exportação. TDD e testes focados; nenhum Chrome, npm test, ZIP ou dependência nova nesta etapa. Não despachar subagentes. Sem commit até o coordenador revisar o diff congelado.

Exportar função síncrona autocontida `runAuditaPageMarkersCommand(command, environment = globalThis)`, serializável para `chrome.scripting.executeScript` no mundo isolado. A prova/autorização do documento e o direcionamento por documentIds pertencem a W3; este componente não as concede. Não usar o nonce de consentimento de pixels. `installationId` é um identificador próprio de apresentação, opaco de22 caracteres base64url, mantido apenas na memória isolada e mensagens ao worker.

Comandos fechados:

- Instalar: `{version:1,op:'install',installationId,ttlMs,targets}`. ttlMs inteiro entre1 e1.800.000; targets denso de até64 alvos. Cada alvo: `{markerId,number,match,signals}`; markerId `m`+inteiro positivo, number1..5000, match `{tag,id}` (tag minúscula e identificador CSS ASCII estável permitido pelo contrato W1, sem interpretar código), signals denso não vazio `{selectionId,classification}`. selectionId `s`+inteiro positivo; classification `failed|alert|manual-review|passed`. IDs de marcador/seleção únicos por instalação; máximo64 sinais totais.
- Selecionar: `{version:1,op:'select',installationId,selectionId,scroll}`; scroll booleano obrigatório. Seleção sem scroll não muda foco/rolagem. Somente scroll:true pode fazer scrollIntoView do elemento; não clicar nem focar controles do site.
- Filtrar: `{version:1,op:'filter',installationId,selectionIds}`; lista densa única de IDs conhecidos. Só esconde/mostra sinais; recompõe quantidade/classificação pela parcela visível, preserva dados originais e numeração.
- Limpar: `{version:1,op:'clear',installationId}`; limpar ID estrangeiro nunca remove outra instalação ou overlay.

Respostas sem conteúdo da página: sucesso de instalação `{ok:true,locatedMarkerIds,unlocated}` com unlocated `{markerId,reason}` e motivos `not-found|ambiguous|not-rendered|unsupported-context`. Outros comandos `{ok:true}` ou `{ok:false,reason}` com motivos fechados `invalid-command|installation-mismatch|selection-unavailable|runtime-unavailable`. Alvo ausente/ambíguo/invisível não bloqueia os demais.

### Comportamento

Resolver tag+id de novo no documento atual, exigindo um único elemento, mesma tag/id e `getRootNode() === document`. IDs de layout não viram atributos dos sinais. Duplicatas de alvos resolvidos no mesmo objeto DOM compartilham um sinal e mantêm todos os IDs de seleção. Overlay isolado em shadow root, sem reestilizar elementos do site. A instalação não modifica foco, seleção, rolagem, valores, atributos ou listeners de controles existentes. Regiões sem elemento resolvido não recebem caixa.

Sinal é botão real, operável por teclado, com número, símbolo e quantidade; falha vermelha ×, alerta âmbar !, revisão âmbar ?, positivo verde ✓. Nome acessível fixo e claro, por exemplo “Sinal 1: falha registrada na auditoria, 2 ocorrências. Abrir no painel.” Não depender só de cor. A classe visual é a mais prioritária entre os sinais visíveis: failed > alert > manual-review > passed. Anel/caixa no elemento selecionado; os outros mantêm ícones discretos. Posição acompanha geometria, inclusive durante scroll/resize, e não ocupa espaço no fluxo da página. Não exibir texto/snippet/URL/hash/IDs de ocorrência/documento/digest/instalação no DOM.

Clique no botão emite apenas `{type:'AUDITA_PAGE_MARKER_SELECTED',installationId,selectionId}` (primeiro sinal visível do grupo). Nunca aciona o elemento original; a ocorrência e seus irmãos serão apresentados no painel por W3. Filtrar e selecionar pelo painel não emitem clique de volta. Nenhuma mensagem via window.postMessage ou listener da página principal; usar chrome.runtime do mundo isolado. Não inserir HTML de entrada.

Manter a sessão somente em estado próprio no mundo isolado; comando estrangeiro/atrasado não substitui nem apaga outra sessão. Uma instalação existente deve ser limpa explicitamente antes de instalar outra. Repetição idêntica é idempotente sem renovar TTL; repetição divergente é recusada. Estado estrangeiro no slot não é apagado/substituído. O slot não guarda nada no DOM.

MutationObserver invalida os alvos que desapareceram, mudaram de identidade ou perderam correspondência única; alteração de conteúdo do alvo também invalida, evitando continuar marcando conteúdo substituído. Não observar em loop as próprias alterações do overlay. Escape, pagehide, popstate/hashchange, expiração e troca do documentElement removem somente a raiz/listeners/timers próprios. W3 cuidará da perda de Port, aba fechada e worker reiniciado. Invalidação autônoma da instalação emite apenas `{type:'AUDITA_PAGE_MARKERS_CLEARED',installationId}`; falha de envio não propaga dados nem impede limpeza.

### Provas de saída

### Precisões congeladas após revisão de contrato

- Duplicatas resolvidas no mesmo objeto DOM usam um único botão, número do primeiro alvo e ordem original dos sinais (a ordem do filtro não altera o destino do clique). Filtro vazio é válido; seleção filtrada retorna `selection-unavailable` e não conserva um anel invisível/enganoso.
- `not-rendered` significa desconectado, retângulo zero/não finito, `display:none` ou `visibility:hidden|collapse`; contexto fora da raiz document é `unsupported-context`. Fora da viewport, por si só, não é invisível. Instalações vazias ou sem alvo localizado são válidas e conservam sessão sem ícones.
- Invalidação de qualquer alvo localizado encerra a instalação inteira, notificando uma vez. Sem tombstone: após cleanup, select/clear antigos retornam `installation-mismatch`; um novo install em B exige prova e direcionamento documental de W3.
- Publicar somente no mundo isolado `__auditaPageMarkersOverlayV1`: propriedade própria não enumerável, não gravável e configurável, com estado de identidade própria contendo ao menos `{version:1,installationId,dispose}`. `dispose(true)` é idempotente, não lança e só apaga o slot se descriptor.value ainda for o mesmo objeto. Preserva substituição estrangeira. O binder W3 valida descriptor/installationId e captura essa referência exata para limpar em Port.onDisconnect; W2 não abre Port.
- Validar comandos por descriptors, sem executar getters: extras, accessors, arrays esparsos, IDs duplicados e limites violados retornam `invalid-command` antes de efeitos. Função deve continuar autocontida após serialização. Runtime obrigatório ausente retorna `runtime-unavailable` atomicamente.

REDs comportamentais: vários alvos e dois sinais no mesmo elemento; instalar sem rolar/focar/alterar a página; clique/teclado comunica seleção opaca sem clicar o alvo; filtro altera sinais/quantidade/cor corretamente; select sem scroll versus Ir ao elemento explícito; alvos ausentes/duplicados/invisíveis isolados; mensagem/clear/install estrangeiro sem efeito; idempotência sem renovar TTL; mutação do alvo; pagehide A→B e comando tardio sem sinais na nova página; cleanup preserva raiz/listeners estrangeiros. Usar fixture DOM/eventos pequena em test utility, sem bibliotecas novas; validação nativa da integração ocorrerá em W4, não alegar que fixture prova Chrome.

Após GREEN, congelar arquivos, rodar diff-check, escrever relatório em `.superpowers/sdd/2026-09-06-in-page-abnt-markers/task-2-report.md` com RED/GREEN/comandos/saídas/limites. Revisão independente única sobre o diff congelado, achados agrupados; revalidar correção pelo mesmo revisor. C/I devem estar zero no recorte.

## Task 3 — autorização específica de conferência (W3-auth)

Recorte independente de W2: apenas `src/background/target-capabilities.js` e `test/background/target-capabilities.test.js`. Introduzir `review-markers` exclusivamente em panel result/view-only de novas sessões não-batch. Preservar tabela atual como PRE_MARKERS_INTENTS: sessões antigas continuam legíveis com privilégios originais, inclusive após transições. PRE_PRIVACY/LEGACY permanecem aceitas sem upgrade. Novas sessões batch usam tabela anterior; autorizar nega também explicitamente modo/binding batch. Consumers review e estados running/privacy-paused/revoked nunca recebem o novo intent. Não modificar APIs, bindings, captura, normas, persistência de evidência ou W1/W2.

Revisão prévia confirmou matriz de modos/estados, tabelas antigas e grants adulterados. REDs: painel result e view-only permitem novo intent; running/paused/review/batch negam; tabela antiga transicionada continua legível sem conceder; batch com tabela nova transplantada nega; grants extras são rejeitados. Focus somente target-capabilities e regressões diretamente afetadas; diff-check. Novo intent sozinho não instala sinais: o controller posterior exige cache original, prova fresca e injection por documentIds. Revisão do diff congelado pelo mesmo revisor, sem Chrome/ZIP nesta etapa.

### Checkpoint W3-auth

Commit0106c42: RED3falhas/2passes, GREEN121/121 em target-capabilities, regressões relacionadas panel-port/highlight-session-authority119/119. Revisão independente spec/qualidade PASS C0/I0; duas melhorias menores de cobertura registradas no backlog. Nenhuma migração silenciosa de privilégios, nenhum handler de instalação conectado ainda.

### Checkpoint W2 — camada visual

Implementação autocontida em page-markers-overlay + fixture/test. RED comportamental13falhas com stub neutro; GREEN13/13, confirmado pelo coordenador. Revisão identificou um I: observer na antiga raiz não observa sua substituição pelo Document. RED fiel sem resize13/14; correção mínima para observar Document; GREEN14/14, confirmado pelo coordenador. Mesmo revisor validou correção e regressões, spec/qualidade PASS C0/I0/M0. Uma rodada de correção. Fixture não substitui prova Chrome. Plano nativo preparado em `docs/qa/2026-09-06-page-markers-acceptance.md`. Integração W3 runtime/protocolo/painel e prova W4 continuam pendentes; não acrescentadas retroativamente à beta1.1.0.
