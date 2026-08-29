# Audita Acessibilidade — fluxo visual orientado à fiscalização

- Data: 29 de agosto de 2026
- Estado: direção visual aprovada pelo responsável pelo produto (opção 2)
- Complementa: `2026-08-26-auditoria-acessibilidade-design.md` e `2026-08-27-motor-hibrido-personas-multipaginas-design.md`
- Alvo visual: `assets/2026-08-29-sidepanel-option-2.png`

## 1. Decisão e objetivo

A versão 1.0.1 não é uma base visual aceitável. Ela expõe demasiada estrutura técnica antes de responder às perguntas práticas da pessoa avaliadora. O produto passa a usar um fluxo em três superfícies:

1. popup mínimo para iniciar a auditoria e acionar personas;
2. painel lateral persistente para acompanhar, compreender e navegar pelos resultados;
3. relatório completo em aba própria para revisão, fundamentação e exportação.

A página auditada é uma quarta superfície operacional: nela a extensão destaca, sob comando explícito, o elemento associado à ocorrência selecionada.

O percurso obrigatório é:

> Abrir extensão → Avaliar página → Ver sumário visual → Abrir uma desconformidade → Destacar o elemento → Consultar ABNT/WCAG, anúncio e evidências → Exportar relatório.

O público principal é formado por pessoas responsáveis por avaliações de acessibilidade, inclusive sem formação técnica. O produto continua local, sem conta, login, servidor, telemetria, código remoto ou vínculo governamental. A distribuição desta linha de produto será por pacote local; publicação em loja não faz parte deste desenho.

## 2. Evidência das referências

O desenho combina princípios observados em execuções exploratórias reais, sem copiar identidade ou layout. As execuções ocorreram em 29 de agosto de 2026, no Chrome 151.0.7922.174, sobre `https://example.com/`, com as configurações públicas padrão de cada serviço. As métricas não são diretamente comparáveis nem constituem requisito do Audita:

- **AMAWeb:** entrada simples, ação única, progressão compreensível e boa hierarquia no PDF. Em `https://example.com/`, a execução observada produziu nota 9,5, cinco verificações manuais e seis aceitas.
- **AccessMonitor:** sumário, separação entre aceitável/manual/inaceitável, detalhe por ocorrência e navegação para o elemento. Para a mesma página, a execução observada produziu 9,1, três resultados manuais, sete aceitáveis e um inaceitável.
- **Acessibilidade Auditoria:** axe-core, personas, filtros e CSV são referências funcionais; a apresentação tabular densa não é referência visual. O relatório público exigiu cadastro, comportamento que não será reproduzido.

Capturas aceitas desta pesquisa:

- `assets/2026-08-29-reference-amaweb-summary.jpg`;
- `assets/2026-08-29-reference-accessmonitor-summary.jpg`;
- `assets/2026-08-29-reference-accessmonitor-occurrence.jpg`;
- `assets/2026-08-29-reference-acessibilidade-auditoria.jpg`.

A divergência dos dois primeiros resultados para a mesma página prova que uma pontuação não pode ser apresentada como certificação. O Audita Acessibilidade exibirá cobertura de execução e resultados em medidas separadas.

O PDF de sete páginas gerado pelo AMAWeb confirmou a utilidade da sequência “conclusão → explicação → elementos → evidência técnica”. O relatório do Audita preservará essa leitura em camadas e acrescentará ABNT, base legal qualificada, nome acessível, prévia de anúncio, capturas, mapa anotado e integridade.

Fontes públicas consultadas:

- `https://amaweb.unifesp.br/avaliador/`;
- `https://accessmonitor.acessibilidade.gov.pt/`;
- `https://github.com/amagovpt/accessmonitor-ce/blob/main/user_guide.md`;
- `https://chromewebstore.google.com/detail/acessibilidade-auditoria/adddfplfbobbfpfgnejjnhajmlgdifpp`;
- `https://developer.chrome.com/docs/extensions/reference/api/sidePanel`;
- `https://www2.camara.leg.br/legin/fed/lei/1990/lei-8078-11-setembro-1990-365086-normaatualizada-pl.html`;
- `https://www2.camara.leg.br/legin/fed/decret/1997/decreto-2181-20-marco-1997-445015-normaatualizada-pe.html`.

## 3. Princípios de experiência

1. **Decisão antes de detalhe.** Sumário e prioridade aparecem antes de código, seletor, proveniência e hashes.
2. **Uma ação principal por estado.** O início oferece “Avaliar esta página”; o resultado oferece a ação contextual segura: “Ver e destacar na página” quando houver binding vivo ou “Consultar evidências” nos demais casos.
3. **Cobertura não é conformidade.** A interface nunca converte execução automática em nota de qualidade, certificação ou conclusão jurídica.
4. **Texto e símbolo acompanham cor.** Vermelho, âmbar e verde nunca são os únicos meios de comunicar estado.
5. **Divulgação progressiva.** Dados técnicos ficam em `details/summary`; impressão e PDF preservam todo o conteúdo.
6. **Rastreabilidade sem jargão inicial.** Toda conclusão continua ligada ao modelo canônico e às evidências, mas a ficha começa em linguagem simples.
7. **Identidade neutra.** Azul-marinho, azul, branco, cinzas e cores semânticas contidas; sem logomarcas ou referências estatais.

## 4. Arquitetura de superfícies

### 4.1 Popup mínimo

O popup é o lançador, não o local de análise. Ele contém:

- domínio e título da aba ativa;
- botão principal **“Avaliar esta página”**;
- ação secundária **“Outra URL ou lote”**, que abre o painel lateral no formulário apropriado;
- três controles compactos: Leitura simulada, Acromatopsia e Somente teclado;
- nota curta: **“Processamento local; nenhum dado é enviado.”**;
- link para privacidade e limites, sem mural técnico obrigatório.

O popup não mostra relatório, matriz normativa, retenção detalhada, código ou lista de ocorrências. Os controles têm alvo mínimo de 44 × 44 CSS px, foco visível e nome acessível.

`action.default_popup` é o único lançador do ícone da extensão; ao declará-lo, o listener histórico `chrome.action.onClicked` deixa de fazer parte do contrato. Ao carregar, o popup consulta a aba ativa e pede ao worker capacidades opacas, curtas e de uso delimitado: uma para `start-audit` e outra para `start-persona`. O worker só as emite depois de validar uma aba HTTP/HTTPS ativa e provar a identidade do documento por uma sondagem local que retorna `documentId` sem ler conteúdo. Cada capacidade autoriza somente a intenção declarada.

O popup prepara `windowId` e as capacidades antes de habilitar os botões e as renova preventivamente, após nova prova do documento, enquanto o popup estiver aberto. No handler síncrono do clique de auditoria, chama imediatamente `chrome.sidePanel.open({windowId})`; somente depois envia a intenção tipada e a capacidade `start-audit` já preparada ao worker. Nenhuma consulta assíncrona antecede `sidePanel.open()` na cadeia do gesto. Se a abertura falhar, nenhuma auditoria é iniciada e o popup mostra erro leigo. Capacidade expirada não é substituída silenciosamente durante o claim: a ação não começa até o popup obter nova prova. A API requer `sidePanel` e Chrome 116 ou superior.

“Avaliar esta página” e os controles de persona enviam somente a capacidade opaca; URL, `tabId`, `windowId` e `documentId` fornecidos pela interface nunca autorizam o alvo. “Outra URL ou lote” abre o estado inicial do painel sem iniciar coleta.

O menu de contexto permanece como atalho para página ou link HTTP/HTTPS e abre o mesmo painel no próprio `onClicked`, antes de operações assíncronas. Depois o worker prepara a capacidade ou valida a URL do link e enfileira a intenção; falha de preparo deixa o painel aberto com explicação, sem auditoria parcial. Ele não será a única forma de iniciar funções.

O primeiro controle de persona reclama a capacidade `start-persona` e cria um `PersonaLeaseV1` do mesmo `tabId` + `documentId`. Alternar ou desativar Leitura simulada, Acromatopsia e Somente teclado usa somente esse lease, com transições fechadas, sem reutilizar a capacidade inicial. O lease não depende de o popup permanecer aberto nem de uma aba artificial do painel; ao reabrir, um contexto autorizado pode reidratá-lo depois de validar novamente o documento. Ele termina no menor valor entre fim da sessão, fim do documento e 30 minutos desde a última ação explícita de persona; cada extensão de prazo exige nova interação em controle de persona. Navegação, fechamento, expiração ou início de auditoria revogam o lease e limpam a simulação. Auditoria e persona disputando o mesmo alvo são serializadas: iniciar auditoria primeiro encerra e confirma a limpeza da persona e só então reclama uma capacidade `start-audit` ainda válida.

### 4.2 Painel lateral persistente

O painel é a superfície operacional. Há quatro estados de tela: **inicial**, **em execução**, **resultado** e **erro/indisponível**. Resultado cobre auditorias completas, parciais, canceladas com modelo válido e conjuntos sem ocorrências. O detalhe é uma expansão/rota dentro de Resultado e preserva filtros, posição de rolagem e foco; não é um quinto estado exclusivo.

O popup abre o painel para a janela corrente, de modo que ele permaneça visível durante a troca entre a página e o relatório. O documento do painel nunca presume possuir `sender.tab`. Cada mensagem e porta tem remetente, URL/caminho de extensão, campos, tamanho e transições permitidos por uma lista fechada; o worker valida `port.sender` antes de anexar a porta.

Uma capacidade interna `AuditTargetCapabilityV1` vincula o gesto a um alvo:

```text
{
  capabilityId, kind: 'attached' | 'disposable', tabId, windowId,
  documentId, initialUrlEvidence, initialUrlSessionDigest,
  createdBy: 'user' | 'audit', allowedIntent: 'start-audit' | 'start-persona',
  issuer: { type: 'extension-document', documentId, path }
        | { type: 'worker-event', event: 'context-menu', eventNonce },
  issuedAt, expiresAt, state: 'prepared' | 'claimed' | 'invalidated'
}
```

O objeto real fica em `chrome.storage.session`; a UI recebe apenas `capabilityId`. Cada ID contém pelo menos 128 bits aleatórios gerados por CSPRNG e nunca aparece em log, diagnóstico, nome de arquivo ou exportação. Na inicialização, o worker aplica `chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`. A capacidade é de uso único, expira 60 segundos após emissão e é invalidada em navegação, troca de documento, remoção de aba, mudança de janela incompatível ou consumo. O claim é atômico e, na mesma transação, valida `port.sender`/`MessageSender`, o emissor discriminado, caminho interno exato quando aplicável, janela, intenção permitida, documento, estado e prazo. Um ID apresentado por outra página interna ou por intenção diferente falha fechado. Eventos confiáveis do próprio worker, como menu de contexto, usam `worker-event` em vez de fingir um documento emissor e continuam sujeitos à mesma intenção, alvo, prazo e atomicidade. Abas `attached` nunca são navegadas, fechadas ou reutilizadas pela extensão; abas `disposable` só podem ser controladas pela sessão que as criou.

Ao reclamar uma capacidade para auditoria, o worker cria `AuditSessionCapabilityV1`, também com pelo menos 128 bits aleatórios, vinculada a `auditId`, janela, modo, consumidores internos autorizados, intenções permitidas e estado `running|privacy-paused|result|view-only|revoked`. `cancel` existe em `running` e `privacy-paused`; `confirm-pixels` existe somente em `privacy-paused`; `highlight` apenas em `result` com binding vivo; `open-report` em `result` ou `view-only`; nenhuma ação existe em `revoked`. O painel recebe apenas o ID e pode reidratá-lo somente quando o worker correlacionar o remetente atual, seu caminho interno, a janela e a auditoria. Ao abrir o relatório, o worker cria a aba e registra internamente seu `tabId`; a primeira conexão autoriza o `documentId` observado, sem bearer em URL. Após reinício do navegador, uma auditoria persistida pode receber nova capacidade **view-only** depois da validação do modelo; ela não ressuscita execução nem binding de destaque perdido.

#### Estado inicial

- página ativa preenchida e ação principal;
- alternativa para URL HTTP/HTTPS;
- lote explícito de até 20 URLs, uma por linha;
- escolha “não reter após exportar” com explicação curta;
- erros de entrada próximos ao campo, sem códigos técnicos.

Não haverá upload de HTML ou arquivo neste marco. Evidência auditável exige URL/estado renderizado, instante, viewport, seletor e capturas; uma futura importação offline deverá ser rotulada como análise sem proveniência de navegação.

#### Estado em execução

As fases são apresentadas em linguagem simples:

1. Abrindo e estabilizando a página;
2. Lendo estrutura e acessibilidade;
3. Verificando regras automáticas;
4. Coletando evidências;
5. Preparando o resultado.

O painel mostra página atual, progresso do lote, tempo decorrido, ação de cancelar e mensagens leigas. Códigos e detalhes sanitizados permanecem em uma expansão opcional. Reabrir o painel reidrata o último checkpoint persistido. Se o worker foi suspenso antes de um ponto recuperável, o painel mostra **“Auditoria interrompida; ela não foi retomada automaticamente”** e oferece reinício explícito, sem inventar continuidade.

#### Estado de resultado: sumário

O sumário segue o alvo visual selecionado:

- URL final, instante e estado da auditoria;
- **Cobertura da execução automática** com percentagem e explicação permanente;
- quatro resultados separados: Falhas confirmadas, Alertas, Revisão humana e Verificações aprovadas;
- filtros grandes por impacto, nível WCAG e item ABNT;
- lista agrupada e priorizada, não uma tabela técnica;
- ação **“Abrir relatório completo”**.

O `PanelSummaryV1` é uma projeção pura e versionada. `expectedCoreRuleIds` é resolvido de `CoreRuleInventoryV1`, registro local imutável e versionado por `rulesVersion`, com `{inventoryVersion, rulesVersion, ruleIds, sha256}`. O checkpoint de execução persiste `rulesVersion`, `inventoryVersion` e `inventoryHash` junto ao início da página; ao finalizar, essa base passa ao registro de progresso final e permanece correlacionada à auditoria durante a mesma retenção. O `AuditModel V2` não ganha a lista nem é alterado por essa projeção. Quando a versão registrada não estiver instalada ou o hash não conferir, o painel mostra **“Cobertura indisponível — inventário de regras não verificável”** e nunca infere a lista de resultados parciais.

Para cada página com `attempted=true` e início persistido, a projeção cria exatamente um par `(pageId, ruleId)` para cada regra do inventário verificado. Página de lote que nunca iniciou fica fora do denominador e aparece em **Não iniciadas**. Página iniciada que falha antes do snapshot mantém seus pares no denominador, sem numerador.

**Definição da cobertura agregada:**

```text
pares (pageId, ruleId) concluídos como passed, failed ou inapplicable
------------------------------------------------------------------------ × 100
todos os pares esperados das páginas cuja execução foi iniciada
```

`cantTell`, `untested` e regra não executada não entram no numerador. O lote soma numeradores e denominadores, sem média de percentagens e sem ponderar pelo número de elementos. O valor usa uma casa decimal, arredondamento half-up; denominador zero produz **“Cobertura indisponível — execução automática não iniciada”**, nunca 0% ou 100%. A percentagem mede completude da execução automática, não qualidade. O texto visível será:

> Percentual da execução automática concluída. Não é nota, certificação ou declaração de conformidade.

O painel não exibe um único “placar de acessibilidade”. Falhas e aprovações continuam visíveis independentemente da cobertura.

As quatro contagens usam a unidade **checkKey = (pageId, engine, ruleId)** e exibem, em texto secundário, o número de ocorrências/alvos sem misturar as unidades:

- **Falhas confirmadas:** checkKeys de requisito/recomendação com estado consolidado `failed`;
- **Alertas:** checkKeys de boa prática/editorial com achado observável, sem conclusão normativa;
- **Revisão humana:** checkKeys de requisito/recomendação com `cantTell` e sem decisão válida;
- **Verificações aprovadas:** pares core com `passed`.

`inapplicable`, `untested`, diagnósticos e páginas não iniciadas aparecem separadamente em Limitações. Uma decisão humana não reescreve o resultado original: o `displayOutcome` consolidado alimenta o cartão, enquanto motor, decisão, autor, instante e justificativa permanecem visíveis. Aprovação de regra não equivale à aprovação integral do item ABNT ou da página.

#### Subestado de detalhe

Uma ocorrência expandida mostra, nesta ordem:

1. título em linguagem simples, classificação e impacto;
2. **Quem é afetado** e por quê;
3. **O que foi observado**;
4. **Como corrigir**;
5. elemento ou elementos afetados e navegação anterior/próxima;
6. nome acessível, origem do nome e prévia estimada de anúncio;
7. WCAG 2.2, nível, item ABNT e classificação requisito/recomendação;
8. fundamentação consumerista fixa e qualificação jurídica, somente quando elegível;
9. captura do elemento e miniatura da página; em imagem ou vídeo, a mídia/miniatura disponível e sua origem sanitizada;
10. `details` de evidências técnicas: seletor, frame, trecho sanitizado, estilos relevantes, motor, regra, versão e hashes.

A referência consumerista só aparece para estado consolidado `failed`, item ABNT oficial, mapeamento normativo congelado e `basisRef` validada pelo catálogo local. Revisão humana exige autor/identificador local, instante e justificativa. Todos os formatos chamam esse bloco de **“referência técnica e jurídica qualificada”** e preservam a ressalva de que não constitui conclusão de infração, responsabilidade, sanção ou certificação.

Quando elegível, o texto-base é fixo e varia somente o item oficial da ABNT: **“A referida desconformidade infringe o disposto nos arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c o art. 12, IX, “a”, do Decreto nº 2.181/1997, e no item {itemABNT} da ABNT NBR 17225:2025.”** Os dispositivos da lei e do decreto nunca são escolhidos dinamicamente; o catálogo local apenas substitui `{itemABNT}` depois das validações de elegibilidade acima.

A ação **“Ver e destacar na página”** aparece somente quando a resolução segura informa um alvo disponível. Ocorrências de página/processo, alvos sem seletor, binding expirado ou frame inacessível usam **“Consultar evidências”** e mostram a razão objetiva: **“Esta verificação não possui um elemento único destacável no estado atual.”** Revisões manuais exibem também a pergunta objetiva e os controles de decisão humana, preservando separadamente resultado do motor, decisão e estado consolidado.

### 4.3 Relatório em aba própria

Concluir a auditoria transforma automaticamente o painel em sumário. O relatório não abre inesperadamente. **“Abrir relatório completo”** cria ou focaliza uma aba da extensão correlacionada ao `auditId`.

A hierarquia do relatório será:

1. identidade neutra, escopo e estado;
2. sumário executivo e limitações críticas;
3. cobertura da execução e quatro grupos de resultado;
4. não conformidades priorizadas;
5. revisões humanas pendentes;
6. mapa visual das prévias de anúncio;
7. matriz completa dos 146 itens;
8. metodologia, fontes, integridade e anexos.

Filtros internos abrangem impacto, nível WCAG, resultado, classificação, página, motor e item ABNT. Correspondência técnica qualificada com Section 508 permanece separada da base brasileira. A aba viva de revisão é uma aplicação local com JavaScript; o **HTML exportado** contém o conteúdo integral e permanece legível sem JavaScript. Filtros alteram somente a visualização viva e nunca removem conteúdo do HTML/PDF exportado.

Exportações permanecem HTML, PDF, CSV e JSON técnico/EARL. Todos são gerados da mesma revisão do modelo final validado. A aba viva pode oferecer destaque; o HTML exportado não simula essa ação e remete às capturas históricas. Uma falha em qualquer artefato torna a entrega parcial e gera limitação explícita.

Cada tentativa define primeiro uma identidade não circular `ExportDeliveryIdentityV1 = {auditId, modelRevision, modelHash, attemptId}`. HTML, PDF, CSV e JSON técnico incorporam apenas essa identidade; nenhum deles contém hash ou conteúdo do recibo. Depois de congelar os quatro bytes, o controlador calcula seus SHA-256 antes de chamar `chrome.downloads.download()` e cria um `ExportReceiptV1` destacado, persistido localmente, com a identidade, hash/MIME/tamanho de cada byte gerado, `downloadId` e estado observado pelo Chrome (`complete|interrupted|unknown`). O recibo não alega reler o arquivo no destino escolhido e seu próprio hash não participa do hash dos artefatos.

O recibo termina como `complete` somente quando os quatro bytes foram gerados, seus hashes pré-download registrados e o Chrome observou quatro downloads concluídos para a mesma identidade. “Não reter após exportar” só exclui dados locais depois desse recibo terminal persistido; falha, cancelamento ou estado desconhecido mantém a auditoria e mostra a pendência.

## 5. Destaque automatizado na página

### 5.1 Comando confiável

Popup, painel e relatório nunca enviam seletor, URL, `tabId`, `frameId` ou `documentId` arbitrários ao conteúdo. A ação viva envia somente `sessionCapabilityId`, `auditId` e `occurrenceId`. O service worker:

1. valida o remetente e a correlação;
2. carrega o modelo canônico persistido;
3. carrega o binding transitório da página, quando existente;
4. resolve ocorrência, evidência, locator e identidade do frame;
5. confirma documento, identidade CDP e assinatura estrutural não sensível do nó;
6. injeta o realçador local somente no documento autorizado;
7. envia uma mensagem mínima, tipada, limitada e correlacionada.

O modelo normativo V2 não recebe IDs efêmeros do Chrome. Um `HighlightBindingV1`, mantido separadamente em `chrome.storage.session`, liga a sessão viva à evidência:

```text
{
  auditId, pageId, tabId, windowId, topDocumentId,
  topUrlEvidence, topUrlSessionDigest,
  createdAt, expiresAt, locatorVersion,
  targets: {
    [occurrenceId]: {
      documentId, frameId, backendNodeId, evidenceId,
      selector: { syntax: 'CSSSelectorV1', value, byteLength, complexity },
      structuralSignature: { version: 'StructuralSignatureV1', sha256 },
      rectBucket
    }
  }
}
```

O binding é criado durante a coleta somente para alvos que possam ser resolvidos com segurança. `backendNodeId` do CDP, `documentId`, `frameId`, seletor único e assinatura estrutural são obrigatórios; se qualquer discriminador não puder ser obtido ou verificado, não há binding vivo para a ocorrência. O seletor usa uma gramática fechada: um único caminho com no máximo 16 segmentos e 2.048 bytes, composto apenas por tag, `#id`/`.classe` aprovados pelo classificador não sensível, valores enumerados de `role`/`type`, `:nth-of-type(n)` e combinador filho `>`. Vírgula, curinga, pseudo-elemento, `:has()`, texto, URL, atributo arbitrário e selector list são proibidos. O parser calcula custo determinístico — tag/id/classe = 1, `role`/`type` = 2, `:nth-of-type` = 3 e combinador = 1 — e rejeita custo total maior que 64 antes de consultar o DOM.

`StructuralSignatureV1` é o SHA-256 de uma serialização canônica versionada de `documentId`, `frameId`, tag, papel computado ou sentinela ausente, e até 16 ancestrais com tag e ordinal `nth-of-type`; atributos estritamente permitidos entram apenas por nome + hash de valor classificado como não sensível. Os valores brutos e o nome acessível não são guardados no binding. A assinatura exige ao menos tag e caminho ancestral completo até o escopo de injeção; ausência desse mínimo impede criação. `rectBucket` é opcional, serve apenas para diagnóstico/desempate quando o viewport não mudou e nunca autoriza o alvo.

`expiresAt` é o menor entre o fim da sessão do navegador e `createdAt + 30 minutos`, sem renovação automática. Cada pedido revalida capability da sessão, `tabId`, `windowId`, `documentId`, digest da URL corrente, `backendNodeId`, seletor único e assinatura estrutural. Navegação, remoção, expiração ou reinício sem o binding de sessão revogam-no; a UI passa para **“Consultar evidências”** e registra a limitação. Página por URL ou lote só pode criar novo auxílio para o estado atual após gesto explícito, sem o apresentar como evidência histórica.

O worker usa `documentIds`/`frameIds` derivados da própria sondagem do Chrome, nunca o `framePath` textual como identificador de injeção. Para destacar, anexa ou reutiliza uma sessão CDP autorizada, resolve `backendNodeId` e prova que o seletor único aponta o mesmo nó no mesmo documento; em seguida, recalcula a assinatura e exige igualdade exata. Se o nó não puder ser provado depois de desconexão/suspensão, o destaque fica indisponível. Reload na mesma URL, SPA que substituiu o alvo, múltiplas correspondências, Shadow DOM fechado ou frame inacessível falham fechados. Não existe fallback por “elemento semelhante”.

O realçador usa mundo isolado, é idempotente e mantém apenas um alvo ativo por aba. O alvo recebe `scrollIntoView({block:'center', inline:'nearest'})`. Foco programático só ocorre quando não ativa controle nem altera dados.

### 5.2 Tratamentos visuais

- **Falha confirmada:** caixa de 6 CSS px, linha sólida vermelha-escura, marcador numerado e símbolo “×”; rótulo textual “Falha confirmada”.
- **Revisão humana:** caixa de 5 CSS px, linha tracejada âmbar, marcador numerado e símbolo “?”; rótulo textual “Revisão humana necessária”.
- **Decisão humana de não conformidade:** passa ao tratamento de falha confirmada sem apagar o resultado original.

O realçador é versionado por `documentId` e nonce. Ele cria um único root da extensão, `pointer-events:none`, `aria-hidden` e não focalizável; não altera atributo, classe ou estilo do elemento autoral. O único listener global é `Escape`, registrado com referência removível. `dispose()` remove root, listeners, observadores e estado.

O destaque é removido ao selecionar outra ocorrência, acionar “Limpar destaque”, pressionar `Escape`, receber nonce/documento divergente, navegar, executar `pagehide`, recarregar ou perder a aba/frame. O worker limpa em `tabs.onUpdated` e `tabs.onRemoved`; o script trata `pagehide`, BFCache e mutações SPA que invalidem o alvo. O `MutationObserver` só pode invalidar o binding e chamar `dispose()`; ele nunca relocaliza o alvo, atualiza `backendNodeId`/assinatura ou aceita outro nó. A limpeza posterior é best-effort; a garantia normativa é que captura pristine e motor sempre executam antes de qualquer destaque/persona.

Se o DOM mudou, o seletor ficou ambíguo, a identidade/assinatura divergiu, o frame é inacessível ou o alvo está em Shadow DOM fechado, o sistema informa **“O elemento não pôde ser localizado no estado atual da página”**. Não há sucesso silencioso nem troca por um elemento apenas semelhante.

### 5.3 Relação com evidências

O destaque ao vivo é auxílio de navegação e não modifica a evidência auditada. A cadeia de custódia continua baseada nas capturas e metadados coletados no instante da auditoria.

As capturas derivadas já usam tratamento automatizado distinto:

- falha confirmada: contorno sólido vermelho de 7 px, “×” e legenda textual;
- revisão manual: contorno tracejado âmbar/marrom, “?” e legenda textual.

A captura integral original permanece sem marcações e com hash próprio. A captura anotada e o mapa de prévias são artefatos derivados, com hashes separados e referência à origem.

## 6. Modos de auditoria e vida da aba

### Página aberta

`POPUP_START_AUDIT` e `PANEL_START_ATTACHED_AUDIT` aceitam somente uma `AuditTargetCapabilityV1` válida. O worker revalida aba, janela, URL HTTP/HTTPS e `documentId`, reclama a capacidade atomicamente e chama o runner com um target `attached`. Esse runner nunca usa `tabs.update()` ou `tabs.remove()` na aba anexada, inclusive em cancelamento, falha de CDP, timeout ou suspensão. Debugger já anexado por outra ferramenta produz erro controlado antes de efeitos.

A auditoria observa a aba sem navegar ou fechá-la. Isso preserva o estado visível e permite destaque confiável após o resultado. A coleta não aciona controles nem envia formulários. Aba fechada ou documento alterado entre preparo e claim invalida a capacidade e não inicia auditoria.

Antes da captura original, a extensão remove e confirma a limpeza de qualquer destaque ou persona ativa no alvo. A simulação não é restaurada automaticamente depois da auditoria, evitando que uma alteração visual seja confundida com o estado observado.

### URL informada

`PANEL_START_URL_AUDIT` aceita somente URL normalizada pelo worker. O runner cria uma aba visível `disposable`, registra a propriedade antes de navegar e pode atualizá-la. Em sucesso ou resultado parcial com documento observado, transfere a aba para estado `retained-for-review` e não a fecha sem ação explícita. Em falha anterior à observação, cancela e remove apenas a aba que ele comprovadamente criou. O painel acompanha o binding do documento observado para destaque.

### Lote

`PANEL_START_BATCH_AUDIT` usa abas `disposable` sequenciais e as fecha depois de confirmar cleanup. Para uma ocorrência sem binding vivo, a ação muda para **“Informar URL e tentar localizar no estado atual”** e exige gesto explícito mais uma URL nova fornecida pela pessoa. `EvidenceUrlV1` nunca é reutilizada como URL de navegação: ela pode estar redigida e a URL bruta original já deve ter sido apagada. O worker normaliza a nova URL, guarda-a no raw vault apenas até o consumo e abre uma aba própria marcada `current-state-assist`. Nessa aba, tenta provar uma correspondência única usando somente o seletor conservador da ocorrência histórica, cria identidade CDP + assinatura novas para o estado corrente e aplica um overlay transitório; esse proof não entra no modelo, não substitui evidência e nunca é apresentado como o documento histórico. A interface mantém visível: **“Estado atual da página; a captura do relatório é a evidência da auditoria.”** Falha, ambiguidade ou seletor histórico inseguro encerra o auxílio sem produzir destaque.

Páginas protegidas (`chrome://`, loja, PDF nativo, DRM), frames inacessíveis e estados autenticados não reproduzíveis geram limitação, nunca aprovação.

### Capacidades transversais preservadas

A troca das superfícies não reduz o núcleo funcional aprovado. Permanecem obrigatórios:

- motor próprio e axe-core 4.13.0 local, com proveniência e deduplicação;
- Leitura simulada com fala/legenda, Acromatopsia e Somente teclado, reversíveis e sem resultado normativo automático;
- menu de contexto como atalho;
- lista explícita de até 20 URLs, sem crawler;
- links genéricos, nova aba sem aviso, texto justificado e conteúdo provisório;
- inventário local de VLibras/Hand Talk sem transformar presença ou ausência em conformidade;
- mapeamentos ABNT/WCAG, correspondência Section 508 e base consumerista fixa qualificada;
- retenção limitada, exclusão, exportação local e ausência de login/telemetria.

## 7. Modelo de apresentação

O modelo V2 validado permanece a autoridade. A reformulação adiciona uma projeção pura e determinística, `buildReportView({model,summary,modelRevision,modelHash})`, sem persistir fatos novos:

```text
AuditModel V2 validado
        │
        ├── buildPanelSummary({model,executionCheckpoint,inventory})
        ├── buildReportView({model,summary,modelRevision,modelHash})
        └── resolveHighlightTarget(model, HighlightBindingV1, occurrenceId)
```

`buildPanelSummary` materializa os pares e checkKeys definidos na seção 4.2, com versão, arredondamento, contagens de alvos e estados indisponíveis explícitos. A classificação visual é a união fechada `failed|alert|manual-review|passed`; o contexto comprovável é `page-or-process|top-document|same-origin-frame|open-shadow-root|mixed`. Conteúdo cross-origin, sandbox ou Shadow DOM fechado que não tenha sido observado aparece como limitação explícita, nunca como ocorrência inventada.

Cartões e detalhe expõem somente essas projeções seguras em `data-classification` e `data-context`. Os filtros do painel têm seletores estáveis separados para `data-filter-dimension="impact"`, `"wcag"` e `"abnt"`, e valores provenientes apenas das distribuições validadas; seletor técnico, URL, IDs Chrome e autoridades opacas nunca entram nesses atributos.

`buildReportView` produz:

- `executive`: cobertura, contagens, páginas e limitações;
- `issues`: ordem, estado original, decisão, estado consolidado, texto leigo, correção, normas e tratamento visual;
- `technicalEvidence`: evidências, seletor, snippet, propriedades e proveniência;
- `readerMaps`: cobertura, segmentos, legendas, hashes e limitações;
- `methodology`: fontes, escopo, integridade e ressalvas;
- `exports`: disponibilidade, hash, MIME e limitações.

Renderizadores não recalculam fatos normativos. CSV continua intencionalmente reduzido e seguro para planilhas; JSON/EARL permanece a representação técnica completa; HTML/PDF usam a mesma projeção visual.

O mapa de anúncios continua um artefato por página e não se torna evidência de ocorrência. Uma associação de apresentação `nodeId → markerNumber` pode permitir navegação visual, mas não entra em `occurrence.evidenceRefs` nem altera integridade normativa.

## 8. Mensagens e estados de erro

Mensagens leigas são estáveis e não repetem entrada privada. O mesmo catálogo e sanitização abrangem UI, logs, diagnósticos persistidos, `console`, nomes de arquivo e erros de APIs Chrome; hostname, caminho, query, valor de campo e stack nativa nunca são incorporados por concatenação. Exemplos:

- “Não foi possível abrir esta página no navegador.”
- “A página mudou depois da auditoria; consulte a captura registrada.”
- “A coleta foi parcial. Os resultados disponíveis continuam no relatório.”
- “O elemento não pôde ser localizado no estado atual da página.”
- “O relatório foi gerado parcialmente; veja quais arquivos não puderam ser criados.”

Falhas são correlacionadas por auditoria, página e etapa. Uma falha de destaque não altera o modelo, o relatório ou a classificação da ocorrência. Fechar popup/painel não cancela auditoria; cancelar exige ação explícita.

## 9. Manifesto, permissões e privacidade

O manifesto passa a conter, entre os demais campos existentes:

```json
{
  "minimum_chrome_version": "116",
  "permissions": [
    "alarms",
    "contextMenus",
    "debugger",
    "downloads",
    "scripting",
    "sidePanel",
    "storage",
    "tabs"
  ],
  "side_panel": { "default_path": "src/panel/index.html" },
  "action": { "default_popup": "src/popup/index.html" }
}
```

Os campos são incorporados às permissões existentes; `alarms`, `tabs`, `scripting`, `debugger`, `downloads`, `storage`, `contextMenus` e hosts HTTP/HTTPS continuam necessários. Existe um único `chrome.alarms.onAlarm` registrado pelo service worker; ele aceita somente os nomes fechados `audita-persona-expiry-v1`, `audita-highlight-expiry-v1`, `audita-pixel-consent-expiry-v1` e `audita-retention-cleanup-v1` e delega, respectivamente, a expiração/limpeza segura de personas, destaques, consentimentos de pixel suspensos e retenção local. Nome desconhecido não produz efeito, e nenhum módulo registra listener próprio. Não haverá `content_scripts` permanentes, `web_accessible_resources`, código remoto ou relaxamento de CSP. Destaque e personas são injetados localmente sob demanda.

Junto à ação de avaliar, a interface informa: **“A auditoria pode capturar pixels e conteúdo visível, inclusive dados pessoais. Tudo permanece neste dispositivo.”** O clique inicia com essa informação presente e oferece **Opções de privacidade**:

- `full-evidence`: captura integral, elementos e mapa;
- `element-only`: omite captura integral e mapa, mantém crops necessários com limitação explícita;
- `no-pixels`: omite toda evidência raster e registra a limitação.

Uma sonda prévia, sem ler valores, procura somente estes sinais objetivos no documento e nos frames em que a extensão possa executar: `input[type=password]`; tokens `autocomplete=current-password|new-password|one-time-code|cc-number|cc-csc`; e elemento/ancestral com `data-audita-private`. Ela não atravessa Shadow DOM fechado, não interpreta canvas/DRM e não analisa significado visual; ausência de sinal **não** significa ausência de conteúdo sensível. Antes de qualquer pixel, um sinal pausa a auditoria e mostra quais categorias, não valores, foram encontradas. `no-pixels` pode prosseguir sem nova confirmação e registra a limitação; `element-only` e `full-evidence` exigem confirmação explícita vinculada àquele `auditId`. Nenhuma preferência anterior autoriza silenciosamente a captura. Redação DOM não é apresentada como garantia de redação de pixels.

A URL de navegação e a URL de evidência são dados diferentes. A URL completa necessária para abrir ou continuar uma página (`RawNavigationUrlV1`) existe apenas em memória do worker ou em `chrome.storage.session` com acesso `TRUSTED_CONTEXTS`; é apagada assim que a etapa que depende dela termina e, em qualquer hipótese, no fim da operação ou sessão. Ela nunca entra em IndexedDB, modelo, log, nome de arquivo ou exportação. Capabilities e bindings guardam uma URL de evidência sanitizada e um HMAC-SHA-256 da URL canônica corrente com chave aleatória da sessão; o digest permite revalidar igualdade sem persistir query/fragmento em claro.

`EvidenceUrlV1` sempre remove credenciais e fragmento. Por padrão, remove toda query e normaliza o caminho; cada segmento só é preservado se tiver no máximo 64 caracteres ASCII seguros e não corresponder a e-mail, UUID, JWT, sequência numérica de sete ou mais dígitos ou token alfanumérico de alta entropia. Segmento rejeitado vira `:redacted-N`, sem hash reversível. A pessoa pode optar por incluir a query na evidência de uma auditoria específica, após aviso de que ela pode conter dados pessoais ou segredos; credenciais e fragmento continuam proibidos. A mesma transformação alimenta `initialUrlEvidence`, `topUrlEvidence`, modelo, tela, nomes derivados e recibo. Nomes de artefato usam por padrão `auditId` + instante, não URL. A sanitização reduz exposição, mas não é anunciada como prova de anonimização.

URL de evidência sanitizada, modelo sanitizado, decisões e pixels permitidos usam IndexedDB com retenção absoluta de 30 dias ancorada em `firstPersistedAt`. O painel mostra expiração local. Limpeza roda na inicialização, por `chrome.alarms` e na abertura do painel; falha mantém o registro marcado **“exclusão pendente”** e tenta novamente sem alegar remoção. Capabilities/bindings ficam em `chrome.storage.session` e são apagados em invalidação/fim da sessão. Exclusão também revoga URLs Blob, limpa checkpoints, latest state, leases e journals correlacionados.

“Não reter após exportar” agenda exclusão somente depois do `ExportReceiptV1` terminal dos quatro downloads da mesma `ExportDeliveryIdentityV1`. Se qualquer formato falhar, for cancelado ou ficar com estado desconhecido, os dados permanecem até nova tentativa ou expiração e a pendência fica visível. Downloads permanecem no dispositivo mesmo depois da exclusão interna.

## 10. Acessibilidade da própria interface

O painel respeita a largura ajustável do Chrome; a extensão não controla nem simula o botão de fechar do navegador. O alvo principal é 480–520 CSS px, com reflow funcional entre 320 e 600 px. Em até 380 px, métricas formam grade 2 × 2, filtros empilham e ações ocupam a largura disponível. Qualquer “×” presente no mock é chrome do navegador e não componente implementado.

Tokens preservam o sistema existente: `#003b71` marca, `#005a9c` ação, `#14212b` texto, `#eef4f8` superfície suave, `#738596` borda, `#8b1e1e` falha, `#6b4e00` revisão e `#1b6e3c` sucesso. Tipografia é `system-ui`, corpo 16 px, metadados no mínimo 14 px, título de painel 20 px e métrica principal até 36 px. Espaçamento usa 4/8/12/16/24/32 px, raio máximo 8 px e sombra somente quando necessária para sobreposição.

O alvo visual orienta hierarquia, densidade e tratamento, não cria controles fora do alcance da extensão. QA compara apenas a região controlada pela extensão contra `assets/2026-08-29-sidepanel-option-2.png`.

- WCAG 2.2 AA como requisito de painel, popup e relatório;
- hierarquia de headings sem saltos;
- regiões e nomes acessíveis para sumário, filtros, lista e ficha;
- foco preservado ao filtrar, expandir, destacar e retornar da página;
- estados anunciados por uma única região viva não intrusiva;
- filtros e listas operáveis por teclado sem atalhos ocultos;
- zoom/reflow em 200% e largura estreita de painel;
- `prefers-reduced-motion` e ausência de animação indispensável;
- `forced-colors` e contrastes sem depender de fundo semântico;
- foco visível com contraste suficiente e área mínima de 44 × 44 CSS px nas ações principais.

## 11. Estratégia de desenvolvimento por risco

### Risco crítico

Permissões, autorização de mensagens, seleção de aba, evidência, modelo normativo, revisão humana, retenção, exclusão e exportação:

- TDD obrigatório;
- duas revisões independentes;
- testes de ataques e atomicidade;
- suíte completa e E2E real no fechamento;
- zero achado crítico ou importante.

### Risco médio

Popup, painel, view-model, filtros, destaque, personas e relatório:

- testes focados durante implementação;
- uma revisão independente por marco;
- suíte completa no fechamento do marco;
- QA visual e de acessibilidade contra o alvo selecionado.

### Risco baixo

Textos, documentação e pequenos ajustes visuais:

- testes diretamente relacionados;
- revisão visual/acessibilidade;
- suíte completa no marco seguinte.

## 12. Testes obrigatórios

### Contrato e unidade

- `default_popup` substitui `action.onClicked`; ícone fixado e não fixado abrem o mesmo popup e as intenções cobrem aba atual, URL, lote e personas;
- `sidePanel.open()` é a primeira operação no handler elegível e falha não inicia auditoria;
- acesso de `chrome.storage.session` fica em `TRUSTED_CONTEXTS`; capabilities têm pelo menos 128 bits CSPRNG, não vazam em diagnóstico e rejeitam remetente, contexto, janela ou intenção divergentes;
- emissão, claim atômico único, expiração e invalidação de `AuditTargetCapabilityV1`, incluindo reload na mesma URL;
- `PersonaLeaseV1` cobre Leitura simulada → Acromatopsia → Somente teclado → auditoria, sem reutilizar capability, sem dois owners e sem overlay residual;
- `AuditSessionCapabilityV1` limita cancelar/destacar/abrir relatório; após reinício, reidratação é somente leitura e não ressuscita execução ou binding;
- runner `attached` nunca navega/fecha a aba; runner `disposable` só remove aba de propriedade comprovada;
- reidratação do painel após fechamento e suspensão do worker, sem retomada inventada;
- `CoreRuleInventoryV1` verifica hash/versão do checkpoint; inventário ausente, divergente ou não instalado torna a cobertura indisponível;
- `PanelSummaryV1` testa denominador zero, página iniciada sem snapshot, página não iniciada e lote parcial;
- contagens de checkKeys e de ocorrências permanecem separadas e ordenadas deterministicamente;
- filtros por impacto/WCAG/ABNT sem perda de itens;
- projeção `buildReportView` sem mutar ou inventar fatos;
- comando de destaque aceita somente IDs, modelo e binding interno; capability expirada nunca autoriza aba;
- ausência de ação de destaque para ocorrência de página/manual/editorial sem locator, com fallback “Consultar evidências”;
- `CSSSelectorV1` rejeita gramática, tamanho ou custo fora do limite; binding não nasce sem `backendNodeId` e discriminadores mínimos;
- rejeição de documento divergente, mesma URL com novo `documentId`, `backendNodeId` substituído, assinatura divergente, seletor ausente/ambíguo, frame inacessível e página protegida;
- `HighlightBindingV1` expira em 30 minutos ou fim da sessão, não renova automaticamente e cai para “Consultar evidências” após expiração/reinício;
- injeção no `documentId`/`frameId` esperado, um destaque por aba, repetição idempotente e `dispose()` integral;
- `MutationObserver` apenas invalida e descarta; nunca relocaliza alvo nem atualiza assinatura;
- caixa sólida vermelha e caixa tracejada âmbar com símbolo/texto;
- overlay não muda o hash/captura pristine nem atributos/estilos do alvo;
- original, decisão humana e estado consolidado preservados;
- HTML/PDF/CSV/JSON concordam em status, item, WCAG e IDs de evidência e preservam essa ordem canônica;
- `ExportReceiptV1` não é circular, registra hashes dos bytes pré-download e estados/IDs observados pelo Chrome antes de autorizar exclusão;
- `EvidenceUrlV1` remove credenciais, fragmento e query padrão, redige segmentos objetivos, protege digest com chave de sessão e não usa URL em nomes de arquivo;
- modos de privacidade, sinais objetivos sem leitura de valor, confirmação por `auditId`, expiração por `firstPersistedAt`, alarmes fechados de segurança/retenção e exclusão pendente.

### Integração e E2E Chrome

- Chrome 116 mínimo, extensão carregada unpacked e action fixada/não fixada → popup → painel lateral em gesto real;
- página aberta → auditoria → sumário → ocorrência → destaque;
- URL informada e lote, incluindo falha intermediária e cancelamento;
- relatório em aba dedicada e retorno ao painel;
- exportação dos quatro formatos e PDF independente dos filtros;
- reinício/suspensão do worker durante progresso;
- navegação SPA, substituição do mesmo seletor por outro nó e DOM alterado depois da coleta;
- iframe same-origin, cross-origin, sandbox e Shadow DOM aberto/fechado;
- personas e destaque sem artefatos residuais;
- CSP MV3 local e axe-core empacotado; a extensão não inicia requisições próprias fora de recursos locais, sem atribuir a ela a rede normal da página auditada;
- rotina E2E versionada salva capturas do percurso e registra versão exata do Chrome, `manifest.json`, recibo de exportação e fixture.

### QA visual e acessibilidade

- comparação lado a lado do alvo selecionado e implementação na mesma dimensão/estado;
- popup, painel inicial, progresso, sumário, detalhe e erro;
- largura estreita, 200% de zoom, impressão A4 e PDF;
- contraste, foco, teclado, leitor de tela e `forced-colors`;
- relatório com conjunto vazio, uma ocorrência e volume grande;
- PDF analisado visualmente e, quando suportado, estruturalmente quanto a tags, outline, headings e descrições de imagem.

## 13. Critérios de aceitação

1. O popup permite auditar a página aberta em um clique quando não houver pausa de privacidade obrigatória e acessar URL/lote/personas.
2. A análise aparece no painel lateral persistente; o relatório completo abre em aba própria.
3. Progresso e falhas são compreensíveis sem códigos técnicos.
4. O sumário separa cobertura da execução, falhas, alertas, revisão e aprovações; não há nota de conformidade.
5. Filtros grandes funcionam por impacto, WCAG e ABNT.
6. Cada problema tem ficha leiga, impacto, correção, alvo, nome acessível, prévia de anúncio, normas, base legal elegível e evidências.
7. “Ver e destacar na página” só aparece com binding/locator seguro, localiza o alvo quando documento, identidade CDP e assinatura correspondem e falha fechado nos demais casos.
8. Falha confirmada usa caixa grossa sólida vermelha, marcador e texto; revisão manual usa caixa tracejada âmbar, marcador e texto.
9. Capturas derivadas preservam automaticamente esses tratamentos; a captura original permanece intacta.
10. HTML, PDF, CSV e JSON técnico são gerados localmente da mesma revisão do modelo final, correlacionados por identidade não circular e registrados em recibo de exportação.
11. PDF começa por sumário, contém todas as ocorrências independentemente dos filtros e apresenta evidências legíveis.
12. Mapa de prévias une números e anúncios sem se apresentar como transcrição literal.
13. Uso permanece local, sem login, telemetria, servidor, código remoto, Web Store ou identidade governamental.
14. Página aberta, URL única e lote de até 20 páginas funcionam com limites e falhas transparentes.
15. Personas, leitor simulado, regras brasileiras, axe-core e retenção continuam funcionais.
16. O percurso mínimo completo é demonstrado em Chrome real e registrado por capturas antes do pacote final.
17. Aba anexada nunca é navegada/fechada pela extensão; abas descartáveis só são removidas sob propriedade comprovada.
18. Opções de privacidade, pausa para contexto sensível, retenção absoluta e exclusão pendente funcionam sem alegação indevida de remoção.

## 14. Fora do escopo

- crawler que descobre links automaticamente;
- login, sincronização ou armazenamento em nuvem;
- publicação automática em loja;
- upload de HTML/arquivo com a mesma força probatória de uma página observada;
- certificação WCAG/ABNT/Section 508 ou conclusão jurídica automática;
- substituição de testes reais com tecnologias assistivas e pessoas com deficiência;
- correção automática do site auditado.
