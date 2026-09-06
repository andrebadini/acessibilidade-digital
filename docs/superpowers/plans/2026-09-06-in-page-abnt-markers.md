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
