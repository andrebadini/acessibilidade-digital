# Conferência na própria página — referência funcional WAVE

## Task 11 — compatibilidade da limpeza no resume de pixels

Novo RED nativo reproduzido duas vezes em dfa1929: element-only pausa, confirmação recusada, sem modelo/relatório; diagnóstico no Debugger da fixture confirma PIXEL_CONFIRM_DENIED no router681. Starter resume fornece target com tabId/windowId/documentId/urlSessionDigest à cleanupBarrier; composição Task7 encaminha4campos ao marker controller exact2 e provoca PAGE_MARKERS_INVALID. Revisão prévia independente confirmou causa e correção mínima.

Arquivos autorizados: somente `src/background/service-worker.js`, `test/background/service-worker.test.js`, e `test/background/page-markers-controller-fixture.js` apenas para expor a fila real ao teste de integração (não alterar comportamento). Na composição clearForTargetLocked projetar apenas argumento dos markers para Object.freeze({tabId:own(target,'tabId'),documentId:own(target,'documentId')}) com helper descriptor-safe existente. Highlight mantém objeto original/reason/lock; ambos tentados em try separado, sucesso somente confirmação dupla. Não editar controller, starter, consentimento, queue ou normas. Nenhum novo gate de todos campos do input e nenhuma flexibilização de autorização.

TDD focado: target4 da retomada e target2 inicial com controller/queue REAIS (fixture), sem instalação deve confirmar absent e composição clear; RED target4 antes da correção. Accessor de identidade nunca invocado, lock ausente/alheio/expirado recusado; erro de um cleaner mantém tentativa do outro e falha composta. Reusar regressões existentes para essas últimas provas. Testar service-worker e controller diretamente relacionados, diff-check, relatório SDD task-11-report.md. Sem subagentes/commit/Chrome/suíte ampla/ZIP pelo implementador. Main remove diagnóstico temporário do E2E e repete percurso nativo após GREEN e revisão independente congelada.

## Task 10 — continuidade limitada do resultado visível

Escopo exclusivo: `src/panel/panel-session-port.js`, `src/panel/panel.js`, `src/background/panel-port.js` e seus três testes existentes em `test/panel/panel-session-port.test.js`, `test/panel/panel-runtime.test.js`, `test/background/panel-port.test.js`. Tasks1–9 congeladas salvo estes pontos de extensão. Sem editar worker/controller/overlay/cache/captura/normas/storage. Sem subagentes, commit, Chrome, suíte ampla ou pacote pelo implementador. TDD focado, diff-check; relatório SDD task-10-report.md. O coordenador prepara W4 em arquivo E2E disjunto.

Adicionar ao cliente existente método `setReviewVisible(boolean)`, sem mudar factory. O método fornece somente visibilidade; o cliente exige independently started, bootstrap pronto, Port atual, estado result OU view-only e correlação atual. Enviar packet fechado `{protocol:'audita-panel',version:1,type:'review-heartbeat'}` a cada20segundos, sem requestId/envelope/URL/IDs/autoridade. Não passa pela fila de intents nem cria pendências. Deadline absoluto30min contado do primeiro bootstrap terminal da auditoria, inclusive oculto; preservar entre duplicatas, revisão nova, hide/show e reconnect da mesma auditoria. Nova auditoria pode receber orçamento novo. Estado desse deadline é separado de clearCorrelation. Verificar relógio real imediatamente antes de enviar; não contar apenas callbacks. Não renovar prazo da origem nem sessão. Uma timer no máximo, callback antigo inerte; erro de post segue indisponibilidade existente. Parar timer em hidden/pagehide/stop/disconnect/não terminal/deadline. Nenhuma recuperação artificial de origem após reinício.

Panel.js sincroniza visibilidade `state.screen === 'result' && document.visibilityState !== 'hidden'`, tanto sumário quanto detalhe, após transitions, visibilitychange e atribuição do cliente; pagehide força false e impede reativação. Readiness e estado terminal continuam exclusivamente verificados pelo cliente. Não mudar apresentação, reducer ou persona timer.

Coordinator extended marker-enabled reconhece packet exact3 antes de intentPacket. Factory antiga mantém comportamento de packet não suportado. Exigir recibo atual de resultado e admission; capturar identidade, reprove contexto nativo, chamar authorizePageMarkersSession existente com dados privados do recibo, validar authorizedPageMarkersPublication e revalidar recibo após cada await. Um heartbeat em voo por binding; descartar duplicatas sem fila. Ausente/negado/expirado/erro operacional é no-op, sem resposta, cleanup novo, scripts, persistência, renovação, publicação ou bloqueio de intents. Packet malformado continua comportamento fechado existente. Não usar GET_HIGHLIGHT_STATE (nega view-only).

Matriz prévia independente aprovada: result/view-only; antes bootstrap/não terminal sem mensagens; hidden/pagehide/disconnect e callback atrasado; repetição/revisão/mesma auditoria reconectada preservam deadline; auditoria nova orçamento novo; relógio atrasado além deadline impede envio; packet sem dados privados; legacy e extras/getter negados; recibo inexistente no-op; autorização/native negados sem efeitos; troca de recibo durante await; burst coalescido; intent/publicação concorrentes preservados. Garantia é continuidade limitada do cliente legítimo: receber qualquer mensagem já conta como atividade no Chrome, portanto negação no coordinator não é mecanismo de desligamento remoto nem garantia contra cliente modificado.

Saída: RED observado, GREEN focado, diff-check, uma revisão independente congelada e correções agrupadas. Gate Chrome posterior deve deixar45s antes de Mostrar e45s após Mostrar sem debugger no worker. Não alegar prazo adicional de origem nem recurso entregue antes do percurso nativo e pacote.

## Task 7 — ligação do worker (W3-wiring)

Escopo autorizado: `src/background/service-worker.js`, `test/background/service-worker.test.js`, módulo pequeno `src/background/page-markers-worker-bridge.js` e teste próprio se necessário para separar composição/canais. Tasks1–6 congeladas. Não editar painel, controller, overlay, normas, captura, protocolos ou armazenamento. Sem subagentes pelo implementador, sem commit, Chrome, pacote ou suíte ampla; TDD focado e diff-check. Relatório no workspace SDD `task-7-report.md`.

Construir controller com origem privada, highlightModelAuthority, bundle validado, autoridade nativa, adapter com AUDIT_EXECUTION_INTERNAL, fila compartilhada, IDs próprios de22 caracteres e publicação dedicada do panel coordinator. Falta de API em adapters customizados não pode impedir auditoria existente: somente marcação fica indisponível. Não capturar erro genérico para afirmar disponibilidade.

Interceptar somente os quatro intents de marcação do Port admitido, reconstruindo dispatch exact4 `{envelope,sender,panelWindowId,isCurrent}` sem launchTabId. Ativar os dois callbacks estendidos do panel coordinator: autorização fixa panel/review-markers e fechamento de marcas. Encaminhar publicação privada à conexão admitida, sem dados extras. Runtime genérico continua negando os quatro intents.

Bridge privada encaminha Port `audita-page-markers-v1` e mensagens fechadas W2 selecionado/limpo somente após startup, deixa validação de sender/instalação ao controller, sem eco de payload ou diagnósticos privados. Manter bridge fora de readyRuntime. Dispose impede encaminhamento/publicação, desconecta canais próprios inclusive se startup pendente; não ampliar API do controller.

Compor limpeza marker+highlight preservando API e publicação existentes. Locked usa lock recebido, nunca o readquire. Ambos cleaners são tentados mesmo quando outro falha; exclusão converte bool do marker para confirmação `{ok,state}` somente se ambos confirmaram, falha mantém pending. Lifecycle invalida marker e cache original sem depender do sucesso highlight. Refazer attached-copy limpa instalação/cache antigos pelo tabId ORIGINAL antes da nova troca/registro; falha bloqueia início, não usar auditId novo como alvo de limpeza. Preserve fluxo já aprovado de reserva/journal e compensação.

Matriz prévia independente: (1) quatro intents chegam exact4, original17≠cópia27; (2) runtime genérico/seleção estrangeira negados; (3) publicação review-markers e fechamento por disconnect; (4) canais/startup/dispose ordenados; (5) cleanup ambos tentados, false não confirma exclusão; (6) refazer original antes do registro novo, sem nestedlock; (7) navegação/fechamento limpam ambos mesmo após falha highlight; (8) adapter custom sem Symbol preserva auditoria e readyRuntime privado. Reutilizar testes do controller para invariantes já provadas, testar aqui composição real, não refazer o motor.

Saída: REDs observados, GREEN focado, diff-check, uma revisão independente sobre arquivos congelados; correções agrupadas e validadas pelo mesmo revisor. Não alegar percurso disponível até UI e Chrome real.

Fechamento Task7: implementação e correção de canais revisadas C0/I0/M1. Calibração ao escopo do usuário: dispose manual não é garantia de quiescência de uma publicação já admitida; essa race apenas na rotina de teardown de testes ficou registrada no backlog. A produção não chama o handle manual. Não reabrir Task6 por esse residual sem demonstrar impacto real ou antes de reutilizar a API para encerramento em produção. Demais contratos de documento, autorização, cleanup e evidência permanecem inalterados.

## Task 8 — seleção privada e painel utilizável (W3-UI)

Escopo helper `src/panel/page-markers-session.js`, `test/panel/page-markers-session.test.js`, wiring `src/panel/panel.js`/`test/panel/panel-runtime.test.js`. Apresentação disjunta Task9 abaixo. Não editar protocolos, controller, core ou worker. TDD focado, sem Chrome/ZIP/suíte ampla. API `createPanelPageMarkersSession({requestIntent,onChange,onSelection})` retorna setResult(bundle|null), receive(packet), show(), hide(), select(occurrenceId,scroll=false), filter(visibleOccurrenceIds), reset(), read(). Correlação audit/revision e mapa ordinal de details ficam privados. Snapshot público congelado `{status:'idle'|'showing'|'active'|'hiding'|'unavailable',groups:[{number,occurrenceIds}],counts,selectedOccurrenceId,message}`; counts null ou `{markers,located,unlocated,general,omitted}`. Sem IDs de sessão/documento/instalação, sem ordinal/revisão no snapshot. Caller fornece bundle já validado pelo cliente.

Validar respostas exact e revisão; counts.markers igual grupos físicos, located soma ordinais únicos conhecidos, soma located/unlocated/general igual details oferecidos (até64); clear somente zerado. Não renderizar erros arbitrários. Generation invalida SHOW tardio após hide/reset/clear; versão de seleção preserva clique recente contra resposta antiga. Serializar SELECT/FILTER; efeitos pendentes não migram para outro resultado. Filtro deriva IDs dos cards filtrados do buildPanelView, ordinais sempre ordenados pela lista original details, não ordenar ABNT como se fosse ordinal. Totais globais não mudam.

Incoming clique da página seleciona detalhe e abre ABNT; se oculto, limpar filtros e informar. Usar focusId neutro sem nó e impedir restoreFocus quando document.hasFocus()===false; não pedir highlight availability antigo nesse caminho. Reenviar filtro atual e select(false), nunca scroll automático. Mostrar é gesto explícito; botão separado Ir ao elemento chama select(true). Refazer exige hide confirmado se marcas ativas/em andamento; resultado/revisão/disconnect/exclusão resetam projeção sem recriar origem. Não implementar heartbeat aqui.

REDs: show/validação/agrupamento; seleção nos dois sentidos e scroll explícito; filtros canônicos sem alteração de totais; packet clear durante show; clique posterior à requisição preservado; revisão/audit/reset invalidam retorno tardio; erros fechados; wiring render/actions/foco. Uma revisão independente congelada, correções agrupadas.

## Task 9 — apresentação da conferência (W3-view)

Escopo somente `src/panel/panel-view.js`, `src/panel/panel.css`, `test/panel/panel-view.test.js`. API buildPanelView ganha argumento opcional `markers` (snapshot Task8), default idle. Copiar apenas campos conhecidos, sem mutar entrada. Result view fornece `visibleOccurrenceIds` derivados dos cards já filtrados; sem alterar reducer/classificação/totais. renderResult mostra bloco “Conferir na página” compacto, Mostrar/Ocultar sinais (intents SHOW_PAGE_MARKERS/HIDE_PAGE_MARKERS), status/legenda × falha, ! alerta, ? revisão, ✓ positivo; cor+texto e formas, controles teclado. Estado showing/hiding desabilita botão correspondente e diz preparando/removendo. Contagens reais diferenciadas: elementos sinalizados, ocorrências localizadas, questões gerais, não localizadas, omitidas (consulte relatório). Explicação curta: sinais ligam resultado registrado a elemento correspondente atual, não nova prova.

Cada ocorrência localizada mostra número do sinal correspondente, incluindo vários problemas por sinal; detalhe localizado oferece “Ir ao elemento” (intent GO_TO_PAGE_MARKER + occurrenceId), sem scroll ao apenas selecionar. Sem localização, manter evidências e texto de limite, nunca caixa inventada. ABNT continua agrupamento principal, nenhum ícone/marca WAVE copiado. Nova auditoria desabilitada enquanto showing/hiding. Preservar destaque/evidências existentes. Snapshot active com zero localizados ainda oferece Ocultar e lista limites. Responsivo no painel estreito, foco/contraste/forced-colors, sem ícones dependentes de fontes externas.

TDD focado visual/DOM com fixture existente, intents exatos, agrupamento e filtros preservados; diff-check. Sem worker/helper edits, Chrome, ZIP, dependências, subagentes ou commit pelo implementador. Relatório SDD task-9-report.md, congelar para revisão independente. QA nativa será integrada posteriormente.

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

## Task 4 — controller e canal de conferência (W3-runtime)

### Arquivos e preservação

Criar somente `src/background/page-markers-controller.js`, `src/browser/page-markers-port.js`, `test/background/page-markers-controller.test.js`, `test/highlight/page-markers-port.test.js`; fixture própria adicional em `test/background/page-markers-controller-fixture.js` se necessária. Reutilizar W1 projection/cache, W2 overlay, target-operation-queue, highlight-model-authority e fixtures reais de modelo. Não editar módulos anteriores, service-worker/painel/protocolo, captura, normas, armazenamento ou exportação. Não instalar dependências nem abrir Chrome/rodar npm test/gerar ZIP. TDD, teste focado, diff-check, self-review e congelamento antes de revisão independente; nenhum commit pelo implementador, nenhum subagente.

### API congelável do controller

Exportar `createPageMarkersController({originCache,modelAuthority,loadPanelResultBundle,authority,chromeApi,chromeAdapter,targetQueue,now,createInstallationId,publish,setTimer,clearTimer})`. Capturar referências de dependências na construção. `modelAuthority.loadValidated({auditId})` é a autoridade existente de modelo verificado. `loadPanelResultBundle({auditId})` fornece bundle já validado; exigir revisão/hash iguais ao snapshot. `authority.authorizeSession` existente deve receber exclusivamente consumer panel, intent review-markers e claimedWindowId derivado do Port. O controller nunca usa open-report/highlight como autorização de scripts.

Métodos públicos internos:

- `dispatch({envelope,sender,panelWindowId,isCurrent})`: panelWindowId vem exclusivamente da binding privada do Port; exigir igualdade com envelope.windowId e usá-lo como claimedWindowId. isCurrent é callback privado da conexão admitida, sem dados como argumento. Envelope fechado contém type/auditId/sessionCapabilityId/windowId/modelRevision, com campos adicionais somente conforme tipo: PANEL_SHOW_PAGE_MARKERS e PANEL_HIDE_PAGE_MARKERS sem adicionais; PANEL_SELECT_PAGE_MARKER acrescenta ordinal (inteiro0..63) e scroll booleano; PANEL_FILTER_PAGE_MARKERS acrescenta visibleOrdinals (string canônica de índices0..63 em ordem crescente separados por vírgula, vazia permitida). Sem IDs de ocorrência/seleção arbitrários vindos da página ou do painel. Todos os comandos exigem isCurrent e autorização válida; mutation exige instalação correlacionada à sessão e revisão.
- `attachPort(port)` → boolean síncrono: registra apenas Port de página próprio descrito abaixo; não registra listener global por conta própria. Wiring posterior encaminhará o canal.
- `handleRuntimeMessage(message,sender)` → boolean síncrono: aceita só mensagens W2 selecionado/limpo da instalação atual e sender nativo exato (extension id, tab/window/document/frame0). Não publicar dados do sender.
- `clearAudit(auditId)` → Promise<boolean>; `invalidateTab(tabId)` → Promise<boolean>; `closePanel({windowId,sessionCapabilityId})` → Promise<boolean>; `clearForTargetLocked(target,reason,lock)` → Promise<{ok,state}> com estado clear/absent ou falha. Reutilizar fila existente, não adquirir lock novamente no método Locked. Sinalizar cancelamento imediatamente antes de awaits; finalizações tardias não reinstalam nem publicam. Limpar cache nos eventos audit/tab; fechar painel limpa instalação mas não amplia/recria origem.

Sucesso dispatch: `{ok:true,markers:{state:'active'|'clear',modelRevision,groups,counts,selectedOrdinal}}`; groups é array de `{number,ordinals}` sem ID privado; counts `{markers,located,unlocated,general,omitted}` inteiros; selectedOrdinal número ou null. Clear usa groups vazio/counts zero/selectedOrdinal null. Omissões preservam a distinção em relação a gerais/não localizados. Publicação assíncrona `publish({windowId,sessionCapabilityId,auditId,modelRevision,state,selectedOrdinal})` fica interna ao worker; wiring posterior filtra conexão correspondente e retira sessionCapabilityId antes da mensagem ao cliente. state active/clear, selectedOrdinal null quando limpeza. Falhas somente `{ok:false,code}`: PAGE_MARKERS_INVALID, PAGE_MARKERS_NOT_AUTHORIZED, PAGE_MARKERS_UNAVAILABLE, PAGE_MARKERS_DOCUMENT_CHANGED, PAGE_MARKERS_STALE_RESULT, PAGE_MARKERS_SELECTION_UNAVAILABLE, PAGE_MARKERS_CLEANUP_UNCONFIRMED. Nenhum erro/log com URL/digest/documentId/installationId/conteúdo.

### Algoritmo do percurso

1. Validar/capturar envelope sem getters antes de efeitos, isCurrent e authorizeSession; confirmar correlação retornada audit/session/window, estado result/view-only e modo não batch. Obter origem privada; ausente/expirada resulta unavailable sem injeção. Lock por tab/document via targetQueue e verificar novamente origem/validade após espera.
2. Show carrega snapshot/bundle correlacionados à revisão solicitada; somente modelo single com uma página. Projetar W1. Ordinal é índice na lista ordenada bundle.details (máximo64), sem reordená-la. Excluir sinais sem detalhe; omitted conta as ocorrências fora desse conjunto. Gerais separados, não localizados explícitos; filtro não muda contagens globais da auditoria.
3. Provar origem exata via chromeAdapter.probeDocumentIdentity(tabId); comparar tab/window/document/digest. Obter fonte com o método snapshotAttachedCopySource do descriptor privado chromeAdapter[AUDIT_EXECUTION_INTERNAL] (símbolo exportado por chrome-adapter.js), capturado na construção sem getters, sanitizar rawUrl imediatamente no controller e descartar fonte; igualar à page.finalUrl sanitizada do modelo, rejeitando redirecionamento divergente. Não existe alias textual chromeAdapter.internal. Nenhuma URL vai para overlay/Port/publicação. Revalidar sessão/isCurrent/TTL antes do efeito; TTL da instalação não ultrapassa menor prazo da origem e sessão.
4. Converter candidatos W1 em alvos W2 somente com sinais oferecidos no bundle. Agrupar mesma match tag/id antes da instalação, preservando número do primeiro candidato e todos seus sinais. installationId criado exclusivamente pela dependência privada e validado22base64url, nunca exposto no retorno ao painel. Injeção `chromeApi.scripting.executeScript` com world ISOLATED, target `{tabId,documentIds:[documentId]}`, func W2 importada e args `[command]`. Validar resposta única frame0/documentId exatos, located/unlocated como partição dos targets enviados. Não chamar APIs de pixels/navegação/foco/ativação de abas.
5. Instalar binder abaixo no mesmo documento e aguardar hello nativo (prazo5s). Provar origem novamente antes de retornar/publicar active. Em qualquer falha depois da instalação, limpar apenas instalação própria, sem erro contendo dados privados. A→B não recebe injeção de fallback por tab/frameId.
6. Select/filter usam a tabela privada ordinal→selectionId e comandos W2; reprovam documento antes e após efeitos. Só scroll:true permite rolagem explícita. Sinal da página publica seu ordinal correspondente apenas após validar sender e instalação; clique não faz auditoria/exportação/exclusão. Caso resposta de select indique seleção ausente, informar indisponibilidade sem inventar localização.
7. Limpeza desconecta Port próprio e envia clear W2 exclusivamente ao documento original; confirmação de documento diferente/aba ausente pode provar ausência (não remover nada em B). Falha operacional sem prova de ausência retorna cleanup-unconfirmed, preservando registro para retry. Timers/Port próprios são encerrados no deadline, cleanup W2 e encerramento de painel. Não trocar instalação de outra auditoria implicitamente.

### Binder isolado e idle

Exportar função autocontida síncrona `bindAuditaPageMarkersPort(installationId,environment=globalThis)`. Exige estado W2 próprio `__auditaPageMarkersOverlayV1`, descriptor não enumerável/não gravável/configurável, version1 e installationId igual; capturar referência/dispose exatos sem getters. Estado estrangeiro não é substituído. Usar slot separado `__auditaPageMarkersPortV1` com mesmos atributos e ownership por referência; repetição idêntica é idempotente. Nenhum ID em DOM.

Abrir runtime.connect({name:'audita-page-markers-v1'}), adicionar onDisconnect antes do hello `{type:'AUDITA_PAGE_MARKERS_HELLO',installationId}`. A cada20s, somente enquanto estado W2 exato ainda existir, enviar `{type:'AUDITA_PAGE_MARKERS_PING',installationId}`; isso mantém a conferência explícita ativa sem worker permanente. Limpeza cancela timer, listeners e Port próprios, chama dispose(true) capturado e faz CAS do slot binder. Port disconnect/erro/estado substituído encerram esse binder; nunca limpar estado estrangeiro. Resultado `{ok:true}` ou `{ok:false}` sem diagnóstico arbitrário. W3 wiring ainda precisará continuidade do painel antes de mostrar sinais; não tratar binder como solução desse intervalo.

Controller aceita hello/ping somente dentro de prazo e correlação nativa da instalação pendente/ativa. Desconexão chama cleanup, invalida seleção e publica clear uma única vez. Publish só por conexão ainda atual; callback privado isCurrent precisa ser rechecado após awaits. Sem storage/recovery artificial de origem perdida após restart.

### Rulings da revisão pré-implementação (contrato congelado)

- SHOW mantém lock durante hello. attachPort/hello resolve a espera diretamente, sem entrar na fila. Disconnect/timeout cancela imediatamente e resolve a espera; compensação usa lock já adquirido.
- Capturar geração de audit/tab/painel antes do primeiro await de autorização, inclusive quando ainda não existe instalação. Clear/close invalida essa geração sincronicamente; rechecá-la após awaits impede instalação tardia.
- Sessão pode apontar cópia/disposable; origem sempre vem do cache original. Não exigir igualdade com session.targetBinding.
- `counts.markers` conta marcadores físicos efetivamente localizados; `groups` inclui somente esses marcadores e seus ordinais. `located`, `unlocated`, `general` particionam ocorrências oferecidas; `omitted` conta ocorrências fora dos detalhes oferecidos. Ocorrência oferecida sem candidato nem geral entra em unlocated. Filtro não muda esses totais.
- W2 retorna installation-mismatch tanto para ausência quanto estado estrangeiro. Para confirmar ausência própria, admite-se helper autocontido somente leitura no novo controller, injetado no documentId original, que inspecione descriptor do slot W2 e retorne apenas own/absent/foreign/unknown. Nunca executar getters ou dispose estrangeiro. absent/foreign comprovam ausência própria; falha operacional/unknown exige retry. Documento diferente comprovado também prova ausência, sem injeção em B.
- Eventos existentes W2 são `AUDITA_PAGE_MARKER_SELECTED` (singular), fechado type/installationId/selectionId, e `AUDITA_PAGE_MARKERS_CLEARED` (plural), fechado type/installationId. Não renomear W2.
- Correção verificada antes do congelamento da implementação: o internal local do adapter é publicado sob AUDIT_EXECUTION_INTERNAL, não propriedade string internal. Fixture deve reproduzir esse descriptor nativo; RED antes de corrigir o controller. Não mudar adapter nem criar alias.

### REDs e saída

Tests com cache/projection/model reais e API Chrome fake estrita no limite externo: autorização recusada sem probe/injection; origem ausente/expirada; modelo/revisão/bundle divergentes; origem original distinta de cópia; redirect final incompatível; A→B entre prova/injection e após injection; zero fallback; injeção/hello/sender estrangeiro; seleção bidirecional ordinal correto; agrupamento2sinais e não localizados; filtro vazio/ordinais inválidos/ocorrência fora64; pipeline modelo/hash inalterados; fechar painel/delete/refazer durante await impede publicação; clear não apaga estrangeiro e falha operacional exige retry. Binder testa serialização, native disconnect/erro/TTLslot perdido, heartbeat limitado sem renovar TTL W2, idempotência e CAS estrangeiro. Usar fixture W2 para provar efeito real da limpeza quando possível, sem ampliar framework.

Executar apenas os arquivos criados e regressões W1/W2 diretamente relacionadas; registrar RED/GREEN em `.superpowers/sdd/2026-09-06-in-page-abnt-markers/task-4-report.md`. Congelar para revisão, agrupar achados e revalidar uma rodada; não implementar wiring/UI dentro deste recorte.

## Task 5 — protocolo e cliente do painel (W3-client)

Arquivos autorizados: `src/background/worker-protocol.js`, `src/panel/panel-session-port.js`, `test/background/worker-protocol.test.js`, `test/panel/panel-session-port.test.js`. Implementação pelo agente principal em paralelo com Task4, após congelamento dos quatro tipos e payloads; nenhum arquivo compartilhado.

Adicionar os quatro tipos da Task4 como panel-only, schemas fechados e limite4096 existente. modelRevision positivo inteiro seguro; select ordinal0..63/scroll booleano; filter string canônica crescente sem duplicatas0..63, vazia válida. parsePanelPortIntent atribui windowId conhecido e recusa janela enviada pelo cliente. Generic runtime continua recusando panel-only.

Cliente preenche auditId/sessionCapabilityId exclusivamente do estado privado atual, somente result/view-only e revisão igual à do último bundle. Caller fornece type/modelRevision e apenas os campos específicos; rejeitar autoridade/target extra. Ordinal precisa existir nos detalhes oferecidos (máximo64). Callback opcional `onPageMarkersState` em alternativa exata da factory preserva callers existentes. Packet assíncrono fechado `{version:1,type:'PAGE_MARKERS_STATE_CHANGED',auditId,modelRevision,state,selectedOrdinal}`; estado active/clear, clear exige null, ordinal0..63 ou null. Ignorar packet estruturalmente válido de audit/revisão antigos; o atual exige ordinal existente. Callback recebe apenas `{modelRevision,state,selectedOrdinal}`. Correlação privada de revisão/detalhes é limpa no disconnect, stop, cancel e bootstrap initial/running. Sem IDs de instalação, URL, digest, nonce ou sessão no callback.

SHOW usa timeout60s para verificação do modelo mais hello; demais operações usam5s existente. Não implementar keepalive, wiring global, UI ou captura. TDD focado nos dois arquivos de teste, regressão direta de protocolo/cliente existente, diff-check; congelar para revisão independente antes de checkpoint. Testar enriquecimento privado, extras/getters, revisão obsoleta, limites de ordinais/filtros, callback sem autoridade, eventos de outra auditoria/revisão, mudança de bootstrap e timeout.

Rulings pré-implementação Task5: pacote assíncrono é validado primeiro por estrutura/primitivos; audit/revisão antigos são ignorados antes de aplicar limite atual de detalhes. Entradas pendentes dos quatro intents capturam revisão; resposta após troca de revisão/audit não entrega sucesso antigo. Quando troca de correlação descarta pendência, guardar requestId em tombstones limitados existentes, sem payload, para ignorar uma resposta tardia sem desconectar o Port atual. Atualizar revisão/contagem antes de callbacks de bootstrap.

## Task 6 — conexão admitida e publicação dos sinais (W3-panel-port)

Somente `src/background/panel-port.js` e `test/background/panel-port.test.js`, pelo principal; Task4 continua em novos arquivos disjuntos. Factory antiga permanece exata; alternativa exata acrescenta juntas `authorizePageMarkersSession` e `closePanelMarkers`, capturadas na construção. Somente alternativa estendida expõe método adicional `publishPageMarkersState`.

Quatro novos intents recebem panelWindowId privado e isCurrent interno duradouro, sem depender da pendência inFlight. O callback verifica conexão/admission/correlação e identidade do recibo privado de resultado entregue. Recibo contém audit/session/revisão/quantidade oferecida; atualizado no caminho send de bootstrap terminal validado, não somente em bind. Resultado R→running→resultado R cria identidade nova e nunca reativa callback antigo. Invalidar recibo antes de post de bootstrap alterado; instalar novo somente após post bem-sucedido; bind subsequente da mesma correlação o preserva. Bootstrap repetido idêntico preserva recibo.

Publicação recebe shape Task4 fechado windowId/sessionCapabilityId/auditId/modelRevision/state/selectedOrdinal, escolhe somente binding exata atual, limita ordinal ao bundle entregue. Reprova contexto nativo e chama autorização dedicada, que será ligada ao intent review-markers. Validar correlação de sessão terminal result/view-only, prazo, modo não batch, intent panel/review-markers e contexto/issuer do painel; não exigir targetBinding igual à origem. Rechecar recibo/conexão após awaits. Emitir só packet Task5, removendo windowId/sessionCapabilityId. Retornar delivered0 para evento malformado/obsoleto/estrangeiro, preservando Port alheio. Sequência privada de publicações impede active antigo, atrasado por await, de substituir clear novo; incrementar apenas após admissão de evento atual estruturalmente válido.

Disconnect, troca de audit/session/revisão ou entrada em estado não terminal invalidam recibo sincronicamente e chamam closePanelMarkers com apenas windowId/sessionCapabilityId antes de awaits; Promise de cleanup não adquire lock do painel nem bloqueia retirement. Controller mantém seu retry privado em falha. clearAudit invalida recibos próprios antes do primeiro await de inventário, sem tocar estrangeiros. Não editar wiring global, lifecycle, UI ou código Task4, não adicionar heartbeat.

REDs: dispatch tem janela privada/callback atual após conclusão e falso após disconnect; publicação view-only/cópia funciona sem comparação de target; estrangeiro/revisão/ordinal inválido zero publicação; autorização negada/expirada zero publicação; evento clear posterior vence active com autorização pausada; transição de bootstrap e falha no post invalidam imediatamente e não revivem callbacks; exclusão durante await impede callback tardio; forma antiga continua intacta. TDD focado, regressão direta e diff-check, revisão congelada antes de commit.
