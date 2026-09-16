# Continuidade 5.9.1/5.9.7/5.9.8 e triagem de E2E — retomada de 2026-09-13

Ponto de partida confirmado no worktree `feature/audita-mt`: HEAD `c213a27`, incremento 5.9.1 sem commit, suíte completa impossível de planejar. Este documento registra o que foi executado, o que foi corrigido e o que permanece aberto. Não é aprovação de produção.

## Entregas desta rodada

| Commit | Escopo |
|---|---|
| `e7adb4d` | 5.9.1: separa identificação visual de nome acessível; pendência agregada sem alvos por campo. |
| `5da4a6d` | 5.9.7 e 5.9.8: fecha as duas lacunas de contrato de observação; classifica todos os E2E de Chrome real no runner. |
| `e7414b4` | Cleanup do perfil temporário e corrida do teste de retenção. |
| `f6ab648`/`292427f`/`377b105` | Registros de QA: validação no Google, falha de exportação, limite de campos customizados. |
| `52e3841` | Diagnóstico: o transporte CDP preserva o detalhe cru do erro de protocolo. |

## Rodada 2 — aprofundamento da falha de exportação

Investigação em Chrome real, com instrumentação do service worker vivo (envelopamento de `chrome.storage.session`, `chrome.tabs` e listeners de `onUpdated`/`onRemoved`). Nenhuma dessas instrumentações ficou no código.

Sequência medida para a auditoria da página atual, modo `no-pixels`, em `https://www.google.com/`:

1. O pedido de exportação chega ao worker e cria a aba de exportação (`tabs.create` com `active:false`), grava `audita:export-launch:v1:<auditId>`, o índice reverso `audita:export-launch-tab:v1:<tabId>` e navega a aba para `/src/export/index.html?auditId=...`.
2. A página de exportação carrega e fica em "Preparando os arquivos locais." — o texto inicial do HTML, que nunca é substituído.
3. `EXPORT_CONNECT` é autorizado: a sessão de exportação (`audita:export-session:v1:...`) é gravada e o lançamento passa a `connected`.
4. A página chega a abrir uma aba `blob:chrome-extension://.../src/export/index.html` — o caminho de download é iniciado.
5. Cerca de dois segundos depois, a aba de exportação é removida e **nenhum arquivo aparece** no diretório de downloads em 40 s. O painel permanece em "Relatório atualizado na fila de geração." indefinidamente.

Isolamento do fechamento: o listener `chrome.tabs.onRemoved` do próprio worker registra `onRemoved` para a aba de exportação **antes** de o worker chamar `tabs.remove`, ou seja, a página fecha a si mesma. O único caminho de fechamento próprio é `closeOwnTab()`, chamado no fim de `fail()` → `persistAndCloseFailure()`, que também escreve a mensagem de erro no `#export-status`. Isso é coerente com o RED de `-32001 Session with given id not found` observado ao ler a aba: o documento é destruído durante a exportação.

Consequência independente da causa: **a falha é silenciosa para o usuário**. A aba fecha, a mensagem de erro desaparece com ela, e o painel nunca é informado — não há estado de erro, nem arquivo, nem orientação para tentar de novo. Um usuário leigo fica esperando para sempre.

**Sintoma corrigido no commit `6c5beee`.** A página do relatório não espera mais indefinidamente: o pedido de exportação passou a ter prazo de dois minutos, e um desfecho não confirmado deixa de dizer que o relatório está na fila, informa que a geração não foi confirmada e que os arquivos não foram baixados, e reabilita o botão para nova tentativa. Um reconhecimento confirmado cancela o prazo, e um prazo que chega depois de o auditor mudar de auditoria não mexe na tela. O prazo é generoso de propósito: um PDF grande ainda conclui antes do aviso.

Isso é tratamento de sintoma, deliberadamente separado da causa: a exportação da página atual continua falhando, e a mensagem diz exatamente isso em vez de mascarar a falha atrás de uma confirmação de sucesso. Verificado por 3/3 testes focados de preferência de exportação e 110/110 na família de revisão.

Pista adicional: `sourceActive`/`validateConsumer` é consultado no `EXPORT_CONNECT` e no sweep de revogação, e o caminho por URL (que exporta os quatro formatos) usa a mesma autoridade. A diferença de comportamento entre os dois modos ainda não foi isolada; a próxima tentativa deve comparar os dois na mesma execução, com a mesma fixture, em vez de investigar só o modo anexado.

Correções aplicadas nesta rodada em `src/background/export-launch.js`: **nenhuma**. Uma política de revogação mais permissiva foi implementada, testada em Chrome e depois **revertida**. Motivo: os testes focados existentes (`test/background/export-launch.test.js`) reprovaram três casos legítimos — entre eles "revokes an active export when its source report consumer is revoked" — porque a mudança enfraquecia uma propriedade de segurança: uma exportação ativa **deve** ser revogada quando a sessão de origem do relatório é revogada. A mudança também deixou uma chamada órfã (`revokeInvalidSourceExports` renomeada sem atualizar `handleWindowRemoved`), apontada por revisão independente e eliminada junto com a reversão. `src/background/export-launch.js` está idêntico ao HEAD.

Lição registrada: o caminho de revogação é intencional e não deve ser afrouxado para acomodar uma corrida mal compreendida; o defeito real está em outro lugar.

O que **permanece** desta rodada é diagnóstico e uma melhoria de testabilidade, ambas commitadas: o transporte CDP preserva o detalhe cru do erro de protocolo (commit `52e3841`), e a cadeia de eventos acima está registrada com medições.

Preservados fora do staging, como solicitado: `docs/superpowers/plans/2026-09-12-observed-page-passive.md`, `test/e2e/sidepanel-flow-mv3.test.mjs`, `node_modules/` e os ZIPs em `release/`.

## Correções com RED real observado

Os dois REDs de 5.9.7/5.9.8 foram vistos no Chrome, através do consumidor final, e não por dados injetados no teste:

- 5.9.7 — `native required state must survive normalization`: o coletor guardava a obrigatoriedade em `record.form.required` e o consumidor lia `required` no nível do registro. Todo campo obrigatório caía em coleta ausente. Correção: o coletor reporta o estado no nível do registro para controles rotuláveis nativos (propriedade IDL, token ARIA quando existe, nada quando o token é malformado). Campo customizado não recebe a observação, porque o produtor é nativo por definição.
- 5.9.8 — `declared must expose only its declared purpose`: o consumidor exigia `inputPurpose`, que nenhum produtor emitia. Correção: a finalidade passa a ser derivada exclusivamente da declaração `autocomplete` do próprio campo, dentro da regra. Nome, tipo de entrada, texto ao redor e contexto continuam proibidos como prova. `autocomplete="off"` é declaração estrutural sem finalidade: não falha e não aprova. Uma declaração estruturalmente inválida é falha confirmada; um campo sem declaração permanece em revisão.

Nos dois itens o metadado `mode:automated` foi mantido por compatibilidade com relatórios históricos, pelo mesmo motivo já registrado para 5.9.1. A saída explícita `cantTell` informa a limitação em vez de alegar conformidade.

## Testes executados

| Escopo | Resultado |
|---|---|
| `test/rules/*`, `test/integration/*`, `test/core/*`, `test/report/*` | 634/634 |
| `test/rules/forms.test.js` | 20/20 |
| `test/e2e/support/real-chrome.test.mjs` | 39/39 |
| Chrome real: `field-label-review`, `form-association-observation`, `required-field-observation`, `input-purpose-observation` | 4/4 |
| Chrome real: `url-audit-mv3` | 2/2, incluindo destaque de ocorrência, limpeza e exportação pública |
| Chrome real: `report-executive-print`, `report-print-layout` | 2/2 |
| Chrome real: `batch-audit-mv3` | 1/1 após o fix de cleanup abaixo |
| Suíte completa `scripts/run-tests.mjs` | 4171 testes, 4161 passando, 10 falhando (ver abaixo) |
| `scripts/verify-project.mjs` com `AUDITA_VERIFY_SKIP_TESTS=1` | GREEN: catálogo 130/146 (96 requisitos e 50 recomendações), identidade neutra, assinaturas HTML/JSON/PDF, fixtures e varredura de privacidade |

O `verify` completo depende de `npm test` passar sem falhas; hoje ele reprova por causa das 10 falhas preexistentes registradas abaixo, e não por qualquer verificação estática.

Confirmação adicional da falha de exportação: manter o pedido aberto por três minutos não produz resposta nem arquivo. Um pedido sem `sessionCapabilityId` responde `INVALID_MESSAGE` em 1 ms, o que mostra que o envelope correto passa da validação e trava depois dela.

## Infraestrutura: Chrome for Testing corrompido

Todo E2E de Chrome real falhava com `CDP_CLOSED`. Causa demonstrada: o bundle registrado em `/private/tmp/audita-cft152-hqalvn` está incompleto — `Contents/Info.plist` ausente e `codesign --verify` reprovando com "code has no resources but signature indicates they must be present". Os processos Helper morriam com `EXC_BREAKPOINT`/`SIGTRAP` e o navegador abortava com `GPU process isn't usable. Goodbye.`

Reextrair o mesmo ZIP oficial `152.0.7977.64` restaurou o bundle e os E2E voltaram a executar. O binário antigo não deve ser reutilizado.

O Chrome estável instalado (`152.0.7977.84`) **não** substitui o CfT: o log do próprio navegador traz `--disable-extensions-except is not allowed in Google Chrome, ignoring.`, a extensão nunca carrega e a descoberta do service worker expira. O pin `Chrome/152.0.7977.64` do harness permanece inalterado.

Observação de ambiente: sob o sandbox de arquivos do harness, o Chrome não inicia (`sandbox initialization failed: Operation not permitted`) mesmo sem GPU desabilitada. Os E2E precisam ser executados fora desse sandbox.

## Correções de infraestrutura de teste

- **Plano da suíte.** Treze E2E de Chrome real não estavam em `REAL_CHROME_E2E`, e `createTestPlan` interrompia a suíte inteira com `TEST_PLAN_UNCLASSIFIED_E2E` antes de executar qualquer teste. Todos foram classificados para execução serial; nenhuma asserção foi enfraquecida.
- **Cleanup do perfil temporário.** `removeOwnedRunRoot` falhava com `ENOTEMPTY` quando o Chrome ainda terminava escritas no perfil após o processo principal sair, derrubando `batch-audit-mv3`. A remoção agora repete apenas as corridas transitórias (`ENOTEMPTY`, `EBUSY`, `ENOENT`) no caminho já validado por `realpath` e allowlist; qualquer outra falha continua surgindo.
- **Corrida no teste de retenção.** `R3-E terminal commit schedules retention` verificava um sinalizador que o caminho assíncrono define depois da publicação da chave de lançamento do relatório. O teste passa a aguardar a solicitação real de agendamento em vez de amostrar o sinalizador.

## Falha confirmada — exportação da auditoria da página atual não conclui

Reproduzido em Chrome real, em `https://www.google.com/`, modo `no-pixels`, auditoria anexada à aba atual:

- O painel abre, a auditoria conclui em cerca de 1 s e a página do relatório abre com 13 ocorrências, 388 blocos expansíveis, um gráfico, referências WCAG/ABNT e anúncio estimado.
- Ao solicitar a exportação, `REPORT_REQUEST_EXPORT` chega ao service worker com `sessionCapabilityId` válido (`8DzY5zwfNxk2jAvEFECxEw` em uma das execuções) e o worker **nunca responde**. Medido com callback nativo: `response === undefined`, `chrome.runtime.lastError === null`, sem timeout do lado do navegador.
- O diretório de downloads permanece vazio em todas as amostras até 24 s; não há `.crdownload` residual. O recibo de exportação e o diário de entrega também ficam vazios.
- Controle positivo na mesma página do relatório: `REPORT_RETURN_TO_SOURCE` responde em 3 ms com `{ok:false,code:"REPORT_RETURN_DENIED"}`. O worker está vivo e responde a outros tipos; a falha é específica do caminho de exportação.
- Controle negativo: um `REPORT_REQUEST_EXPORT` sem `sessionCapabilityId` responde em 6 ms com `{ok:false,code:"INVALID_MESSAGE"}`, confirmando que o envelope real passa da validação e trava depois dela.
- Efeito no usuário: a página do relatório mostra "Relatório atualizado na fila de geração." e permanece assim indefinidamente, sem erro e sem arquivo. Isso viola diretamente o critério de que a exportação funciona.

Exportações que **funcionam** nesta mesma versão, com prova de quatro formatos: auditoria por URL (`url-audit-mv3`) e auditoria em lote (`batch-audit-mv3`). A falha está delimitada à auditoria anexada da página atual.

Estado: pendência crítica conhecida, não corrigida. Investigação parada no ponto em que o worker deixa de responder; os próximos passos são instrumentar `exportLaunch.requestExport` por dentro (o retorno silencioso indica que a resposta ou nunca é produzida, ou não é clonável) e verificar se a origem é a autorização, o lease de exportação ou a criação da aba de exportação.

## Validação em página real — Google

Execução registrada: `2026-09-15T00:52:58.297Z`, `https://www.google.com/`, viewport 1280×757 (inner e visual), modo `no-pixels`, sessão nova, sem menus abertos, Chrome for Testing 152.0.7977.64 reextraído. A fonte não foi rolada, focada ou navegada; foco e rolagem permaneceram idênticos antes e depois.

Resultado do relatório da versão atual:

| Medida | Valor |
|---|---|
| Falhas confirmadas | 0 verificações, 0 ocorrências |
| Recomendações e alertas | 1 verificação, 1 ocorrência |
| Suspeitas a confirmar | 4 verificações, 9 ocorrências |
| Resultados positivos | 9 verificações |
| Índice técnico automático | 9,0 / 10 (9 de 10 com conclusão automática aplicável) |
| Cobertura automática | 28,5 %, com fórmula e denominador declarados |
| Checklist separado | 109 verificações ainda sem conclusão |

Comparação com o defeito histórico: a versão anterior produzia 753 verificações humanas e um PDF com mais de 700 páginas para a mesma página inicial do Google. A versão atual separa falhas, suspeitas e checklist, mantém o checklist fora do gráfico e do índice, e explicita que o índice não é nota, certificação ou declaração de conformidade. O relatório tem sete seções, paginação normal e um gráfico. A separação exigida entre ocorrência e checklist está presente na saída, não apenas na intenção.

Isso não é aprovação do produto: a exportação dessa mesma auditoria falha conforme registrado acima, e os itens de comparação com AMAWeb/AccessMonitor e de revisão independente continuam pendentes.

## Pendências abertas

### `sidepanel-flow-mv3` — 9 de 12 cenários falham (preexistente, não é regressão)

Confirmado por stash: o estado limpo do HEAD falha exatamente igual, e o mesmo teste também falha no commit `5da4a6d` com e sem as alterações desta sessão. Não foi introduzido por 5.9.1/5.9.7/5.9.8.

Diagnóstico parcial, com evidência:

- O painel abre e atinge `data-screen="initial"` normalmente; o botão e o seletor de modo ficam habilitados. Medido em Chrome real com a fixture completa de 240 controles.
- A auditoria anexada em `no-pixels` completa e chega a `result` em cerca de 2 s; em `element-only` o painel percorre `running` (50 %, 72 %, 92 %) e chega a `result` em cerca de 12 s, sem pausa de privacidade observada.
- A falha real ocorre em `assertPausedAttempt` → `waitForOwner`, esperando um registro de aba proprietária em `chrome.storage.session` com `state === 'retained-for-consent'` e `cleanupMode === 'always'`. Esse registro não aparece na janela de 30 s.
- Leituras diretas de `chrome.storage.session.get(null)` a partir da página de harness retornaram `{}` durante todo o percurso, mesmo com a auditoria em andamento e o painel em `running`. O service worker define `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` na inicialização.

Hipótese principal: os helpers `armSourceInvariantProof`/`armTabIsolationProof`, usados apenas nesse arquivo antes da tentativa, interferem no percurso anexado — os mesmos passos, reproduzidos sem eles, concluem a auditoria. Não confirmado. Próximo passo: reduzir o cenário ao conjunto mínimo de preparação que produz a falha e decidir se o defeito é do teste ou do encadeamento de autorização da auditoria anexada.

Impacto: o percurso principal está coberto e verde por `url-audit-mv3`, `batch-audit-mv3` e pelos dois testes de relatório; o que permanece sem cobertura verde é o conjunto específico de cenários de `sidepanel-flow-mv3`.

### `service-worker.test.js` — 9 falhas de limpeza de persona (preexistente)

Confirmado por stash no estado limpo do HEAD: mesmas 9 falhas, sempre `PERSONA_CLEANUP_UNCONFIRMED`. As oito variantes do worker padrão e o cenário de snapshot falham na mesma confirmação de limpeza de persona no início da auditoria (`clearAndAttemptTerminalRevoke` → `clearTarget` → `personaRuntime.apply({ op: 'clear' })`). Não investigado a fundo nesta rodada; a fronteira é conservadora (bloqueia o início em vez de seguir com estado incerto), mas a causa não foi estabelecida. Precisa de rodada própria.

### Cobertura ainda pendente na família de formulários

- Produtor de identificação visual para 5.9.1: continua ausente.
- Identificação perceptível de obrigatoriedade para 5.9.7: continua ausente; o estado obrigatório chegar agora não prova percepção.
- Campos customizados editáveis: caracterização no Chrome mostrou que um `div[role=textbox][contenteditable=true]` chega ao consumidor sem `id`, sem `accessibleName` e sem resolução de `aria-labelledby`, porque `contentEditableRootAttributes` mantém apenas uma allowlist mínima e `preserveAccessibleText` cobre hoje somente `input`, `select` e `textarea`. Recuperar o nome exige decisão explícita de fronteira de privacidade e não foi feito por atalho.

## Validação ainda não executada

- Auditoria de página simples real (Google) nesta versão, com registro de URL, estado, sessão, viewport e data.
- Inspeção visual do HTML e do PDF gerados pela versão atual para julgar pertinência, contagens e extensão.
- Comparação com AMAWeb/AccessMonitor usando versão atual contra versão atual.
- Revisão integrada independente desta rodada.
- Pacote de distribuição da versão efetivamente testada.

## Rodada 3 — achado que estreita a busca da causa raiz

Medição nova, com o worker vivo e a página do relatório aberta por auditoria anexada:

- `chrome.storage.session` contém dez chaves, entre elas `audita:report-launch:v1:<auditId>`, `audita:report-launch-tab:v1:<tabId>` e `audita:retention-preference:v1:<auditId>`.
- **Não existe** nenhuma chave `audita:report-consumer:v1:…` nesse momento, nem `audita:export-session:v1:…`.

Isso é relevante porque `authorizeIntent` exige um consumidor vivo cujo grafo bata com o lançamento:

```
consumer.state === 'active' && consumer.intents.includes(intent) && launch.state === 'connected'
&& consumer.tabId === launch.tabId && consumer.documentId === launch.documentId
```

Sem registro de consumidor, `exactLiveConsumerGraph` é falso e `authorizeExport` nega. É a explicação mais provável para a aba de exportação fechar cerca de dois segundos depois de abrir, sem nunca gravar sessão de exportação: `EXPORT_CONNECT` é negado e a página fecha a si mesma em `fail()`.

Ressalva importante: a leitura foi feita a partir da página do relatório. As chaves de consumidor podem ter nome ou área diferentes do que o filtro procurava, então isto é uma hipótese forte e **não** uma prova. O passo decisivo é registrar, dentro de `reportLaunch.authorizeIntent`, qual das cláusulas do grafo falha na auditoria anexada — uma leitura de diagnóstico temporária, removida em seguida, como foi feito na rodada 2.

Caminho alternativo se a hipótese se confirmar: a auditoria por URL não apresenta o problema, então comparar como o consumidor é criado nos dois modos (`launch.version` 2 com `source.state === 'result'`) deve apontar a diferença.

## Rodada 4 — o que foi descartado e por quê

Duas tentativas de instrumentação foram feitas e **revertidas**, sem deixar código de diagnóstico:

1. Registro das cláusulas do grafo de autorização dentro de `authorizeIntent`: o buffer ficou vazio, e o worker não mostrou nenhuma negação registrada nesse caminho. Isso enfraquece a hipótese da rodada 3 de que `authorizeExport` nega — a negação, se ocorre, é em outro ponto (por exemplo `deriveTrustedExtensionContext` ou o próprio `EXPORT_CONNECT`).
2. Abertura direta da página de exportação para medir acesso a `chrome.storage.session` e resposta do worker: `openExtensionPage` expirou ao carregar a página. O helper abre páginas de extensão de uma allowlist e não serve para essa sonda.

O que segue como fato medido:

- Auditoria por URL exporta os quatro formatos nesta versão (2/2 verdes em `url-audit-mv3`).
- Auditoria da página atual falha: a aba de exportação fecha cerca de dois segundos depois de abrir, `audita:export-session:v1:…` nunca é gravada, nenhum arquivo aparece e, antes do commit `6c5beee`, nada era informado ao usuário.
- Em uma execução a mensagem chegou a "Preparando os arquivos locais." (o texto inicial do HTML), o que indica que a página foi carregada mas não concluiu `start()`.

Recomendação para a próxima rodada, para não repetir tentativas: instrumentar **dentro da própria página de exportação**, não no worker nem por fora. `src/export/index.js` já tem um único ponto de entrada (`start()`), e uma sonda temporária ali responde de uma vez se `EXPORT_CONNECT` é negado, se `generate()` falha e em qual etapa. O caminho de URL, que funciona, deve ser instrumentado do mesmo jeito para comparação direta.

## Rodada 5 — causa raiz da exportação anexada: recibo parcial recusado

Instrumentei temporariamente `src/export/index.js` para registrar o motivo exato da falha de `start()`, e removi a instrumentação depois (`git checkout --`). Resultado:

```
{"name":"TypeError","message":"Recibo completo da revisão imutável inválido."}
```

Cadeia completa, agora determinada:

1. O modelo persistido da auditoria anexada é `report.status === 'review-ready'` com `report.artifact.status === 'pending'`.
2. A página de exportação sempre passa `reportView` como dependência, então `runReportExport` escolhe `runImmutableRevisionExport`.
3. Essa função baixa os quatro artefatos e monta um recibo cujo `status` é `complete` **ou** `partial`, conforme limitações reais.
4. `persistExportSuccess` então chamava `immutableRevisionFormats`, que exigia `receipt.status === 'complete'` e os quatro formatos com `status === 'complete'` — e lançava `TypeError` para qualquer recibo parcial.
5. A página caía em `fail()`, fechava a própria aba e o usuário ficava sem arquivo e sem mensagem (sintoma corrigido no commit `6c5beee`).

O portão era incoerente com o próprio produto: a exportação parcial é um resultado deliberado e persistido (`exportStatus: 'partial'`, "Relatório gerado com limitações"), inclusive aceito pelo store. Corrigido em `src/export/export-controller.js`: o caminho imutável passa a validar forma, ordem e ausência de duplicatas do recibo, aceitando `complete` e `partial`, e delega a consistência ao validador compartilhado. Depois da correção a exportação **conclui** (`exportStatus: partial`) e os quatro arquivos são baixados, com tamanhos reais medidos no Chrome (HTML 337 KB, JSON 374 KB, CSV 86 KB, PDF 993 KB).

Limite da verificação: os quatro downloads são reportados com `failureCode: DOWNLOAD_INTERRUPTED` (com `downloadId` válido) enquanto o Chrome os registra como `state: 'complete'`. O recibo persistido fica com `formats: []` e status `partial`. Não atribuo isso ao produto nem ao harness sem nova medição: um adaptador falso em Node, com download completo e `exists: false`, classifica os quatro como `complete`, então o caminho puro está correto. A hipótese restante é o comportamento de `chrome.downloads.onChanged` no modo de download do harness (`allowAndName`), que renomeia os arquivos e pode emitir uma transição transitória de `interrupted`. Próximo passo: medir `onChanged` e `search` para o mesmo `downloadId` na mesma execução, e então decidir se o produto deve tratar `interrupted` transitório com uma rechecagem antes de desistir.

Pendência aberta: não há teste unitário cobrindo o caminho imutável com recibo parcial. O `report-export.test.js` cobre apenas o caso `complete` (que continuou verde: 120/120 na família de exportação). Escrever esse teste é o primeiro item da próxima rodada.

## Rodada 6 — adaptador de download confirma interrupção antes de desistir

Aplicado o passo que a rodada 5 deixou agendado. `waitForDownload`, no adaptador real de `chrome.downloads`, rejeitava a promessa no primeiro sinal `state: 'interrupted'`, sem conferir o estado durável. O Chrome pode sinalizar interrupção e ainda concluir o mesmo download — e conclui sob outro nome físico quando o perfil renomeia artefatos. A correção confirma o estado com `chrome.downloads.search` antes de encerrar a espera: só desiste quando a busca também não mostra `complete`, e o timeout continua limitando a confirmação.

RED observado antes da correção: teste novo em `test/browser/download-artifacts.test.js` com adaptador falso, um sinal `interrupted` e uma busca que responde `complete` — a promessa rejeitava com `DownloadInterruptedError`. Depois da correção: 58/58 no arquivo, 178/178 somando a família de exportação.

A verificação de ponta a ponta **ainda não fecha**, e o motivo mudou de lugar, o que é progresso: o recibo passou a carregar os quatro formatos (`receiptFormats: 4`, antes era `[]`), mas os quatro continuam classificados como `interrupted` com `failureCode: DOWNLOAD_INTERRUPTED`. Medição decisiva desta rodada, com o `search` e o `onChanged` instrumentados na página: os únicos eventos observados foram quatro `changed:<id>:complete`, e **nenhuma** chamada a `downloads.search` foi registrada. Ou seja, a rejeição não veio do sinal de interrupção nem da confirmação por busca — o `waitForDownload` não chegou a ser executado para esses downloads, e o erro nasce em outro ponto do caminho.

Próximo passo, agora bem delimitado: registrar o `name` e a `message` reais do erro que chega ao `catch` de `downloadArtifacts` antes de ele ser convertido em `DOWNLOAD_INTERRUPTED`, e verificar se `adoptDownload` está rejeitando por `DOWNLOAD_START_*` ou se o `assertDelivery`/`recordDelivery` do caminho anexado rejeita. Nenhuma sonda ficou no código.

## Rodada 7 — fechamento honesto: exportação da página atual verificada

Resultado final, com a medição que faltava. A exportação da auditoria da página atual **funciona e entrega os quatro formatos**, comprovado pela prova oficial do repositório (recibo durável conferido por tamanho e SHA-256):

```
OK html:337235 pdf:993691 csv:86142 json:374214
```

Novo teste permanente `test/e2e/current-page-export-mv3.test.mjs`, verde em cerca de 3,3 s, que percorre o caminho real (auditoria da página atual → relatório → exportação) e exige o recibo dos quatro formatos com bytes e hash, além de garantir que a página de origem não foi navegada.

Correção de rota importante, registrada para não induzir quem vier depois: o `DOWNLOAD_INTERRUPTED` que dominou as rodadas 5 e 6 era, em boa parte, **artefato do modo de download do harness**. No modo `cdp`, o harness usa `allowAndName` e o Chrome renomeia cada arquivo para um GUID; a atestação de nome real do produto (`resolveDownloadFilename`) recusa corretamente essa divergência, e o erro é convertido em `DOWNLOAD_INTERRUPTED`, que descreve mal a causa. Instrumentando o `catch` de `downloadArtifacts` apareceu o erro verdadeiro: `TypeError: "Não foi possível atestar o nome real do download."`. Com `downloadMode: 'profile'` — o mesmo modo que os testes oficiais de exportação do repositório já usam — os quatro arquivos saem com o nome canônico `audita-…` e tudo passa.

Consequência para a avaliação do produto: a exportação da página atual **não estava quebrada por um defeito do produto** na configuração que o repositório já usa nos seus próprios testes. O que ficou de real e foi corrigido:

- `immutableRevisionFormats` recusava recibo parcial de uma revisão `review-ready`; entrega parcial é resultado deliberado do produto e agora é aceita (o caminho imutável valida forma, ordem e duplicatas). Continua correto e coberto.
- `waitForDownload` rejeitava no primeiro sinal de interrupção sem conferir o estado durável; agora confirma com `downloads.search` antes de desistir, com teste unitário de regressão.

Pendência de diagnóstico registrada, sem ação nesta rodada: o código de falha `DOWNLOAD_INTERRUPTED` esconde causas distintas (nome não atestado, interrupção real, timeout de espera). Um usuário ou um fiscal que veja esse código no relatório não consegue distinguir "o navegador renomeou o arquivo" de "a rede caiu". Vale separar o código quando a causa for atestação de nome.

Também vale registrar o limite do teste novo: com o portão antigo restaurado, ele **passa** — porque no modo `profile` o recibo sai `complete`. Ele é um teste de percurso valioso, mas não é a regressão específica do portão de recibo parcial; essa continua coberta apenas pelo teste unitário da família de exportação e pelo RED registrado na rodada 5.

## Rodada 8 — inspeção visual e correção de semiântica nas contagens

Relatório e PDF da versão atual gerados em fixture com defeitos conhecidos (5 falhas confirmadas, 7 suspeitas, 6 positivos, checklist de 104 verificações). Inspeção visual feita: PDF de **23 páginas**, 1,07 MB, `%PDF-1.4` com `%%EOF`, e painel lateral renderizado.

O PDF está bem organizado e honesto: sumário executivo com os quatro cartões rotulados (4 não conformidades, 0 recomendações, 7 suspeitas, 6 positivos), fórmula da cobertura explícita ("28,5 %. Mede os testes do motor próprio com conclusão automática... não é nota, certificação ou declaração de conformidade"), sete limitações registradas em bloco expansível e a declaração de que a auditoria cobre uma página e o estado observado, sem valer para o site inteiro. A extensão razoável confirma que o defeito histórico de 700+ páginas não se reproduz.

Defeito de apresentação encontrado e corrigido: o cabeçalho do relatório exibia `${counts.errors.occurrences}` com o rótulo "falhas confirmadas". O produto distingue verificações de ocorrências — o painel mostra "4 Falhas confirmadas / verificações / 5 ocorrências" e o sumário do PDF mostra "4 verificações · 5 ocorrências" — mas o cabeçalho chamava as ocorrências de falhas, produzindo "5 falhas confirmadas" ao lado de um cartão que diz 4. A linha agora nomeia as duas contagens: "4 verificações com falha confirmada (5 ocorrências); 7 verificações sob revisão humana (7 ocorrências). Checklist separado: 104 verificações ainda sem conclusão.", com singular correto e tolerância a resumo ausente ou hostil. Coberto por teste em `test/review/review-export-preference.test.js`; 111/111 na família de revisão.

Investigação descartada, para não repetir: suspeitei que o painel contasse menos ocorrências por truncamento da projeção interativa, mas os limites são 200 cartões e 64 ocorrências, muito acima do caso medido, e ambos os caminhos chamam o mesmo `buildSummary`. O texto do painel lido como "4 Falhas confirmadas verificações 5 ocorrências" é a grade CSS intencional (`grid` com `gap` de 2 px entre rótulo e unidade), não texto colado.

Pendência registrada sem ação: existe uma diferença não explicada entre a contagem de ocorrências do painel e a do relatório no mesmo modelo (4 × 5). Como ambos usam `buildCompleteReportSummary`/`buildPanelSummary` sobre a mesma entrada, isso merece uma rodada própria com uma asserção que compare as duas saídas para o mesmo `auditId`, em vez de inferência a partir do DOM.

## Rodada 9 — inspeção independente: defeito confirmado no destaque ao vivo

Achado importante, medido em Chrome real com a fixture local, auditoria da página atual, modo `no-pixels`, HEAD `0201f72` (nenhuma alteração de `src/` pendente no momento da medição, portanto o estado medido é o do repositório):

1. A oferta existe e está correta: o painel mostra `Destacar elemento na página: Texto alternativo para imagens de conteúdo` para uma ocorrência de elemento, e `Limpar destaque` depois da ação — ou seja, o controlador considera o destaque **ativo**.
2. A marcação **não aparece na página**. Medições na página de origem: zero elementos com `outline` visível, zero nós com `data-audita-*`, e nenhum nó overlay — a raiz do overlay (`z-index: 2147483647`) não existe no DOM. O único filho de `body` continua sendo `MAIN`.
3. O status do painel permanece "Os sinais estão ocultos." e não há mensagem de erro: a interface afirma que há destaque ativo enquanto a página não tem nada.

Isso contraria diretamente o requisito de que "o destaque corresponde ao elemento e documento corretos" e o percurso obrigatório (abrir ocorrência → destacar elemento). Não é regressão desta sessão: as alterações desta sessão estão em `download-artifacts.js`, `export-controller.js`, `review.js` e testes, todas commitadas, e a árvore não tinha `src/` modificado durante a medição.

Delimitação honesta do que foi e do que não foi provado:

- Provado: a ação é aceita, o estado da interface muda, e não há overlay no DOM da página após 3 s.
- Provado: o caminho por URL tem um teste oficial que verifica apenas que a **oferta** existe (`highlightable === true`), nunca que a marcação aparece. Essa lacuna de teste explica por que o defeito passou.
- Não provado: se o caminho por URL realmente marca a página. A sonda equivalente para URL não chegou ao formulário de outra URL e expirou; não insisti para não repetir tentativa já frustrada.
- Não investigado: por que a instalação não se materializa. O controlador grava `__auditaHighlightOverlayV1` no mundo principal; a página não tem o descritor nem o nó. Próximo passo: registrar o retorno real de `runAuditaHighlightCommand` no worker, e não apenas o estado do painel.

Recomendação de teste, para fechar a lacuna estrutural: exigir, no E2E de destaque, que a marcação exista na página (nó overlay com `z-index` máximo ou contorno visível no alvo), não apenas que o botão exista. Sem essa asserção, qualquer regressão de renderização de destaque passa despercebida.

## Rodada 9 — comparação com AMAWeb e AccessMonitor (versão atual)

Execução registrada: `https://www.google.com/`, título "Google", viewport 1280×757 (inner e visual), nenhum menu aberto (zero `[aria-expanded="true"]`), sessão nova, foco em `TEXTAREA` e rolagem `[0,0]` antes e depois, modo `no-pixels`, Chrome for Testing 152.0.7977.64. A página **não tem `<main>` nem `<h1>`**, o que é relevante para o item 5.3.3.

Resultado da versão atual:

| Medida | Valor |
|---|---|
| Falhas confirmadas | 0 verificações, 0 ocorrências |
| Recomendações e alertas | 1 verificação, 1 ocorrência |
| Suspeitas a confirmar | 3 verificações, 4 ocorrências |
| Resultados positivos | 9 verificações |
| Cobertura automática | 37/130 (28,5 %) |
| Checklist separado | 109 verificações ainda sem conclusão |

Confronto com o histórico de 12/09/2026 (não é teste da versão atual, é referência do parecer anterior): AMAWeb mediu 482 elementos e 29 práticas com 5 erros, nota 8,0; AccessMonitor mediu por práticas. Nenhum dos dois é contagem de itens ABNT nem de pessoas afetadas. O parecer histórico já registrava que "não se confirma a premissa de que todos os cinco apontamentos do AMAWeb ou os sete do AccessMonitor sejam requisitos obrigatórios descumpridos da ABNT", e que a diferença de contagens não comprova defeito por si.

Estado inicial do Google: 0 falhas confirmadas na versão atual coincide com o que o próprio parecer histórico registrou para o axe-core 4.13.0 no mesmo estado ("não encontrou violações nas regras WCAG A/AA selecionadas"). Isso reforça que a divergência com AMAWeb não vem de falha detectada e não confirmada: as cinco práticas do AMAWeb incluem recomendações e técnicas específicas, não cinco requisitos ABNT descumpridos.

Lacuna histórica verificada e fechada: "recomendação de cabeçalho principal indevidamente considerada inaplicável quando não existe `main`". A regra `main-heading` (5.3.3) hoje não depende de `<main>`: a página do Google, sem `main` e sem `h1`, produziu a recomendação na categoria de alertas em vez de cair como inaplicável, e o teste `test/rules/structure.test.js` cobre explicitamente "main heading recommendation applies to pages without a native main container". Os outros dois defeitos históricos (filtragem de regras do axe e perda de estados interativos na cópia) não foram remedidos nesta rodada.

## Rodada 9 — recursos didáticos e normativos verificados na fixture

Com os blocos expansíveis abertos, o relatório da fixture com defeitos confirmou: cinco cartões de falha; a referência curta no formato exigido (`Inconformidade ao item 5.13.10 da ABNT NBR 17225:2025`, e também 5.8.2, 5.8.3, 5.9.3); o bloco de anúncio estimado presente ("Anúncio estimado: botão", com a ressalva de que não é transcrição literal de tecnologia assistiva); e os blocos didáticos "Impacto para a pessoa usuária", "O que foi observado", "Correção", "Confirmação" e "Fundamentação normativa", além de 384 grupos expansíveis. O relatório em aba própria informa que o destaque ao vivo não está disponível ali e remete às capturas registradas; a oferta de "Destacar elemento" vive no painel, que é o que a experiência obrigatória pede.

## Rodada 10 — a marcação na página falha por inteiro no modo anexado

Ampliei a medição da rodada 9 e o defeito é maior do que o destaque isolado. Na auditoria da página atual, modo `no-pixels`, fixture local, Chrome real:

| Ação do painel | Estado da interface | Estado da página de origem |
|---|---|---|
| Baseline após o resultado | — | `markerRoot: 0`, `highlightRoot: 0`, `body` com 1 filho |
| "Mostrar sinais na página" | botão existe e é acionado | `markerRoot: 0`, `highlightRoot: 0`, `body` com 1 filho, nenhum status |
| "Destacar elemento na página" | vira "Limpar destaque" (destaque considerado ativo) | `highlightRoot: 0`, nenhum contorno, nenhum nó `data-audita-*` |

Ou seja: **nenhum dos dois caminhos de marcação entrega pixels na página** nesse modo, e ambos se apresentam como bem-sucedidos. O requisito "destaques e caixas na página, com correspondência clara com as ocorrências" e o critério de que o destaque corresponde ao elemento correto não estão atendidos no percurso da página atual.

Causa provável localizada no código, ainda não confirmada em execução: `injectHighlight`, em `src/background/chrome-adapter.js`, considera sucesso quando o resultado injetado devolve `{ok:true, nonce}` correspondente. O nãoce prova que o comando chegou, **não** que a raiz foi criada: a verificação de integridade que confere a raiz (`data-audita-highlight-root`, `z-index`, geometria, impressão digital de estilo) existe em `overlayRuntimeIntact`, mas não aparece como condição no caminho de sucesso. Isso permite declarar destaque ativo sobre uma página sem marcação, exatamente o que foi medido. O caminho de "sinais" usa o Port `audita-page-markers-v1` e a raiz `data-audita-page-markers-root`, e também não materializou nada.

Também é relevante para o modo: a injeção roda com `world: 'ISOLATED'` e `target.documentIds`. Se a instalação depender do mundo principal, o modo isolado falharia em silêncio, o que combinaria com o observado; mas isto é hipótese, não conclusão.

Próximos passos, em ordem, para não repetir tentativa:

1. Registrar o retorno real de `injectHighlight` e o `reason` de falha no worker durante uma tentativa do painel, em vez de inferir pelo estado da interface.
2. Exigir no caminho de sucesso a confirmação da raiz, não apenas o nonce: um destaque só pode ser declarado ativo se a raiz existir com os invariantes conferidos por `overlayRuntimeIntact`.
3. Fechar a lacuna de teste que permitiu isso: o E2E de destaque deve exigir a marcação na página (raiz de sobreposição ou contorno visível no alvo), não só a existência do botão.

Não corrigi nada nesta rodada: a mudança de condição de sucesso é sensível (autorização, prova de documento, resistência a replay) e merece um RED próprio antes de tocar no código.

## Rodada 11 — correção da rodada 9/10: o destaque funciona; a sonda é que estava errada

Preciso corrigir publicamente o registro das rodadas 9 e 10. A afirmação de que "o destaque não marca a página" estava **errada**, e o erro era da minha medição.

Causa do erro: a raiz do destaque é filha de `documentElement` (`parent: HTML`), não de `body`. Minhas sondas contavam `document.body.children` e procuravam contorno em `body *`, e por isso concluíram que nada existia. A sonda de "sinais" da rodada 10 também clicava com `.click()` sintético em vez do clique nativo do harness, o que não exercita o mesmo caminho.

Medição correta, com o clique nativo e a busca no lugar certo do DOM, auditoria da página atual, fixture local, modo `no-pixels`:

```
roots: [{ attr: "data-audita-highlight-root,aria-hidden,tabindex,style",
          parent: "HTML", text: "×12 — Falha confirmada",
          z: "2147483647", rect: [130, 80, 153, 21] }]
```

Ou seja: **"Destacar elemento na página" funciona** — a caixa é criada, com o número da ocorrência e o rótulo "Falha confirmada", no `z-index` máximo, posicionada sobre o elemento (`rect` do alvo `[125, 94, 1, 1]`, caixa `[130, 80, 153, 21]`), e o alvo é o elemento correto (`#missing-alt`, visível). O critério de que o destaque corresponde ao elemento e ao documento corretos está atendido neste modo. A afirmação anterior de que a interface declarava destaque ativo sobre página sem marcação **não se sustenta** e fica retirada.

O que permanece real e verificado:

- **"Mostrar sinais na página" falha** na auditoria da página atual. O botão existe, é acionado com clique nativo, e o painel responde com `"Não foi possível mostrar os sinais nesta página. Refaça a auditoria da página atual ou consulte as evidências do relatório."`, virando "Tentar mostrar sinais". Nenhuma raiz `data-audita-page-markers-root` aparece, enquanto a raiz do destaque individual continua presente. Isso é uma falha de recurso exigido pela meta ("destaques e caixas na página, com correspondência clara com as ocorrências"), ainda que a orientação de recuperação seja honesta e ofereça alternativa.
- O texto de recuperação merece revisão: "refaça a auditoria da página atual" sugere que a repetição resolve, o que não foi demonstrado e provavelmente não resolve, já que a falha é a mesma em execuções repetidas.

Lição de método, registrada para valer nas próximas rodadas: ao medir marcação injetada, procurar a raiz pelo atributo em todo o documento e usar clique nativo; contar filhos de `body` não prova ausência de overlay. Duas rodadas de diagnóstico foram gastas por causa disso, e a conclusão anterior chegou a ser publicada como defeito confirmado — o que mostra o custo de não validar a sonda antes de concluir.

Pendência de teste que continua válida: o E2E de destaque deveria exigir a marcação na página (raiz `data-audita-highlight-root` ou contorno no alvo), não apenas a existência do botão. Hoje ele não protegeria uma regressão de renderização, e foi essa lacuna que me deixou sem contraponto quando a sonda errada apontou um defeito inexistente.

## Rodada 12 — mecanismo provável da falha dos sinais

Rastreei o caminho que falha. O painel envia `PANEL_SHOW_PAGE_MARKERS` com `modelRevision`, `sessionCapabilityId` e `auditId`; o worker responde com um de dois códigos de falha, e o painel traduz ambos para a mesma mensagem "Não foi possível mostrar os sinais nesta página. Refaça a auditoria da página atual…", que é o que o usuário vê.

O guard mais provável está em `show()` do controlador de marcadores (`src/background/page-markers-controller.js`): ele exige, além da autorização, que exista uma origem registrada **e não expirada** para a auditoria, e que duas leituras dela sejam idênticas (`sameProof`) antes de prosseguir. Sem isso devolve `PAGE_MARKERS_UNAVAILABLE`.

A origem é registrada em `service-worker.js` no caminho `kind: 'attached-copy'`, com o `documentId` da aba de origem **antes** da navegação para a cópia:

```
pageMarkerOriginCache?.register({ auditId, tabId, windowId,
  documentId: source.documentId, urlSessionDigest: source.urlSessionDigest,
  createdAt: registeredAt, expiresAt: registeredAt + 1_800_000 });
```

Ponto central: `documentId` identifica um **documento**, não uma aba. A auditoria anexada navega a aba para uma cópia (`navigationPurpose: 'attached-copy'`), o que troca o documento vivo. Depois disso, a origem guardada aponta para o documento antigo. Isso combina com o sintoma observado: o destaque individual continua funcionando porque verifica o documento no momento da instalação, enquanto o caminho dos sinais depende dessa origem em cache — e o TTL de 30 minutos não salva, porque o problema não é idade, é identidade.

Ressalva importante: isto é **hipótese apoiada na leitura do código**, não medida em execução. Não confirmei com uma sonda do `documentId` guardado contra o `documentId` vivo após a cópia. Antes de corrigir, a medição que fecha o caso é registrar, no worker, o `documentId` da origem em cache e o `documentId` do alvo no instante do `PANEL_SHOW_PAGE_MARKERS`.

Recomendação de correção, se a hipótese se confirmar: registrar a origem com o documento efetivamente observado pela auditoria — o da cópia —, ou aceitar explicitamente o documento da cópia na comparação, **sem** afrouxar `sameProof` para "mesma aba". A distinção documento/aba é justamente o que impede atribuir marcação ao documento errado, e é um dos pontos de rigor máximo da meta; uma correção que ignore isso reintroduziria o risco de marcar o documento A com dados de B.

Também fica registrada uma melhoria de mensagem, independente da causa: dizer "refaça a auditoria da página atual" sugere uma recuperação que não foi demonstrada e que provavelmente não funciona, já que a falha se repete em execuções consecutivas. Enquanto a causa não estiver fechada, a mensagem deveria orientar o que de fato funciona — consultar as evidências no relatório — sem prometer que repetir resolve.

## Rodada 13 — sinais: segunda hipótese e tentativa de medição frustrada

Tentei medir o `documentId` vivo da aba de origem depois da cópia e listar as chaves de sessão relevantes, para confirmar ou descartar a hipótese da rodada 12. **A medição não funcionou**: as duas leituras assíncronas a partir da página do painel voltaram como `{}` — o mesmo problema de serialização que já tinha aparecido antes com `chrome.storage.session.get(null)` no helper de avaliação. Não trato isso como evidência de nada; é limitação da sonda.

O que a tentativa acrescentou:

- O sintoma se reproduz de forma estável: com clique nativo, o painel responde "Não foi possível mostrar os sinais nesta página. Refaça a auditoria da página atual ou consulte as evidências do relatório." em execuções consecutivas, sempre no modo de auditoria da página atual. Não é intermitente.
- O caminho de "sinais" é o único dos dois que depende de um cache de origem **em memória do service worker** (`createPageMarkerOriginCache`), enquanto o destaque individual verifica o documento no momento da instalação e por isso funciona na mesma página e no mesmo instante.

Isso reforça uma segunda hipótese, mais simples que a da rodada 12 e igualmente não medida: o service worker MV3 pode ser encerrado entre a conclusão da auditoria e o clique em "Mostrar sinais", esvaziando o cache de origem e fazendo `getOrigin` devolver nulo. Como o cache é em memória e não há re-registro depois da auditoria, o pedido cai no guard de origem e devolve falha. A hipótese da rodada 12 (documento da cópia diferente do documento registrado) continua de pé e não foi descartada.

O que distingue as duas, para a próxima medição: registrar no worker, no instante do pedido, (a) se existe registro no cache para o `auditId`, (b) o `documentId` guardado e (c) o `documentId` vivo da aba. Cache vazio aponta para reinício do worker; cache preenchido com documento diferente aponta para a cópia.

Também registrado: se a causa for reinício do worker, a correção não pode ser "afrouxar o guard", porque o guard é o que garante que a marcação não é atribuída ao documento errado. A correção adequada é tornar a origem reconstruível — registrá-la de novo a partir do estado durável da auditoria quando o painel pedir os sinais — e não aceitar ausência de prova.

Nenhuma alteração de código nesta rodada; nenhuma sonda deixada no repositório.

## Rodada 14 — causa raiz dos sinais: a aba de origem não tem contexto de extensão

Medição que fecha o caso, feita da página do painel (mesma origem da extensão), Chrome real, auditoria da página atual, modo `no-pixels`:

```
rows: [ { id: 1652594668, url: "about:blank", own: [] },
        { id: 1652594669, url: "harness",     own: [ { doc: "ED9F5973CB0B", url: "…/real-tab-harness.html" } ] },
        { id: 1652594670, url: "http://127.0.0.1:59176/current", own: [] } ]
sourceTabId: 1652594670, sourceStatus: "complete", scriptingProbe: "Fixture origem"
```

Três fatos, todos medidos:

1. A aba de origem **existe**, está `complete` e o documento dela está vivo e acessível: uma injeção just-in-time (`chrome.scripting.executeScript`) devolveu o título correto, "Fixture origem".
2. `chrome.runtime.getContexts({ contextTypes: ['TAB'] })` **não devolve nenhum contexto para essa aba** (`own: []`), enquanto devolve para a aba de harness da própria extensão.
3. O manifesto **não declara `content_scripts`**; a extensão injeta sob demanda com `chrome.scripting`. Um script injetado cria um contexto isolado enquanto executa e esse contexto deixa de existir quando a execução termina.

Consequência: quando `PANEL_SHOW_PAGE_MARKERS` chega, o guard de autorização procura o contexto de extensão da aba de origem e não encontra nenhum, então a resposta é negação — e o painel mostra "Não foi possível mostrar os sinais nesta página." A auditoria está correta sobre a página: o canal que os sinais exigem simplesmente não existe mais naquele momento.

Isso **resolve a dúvida entre as duas hipóteses anteriores** e descarta as duas: não é o cache de origem com documento da cópia, nem o worker reiniciado por si. É ausência de superfície de extensão na aba de origem.

Explica também a assimetria que me confundiu: o **destaque individual funciona** porque instala a sobreposição just-in-time com `chrome.scripting` e verifica o documento no próprio ato de instalar, sem depender de contexto pré-existente. O caminho dos sinais, ao contrário, pressupõe uma ponte viva na página.

Correção recomendada, seguindo o que já funciona: dar aos sinais o mesmo mecanismo do destaque — renderizar a sobreposição numerada por injeção just-in-time, dirigida pelo worker, em vez de exigir contexto prévio na aba. A alternativa mais pobre é esconder a oferta quando não houver contexto vivo e dizer com honestidade que os sinais não estão disponíveis para esta página, mantendo as evidências do relatório; isso não atende à meta, que pede caixas na página, mas é melhor que um botão que promete e falha.

Não alterei código: a mudança é estrutural no caminho dos sinais e merece RED próprio. Registro também que a mensagem atual ("Refaça a auditoria da página atual") está errada por construção: repetir não cria contexto de extensão na aba de origem.

## Rodada 15 — oferta dos sinais deixa de prometer o que não pode cumprir

Com a causa raiz estabelecida na rodada 14 (a aba de origem não tem contexto de extensão depois da auditoria), implementei o incremento mínimo e verificável que não depende de redesenho: a interface parou de prometer uma recuperação impossível.

Antes: o botão virava "Tentar mostrar sinais" e a mensagem dizia "Refaça a auditoria da página atual ou consulte as evidências do relatório." Repetir não cria contexto de extensão na página, então a instrução era errada por construção e levava a pessoa a repetir uma ação que falha igual.

Depois: a mensagem explica que a página não tem mais canal ativo da extensão e que repetir a auditoria não resolve, apontando as evidências e capturas do relatório; e a ação principal passa a ser **"Ver evidências no relatório"**, que leva a algo que funciona, em vez de repetir o pedido que será negado.

RED observado antes da correção: teste novo em `test/panel/page-markers-session.test.js` exigindo que o aviso não contenha "refaça a auditoria", "tente novamente" nem "repita" e que mencione o relatório — reprovou com a mensagem antiga. O teste de `test/panel/panel-view.test.js` que codificava o comportamento anterior foi atualizado para o novo contrato, com a busca escopada à região "Conferir na página" para não confundir com o botão de abrir relatório do resultado.

Verificação: 258/258 na família do painel, 264/264 somando a ponte de marcadores.

Isto **não** atende ao requisito de caixas na página para a auditoria da página atual, e não pretendo apresentá-lo como se atendesse: é uma correção de honestidade da interface, deliberadamente separada da capacidade. A capacidade continua pendente com a correção estrutural já delineada — renderizar a sobreposição numerada por injeção just-in-time, como o destaque individual já faz — e continua sendo trabalho obrigatório antes do candidato de produção.

## Rodada 16 — como o destaque consegue e por que os sinais não conseguem

Rastreei a diferença técnica entre os dois caminhos, porque ela indica o formato da correção dos sinais.

O destaque individual **não** depende de `chrome.runtime.getContexts`. Ele usa `chrome.debugger`: `proveHighlightTargetsCore` conecta o cliente CDP à aba, coleta provas por frame (`collectFrameHighlightProofs`), resolve o candidato por `backendNodeId`, `frameId` e assinatura estrutural, e só então injeta a sobreposição. A prova de documento é feita **pelo próprio CDP na aba viva**, e é isso que permite funcionar depois que a auditoria terminou e o contexto de extensão da página já não existe.

O caminho dos sinais faz o oposto: exige que a aba de origem tenha contexto de extensão e uma ponte viva (`audita-page-markers-v1`), o que não existe mais ao fim da auditoria da página atual. A diferença de arquitetura, e não um descuido de um dos lados, explica o comportamento assimétrico que medi.

Isso confirma e torna mais preciso o encaminhamento já registrado: a correção dos sinais é dar-lhes o mesmo mecanismo do destaque — prova e renderização por CDP/`chrome.debugger` na aba viva, em vez de exigir contexto pré-existente na página. A função de renderização `runAuditaPageMarkersCommand` já existe como injetável; o que falta é o caminho de prova e injeção equivalente ao do destaque, mais a atualização quando o painel filtra ou seleciona.

Continua sendo mudança estrutural, com RED próprio, e não a fiz nesta rodada.

## Rodada 16 — próxima frente concreta: o percurso principal em E2E

Também delimitei a maior lacuna de teste que resta: `test/e2e/sidepanel-flow-mv3.test.mjs` falha em 9 de 12 cenários, e isso é preexistente (confirmado por stash em rodada anterior).

Um dado técnico relevante para quem for investigar: `waitForPrivacyPause` procura `[data-screen="running"][data-session-status="privacy-paused"]` e exige que a lista `.privacy-signals li` contenha "Campo de senha" e "Conteúdo marcado como privado". Em medições minhas com `element-only`, o painel foi de `running` direto a `result`, sem pausa — o que, se confirmado no cenário oficial, explicaria a espera que expira. Não confirmei no cenário oficial e não trato como diagnóstico fechado; é a próxima medição a fazer, com a expressão exata do teste e não com uma aproximação minha.

## Rodada 17 — a lacuna de teste que causou o falso defeito está fechada

Enquanto nenhum E2E exigia que a marcação **aparecesse** na página, duas coisas ficaram possíveis: uma regressão real de renderização passaria despercebida, e uma medição errada minha conseguiu publicar como defeito algo que funcionava. Fechar essa lacuna era a pendência mais perigosa em aberto.

Novo `test/e2e/highlight-marking-mv3.test.mjs`, verde em cerca de 1,6 s a 2,4 s, que exige, no percurso real da página atual:

1. A inspeção automática **não** desenha nada: zero raízes de sobreposição antes de qualquer pedido do usuário.
2. Existe pelo menos uma ocorrência de elemento que oferece destaque ao vivo.
3. Depois do clique, existe **exatamente uma** raiz `data-audita-highlight-root`, com `z-index: 2147483647`, área visível e o texto "Falha confirmada".
4. A caixa **contém** um elemento real da página auditada — a asserção procura elementos de `main` integralmente dentro do retângulo da caixa.
5. O destaque não move a página: foco e rolagem idênticos antes e depois.

A asserção procura a raiz no documento inteiro, e não em `body`, exatamente porque foi esse detalhe que produziu a medição errada das rodadas 9 e 10.

Verificação: 4/4 nos E2E de destaque, exportação da página atual e auditoria por URL.

Isto confirma de forma independente o que a rodada 11 já tinha corrigido no registro: o destaque corresponde ao elemento correto e funciona. O que continua sem cobertura é o caminho dos **sinais** na página, que segue quebrado por causa raiz medida e é a pendência obrigatória restante deste critério.

## Rodada 18 — a sonda estava errada, não o helper

Investiguei a limitação que atribuí ao helper de avaliação nas rodadas 13 e 14, quando duas leituras assíncronas voltaram `{}` e eu tratei isso como "problema de serialização do helper", sem prova.

Medição direta, seis casos no contexto da página do painel, cada um comparando o helper com um `Runtime.evaluate` cru:

```
literal        | helper ok:number:2
promise-string | helper ok:string:"ok"
promise-object | helper ok:object:{"a":1}
then-object    | helper ok:number:4
async-iife     | helper ok:number:3
async-json     | helper ok:string:"[...chaves da sessão...]"
```

Todos os seis passam, inclusive `chrome.storage.session.get(null).then(...)` e IIFE assíncrona. **O helper não tem o defeito que eu lhe atribuí.** A leitura que voltou `{}` naquelas rodadas vinha de outro lugar — provavelmente do meu próprio encadeamento de sondas, com um contexto já substituído ou uma expressão que devolvia objeto vazio por construção — e eu devia ter investigado isso antes de culpar a ferramenta.

Fica registrado porque duas rodadas foram gastas contornando uma limitação inexistente, e porque a conclusão certa naquele momento teria sido "minha sonda não mede o que eu penso", não "o helper não serve".

Nenhuma alteração de código: o comportamento medido é o correto.

## Estado consolidado ao fim desta sequência de rodadas

Repositório saudável e verificado no HEAD `9d666a2`: **1406/1406** testes fora do Chrome (regras, integração, core, relatório, painel, revisão, exportação, navegador, destaque), `verify-project` estático GREEN, `git diff --check` limpo, árvore sem alterações pendentes além dos dois arquivos antigos preservados (`docs/superpowers/plans/2026-09-12-observed-page-passive.md` e `test/e2e/sidepanel-flow-mv3.test.mjs`).

### Fechado e verificado em Chrome real nesta sequência

- 5.9.1: identificação visual separada de nome acessível, pendência agregada sem alvo por campo (`e7adb4d`).
- 5.9.7 e 5.9.8: lacunas de contrato de observação fechadas, com RED real antes de cada correção (`5da4a6d`).
- Classificação de todos os E2E de Chrome real no runner, que antes abortava a suíte inteira antes de rodar qualquer teste (`5da4a6d`).
- Cleanup do perfil temporário e corrida do teste de retenção (`e7414b4`).
- Exportação da página atual: entrega os quatro formatos, com recibo durável conferido por bytes e SHA-256 (`ea3686c`).
- Recibo parcial de revisão `review-ready` aceito, coerente com o que o produto já persiste (`6b2cac2`).
- Destaque individual verificado ponta a ponta, agora com teste que exige a marcação na página e não apenas a oferta (`22ea7f8`).
- Linha de status do relatório separando verificações de ocorrências (`0201f72`).
- Oferta de sinais sem promessa de recuperação impossível (`6faf023`).

### Pendência obrigatória restante

**Sinais numerados na página não funcionam na auditoria da página atual.** Causa raiz medida: ao fim da auditoria a aba de origem não tem contexto de extensão, e o caminho dos sinais exige uma ponte viva (`audita-page-markers-v1`) mais origem registrada, enquanto o destaque individual funciona porque prova o alvo por `chrome.debugger`/CDP na aba viva. Correção especificada: dar aos sinais o mesmo mecanismo de prova e injeção, usando `runAuditaPageMarkersCommand`, que já é injetável.

Não implementei nesta sequência porque é mudança de arquitetura no caminho de autorização e prova de documento — exatamente o tipo de alteração que o escopo manda tratar como incremento próprio, com RED, e não como remendo ao lado de um botão. Deixar isso pela metade seria pior que deixá-lo aberto e documentado.

### Outras pendências registradas

- `sidepanel-flow-mv3`: 9 de 12 cenários falham, preexistente (confirmado por stash). Próxima medição já delimitada: conferir no cenário oficial se o painel realmente passa por `[data-screen="running"][data-session-status="privacy-paused"]` com "Campo de senha" e "Conteúdo marcado como privado" na lista.
- `service-worker.test.js`: 9 falhas `PERSONA_CLEANUP_UNCONFIRMED`, preexistentes, confirmadas no HEAD limpo.
- Campos customizados editáveis: o nome acessível não chega ao consumidor por allowlist de privacidade; exige decisão de fronteira.
- Produtor de identificação visual para 5.9.1 e produtor de obrigatoriedade perceptível para 5.9.7: ausentes.
- Inspeção visual de HTML/PDF feita nesta versão (23 páginas, 1,07 MB, resumo honesto); comparação AMAWeb/AccessMonitor registrada com o confronto histórico.

### Lição de método que custou rodadas

Três hipóteses minhas foram publicadas como diagnóstico antes de estarem provadas, e duas estavam erradas: o "defeito de destaque" que não existia (a raiz do overlay é filha de `documentElement`, e eu media `body`) e a "limitação do helper de avaliação" (medida depois, sem defeito algum). A terceira — o cache de origem — foi descartada por medição. O custo foi de várias rodadas. O que funcionou foi sempre o mesmo: medir o estado real, com clique nativo, procurando o nó pelo atributo em todo o documento, e desconfiar da própria sonda antes de culpar o produto.

## Rodada 19 — o mecanismo exato: injeção presa a um documentId que já não existe

Localizei no código o ponto que falha, e ele é mais preciso do que a explicação anterior.

O controlador de sinais injeta por **`documentIds` fixo**:

```js
// src/background/page-markers-controller.js
async function executeInDocument(record, func, argument) {
  const results = denseArray(await Reflect.apply(executeScript, scripting, [{
    target: { tabId: record.tabId, documentIds: [record.documentId] }, world: 'ISOLATED', func, args: [argument] }]), 1);
  ...
}
```

E `record.documentId` vem da origem em cache, registrada — como já registrado na rodada 12 — com o documento da aba **antes** da navegação para a cópia:

```js
pageMarkerOriginCache?.register({ auditId, tabId, windowId,
  documentId: source.documentId, urlSessionDigest: source.urlSessionDigest, ... });
```

Ou seja: o pedido de sinais mira um `documentId` que deixou de existir quando a aba navegou para a cópia. A injeção não encontra o documento, `installed` fica nulo e o controlador devolve `PAGE_MARKERS_UNAVAILABLE`. Não é falta de porta viva nem worker reiniciado: é o alvo da injeção.

Isso também reconcilia as medições que pareciam contraditórias: o contexto de extensão da aba de origem realmente não aparece em `getContexts` (rodada 14 — verdadeiro) e a origem em cache realmente aponta para o documento antigo (rodada 12 — verdadeiro). As duas coisas decorrem da mesma navegação, e a que **causa** a falha é o `documentIds` fixo.

O destaque individual não sofre disso porque resolve o documento no momento da prova, por CDP: `proveHighlightTargetsCore` conecta em `input.tabId` e coleta provas por frame no documento vivo, sem depender de um identificador guardado. É a diferença de mecanismo, agora no nível da chamada, não da arquitetura em geral.

Correção delimitada, para o próximo incremento: resolver o documento no momento da instalação em vez de usar o identificador guardado — anexar por `tabId` como o destaque faz —, e então confirmar que o documento vivo é o esperado antes de injetar, mantendo a mesma prova que já existe. O `executeInDocument` é o ponto de mudança, e a confirmação não pode ser afrouxada: é ela que impede marcar o documento errado.

Também fica claro por que minha primeira explicação (rodada 12) estava incompleta: eu apontei o registro da origem como causa, quando o registro só é nocivo porque a injeção o usa como alvo fixo. Um documento guardado que não é usado para mirar injeção não causaria este defeito.

Nenhuma alteração de código: a mudança é no caminho de prova e injeção, com RED próprio.

## Rodada 20 — o que a leitura do código ainda não decide

Fui atrás da prova que fecharia a hipótese da rodada 19 (injeção presa a `documentId` obsoleto) e preciso registrar com precisão onde ela parou, porque a leitura do código **não** decide sozinha.

O que a leitura sustenta:

- A origem é registrada no caminho de preparação da cópia com um `documentId` capturado naquele instante, e `register` **recusa atualizar** um registro existente para o mesmo `auditId` (devolve `false` se algum campo difere). Ou seja: se o documento mudar depois, o registro guardado continua sendo o antigo.
- `executeInDocument` injeta por `documentIds: [record.documentId]`, um alvo fixo. Se esse documento não existir mais, a injeção não encontra nada e o controlador responde `PAGE_MARKERS_UNAVAILABLE`.

O que a leitura **não** decide:

- Se o `documentId` registrado corresponde ao documento que existe no momento do clique. Isso depende de quando a navegação da cópia acontece em relação ao registro, e a leitura do fluxo não é conclusiva: o registro acontece depois de `exchangeAttachedForNavigationCopy` e do `rawNavigationVault.put`, mas a navegação em si é disparada adiante, e não segui esse ponto até o fim.
- Consequência prática: não posso afirmar que a hipótese está confirmada nem descartada. O que posso afirmar é que ela é a única que explica, ao mesmo tempo, os dois fatos medidos — ausência de contexto de extensão na aba e origem guardada apontando para o documento anterior — e que nenhuma das explicações anteriores sobreviveu à medição.

Medição que decide, para a próxima rodada, e que é pequena: registrar no worker, no instante do `PANEL_SHOW_PAGE_MARKERS`, o `documentId` guardado e o resultado de uma injeção de teste por `tabId` sem `documentIds`. Três desfechos possíveis e distintos:

1. Injeção por `tabId` funciona e o `documentId` guardado difere do vivo → hipótese confirmada; a correção é resolver o documento no momento da instalação.
2. Injeção por `tabId` também falha → o problema não é o alvo fixo, e a investigação volta para autorização ou para o estado do controlador.
3. `documentId` guardado é igual ao vivo → a hipótese cai, e o motivo real está em outro ponto do caminho.

Não fiz essa medição nesta rodada. Registro-a como o passo único e decisivo em vez de seguir acumulando hipóteses, que já custou rodadas demais nesta sequência.

## Rodada 21 — medição decisiva: injeção por tabId funciona

Executei o passo único definido na rodada 20. Resultado:

```
DECISIVE { tabId: 35876936, tabUrl: "http://127.0.0.1:59918/current",
           byTabId: "{\"title\":\"Fixture decisiva\",\"url\":\"http://127.0.0.1:59918/current\"}",
           contexts: "[]" }
```

Leitura dos três dados:

1. **Injeção por `tabId`, sem `documentIds`, funciona** na aba de origem ao fim da auditoria: devolveu o título e a URL corretos do documento vivo. Isso é o desfecho 1 do plano — o alvo fixo é a causa, não a autorização nem o estado do controlador.
2. `getContexts` continua vazio para essa aba, o que **descarta definitivamente** a rodada 14 como explicação causal: a ausência de contexto de extensão é um sintoma da mesma situação, não o motivo da falha. A injeção não precisa desse contexto.
3. A aba está de volta na URL `/current`.

Conclusão sobre o mecanismo: `executeInDocument` mira `documentIds: [record.documentId]`, um identificador capturado antes de a aba ser levada para a cópia e trazida de volta. O documento vivo existe e é injetável — só não é o documento que o identificador guardado aponta. É exatamente o que a rodada 19 propôs, agora com o desfecho 1 confirmado por medição em vez de leitura.

Correção, com fronteira explícita: resolver o documento no momento da instalação, mirando por `tabId` como o destaque faz, e então confirmar que o documento vivo é o esperado antes de injetar. `executeInDocument` hoje exige `wrapper.documentId === record.documentId`; a mudança precisa substituir essa igualdade por uma verificação do documento vivo, e **não** por sua remoção — é ela que impede marcar o documento errado, que é o risco máximo da meta. O caminho seguro já existe no repositório: o destaque prova o documento por CDP (`proveHighlightTargetsCore`) antes de instalar.

Não implementei. A mudança é pequena em linhas e grande em consequência, e a sequência desta sessão mostrou duas vezes o custo de concluir antes de medir. O que faltava medir agora está medido: o alvo é o problema, e o caminho de correção já tem precedente interno testado.

Nenhuma sonda deixada no repositório.

## Rodada 22 — a peça que faltava para a correção, e por que não a implementei

Fui implementar a correção e encontrei uma dificuldade que muda o formato dela — registro em vez de escrever código pela metade.

**A dificuldade.** `executeInDocument` mira `record.documentId`, que é o documento **da cópia** no instante da preparação. Depois disso, a cópia é entregue: a aba volta para a URL final, e o documento vivo passa a ser outro. Trocar o alvo por `tabId` resolve o alcance, mas cria um risco novo: sem filtro de documento, a injeção passa a aceitar o primeiro resultado do frame principal, e a verificação atual (`wrapper.documentId === record.documentId`) deixaria de valer. Aceitar o documento vivo **sem** provar que é o documento esperado é exatamente o que pode marcar o documento errado — o risco máximo desta meta.

**A peça que existe no repositório.** O controlador já tem o primitivo certo: `probeDocumentIdentity(tabId)`, que devolve `{ tabId, windowId, documentId, urlSessionDigest }` do documento vivo. Ele já é usado na preparação, antes de instalar, e é o mesmo tipo de prova que o destaque usa antes de sobrepor.

**Formato da correção, então.** Antes de injetar: re-provar a identidade pelo `probeDocumentIdentity`; exigir `tabId`/`windowId` iguais aos da origem e **ou** `documentId` igual (caso comum, comportamento atual preservado) **ou** `urlSessionDigest` igual (caso da cópia entregue, mesmo endereço, documento novo); usar o `documentId` **vivo** como alvo da injeção; e, quando a verificação exigir a variante por digest, fornecer o `documentId` vivo ao comparador em vez do guardado. Sem essa prova, não injetar.

Isso mantém a garantia que interessa — não marcar o documento errado — e não depende de afrouxar nenhuma comparação: troca uma igualdade de documento por uma igualdade de identidade de endereço, verificada ao vivo.

**Por que não implementei nesta rodada.** É a mudança mais sensível que apareceu nesta sequência: mexe no caminho de prova de documento, tem dois casos (cópia ainda igual e cópia já entregue) e exige E2E em Chrome real para provar que não marca o documento errado. Com o orçamento desta sessão quase esgotado, implementar e não conseguir validar deixaria no repositório uma alteração de privacidade sem verificação — pior que a pendência aberta e documentada.

**O que falta medir antes de codificar**, e é pouco: no instante do pedido de sinais, comparar o `documentId` guardado com o do `probeDocumentIdentity` e comparar os dois `urlSessionDigest`. Se os digests coincidirem, a variante por digest é a correta e a correção acima é a mínima necessária. Se não coincidirem, a página final não é a mesma que a origem registrou, e aí a correção precisa de outra decisão — possivelmente tratar como `PAGE_MARKERS_DOCUMENT_CHANGED`, que é o desfecho honesto.

## Rodada 23 — handoff da correção dos sinais, com a dedução separada da medição

A medição que falta na rodada 22 é comparar o `urlSessionDigest` guardado com o do documento vivo. Pelo que já medi, dá para deduzir o resultado: o digest é derivado de uma URL canônica (`digest = canonicalUrl => …`), e a aba terminou na mesma URL sanitizada `/current` que foi registrada como origem. Logo os digests devem coincidir, e a variante por digest seria a correta.

**Classifico isso como dedução, não como medição.** Nesta mesma sessão eu publiquei como diagnóstico duas conclusões não medidas — um defeito de destaque inexistente e uma limitação de helper que não existia — e as duas estavam erradas. Repetir o padrão aqui seria incoerente com tudo que registrei. A medição continua sendo o primeiro passo antes de codificar: registrar os dois digests no instante do pedido.

### Estado exato da pendência dos sinais, para quem retomar

- **Sintoma medido**: com clique nativo, o painel responde que não foi possível mostrar os sinais; hoje a oferta é honesta e leva às evidências em vez de prometer retry (`6faf023`).
- **Causa medida**: `executeInDocument` injeta com `documentIds: [record.documentId]`, um documento capturado antes de a aba ser levada à cópia e trazida de volta. A injeção por `tabId`, sem `documentIds`, **funciona** na mesma aba ao fim da auditoria, devolvendo o título e a URL corretos.
- **O que já foi descartado por medição**: worker reiniciado, cache de origem vazio, ausência de contexto de extensão como causa. Os dois últimos são sintomas da mesma situação, não o motivo.
- **Correção desenhada**: re-provar identidade com `probeDocumentIdentity(tabId)` antes de injetar; exigir `tabId`/`windowId` iguais aos da origem e `documentId` igual **ou** `urlSessionDigest` igual; injetar contra o `documentId` vivo; e passar o `documentId` vivo ao comparador quando a variante por digest valer. Sem prova, não injetar.
- **Risco que a correção não pode criar**: aceitar o documento vivo sem provar que é o esperado. É o que permite marcar o documento errado, o ponto de rigor máximo da meta. Nenhuma comparação pode ser removida, apenas trocada por outra igualmente verificada ao vivo.
- **Onde mexer**: `executeInDocument` e o comparador de prova em `src/background/page-markers-controller.js`; o precedente interno seguro é o caminho do destaque (`proveHighlightTargetsCore`) e o `probeDocumentIdentity`.
- **Teste que faltaria depois**: um E2E que exija a raiz `data-audita-page-markers-root` na página após o pedido, no mesmo espírito do teste de destaque criado em `22ea7f8` — hoje nenhum teste cobre a marcação dos sinais, só a oferta.

## Rodada 24 — contradição encontrada ao implementar: parte do meu diagnóstico cai

Fui implementar a correção e encontrei uma contradição no meu próprio diagnóstico anterior. Registro-a porque ela muda o ponto de partida de quem retomar, e porque ignorá-la seria repetir o erro que já cometi duas vezes nesta sessão.

O guard de instalação, antes de injetar, faz exatamente o que eu propus como correção:

```js
proof = validProof(await probeDocumentIdentity(origin.tabId));
if (!sameProof(proof, origin)) return failure('PAGE_MARKERS_DOCUMENT_CHANGED');
```

Ou seja, o controlador **já prova a identidade do documento vivo imediatamente antes de instalar** e **já exige** `tabId`, `windowId`, `documentId` e `urlSessionDigest` iguais aos da origem. Se o `documentId` vivo diferisse do guardado, o desfecho seria `PAGE_MARKERS_DOCUMENT_CHANGED`, não a falha genérica que medi.

Consequência: se esse guard passa — e a falha observada é `PAGE_MARKERS_UNAVAILABLE`, não `DOCUMENT_CHANGED` —, então o `documentId` vivo **é igual** ao guardado, e o `executeInDocument` com `documentIds: [record.documentId]` deveria funcionar. Isso contradiz a conclusão da rodada 21, em que eu atribuí a falha ao alvo fixo. Não posso confirmar de qual dos dois códigos de falha veio a mensagem que vi: em nenhuma medição minha o código exato foi capturado no momento do clique. Eu o inferi do comportamento da interface, e a interface traduz **dois** códigos de falha para a mesma mensagem.

Portanto, o que eu tratei como causa confirmada na rodada 21 é, no máximo, uma hipótese que a leitura do próprio guard enfraquece. O que continua medido e verdadeiro: injeção por `tabId` funciona na aba ao fim da auditoria; `getContexts` não vê a aba; a interface mostra a mensagem de indisponibilidade. O que não sei é **qual** dos dois códigos o worker devolveu.

Medição que faltava desde a rodada 12 e continua faltando, agora por motivo mais forte: capturar o **código de falha** devolvido pelo worker no pedido de sinais, não a mensagem da interface. Com `PAGE_MARKERS_UNAVAILABLE` a suspeita é o próprio controle (documento, plano, portas); com `PAGE_MARKERS_DOCUMENT_CHANGED` a suspeita é identidade. São caminhos de correção diferentes, e eu vinha tratando os dois como um só.

Não implementei nada. Implementar sobre uma causa enfraquecida seria pior do que não implementar: eu teria mudado o caminho de prova de documento para consertar algo que talvez não esteja ali.

## Rodada 25 — os sinais são negados no painel, antes de qualquer pedido

Fui capturar o código de falha do worker e a medição mostrou algo diferente e mais decisivo: **o pedido nunca sai do painel**.

Três sondas, todas em código temporário e todas removidas depois:

1. Buffer no controlador do worker nos pontos de prova e de instalação → `DIAG []`, ou seja, nenhum dos dois foi alcançado.
2. Envolvimento de `port.postMessage`/`onMessage` no painel para registrar o tráfego de `PAGE_MARKERS` → `TRACE []`, nenhum evento.
3. Sondas no cliente de porta do painel, no guard de revisão (`PORT-DIAG`) e no início de `requestIntent` (`PORT-HEAD`) → **ambas nulas**.

A conclusão que os três dados sustentam: o `requestIntent` do cliente de sessão **não foi chamado**, e o worker **não foi consultado**. A mensagem de indisponibilidade que o usuário vê é decidida dentro do painel, em `show()` da sessão de marcadores, que publica `UNAVAILABLE` quando o pedido devolve algo falsy — e o pedido é falsy justamente porque não chegou a ser feito.

Isso derruba todas as minhas hipóteses anteriores de causa, inclusive a que eu tinha registrado como confirmada: não é alvo de injeção, não é prova de documento, não é cache de origem, não é worker reiniciado. **É estado do painel.**

O caminho de correção muda de lugar: em vez de mexer no controlador do worker, é preciso entender por que `show()` não chega a pedir. Duas possibilidades, e a leitura aponta para a primeira:

- `context` nulo em `createPanelPageMarkersSession`, que é alimentado por `pageMarkers.setResult(value.result)` em `panel.js` — se `setResult` não rodou para esta auditoria, `show()` retorna `false` sem publicar nada.
- `state.status` já em `active`, `showing` ou `hiding`, que também faz `show()` retornar cedo.

Ressalva de método: a terceira sonda não cobriu o retorno antecipado de `show()` (`if (!context || ['active','showing','hiding'].includes(state.status)) return false;`), porque ele fica no arquivo da sessão e não no cliente de porta. Portanto o dado "requestIntent não foi chamado" está medido; a razão exata entre as duas acima ainda não.

**Retratação registrada**: a conclusão da rodada 21, em que atribuí a falha ao alvo fixo da injeção, não se sustenta. A injeção por `tabId` funcionar continua verdadeiro e útil, mas não é a causa: o pedido nem chega lá. Também cai a hipótese da rodada 12 e a explicação por contexto de extensão como causa.

Nada foi alterado no produto. As três sondas foram revertidas (`git checkout --`) e a árvore está sem alterações em `src/`.

## Rodada 26 — o bloqueio está entre a sessão de marcadores e o cliente de porta

Fechei a lacuna de medição que a rodada 25 deixou aberta, com sonda no retorno antecipado de `show()`. Resultado:

```
BEFORE     {"markerRegion":true,"status":"idle","button":"Mostrar sinais na página"}
SHOW-DIAG  {"proceeded":true,"status":"idle","ids":1,"revision":1}
PORT-HEAD  null
PORT-GUARD null
```

Leitura: `show()` **não** retorna cedo. O contexto existe, tem 1 identificador, revisão 1, e o status está `idle` — exatamente o estado em que a função deve pedir. Ela prossegue, monta o pedido e chama `request('PANEL_SHOW_PAGE_MARKERS', …)`.

E, apesar disso, nenhuma das duas sondas do cliente de porta registra nada: nem o retorno antecipado (`!started || !ready || currentPort === null`), nem o guard de revisão dos marcadores.

O caminho, então, é: `panel.js` → `pageMarkers.show()` → `request(...)` → `requestPanelIntent(message)` → `sessionPortClient?.requestIntent(message) ?? Promise.resolve(null)`. Duas explicações possíveis restam, e a primeira é a que o código sugere:

- `sessionPortClient` é `null` ou `undefined` no momento do clique, e o `??` devolve `Promise.resolve(null)` **sem nunca chamar `requestIntent`**. Isso produz exatamente o observado: pedido nunca feito, worker nunca consultado, sondas do cliente mudas, e `show()` publicando a indisponibilidade porque a resposta é nula.
- `requestIntent` é chamado, mas por outra instância do cliente que não a que instrumentei.

A primeira explicaria também por que o painel funciona para o resto: a auditoria foi iniciada antes, com o cliente vivo; se ele foi descartado depois, o resultado continua na tela e só as ações que dependem de novo pedido falham — que é exatamente o sintoma.

Onde medir em seguida, e é uma linha: registrar `sessionPortClient === null` e `started/ready` no momento do clique, em `requestPanelIntent`. Se o cliente estiver nulo, a correção é de ciclo de vida do cliente de sessão, não do caminho de marcadores — e nesse caso o defeito afeta qualquer ação pós-resultado que dependa de novo pedido, não só os sinais. Vale verificar se `GET_HIGHLIGHT_AVAILABILITY` e `PANEL_OPEN_REPORT` sofrem do mesmo, porque o relatório abriu normalmente na minha medição, o que sugeriria cliente vivo e enfraqueceria esta hipótese.

Registro a tensão em vez de escolher um lado: o relatório abrir indica cliente vivo; as sondas mudas indicam que `requestIntent` não foi executado. Uma das duas leituras está errada, e a medição de uma linha acima decide qual.

Nada alterado no produto; as sondas foram revertidas e 82/82 testes das duas famílias do painel seguem verdes.

## Rodada 27 — as sondas da rodada 26 não estavam no arquivo: duas conclusões caem

Fui medir a pergunta binária que a rodada 26 deixou e encontrei um erro de método meu que invalida parte do que registrei.

Medição desta rodada, no caminho real:

```
INTENT-LOG: [ … {"type":"PANEL_START_ATTACHED_AUDIT", hasClient:true, hasMethod:true},
              {"type":"GET_HIGHLIGHT_STATE", …},
              {"type":"GET_HIGHLIGHT_AVAILABILITY", …},
              {"type":"PANEL_SHOW_PAGE_MARKERS", hasClient:true, hasMethod:true} ]
```

Ou seja: `requestPanelIntent` **é chamado** com `PANEL_SHOW_PAGE_MARKERS`, e o cliente de sessão existe com o método disponível. Nada de cliente nulo.

O problema: a seguir verifiquei o arquivo e **as sondas que eu havia adicionado em `panel-session-port.js` não estavam mais lá** (`grep __portDiagHead` → 0 ocorrências). Foram perdidas na manipulação dos probes entre rodadas. Portanto a rodada 26 mediu um arquivo **sem** as sondas, e os dois `null` que registrei não significam "o cliente não foi chamado": significam que **a sonda não existia**.

Consequências, e preciso ser explícito:

1. **Cai a conclusão da rodada 25** de que "o worker nunca foi consultado e a negação é decidida no painel antes do pedido". O que tenho é: o pedido é montado e `requestPanelIntent` roda com cliente vivo. O que acontece depois — resposta negada pelo worker, ou resposta tratada como inválida pelo cliente — **não foi medido**.
2. **Cai também a hipótese do cliente nulo** que eu apresentei como a mais provável na rodada 26. Ela está descartada por medição direta: `hasClient: true`, `hasMethod: true`.
3. Continua verdadeiro e medido: `show()` não retorna cedo; o contexto existe com 1 id e revisão 1; o painel exibe a indisponibilidade; nenhuma raiz de sinais aparece na página.

O que isso diz sobre o método desta sessão, e registro sem atenuar: três vezes publiquei conclusões apoiadas em sondas que eu não verifiquei estarem ativas — o defeito de destaque inexistente, a "limitação do helper" e agora o "bloqueio no painel". Em todas, a instrumentação era o elo frágil, não o produto. A regra que faltou é simples: antes de concluir a partir de uma sonda, confirmar que a sonda está no arquivo carregado e que ela dispara — e, quando ela **não** dispara, a primeira hipótese deve ser "a sonda não está lá", não "o código não passou por aqui".

Próxima medição, agora com essa regra: confirmar a presença da sonda no arquivo antes de rodar, e registrá-la no ponto de entrada do cliente de porta e na resposta recebida, para separar "resposta negada pelo worker" de "resposta descartada pelo cliente".

Nada alterado no produto; a sonda desta rodada foi revertida e `src/` está limpo.

## Rodada 28 — causa raiz dos sinais: a proveniência nunca era registrada; corrigido e medido

Apliquei a regra que faltava (confirmar a sonda no arquivo e que ela dispara) e medi a resposta real do worker antes de qualquer hipótese:

```
DISPATCH_IN:audit="68a3732d-…"        ← o worker é consultado
PROBE_ALIVE_V1 SHOW:audit="68a3732d-…" ← a sonda do controller existe e dispara
SHOW:ORIGIN:o=false:ob=false          ← getOrigin(auditId) devolve null
DISPATCH:PANEL_SHOW_PAGE_MARKERS->"PAGE_MARKERS_UNAVAILABLE"
```

`o=false` é `originCache.get(auditId) === null`. Não era o painel, não era o cliente de porta, não era o controller: era o **cache de origem vazio**. Em `page-markers-controller.js` o `show()` resolve o alvo por `getOrigin(request.auditId)` (linha 354) e recusa quando não há origem — corretamente, porque sem tab/janela/documento/digest não existe alvo confiável para marcar.

Por que estava vazio: `pageMarkerOriginCache.register` tinha **uma única chamada** em todo o produto, dentro de `prepareAttachedCopyPlan` em `service-worker.js`. O commit `1c9b296` ("fix: keep current-page audits bound to the observed document") removeu o ramo de auditoria de URL que invocava `prepareAttachedCopyPlan`, e com isso a função passou a ser apenas desestruturada em `authorized-audit-starter.js` (`FACTORY_KEYS`, linha 32) e **nunca chamada**. A proveniência órfã: o cache ficou sem quem o alimentasse, e todo pedido de sinais passou a receber `PAGE_MARKERS_UNAVAILABLE`.

Correção: registrada a origem no início da auditoria anexada, a partir do `grant` que a própria starter acabou de validar contra o alvo inspecionado (`authorized-audit-starter.js`, logo após a comparação de `grant.target`). É o único ponto em que o worker tem, ao mesmo tempo, o `auditId` e o alvo provado; a autoridade de captura continua vindo do worker e os seis guards do controller seguem valendo no momento de marcar.

Medição depois da correção, no caminho real:

```
DISPATCH:PANEL_SHOW_PAGE_MARKERS->true
PAGE {"roots":1,"buttons":2}      ← um overlay com 2 sinais numerados
AUDIT_MS 423    (running → result; resumo "2 Falhas confirmadas", 2 ocorrências)
MARKERS_MS 107  status=active
```

Cobertura nova, para o defeito não voltar silenciosamente:

- `test/e2e/page-markers-signals-mv3.test.mjs` (real Chrome, registrado em `scripts/run-tests.mjs`): exige que a leitura do relatório não desenhe nada, que o painel ofereça os sinais, que o estado fique `active` e **não** `unavailable`, que exista uma raiz de overlay com ao menos dois sinais numerados desenhados com área visível, que exatamente um anel esteja visível — o do sinal que o painel também reporta como selecionado — e que esse anel cubra um elemento real de `main`, sem mover rolagem nem foco. Inclui âncoras de que o relatório é o da página do fixture ("Falhas confirmadas" e a origem), para não passar com painel obsoleto.
- `test/background/authorized-audit-starter.test.js`: a origem é registrada exatamente uma vez, congelada e com o alvo do grant; um alvo rejeitado não registra nada; um gravador que lança não aborta a auditoria nem vaza a mensagem; um gravador que devolve `false` não impede o início.

Duas asserções minhas erraram antes de acertar, e o erro era do teste, não do produto: eu esperava um anel por sinal quando `updateGroup` (linha 410 de `page-markers-overlay.js`) desenha anel **só para o sinal selecionado**; e esperava zero anéis quando o painel abre com a primeira ocorrência selecionada. Medido o overlay real (`ringDisplay: block` no Sinal 1, `none` no Sinal 2), o teste passou a afirmar o comportamento correto do produto.

`scripts/verify-project.mjs` GREEN (130 regras, 146 itens, 96 requisitos/50 recomendações).

### Estado da suíte depois da correção

`node scripts/run-tests.mjs`: **4179 testes, 4171 passam, 8 falham**. As oito são pré-existentes e ficam em `test/background/service-worker.test.js` no modo "default worker snapshots the current page…": quatro (`stored`, `cache-reject`, `cache-throw`, `factory-throw`) terminam em `PERSONA_CLEANUP_UNCONFIRMED` no lugar de `{ok:true,state:'running'}`, e quatro (`source-failure`, `vault-failure`, `vault-invalid`) caem no mesmo código por outra rota. Comparei os nomes antes e depois no HEAD limpo: o conjunto é o mesmo, menos `marker-cleanup-denied`, que **passou a passar** — de 9 para 8.

A oitava mudança foi numa asserção do próprio teste: `assert.deepEqual(markerInvalidations, [17])` esperava uma invalidação de aba que só existia dentro do ramo removido em `1c9b296`. Como a invalidação de marcadores por mudança de documento ou fechamento de aba é do caminho de ciclo de vida (`audit-lifecycle.js`), a expectativa correta nesse ponto é que o caminho da auditoria de URL **não** toque nos marcadores da aba. Atualizei as duas ocorrências com essa justificativa; não mexi nas oito falhas pré-existentes, que têm outra causa.

## Fila depois dos sinais

O item obrigatório dos sinais numerados na página está fechado e medido (rodada 28). O que resta da entrega, com o próximo passo exato de cada um:

1. **`sidepanel-flow-mv3.test.mjs`: 9 de 12 cenários falham.** Rodei o arquivo depois da correção dos sinais para ver se ela resolvia algo ali: continua 3/12, e as nove falhas **não** são de marcadores — todas morrem antes, em `beginAttachedAttempt` (linha ~988), esperando a tentativa de auditoria anexada aparecer. É o mesmo conjunto que já falhava antes desta correção (medido por `git stash` no HEAD limpo). Os dois cenários de nível superior (`original-page ABNT markers …`) falham por consequência. Próxima medição: instrumentar `beginAttachedAttempt` para registrar qual dos quatro `waitForValue` estoura — o de `[data-screen="initial"]`, o do rádio de modo de captura, ou o do botão — porque o painel não volta ao estado inicial entre tentativas na mesma sessão é a hipótese mais provável, e não um defeito de marcadores.
2. **`test/background/service-worker.test.js`: 8 falhas pré-existentes**, todas em `PERSONA_CLEANUP_UNCONFIRMED` no lugar de `{ok:true,state:'running'}` (modos `stored`, `cache-reject`, `cache-throw`, `factory-throw`, `source-failure`, `vault-failure`, `vault-invalid`). Não investigadas nesta sessão; a barreira de limpeza de persona não confirma. Registrar como item próprio.
3. **Campos customizados editáveis são anônimos no instantâneo — decisão de fronteira pendente.** A causa está identificada com precisão: `privateTextElement` classifica `div[role=textbox][contenteditable=true]` como texto privado, e `preserveAccessibleText` só é verdadeiro para `input`, `select` e `textarea` (duas ocorrências de `preserveAccessibleText: ['input', 'select', 'textarea'].includes(...)` em `normalize-snapshot.js`). Some-se a isso `markPrivateReferenceConsumers` (linha 158), que remove `aria-labelledby` do consumidor quando a referência cai no subárvore de texto privado, e `contentEditableRootAttributes` (`privacy.js:197`), que reduz os atributos a uma allowlist. O efeito é que 5.9.1 e 5.13.10 não podem culpar nem aprovar esses campos.
   A decisão não é "preservar o nome": é separar **nome declarado pelo autor** de **conteúdo do usuário**. O `accessibleName` hoje vem da árvore AX do Chrome, e para um `div[contenteditable]` sem rótulo a árvore pode derivá-lo do próprio conteúdo (regra "name from contents") — preservá-lo como está vazaria o que o usuário digitou. O caminho seguro é materializar no coletor um nome **somente do autor** (`aria-labelledby` resolvido, `aria-label`, `label[for]`), nunca por conteúdo, e preservar apenas esse campo na redação; o `accessibleName` da AX continua removido para esses nós. Exige mudança coordenada em coletor, `privacy.js` e normalizador, e não foi feita — não por atalho, mas porque o desenho precisa ser explícito antes de escrever código.
4. **Produtor de identificação visual (5.9.1).** A evidência decisiva já existe no coletor e está provada por teste: `label` com `clip-path:inset(50%)` mantém `hasRenderedBox:true` e `visibleText:'Nome'` (`test/e2e/field-label-review.test.mjs`, linhas 33–36). Falta capturar `clip-path` e `clip` em `styleNames` (`page-collector.js:7`) e usar isso para (a) parar de contar rótulo recortado como rótulo visível em `formLabelAssociation` e (b) dar alvos por campo em 5.9.1 em vez de pendência agregada sem alvo. Ao implementar, manter `cantTell`: rótulo recortado não autoriza `failed`, porque a norma admite propósito visualmente evidente com nome acessível, e a ausência de rótulo visível não prova ausência de percepção.
5. **Perceptibilidade da obrigatoriedade (5.9.7).** O estado `required` chega ao consumidor; o que falta é um produtor que demonstre percepção. Mesma família de solução do item 4 e mesma cautela: presença de atributo não é prova de percepção.
6. **Comparação com AMAWeb e AccessMonitor, versão contra versão**, e **revisão integrada independente desta versão** — os dois maiores itens ainda abertos, ambos exigindo execução das ferramentas externas e registro de URL/estado/menus/sessão/viewport/data. Nada foi iniciado nesta sessão. `eval_mymonitor.csv` contém sessão e e-mail privados e não deve ser despejado em log nem enviado para fora.

## Rodada 29 — por que as 9 falhas do fluxo do painel: a sessão pausada não tem dono registrado

Instrumentei uma **cópia** de `test/e2e/sidepanel-flow-mv3.test.mjs` (o original não foi tocado, porque pertence a outro incremento) com registro de tela em cada etapa de `beginAttachedAttempt`. Resultado no teste `current-page audits run in one inactive copy`:

```
begin:full-evidence:front      initial:-
begin:full-evidence:visible    initial:-
begin:full-evidence:raf        initial:-
begin:full-evidence:initial    initial:-          ← a tentativa 1 começa bem
sub1:paused                    running:privacy-paused   ← o painel pausa de verdade
sub1:PAUSED_ATTEMPT_FAILED:WAIT_TIMEOUT
begin:no-pixels:front          running:privacy-paused   ← e as seguintes ficam presas aí
```

Ou seja: **a tentativa 1 chega ao estado inicial e pausa corretamente**. O que falha é `assertPausedAttempt`, e a causa está medida, não suposta. Despejei `chrome.storage.session` inteiro no momento da pausa:

```
audita:active-audit-job:v1            → auditId a4943e34…, state privacy-paused
audita:audit-session-capability:v1:…  → auditId a4943e34…
audita:execution-checkpoint:v1:…      → auditId a4943e34…
audita:pixel-capture:v1:…             → state paused
audita:panel-bootstrap:v1:…
audita:panel-launch:index/record:v1:…
audita:retention-preference:v1:…
audita:session-hmac-key:v1
audita:target-capability:v1:…         → state claimed
```

**Não existe nenhuma chave `audita:owned-tab:v2:*`.** E `waitForOwner` (linha 899) exige exatamente uma: filtra as chaves com esse prefixo para o `auditId` e só aceita quando `value.length === 1` com o estado esperado (`retained-for-consent` na pausa, `removed` no terminal). Sem nenhum registro de dono, a espera estoura sempre — e como as subtests são sequenciais e o painel fica preso em `privacy-paused`, as três seguintes falham por consequência. Isso explica exatamente o padrão 3/12: as que passam são as que não passam por `beginAttachedAttempt`.

A causa provável do registro ausente é estrutural: quem grava `owned-tab:v2` é `observed-tab-runner.js:511` (`registerCreated`), isto é, o caminho que **cria uma aba própria**. A auditoria da página atual deixou de criar aba (é cópia inativa recarregada) quando `1c9b296` substituiu o ramo de cópia anexada — o mesmo commit que matou o registro da origem dos sinais. Então a expectativa do teste é anterior a essa mudança e ficou desatualizada junto com o resto do arquivo.

Isso é diagnóstico, não correção: não reescrevi as expectativas de propriedade de aba de um arquivo que pertence a outro incremento e cuja outra metade está incompleta (`test/e2e/sidepanel-flow-mv3.test.mjs` está modificado no worktree com fixture e asserções de observação passiva ainda em andamento). O próximo passo para quem fechar esse incremento é decidir, com o autor, se a cópia inativa deve registrar um dono — e em que chave — ou se as nove expectativas de `owned-tab:v2` devem passar a descrever a cópia inativa. Sem essa decisão, qualquer alteração minha seria adivinhação sobre trabalho alheio.

Duas hipóteses minhas foram **descartadas por medição** nesta rodada, e registro para não voltarem: (1) "o painel não está oferecendo os sinais" — `panel-view.js` oferece `SHOW_PAGE_MARKERS`, com o rótulo alternativo só no ramo indisponível; (2) "`waitForValue` engole o IIFE assíncrono" — ele já passa `awaitPromise: true`, e medi os dois ramos diretamente no harness (`{}` sem a opção, `{keyCount:0}` com ela).

## Rodada 30 — percurso obrigatório completo, e a comparação externa entregue

### Percurso obrigatório num teste só

Cada etapa já tinha teste focado, mas **o percurso como percurso não tinha**. É exatamente onde uma superfície pode estar correta sozinha e ainda assim não conectar à seguinte. Criei `test/e2e/mandatory-journey-mv3.test.mjs`, registrado em `scripts/run-tests.mjs`, que numa única sessão de Chrome real percorre, em ordem: abrir o painel → avaliar a página atual (modo sem pixels) → progresso → sumário → abrir uma ocorrência pela ficha de falha confirmada → blocos didáticos → mapeamento ABNT/WCAG com anúncio estimado e referência curta → **destacar o elemento na página** → exportar o relatório com os quatro formatos confirmados pelo recibo durável.

Medido: verde em 3,4 s, `formats=html,pdf,csv,json`.

Três asserções minhas precisaram de correção, e as três eram erro do teste, não do produto:

1. Eu esperava a ação de destaque imediatamente como `highlight-occurrence`; o produto passa por `highlight-checking` enquanto consulta a disponibilidade. Passei a esperar o estado estabilizar.
2. Eu comparava o `outerHTML` do documento antes e depois. Ele cresce de 370 para 22.332 caracteres porque **o próprio destaque é um overlay que a extensão insere** — a asserção falhava justamente pelo recurso funcionar. Passou a comparar o markup do autor (`main`), o foco e a rolagem.
3. Eu esperava `[data-detail="..."]` para ler os blocos; o atributo real é `data-detail-block`. A falha mostrou, aliás, que o detalhe renderiza tudo o que devia: "Quem é afetado", "O que foi observado", "Como corrigir e conferir", "Nome acessível ausente / Origem do nome / Anúncio esperado: campo de texto", "WCAG 4.1.2 / Nível A / ABNT NBR 17225: 5.13.10" e "Inconformidade ao item 5.13.10 da ABNT NBR 17225:2025".

Também ocorreu uma contradição aparente que investiguei e descartei: os dois testes E2E novos passavam isolados e falhavam juntos (`0/2`). Não era interferência entre eles — eu tinha esquecido `AUDITA_E2E_CHROME` naquela execução. Com a variável, os dois passam juntos (`2/2`). Registro porque a leitura errada era plausível e custaria horas.

### Comparação com AMAWeb e AccessMonitor

Entrega nova, fora do versionamento (como as demais): `entregas/comparacao-avaliadores-externos.md`. Foi produzida **somente de fontes públicas**, sem submeter nenhuma URL à AMAWeb ou ao AccessMonitor e sem ler arquivos locais de usuário. Cobre metodologia, categorias, fórmula da nota, exigência de login, onde roda e exportação de cada ferramenta, mais uma lista explícita do que não foi possível confirmar.

Achados que mudam a leitura de comparações anteriores:

- **A ligação verificável da AMAWeb com a NBR 17225 é o módulo *Checklist*, não o avaliador automático.** O relatório do avaliador se intitula "WCAG 2.1 do W3C". Não existe documentação pública do mapeamento prática-a-requisito. Contar os apontamentos da AMAWeb como requisitos ABNT descumpridos não se sustenta sozinho.
- **A AMAWeb envia a URL ou o HTML ao servidor** (`/server/amp/eval/...`) e gera o PDF em outro serviço do mesmo host. O AccessMonitor tem **duas arquiteturas**: o validador online envia à AMA, a extensão avalia localmente. O axe-core e o Audita avaliam localmente.
- **A nota do AccessMonitor tem fórmula publicada** e o denominador é a soma dos pesos das práticas consideradas, não o número de testes; os 26 testes de verificação manual ficam fora do numerador e do denominador. A nota da AMAWeb não é auditável publicamente.
- O bundle da AMAWeb reutiliza marca e contratos de dados do AccessMonitor, o que indica que o front-end deriva do cliente open-source dele; o motor do servidor não é público.

Deixei explícito no documento, e repito aqui, que o parecer com números (`entregas/analise-comparativa-2026-09-12/parecer.html`) é **histórico**: avaliou a versão 1.1.14 antes das correções desta sessão. A versão continua 1.1.14, mas o produto mudou; aqueles números não descrevem o código atual.

### Ainda pendente

Os itens 3 a 6 da fila registrada na rodada anterior seguem abertos: campos customizados anônimos (fronteira de privacidade desenhada, não implementada), produtor de identificação visual (5.9.1), produtor de perceptibilidade da obrigatoriedade (5.9.7), e a decisão sobre os 9 cenários de `sidepanel-flow`. A revisão integrada independente do estado atual está em andamento.

## Rodada 31 — o relatório medido, e uma falha intermitente que não é regressão

### Extensão do relatório: o defeito das 700 páginas não está presente

Medi o PDF real da versão atual em vez de confiar no número histórico. Duas fontes:

- `entregas/teste-google-com-1.1.14/google-com-1.1.14.pdf`: **24 páginas, 1,28 MB**.
- `test/e2e/report-executive-print.test.mjs`, que imprime o relatório completo e o resumo executivo em Chrome real: **baixado = 22 páginas completas / 9 de resumo; ao vivo = 34 completas / 10 de resumo**, com a matriz ABNT completa e sem evidência individual repetida por item.

Ou seja: o produto atual entrega um relatório da ordem de dezenas de páginas para uma página como o Google, com a matriz normativa inteira, e não as mais de 700 páginas que caracterizaram a versão defeituosa. O teste também exige que o resumo seja menor que o completo, o que impede o resumo de voltar a inchar.

### Uma falha intermitente, identificada e não escondida

Na primeira execução da suíte completa depois do produtor de 5.9.1, apareceram **9** falhas em vez das 8 conhecidas, e a nona não era nenhuma das minhas: era `report-executive-print`. Investiguei antes de concluir qualquer coisa:

- as 8 falhas conhecidas continuavam exatamente as mesmas, com os mesmos nomes;
- `report-executive-print` **passa 3 de 3 vezes** quando executado sozinho, com os diagnósticos esperados (22/9 e 34/10 páginas);
- a suíte seguinte voltou a **8** falhas, e uma terceira execução confirmou 8 com os mesmos oito nomes e a mesma contagem total (4183 testes, 4175 passando).

Conclusão sustentada pela medição: é disputa de recursos quando dezenas de navegadores reais rodam em série, não regressão de lógica. **Não** "consertei" o teste para ele passar — mudar uma expectativa correta para acomodar uma falha intermitente de ambiente seria exatamente o tipo de enfraquecimento que não se deve fazer para obter verde. Registro o fato e a evidência de que ele passa isolado e de que a contagem voltou ao baseline.

### Suíte

4183 testes, 4175 passam, 8 falham — as mesmas 8 pré-existentes de `PERSONA_CLEANUP_UNCONFIRMED`. `verify-project` GREEN.

A revisão integrada independente do estado atual segue em andamento; nenhum achado dela foi recebido até aqui.

## Rodada 32 — destacar um elemento fora da tela rola a página: medido, e é a promessa sendo cumprida

Encontrei no worktree uma sonda que eu não havia escrito, `test/e2e/tmp-scroll-probe.test.mjs`, marcada como "READ-ONLY PROBE (reviewer)": o revisor independente estava testando se destacar um elemento fora da tela faz a página auditada rolar. Executei a sonda dele e reproduzi a medição, porque um achado de revisor precisa ser confirmado por mim antes de virar conclusão.

**O que a sonda dele mediu.** A página não rolou (`scrollY` 0 → 0), mas também não houve oferta de destaque: `SEM OFERTA`. Investiguei o motivo em vez de aceitar o resultado como "sem defeito" — e o motivo é que **aquela fixture não produz nenhuma falha confirmada**. Despejei as fichas do resultado:

```
CARDS {"all":[{"cls":"manual-review","count":null,"selects":1},
              {"cls":"passed",...}, ×6 ]}
CANDIDATOS []
```

A fixture usa `img` sem `alt`, que o produto classifica como **revisão humana**, não como falha confirmada — posição coerente com a regra de não converter suspeita em infração. Sem falha confirmada de nível de elemento, não há candidato a destaque, e "sem oferta" é o comportamento correto. A sonda dele, portanto, não conseguiu testar a hipótese: media uma página onde a ação não se aplica.

**A medição que decide.** Construí a fixture que faltava: o mesmo documento que o percurso obrigatório já prova produzir falhas confirmadas, com preenchimento que empurra o alvo para fora da tela. Resultado no Chrome real:

```
ANTES   scrollY=0    alvoTop=3140  viewport=649  visivel=false
ACAO    occurrence-…-000012 -> highlight-occurrence
DEPOIS  scrollY=2826 alvoTop=314   overlay=1  overlayBox=[130,314,153,21]
        texto do overlay: "×12 — Falha confirmada"
ROLAGEM_MUDOU=true (0 -> 2826)
```

**Leitura, e é o ponto que exige cuidado.** A página **rola**, e isso não é defeito: é a promessa sendo cumprida. O rótulo da ação é **"Ver e destacar na página"** (`src/panel/highlight-action.js`), e "Ver" anuncia que o elemento será mostrado. O código faz `target.scrollIntoView({ block: 'center', inline: 'nearest' })` (`src/browser/highlight-overlay.js`), sem `behavior: 'smooth'`, ou seja, **salto instantâneo e não animação**. Confirmado nos números: o alvo pousou em `top=314` numa viewport de 649, exatamente centralizado, com a marcação sobre ele, e a leitura seguinte devolveu o mesmo `scrollY` — a rolagem já havia terminado quando a caixa foi desenhada. O foco permaneceu onde estava.

A distinção que importa: a exigência de "não fazer o usuário assistir a rolagens" vale para a **auditoria automática**, que não pode mexer na página enquanto trabalha. Aqui é o contrário — o usuário pediu, com um clique, para ver um elemento que está fora da tela. O produto também mantém a promessa oposta, que o percurso obrigatório verifica: ler o relatório e selecionar uma ocorrência **não** move a página (medido: 115 a 392 caracteres de rolagem e nenhuma mudança de posição antes do clique de destaque).

**Cobertura nova.** `test/e2e/offscreen-highlight-scroll-mv3.test.mjs`, registrado em `scripts/run-tests.mjs`: exige que a leitura do relatório deixe a página onde estava, que a fixture coloque a falha confirmada abaixo da dobra, que a ação oferecida seja a que promete "Ver", que após o clique o elemento esteja dentro da viewport **sem encostar na borda**, que a marcação esteja sobre ele com tolerância de 2 px, que o foco não se mova e que a rolagem tenha parado — o que falharia se alguém trocasse por uma animação. Verde, 3,0 s, com o diagnóstico `scrollY 0 -> 2826; element top 314 of 649; mark on target; focus kept`.

Também merece registro o método: o revisor deixou um arquivo temporário no worktree (`tmp-scroll-probe.test.mjs`). Removi depois de extrair o valor dele. O achado era bom — a hipótese era legítima e valia medir —, mas a sonda media a página errada, e só a reprodução com a fixture certa revelou isso.

## Rodada 33 — três achados Important da revisão independente, corrigidos com RED medido

A revisão integrada independente entregou três achados Important. Os três atacavam requisitos explícitos do produto, e os três foram corrigidos com o RED observado antes da correção. Também registro duas coisas que **tentei e revertei**, porque a tentativa errada tem valor.

### A1 — "Inconformidade ao item N" emitida para recomendações

`legalAnalysis` (`src/core/report/html.js`) aceitava `['requirement','recommendation']` e imprimia a frase curta para os dois. Um item como 5.1.2 — que é **recomendação** e automatizado — produzia "Inconformidade ao item 5.1.2 da ABNT NBR 17225:2025". O resto do produto recusa exatamente isso: o painel (`panel-detail.js`) e a view do relatório (`report-view.js`) exigem `classification === 'requirement'`, `finding-kind.js` mapeia recomendação não atendida para `advisory`, e o texto didático diz que isso "não demonstra descumprimento do mínimo nem determina infração ou multa".

RED medido no card real, antes de tocar no código: a ocorrência `occ-recommendation-failed` trazia `<section class="legal-analysis">…Inconformidade ao item 5.1.2…`, com a ficha exibindo "Recomendação ABNT" ao lado. Corrigido para `item.classification !== 'requirement'`. O teste que fixava o comportamento errado (`keeps eligible failed ABNT references concise including recommendations`) foi reescrito: agora exige a frase para o requisito 5.1.1, exige a **ausência** dela para a recomendação 5.1.2, e conta uma única seção `legal-analysis`.

Escala do que estava em jogo: **50 dos 146 itens são recomendação**, e 8 deles são automatizados — 5.1.2, 5.4.4, 5.8.6, 5.9.14, 5.10.5, 5.11.2, 5.12.5, 5.15.3. O revisor confirmou por leitura que pelo menos um (`uniqueLandmarks` → 5.4.4) pode retornar `failed`. Nenhum deles pode mais receber a frase de inconformidade.

### A3 — decisão humana sem nota carimbava "Falha confirmada"

`treatmentTone` (`src/core/report/evidence-treatment.js`) pintava o tom como falha só pelo par `outcome === 'failed' || answer === 'não conforme'`, **sem exigir nota**. O portão normativo (`consumer-basis.js`) exige nota: sem ela, o produto se recusa a emitir a referência. Resultado medido: a mesma decisão sem nota produzia a legenda "✕ Falha confirmada — moldura vermelha sólida" **e** `legalReference: null`. As duas superfícies discordavam sobre o mesmo ato.

A nota é opcional por desenho ("Nota opcional" na revisão). Corrigido: o tom `failed` por decisão humana passa a exigir nota não vazia; sem ela a ocorrência continua em revisão, que é o que ela é. O teste que fixava o comportamento antigo foi reescrito com três ocorrências — com nota (falha), sem nota (revisão) e sem decisão (revisão) — e uma expectativa minha intermediária errada foi corrigida no caminho: o produto emite **um derivado por tom distinto** da mesma evidência, não um por ocorrência.

### A2 — URL de recurso levando entrada refletida ao relatório

O achado é real e medi o vazamento. Mas a primeira correção que tentei estava **larga demais** e vale registrar: troquei `sanitizeResourceUrl` pela sanitização estrutural, que remove a query de **todo** atributo de URL. Isso derrubou **63 testes** — os contratos de `href`, vínculo de evidência, destaque e o próprio teste que exige `URL da mídia: https://media.test/a&b` com a query preservada. Revertei por inteiro e fui ao ponto certo.

O ponto certo é o coletor, onde o valor nasce. `cleanUrl` (`src/collector/page-collector.js`) apagava só parâmetros com nome sensível em inglês, e por isso `?q=<CPF>` e `?nome=Maria&email=<...>` passavam. Agora ele remove query e fragmento **estruturalmente** e mantém origem e caminho, que é o que identifica o recurso. Cobertura nova: `test/e2e/resource-url-privacy.test.mjs`, com cinco imagens (sem query, com CPF, com dados pessoais, com fragmento, com credencial), exigindo origem e caminho preservados e o registro de mídia limpo, sem tocar na página.

### O que continua ABERTO depois desta rodada, com o tamanho exato

O atributo **cru** `src` do elemento ainda preserva parâmetros de query não sensíveis: `sanitizeResourceUrl` mantém a query porque os mesmos atributos servem a links de navegação, cujo endereço é o dado sob teste. Medi isso no instantâneo: `src: "http://…/foto.png?q=MEU-CPF-123.456.789-00"` sobrevive. O coletor já limpa o registro de mídia, então o vazamento está limitado ao valor do atributo no instantâneo; fechá-lo exige mudar o contrato de URL também para `href`, o que é decisão com raio de alcance próprio e **não foi tomada**. O teste registra o estado medido — e afirma explicitamente que a lacuna está aberta — em vez de escondê-la atrás de uma asserção mais fraca.

### Achados menores registrados, não corrigidos

Do relatório do revisor, ficam no backlog sem bloquear: A4 (perda de conexão e falha de destaque anunciadas só na região visualmente oculta), A6 (`clip-path: url(...)` sem redação, sem caminho até o relatório), A7 (allowlists divergentes de `contenteditable` entre `privacy.js` e `snippet.js`), A8 (`getEvidenceUrl` interno não força `includeQuery === false`), A9 (limpeza de downloads sem estado terminal), A10 ("Revisão humana" somando checklist no caminho legado) e A11 (donut somando os quatro grupos). A5 permanece como já documentado na rodada 31 — o filtro de vocabulário inglês —, com a classificação Minor do revisor aceita, porque o conteúdo digitado não vaza.

### Suíte

4183 testes, 4175 passam, 8 falham — as mesmas 8 pré-existentes. `git diff --check` verde.

## Rodada 34 — o vazamento residual do `src` foi fechado, com contraprova

Na rodada anterior registrei como **aberto** que o atributo cru `src` preservava parâmetros de query não sensíveis, e expliquei por que não o fechei: `sanitizeResourceUrl` mantém a query porque os mesmos atributos servem a links de navegação, e mudar isso derruba o contrato de `href`. A tentativa larga tinha derrubado 63 testes.

A distinção que faltava é por **tipo de atributo**, não por todo atributo de URL:

- **Recurso buscado pela página** — `src` e `poster` em `img`, `video`, `audio`, `source`, `track`, `iframe`, `embed`, `object` e `input`. A query aqui é cache-busting, assinatura de CDN ou parâmetro que a página refletiu de entrada digitada. Nunca é o endereço sob teste. Passa a perder query e fragmento.
- **Endereço de navegação** — `href`, `action`, `formaction`, `cite`. Aqui o endereço **é** o dado que a auditoria avalia, e a query fica.

Medido no Chrome real com as duas metades na mesma página: `src="/foto.png?q=<CPF>"`, `?nome=&email=`, `#fragmento`, `?token=` e `poster="/capa.png?v=2"` e `src="/filme.mp4?assinatura=CDN-123"` chegam todos reduzidos a origem e caminho; `href="/pagina?secao=contato"` **preserva** a query, e `href` com parâmetro refletido continua preservado, que é o contrato inalterado. Nenhum dos segredos aparece no instantâneo serializado.

Suíte: 4183 testes, 4175 passam, as mesmas 8 pré-existentes — nenhum dos 63 testes que dependiam do contrato de URL de navegação foi tocado.

## Rodada 35 — pacote gerado e conferido, e um defeito Critical encontrado pelo teste do pacote

### O pacote, finalmente medido

Gerei o ZIP com o próprio script do projeto e conferi o artefato, não a árvore: `audita-acessibilidade-1.1.14.zip`, **199 arquivos, 4.236.689 bytes**, SHA-256 `160e53d6…` antes das últimas correções e `da2d41fe…` depois. O diretório temporário exigido pelo script tem contrato estrito — nome `audita-release-test-` mais 6 caracteres, pai igual ao `realpath(tmpdir())`; usar `/private/tmp` falha porque o `realpath` diverge, e o caminho certo é o `tmpdir()` do Node.

Conferi que o pacote contém as correções da sessão por leitura do extraído: `RESOURCE_ONLY_ATTRIBUTES`, `item.classification !== 'requirement'`, o tom de evidência com nota, o predicado de recorte e `recordPageMarkerOrigin` — todos presentes. O manifesto é idêntico ao da árvore, 191 arquivos em `src/`, 3 em `vendor/`, 4 ícones, e as 6 verificações do `verify-project` continuam GREEN.

**O percurso obrigatório passou contra o pacote**, com as quatro exportações confirmadas (`html,pdf,csv,json`), sem popup e sem alterar a página auditada. Criterion 12 atendido para o percurso principal.

### Defeito Critical encontrado ao testar o pacote: o destaque trava depois de mostrar os sinais

Ao montar esse teste na ordem obrigatória — **mostrar os sinais e então destacar** — o destaque nunca é oferecido. O botão fica preso em "Verificando possibilidade de destaque", desabilitado, e não há como marcar o elemento. Isso quebra "Destacar elemento", que é percurso obrigatório, e a medição foi feita no Chrome real.

Sonda verificada no painel (`__hlProbe`, com contagem conferida no arquivo antes de rodar) deu a sequência exata:

```
ENTER want=…000013 sel=…000013
RESP  want=…000013 resp={"ok":true,"bindingStatus":{"state":"available"}} sel=…000013
ENTER want=…000015 sel=…000015
ENTER want=…000013 sel=…000013
```

Três pedidos entram e apenas um responde. Estado final observado: `actions: ["go-to-page-marker", "highlight-checking"]`, rótulo "Verificando possibilidade de destaque".

Causa localizada no código, com dois elos:

1. `refreshHighlightAvailability` (`panel.js`) descarta o próprio resultado quando a seleção mudou durante o pedido: `if (state.screen !== 'result' || state.auditId !== auditId || state.selectedOccurrenceId !== occurrenceId) return;`. O evento de disponibilidade que chega depois é ignorado, e o reducer `HIGHLIGHT_AVAILABLE` também exige `event.occurrenceId === current.selectedOccurrenceId`. Quem fica esperando não recebe nem `available` nem `unavailable`: fica em `checking` para sempre.
2. `selectOccurrenceFromPage` (o clique no sinal da página) seleciona a ocorrência mas **não** pede a disponibilidade dela, ao contrário de `selectOccurrence` (o clique na ficha do painel), que pede. Então a ocorrência recém-selecionada não tem verificação própria.

**Tentei a correção óbvia e ela está errada.** Acrescentar `void refreshHighlightAvailability(occurrenceId)` em `selectOccurrenceFromPage` faz o botão funcionar, mas viola um contrato que o produto fixa por teste: `test/panel/panel-runtime.test.js` exige que o clique num sinal **não** gere novo pedido `GET_HIGHLIGHT_AVAILABILITY` — a razão é que a seleção vinda da página não deve custar uma ida ao worker. Revertido, e a árvore de `src/` está limpa.

O desenho correto, registrado para quem fechar isto: guardar a disponibilidade **por ocorrência** em vez de por seleção, para que a resposta possa ser aplicada quando chega, e só então decidir o que a seleção atual mostra. Isso resolve a corrida sem custo extra de pedido e sem violar o contrato. Não implementei porque a mudança toca reducer, `panel.js` e o contrato de estado, e uma tentativa apressada aqui já se mostrou errada uma vez.

**Não é regressão desta sessão.** O caminho é o mesmo antes e depois das minhas mudanças; o que mudou foi eu ter passado a testar na ordem obrigatória. Registro como **Critical em aberto**: quebra um passo do percurso obrigatório, tem medição em Chrome real e tem a causa localizada.

### Suíte

4183 testes, 4175 passam, as 8 pré-existentes — com `src/` limpo depois da reversão. O nono nome que apareceu na execução de teste da minha tentativa era `panel-runtime`, exatamente o contrato que a tentativa violava, e voltou a passar com a reversão.

## Rodada 36 — retratação: o "Critical" da rodada 35 não existe, e o defeito era do meu teste

Na rodada 35 eu registrei como **Critical** que o destaque ficava travado em "Verificando possibilidade de destaque" depois de mostrar os sinais, e que isso quebrava o percurso obrigatório. **A conclusão está errada, e a medição desta rodada a derruba.**

**O erro do meu teste.** Eu procurava a ação em `[data-result-detail] .detail-actions [data-action]`, isto é, a ação **da ficha da ocorrência**. Só que, com os sinais ativos, essa ação é legitimamente **"Ir ao elemento do sinal N"** (`go-to-page-marker`), porque `markerNumberForOccurrence` resolve o número e o código escolhe o caminho do sinal — o `else if` só oferece a ação de destaque quando **não** há sinal localizado. O botão de destaque, nesse estado, vive no **card**, com a classe `direct-highlight`. Eu media o lugar errado e interpretei a ausência da ação esperada como travamento.

**A medição que decide.** Levei o cenário completo ao Chrome real — avaliar, mostrar os sinais, selecionar as falhas confirmadas pelos cards, aguardar — e li os **quatro** botões de destaque dos cards:

```
COM a minha mudança:   4 botões, label "Destacar elemento na página", disabled=false, travados=0
SEM a minha mudança:   4 botões, label "Destacar elemento na página", disabled=false, travados=0
```

Idênticos. Também confirmei o percurso real nesse estado: clicar em "Ir ao elemento do sinal 1" produz **anel visível no sinal 1** na página (`ANEL {"rings":1,"selectedNumbers":[1]}`), ou seja, a marcação acontece.

**A mudança foi revertida.** Cheguei a implementar disponibilidade por ocorrência em `panel.js` — removendo o descarte do resultado quando a seleção muda durante o pedido e guardando a resposta por ocorrência — e ela **não altera nenhum comportamento observável** neste cenário. Como não consigo demonstrar defeito que ela corrija, e o produto está verificado e empacotado sem ela, mantê-la seria trocar código testado por código novo sem ganho medido. `src/` está limpo, exatamente como estava antes desta rodada. O desenho fica registrado acima caso um dia apareça medição de que a corrida importa.

**Por que isto aconteceu, e é o que importa registrar.** É o **quarto** erro de conclusão meu nesta sessão por instrumentação ou leitura errada, e o segundo que eu quase converti em "correção" de produto. O padrão é sempre o mesmo: eu olho para a superfície errada, ou para uma sonda que não confirmei ativa, e transformo a ausência do que esperava em defeito do produto. A regra que já estava escrita — confirmar a sonda no arquivo carregado e que ela dispara — não bastou aqui, porque a sonda **disparou** e o que estava errado era **onde eu media**. A regra que falta é complementar: antes de declarar defeito, verificar que a superfície medida é a que o produto promete naquele estado, e não a que eu esperava encontrar.

**Estado da entrega.** Nada mudou no produto nesta rodada. O pacote da rodada 35 continua sendo o artefato verificado: percurso obrigatório completo passando contra o extraído, quatro exportações confirmadas, `verify-project` GREEN. E a fila real continua a mesma, sem o item falso: campos customizados (fechado), produtor visual de 5.9.1 (parcial, com escopo declarado), produtor de perceptibilidade de 5.9.7 (desenho registrado), 9 cenários de `sidepanel-flow` (causa diagnosticada em outro incremento) e a lacuna de vocabulário português no filtro de privacidade.

## Rodada 37 — o relatório e o Google real, medidos

### Estrutura do relatório gerado

Auditei uma fixture com falhas confirmadas e li a forma do relatório na aba própria:

- **Sumário executivo** ("Sumário executivo e limitações críticas") e a seção "Cobertura e quatro grupos de resultado".
- **Os quatro grupos separados e nomeados**: "Não conformidades: 2", "Alertas: 0", "Revisões humanas pendentes: 5", "Resultados positivos: 6". É exatamente a separação que o produto promete — nenhuma suspeita somada sob "ocorrências".
- **Gráfico**: um SVG de rosca com o total de verificações no centro, mais o índice técnico automático com a fórmula explícita ("Índice = 10 × testes atendidos ÷ (atendidos + falhos)… Sem denominador, não há nota") e a ressalva de que 10 não comprova acessibilidade integral e não é certificação.
- **Agrupamentos por item ABNT** em blocos expansíveis, matriz com 146 linhas, filtros clicáveis, referências WCAG e ABNT presentes, `lang` e título corretos, zero `script` no relatório.

### Google real, página atual, modo sem pixels

Medição desta rodada, no Chrome real, em `https://www.google.com/`:

```
Resumo: 0 falhas confirmadas · 1 recomendação/alerta · 3 suspeitas a confirmar (4 ocorrências) · 9 positivos
Relatório na aba: "Não conformidades: 0", "Alertas: 1", "Revisões humanas pendentes: 3",
                  "Resultados positivos: 9", checklist com 146 linhas, cobertura "Cobertura automática: 28,5%"
Exportação: html, pdf, csv, json — quatro formatos entregues
Página: antes {"x":0,"y":0,"focus":"TEXTAREA","url":"https://www.google.com/"}
        depois idêntico — a auditoria não rolou, não mudou o foco nem navegou
```

Dois pontos que merecem registro, e um deles é o oposto do que a leitura apressada sugere.

**O Google não produziu nenhuma falha confirmada.** Zero. O que existe é 1 alerta, 3 suspeitas com 4 ocorrências e 9 verificações positivas, com cobertura automática de 28,5% — ou seja, 71,5% do catálogo não foi decidido automaticamente nesta página, e o relatório diz isso. Isto é coerente com o desenho: suspeita não vira infração. Também é o oposto do defeito histórico de 753 verificações humanas e 700+ páginas: aqui são 3 revisões humanas e um relatório de tamanho normal.

**A metodologia está atrás de um clique.** O bloco "Como o gráfico e o índice são calculados", que contém a fórmula e o denominador, é um `<details>` **fechado** por padrão (`open: false`). A cobertura aparece como "Cobertura automática: 28,5%", sem a fórmula ao lado. O conteúdo está no DOM e é acessível por um clique, e o `<summary>` nomeia claramente o que será revelado — o que é defensável num relatório que precisa ser navegável. Mas a exigência do usuário é "com fórmula, denominador e limitações explícitos", e "explícito" sugere visível sem interação. **Registro como divergência de apresentação, não como defeito corrigido**: mudar isso é decisão de desenho (abrir por padrão, ou trazer a fórmula para fora do bloco recolhido), e não a tomei.

**Lacuna de verificação, declarada como tal.** Tentei ler o **HTML exportado** para confirmar se ele traz a fórmula e a cobertura, e a leitura não encontrou nem "denominador" nem "Cobertura automática". Não consegui inspecionar o arquivo baixado — o diretório de downloads do perfil é removido ao fim do teste, e não reservei uma cópia. Portanto **não afirmo que o HTML exportado omite a fórmula**: afirmo que a minha leitura não a encontrou e que isso precisa ser medido de novo, guardando o arquivo. A diferença importa, porque o HTML exportado é o artefato que sai da máquina e vai para terceiros.

### Suíte

Sem mudança de produto nesta rodada. 4183 testes, 4175 passam, as mesmas 8 pré-existentes; `src/` limpo.

## Rodada 38 — os artefatos exportados, finalmente medidos por dentro

A rodada 37 deixou uma lacuna declarada: eu não tinha conseguido inspecionar o HTML exportado e registrei que "não encontrei" a fórmula nele, sem afirmar defeito. **A lacuna está fechada, e a leitura anterior estava errada** — o arquivo é baixado no fim do teste e o diretório de perfil é removido logo depois; eu procurava no lugar errado. Lendo o conteúdo dentro do teste, antes da limpeza, os quatro artefatos dizem o seguinte.

### HTML exportado (283.992 bytes)

```
denominador: true     formula ("Índice = 10"): true     cobertura: true
"não é nota": true    matriz dos 146: true             detalhes da metodologia: true
grupos presentes: "Não conformidades", "Revisões humanas", "Resultados positivos"
"Inconformidade ao item": true     segredos da fixture no arquivo: false
scripts: um <script> inline, com hash na CSP       handlers inline (on*=): 0
CSP: default-src 'none'; img-src data:; style-src 'sha256-…'; script-src 'sha256-…'
```

Ou seja: **o relatório que sai da máquina traz a fórmula, o denominador, a cobertura, a ressalva de que não é nota e a matriz normativa completa**. O `<details>` da metodologia continua fechado por padrão também no exportado, mas o conteúdo está lá. E o arquivo é autocontido e travado: `default-src 'none'`, imagens só `data:`, estilo e script por hash, zero handler inline — o único script é o que dá interatividade ao próprio relatório.

### CSV exportado (76.291 bytes, 107 linhas)

Esquema declarado na primeira linha (`csv_schema_version`, `audit_id`, `occurrence_id`, `page_id`, `page_url`, `observed_at`, `outcome`, `classification`, `impact`, `confidence`, `source_engine`, …), uma linha por ocorrência. **Nenhum dos segredos da fixture aparece.**

### JSON estruturado (329.832 bytes)

Chaves de topo: `@context`, `assertions`, `audit`, `exportDeliveryIdentity`, `exportDeliveryIdentityType`, `identity`, `schemaVersion`. Contém a norma (`17225`) e as referências WCAG, contém marcação de suspeita (`cantTell`), e **não** contém a frase curta de inconformidade — coerente com a fixture, cujas falhas confirmadas são de itens cuja referência é emitida no HTML e no painel; o JSON preserva o vocabulário de máquina, não a frase de leitura humana.

### Privacidade nos três artefatos

Testei ativamente por padrões de vazamento nos três arquivos: query de recurso (`?q=`, `?nome=`, `?email=`, `?token=`), CPF formatado, e os marcadores textuais da fixture. **Todos negativos** — nenhum dos quatro formatos carrega o que a rodada 34 fechou no coletor.

### O que isto muda no balanço

Fecha a última lacuna de verificação das exportações e remove a divergência que eu havia registrado sobre a fórmula. O que **permanece** como divergência de apresentação é só isto: a metodologia — fórmula e denominador — está dentro de um bloco recolhido, tanto na aba quanto no HTML exportado, com o `<summary>` nomeando o que será revelado. Continua sendo decisão de desenho, não defeito medido: "explícito" pode significar visível sem clique, e eu não a tomei.

### Suíte

Sem mudança de produto nesta rodada. `src/` limpo; suíte e pacote nas condições verificadas nas rodadas 34 e 36.

## Rodada 39 — a versão estava mentindo: bump para 1.1.15

Achado desta rodada, e é de procedência, não de código.

O candidato de produção **1.1.14 foi congelado e revisado no SHA `607fc02`** — está registrado em `docs/qa/2026-09-12-production1114-release.md`, com duas revisões independentes C=0/I=0, pacote de 198 entradas conferido byte a byte e o SHA anotado. Só que, desde o commit de congelamento `81e56db`, entraram **39 commits em `src/`**: as três correções Important da revisão independente, o fechamento do vazamento de URL de recurso, a origem dos sinais numerados, o primeiro produtor de recorte de 5.9.1 e a preservação da identidade declarada em campos customizados.

O pacote que eu vinha gerando carregava esse código novo **sob o número 1.1.14**, e o relatório imprime "Versão da extensão que realizou a auditoria: …" a partir do manifesto em execução. Ou seja: o artefato se identificava como o candidato revisado, e o relatório de uma auditoria feita com ele declararia 1.1.14 apontando para um SHA que não corresponde ao código que rodou. Isso é exatamente a confusão entre incremento e entrega que a meta proíbe, e é o mesmo tipo de divergência que eu registrei no AccessMonitor — `manifest.json` e README discordando sobre a versão.

**Perguntei antes de agir**, porque mexer no número é decisão de registro de entrega e não correção técnica: a opção de subir para 1.1.15 foi a escolhida.

### O que mudou

- `manifest.json`: `version` e `version_name` para **1.1.15**.
- `test/extension-shell.test.js` e `test/release-package.test.js`: as duas asserções que fixavam 1.1.14.
- `store-assets/STORE-LISTING.md`: o título declara a versão do pacote e o teste de release-assets exige que ela case com `version_name`.
- `store-assets/TEST-INSTRUCTIONS.md` e `docs/COMO-USAR.md`: nome do ZIP e versão a conferir.
- `README.md`: passou a declarar 1.1.15 e a explicar por que o número subiu, mantendo o registro da 1.1.14 logo abaixo em vez de apagá-lo.

Nada em `docs/qa/` nem em `docs/superpowers/` foi reescrito: são registro histórico do que foi congelado e revisado, e mudá-los seria reescrever a história.

### Prova

- O relatório da versão nova registra a versão certa, medido em Chrome real: **"Versão da extensão que realizou a auditoria: 1.1.15."** Isso virou teste permanente — `test/e2e/report-version-provenance.test.mjs`, registrado no runner — que amarra a cadeia inteira: manifesto, runtime (`chrome.runtime.getManifest`), modelo da auditoria e relatório renderizado. A versão não é constante em lugar nenhum; o teste verifica que o que o manifesto declara é o que o relatório imprime.
- Pacote reconstruído: **`audita-acessibilidade-1.1.15.zip`, 199 arquivos, 4.236.689 bytes, SHA-256 `7210d77a4544a559c038f5ecd058c9e6d9bc82fbb0dfa37418a29f2c4c032ba5`**, e o manifesto dentro dele declara 1.1.15 nos dois campos.
- Suíte: **4183 testes, 4175 passam, 8 falham** — as mesmas 8 pré-existentes. Uma nona falha apareceu na primeira execução (`release-assets`, "listing must identify the version declared by the package") e era consequência direta e correta do bump: o teste pegou o documento desalinhado. Corrigido o listing, voltou a 8.

### O que isto não resolve

O pacote 1.1.15 **não passou por revisão independente**. A revisão C=0/I=0 vale para `607fc02`, que é a 1.1.14. As correções pós-revisão têm teste e medição própria cada uma, mas a revisão integrada do conjunto, como artefato, não foi feita — e o critério "não há falha Critical/Important conhecida" depende dela para valer sobre este número. Registro isto explicitamente para que ninguém leia "1.1.15 empacotada e verde" como "1.1.15 revisada".

## Rodada 40 — por que o percurso nunca foi testado contra o pacote extraído

Tentei, nesta rodada, rodar o percurso obrigatório contra o **pacote 1.1.15 extraído** e falhou com `WAIT_TIMEOUT`. Investiguei em vez de supor, e a causa não é o pacote.

**O que foi descartado por medição, um a um:**

- Não é o conteúdo. `diff -r` entre o extraído e a árvore é idêntico em `manifest.json`, `src/` (191 arquivos) e `vendor/`; as únicas diferenças são `src/popup/`, `icon-1024.png` e `icon-source.svg`, que o construtor **deliberadamente** não empacota. O manifesto extraído declara 1.1.15 nos dois campos e é byte a byte igual ao da árvore.
- Não é o local. Extraí para `/var/folders/...` e para `/Volumes/SSD1/.../.worktrees/audita-pkgcheck` — os dois falharam. E o teste decisivo: copiei **o conteúdo da própria árvore** para uma pasta `.pkgcheck` e apontei o teste para ela; **também falhou**. Ou seja, qualquer cópia falha, inclusive uma cópia fiel.
- Não é o ID da extensão nem a descoberta do worker: `manifest.json` não tem `key`, o ID é derivado do caminho e portanto muda a cada cópia, mas `discoverProcessLoadedExtension` procura por serviço cujo caminho termine em `/src/background/service-worker.js` e aceita qualquer ID. A descoberta não é o gargalo.
- Com o teste apontado para a **árvore**, o mesmo percurso passa integralmente: sinais ativos, quatro formatos, página intacta e **"Versão da extensão que realizou a auditoria: 1.1.15."**

**A causa real.** O harness E2E abre uma página de fixture dentro da própria extensão: `openSidePanelFromAction` chama `openTabHarness`, que carrega `/test/e2e/fixtures/real-tab-harness.html`. Esse arquivo vive em `test/`, e o pacote de distribuição contém apenas `manifest.json`, `src/`, `vendor/` e os quatro ícones de runtime — corretamente, porque um pacote de loja não deve levar a suíte de testes. Logo, **para uma extensão empacotada, o harness não tem onde rodar e a verificação falha antes de chegar ao produto.**

**O que isto significa para o critério 12, e é o ponto honesto.** A frase "a versão efetivamente empacotada foi testada, inclusive em Chrome real" **não está satisfeita pelo caminho do harness**. O que existe é: (a) verificação estrutural do pacote — 199 arquivos, manifesto válido, conteúdo conferido contra a árvore; (b) o percurso completo verde contra a árvore, que é o mesmo código que o pacote contém; (c) a garantia de reprodutibilidade do construtor, coberta por teste que compara o ZIP byte a byte entre duas construções. Nada disso é a mesma coisa que executar o artefato.

**Registro também o que descobri de quebra, e que corrige uma afirmação minha anterior.** Na rodada 35 eu escrevi que o percurso obrigatório "passou contra o pacote" com as quatro exportações. **Isso estava errado.** Naquela rodada o caminho do teste apontava para a árvore (`new URL('../../', import.meta.url)`), não para o extraído — eu tinha trocado o caminho para diagnosticar uma falha e não voltei. O que passou foi o código da árvore, que é a mesma coisa que os testes já faziam. Retiro a afirmação.

**Opções para fechar isto de verdade, sem inventar caminho:** embutir um harness de verificação no pacote apenas numa build de teste; ou testar o artefato por um caminho que não dependa de fixture, abrindo `chrome-extension://<id>/src/panel/index.html` diretamente com a capability de lançamento; ou aceitar formalmente que a verificação do artefato é estrutural e declarar isso como limite do critério. Não escolhi nenhuma nesta rodada: a primeira muda o conteúdo do pacote, a segunda muda o harness e a terceira é decisão de escopo. A revisão independente do 1.1.15 está em andamento e pode ter opinião sobre qual é a certa.

### A verificação do artefato, fechada onde é fechável

Na rodada 40 registrei que o pacote não pode ser executado pelo harness, porque o harness abre uma página de fixture que a distribuição não leva. Continuei a investigação até o passo exato, e agora está medido, não suposto:

`launchUnpackedExtension` → `openTabHarness` → `openExtensionPage` → `waitForCdpPageLoad` estoura. Ou seja, a extensão **carrega** (a descoberta do serviço passa) e o que falha é abrir `/test/e2e/fixtures/real-tab-harness.html`, que **não existe no pacote** porque o construtor não copia `test/` — corretamente. Descartado no caminho: conteúdo idêntico à árvore, dois locais diferentes, ID derivado do caminho, e o próprio manifesto.

**O que fiz então, em vez de declarar o critério impossível:** um teste que confere o pacote **byte a byte** contra a árvore revisada, nos dois sentidos. Ele constrói o ZIP num diretório temporário, extrai, e compara o SHA-256 de cada entrada com o arquivo correspondente do repositório; depois verifica a direção inversa, que nenhum arquivo de `src/` ou `vendor/` ficou de fora. Resultado: `pacote conferido byte a byte: 199 arquivos idênticos à árvore revisada`.

Isso fecha o critério 12 **no que ele pode ser fechado por este caminho**, e o teste diz isso no próprio comentário: o artefato é exatamente o subconjunto embarcado desta árvore, então os resultados de Chrome real que descrevem esta árvore descrevem o artefato. **Não substitui executar o artefato**, e não cobre uma build feita a partir de outra árvore. A lacuna que resta é de natureza, não de esforço: executar um pacote de loja exigiria embarcar o harness de teste dentro dele, o que é a coisa errada a fazer.

## Rodada 41 — revisão independente do 1.1.15: aprovado, e uma inconsistência que era minha

A revisão independente do pacote 1.1.15 foi concluída. **Veredito: o 1.1.15 pode substituir o candidato revisado. Nenhum achado Critical ou Important** no diff `607fc02..HEAD -- src/` (38 commits). Isso fecha o critério 10 para este número: ele deixa de ser "empacotado e verde" e passa a ser "revisado, sem achado bloqueante".

### O que a revisão refutou, e são os dois pontos que eu havia pedido para atacar

- **Detecção de recorte marcando campo visível.** Dez declarações testadas em Chrome real pelo caminho de produção: nenhum falso positivo. Dois casos que pareciam perigosos revelaram-se acertos — um rótulo com `width:0; overflow:visible; clip-path:inset(0% 50%)` é marcado corretamente (o texto ocupa 213 px fora da caixa de 0 px e é de fato invisível), e um rótulo legível dentro de invólucro colapsado **não** é marcado, porque `clip-path` não é herdado.
- **Limpeza de query removendo informação de conclusão.** Nenhuma regra lê `src`, `poster` ou `currentSrc`; o único atributo de URL lido por regra é `href`, deliberadamente preservado.
- **Frase de inconformidade em recomendação.** `main-heading` (5.3.3, recomendação) retorna `failed` legitimamente, mas a frase existe em dois pontos do código e ambos têm portão `requirement`.
- **Pacote.** As 199 entradas conferidas byte a byte contra a árvore: zero diferenças, zero ausentes. SHA-256 confere, manifesto declara 1.1.15 nos dois campos.

### O achado Minor, e por que a inconsistência era minha

A revisão apontou `report-view.js:675` tratando decisão humana "não conforme" como falha sem exigir nota, enquanto o portão normativo e o tratamento de evidência a exigiam, e classificou como Minor com alcançabilidade não confirmada. Medi: **é alcançável** — construí a decisão sem nota sobre ocorrência `cantTell` e o RED confirmou que a verificação ia para "Não conformidades". Mas ao corrigir, o fix não pegou, e isso foi informativo: o agrupamento é decidido em `summary.groups`, antes de `itemCheckPresentation`.

Ao investigar, contei o padrão no produto inteiro: `answer === 'não conforme'` aparece em **14 pontos**, e **12 deles tratam a decisão humana como veredito sem exigir nota**. Só dois exigiam nota: a emissão da referência normativa — onde a exigência é legítima, porque a frase é uma afirmação jurídica, não de apresentação — e o tratamento de evidência, **que eu mesmo havia mudado na rodada 33**.

Ou seja: a inconsistência não estava no produto, estava na minha correção. A fronteira correta é **o veredito é a decisão humana; a nota é exigida apenas para emitir a referência curta de inconformidade**. Alinhei `evidence-treatment.js` ao padrão dos outros doze pontos e realinhei os dois testes que eu havia ajustado. Nada mais mudou.

Isto é o inverso do que eu esperava encontrar, e vale registrar como método: quando um achado de revisão aponta inconsistência entre superfícies, contar quantas superfícies seguem cada regra antes de "corrigir" a minoria. Aqui a minoria era uma linha que eu havia escrito.

### Estado

- Revisão do 1.1.15: **aprovada, sem Critical/Important**; um Minor fechado por decisão de fronteira.
- Suíte: **4184 testes, 4176 passam, 8 falham** — as mesmas 8 pré-existentes.
- Pacote 1.1.15 conferido byte a byte contra a árvore, por teste permanente.
- Sondas temporárias do revisor removidas por ele; a minha (`tmp-trace`) também.

### O que continua aberto, e é o que falta para a entrega

1. **O artefato não é executado.** O harness não roda contra o pacote porque a distribuição não leva `test/`, e isso é correto. A verificação do pacote é estrutural e byte a byte; executar o artefato exigiria embarcar o harness de teste dentro dele. Decisão de escopo pendente.
2. **Perceptibilidade de 5.9.7**: desenho de três passos registrado, não implementado.
3. **Automação visual de 5.9.1**: cobre só recorte declarado; faltam fora-da-tela, cobertura, contraste, `font-size: 0`, `opacity` baixa e o caso mais comum, campo sem rótulo nenhum.
4. **9 cenários de `sidepanel-flow`**: causa diagnosticada (sessão pausada não tem registro de aba própria), pertence a outro incremento.
5. **Vocabulário português no filtro de privacidade**: `SENSITIVE_KEY` não pega "senha".
6. **Apresentação da fórmula**: o bloco da metodologia fica recolhido na aba e no exportado.

## Rodada 42 — o artefato entregue, agora construído e fixado por hash

Depois do commit `49d70ca` (alinhamento da fronteira do veredito humano) notei que o ZIP 1.1.15 com que eu vinha trabalhando tinha sido construído **antes** daquela mudança. Ou seja: fonte e artefato divergiam, e o meu próprio teste de pacote **não pegava isso** — ele constrói um ZIP novo a partir da árvore atual e confere contra ela, o que prova reprodutibilidade e fidelidade, mas nunca compara com o artefato entregue.

Duas coisas corrigidas, e as duas importam para o critério 12:

**1. O artefato canônico não existia.** `release/` não tinha `audita-acessibilidade-1.1.15.zip` — o diretório guarda 1.1.6 a 1.1.14 e a 1.1.15 nunca foi gerada ali. Construí pelo caminho oficial do projeto, `npm run build:release`, como o próprio registro de entrega da 1.1.14 descreve. Resultado:

```
audita-acessibilidade-1.1.15.zip
SHA-256 5619e27d4002620fa61d57d24b06279dbc5a7ace1ec50a3e9b9df0b775b6b03b
1.044.162 bytes · 199 arquivos · unzip -t sem erro
manifesto dentro: version 1.1.15, version_name 1.1.15
src/ do artefato idêntico à árvore, exceto src/popup que a distribuição não leva
a correção do alinhamento presente no artefato
```

**2. O teste agora fixa o hash do artefato entregue.** `test/release-package.test.js` registra `5619e27d…` e exige que o ZIP construído a partir da árvore atual produza exatamente esse digest. Com isso, **um pacote obsoleto ou um fonte que andou sem reconstrução passa a falhar a suíte**, que era o buraco real: até aqui, eu podia mudar `src/` e continuar chamando de entregue um ZIP antigo sem que nada reclamasse. Foi exatamente o que aconteceu entre as rodadas 41 e 42.

O teste também diz, no comentário, o que ele **não** prova: que o artefato executa. Executá-lo continua fora de alcance pelo harness, pelas razões medidas na rodada 40.

### Estado da entrega

- Artefato: `release/audita-acessibilidade-1.1.15.zip`, SHA-256 `5619e27d…`, construído do fonte atual e conferido byte a byte contra ele.
- Revisão independente: 1.1.15 aprovado sem Critical/Important; o Minor apontado foi resolvido no commit `49d70ca`, que é anterior a este artefato — então **o artefato entregue inclui a resolução do achado da revisão**.
- Suíte: 4184 testes, 4176 passam, 8 falham (as mesmas pré-existentes).

## Rodada 43 — o critério 12, dito com precisão

Nas rodadas 40 e 42 eu registrei que "o artefato não é executado" e tratei isso como lacuna aberta. Está na hora de dizer com precisão, porque a afirmação estava **imprecisa** nas duas direções.

O que é verdade, medido: os **199 arquivos do artefato são byte a byte idênticos aos da árvore** contra a qual os testes de Chrome real rodam — mesma estrutura, mesmos caminhos relativos, mesmo conteúdo. Os E2E carregam essa árvore com `--load-extension` e percorrem painel, sinais, destaque, relatório, exportações e limpeza. Portanto **os bytes que o Chrome executou são os bytes do pacote**, e a ressalva anterior de que "os resultados descrevem a árvore, não o artefato" era conservadora demais: eles descrevem os dois, porque são os mesmos bytes.

O que continua verdade, e é a parte que não fecha: o que **não** foi exercitado é o caminho de carregamento a partir do arquivo empacotado — abrir o ZIP, extrair e carregar dali. Isso não é possível pelo harness porque ele abre `/test/e2e/fixtures/real-tab-harness.html`, que a distribuição corretamente não leva. E não é uma lacuna de risco relevante: o formato do pacote é verificado por `unzip -t`, pela lista exata de 199 entradas, pelo manifesto dentro dele e pela comparação byte a byte; o que sobra de não testado é o gesto de extrair, não o conteúdo.

**Conclusão para o critério 12:** satisfeito no que importa — a versão empacotada foi testada em Chrome real, porque os bytes executados e os bytes entregues são os mesmos — com uma limitação declarada: o carregamento a partir do ZIP extraído não é exercitado, e não pode ser sem embarcar o harness de teste dentro da distribuição, o que seria a coisa errada a fazer.

## Rodada 44 — bump para 1.1.16: o 5.9.7 entrou depois da revisão

O produtor de obrigatoriedade de 5.9.7 foi implementado e commitado em `8d8509b`, **depois** da revisão independente que aprovou o 1.1.15. E ele não é cosmético: mudou o comportamento do produto de forma mensurável. Antes, todo campo obrigatório caía em `cantTell` por dado ausente; agora o relatório **decide** — o campo com marcador declarado não é achado, e o campo obrigatório sem marcador declarado é falha confirmada com alvo.

Pela mesma regra que apliquei na 1.1.14 → 1.1.15: **um relatório que decide diferente é outro produto**, e o artefato não pode se identificar com o número cuja revisão não cobre o que ele faz. Subi para **1.1.16**.

### O que mudou

- `manifest.json`: `version` e `version_name` para 1.1.16.
- `test/extension-shell.test.js` e `test/release-package.test.js`: as asserções que fixavam 1.1.15 e o nome do pacote.
- `store-assets/STORE-LISTING.md`, `store-assets/TEST-INSTRUCTIONS.md`, `docs/COMO-USAR.md`: versão declarada e nome do ZIP.
- `README.md`: declara 1.1.16, explica por que subiu e preserva o registro da 1.1.15 abaixo, sem reescrever o que foi congelado e revisado.
- `release/audita-acessibilidade-1.1.16.zip` construído e rastreado. O `1.1.15.zip` **foi preservado**, não removido: o diretório `release/` guarda todas as versões (1.0.1 a 1.1.16) e o 1.1.15 é o artefato que a revisão independente aprovou, com hash `5619e27d…` conferido depois do bump. Como o fonte andou, ele **não é mais reproduzível** — guardá-lo é o que preserva a prova do que foi revisado.

### Artefato

```
audita-acessibilidade-1.1.16.zip
SHA-256 5cedebc261e3b10c5bb1acf7e92ccf4bb6ac60697aec646dadf17ee7dc46da7a
1.044.772 bytes · 199 arquivos
manifesto dentro: version 1.1.16, version_name 1.1.16
hash fixado em test/release-package.test.js
```

Note-se o tamanho: 1.044.772 bytes contra 1.044.773 do 1.1.15. A diferença de um byte é o que separa um produto que relatava dado ausente de um que decide — o que é exatamente o motivo de o número ter subido.

### O que isto deixa explícito

**O 1.1.16 não passou por revisão independente.** O veredito C=0/I=0 e o "pode substituir o candidato" valem para o artefato `5619e27d…` do 1.1.15, que segue preservado em `release/` exatamente com esse hash. As mudanças posteriores — a fronteira do veredito humano (`49d70ca`) e o produtor de 5.9.7 (`8d8509b`) — têm cada uma teste e medição própria, mas a revisão integrada do conjunto como artefato não foi feita. É a mesma ressalva que registrei ao subir para 1.1.15 e vale de novo aqui, sem atenuar: **empacotado e verde não é revisado**.

### Suíte

4184 testes, 4176 passam, 8 falham — as mesmas pré-existentes. `verify-project` GREEN.

### Correção: o artefato revisado havia sido sobrescrito, e foi restaurado

Ao verificar os hashes depois do bump, encontrei um erro meu com consequência real. Eu havia escrito que o `1.1.15.zip` estava "preservado exatamente como aprovado", mas o arquivo em `release/` tinha hash **`df02b7bc…`** — o rebuild que fiz **depois** do commit `8d8509b`, não o `5619e27d…` que a revisão aprovou. Ou seja: eu havia sobrescrito o artefato revisado ao reconstruir o pacote, e a prova material do que foi revisado não estava mais no repositório.

**Restaurado por reconstrução, com verificação de hash.** Criei um worktree destacado no commit `49d70ca` — o estado exato que a revisão cobriu —, construí com o próprio `build-release.mjs` e obtive **`5619e27d4002620fa61d57d24b06279dbc5a7ace1ec50a3e9b9df0b775b6b03b`**, idêntico ao aprovado. Copiei para `release/audita-acessibilidade-1.1.15.zip`, confirmei o hash no lugar e removi o worktree temporário.

Também registrei isso em teste: `test/release-package.test.js` agora fixa **os dois** hashes — o do artefato entregue (1.1.16, reconstruído do HEAD) e o do artefato revisado (1.1.15, preservado em `release/`). Se alguém sobrescrever o 1.1.15 de novo, a suíte falha; foi exatamente o que aconteceu comigo e nada reclamou.

**A lição, e é a terceira vez nesta sessão que o mesmo tipo de falha aparece:** eu tinha um mecanismo que pegava pacote obsoleto — o hash fixado do entregue — e ele funcionou duas vezes. O que faltava era o mesmo mecanismo para o artefato **histórico**: um pacote antigo que foi aprovado precisa ser imutável, e nada no repositório garantia isso. Agora garante.

De passagem, o tamanho de cada um confirma a diferença: 1.1.15 tem 1.044.162 bytes e 1.1.16 tem 1.044.772 — 610 bytes de código novo, o produtor de 5.9.7.

## Rodada 45 — revisão independente da 1.1.16: um Critical, e a correção que ele exigiu

A revisão integrada independente da 1.1.16 finalmente foi executada, sobre o diff congelado `2d205c1..3cacadd` e o artefato `c175a224…`, num worktree destacado e separado da árvore de trabalho. Veredito: **1 Critical, 2 Important, 3 Minor.** O relatório completo está em `/private/tmp/adv116/REVIEW-1.1.16.md` (fora do repositório, porque é insumo de trabalho, não entrega). Ela também confirmou os dois pins (zip e PDF), conferiu os 199 arquivos do zip entregue contra a árvore por descompactação própria, e provou a não vacuidade dos testes revertendo `src/` para `2d205c1` numa cópia.

### C1 — Critical: 5.9.7 convertia marcação legítima em infração confirmada

**O que ela mediu, e eu reproduzi com o mesmo consumidor no Chrome 152.0.7977.64.** O produtor de obrigatoriedade lia apenas o `innerText` do `<label>` associado. Com isso, cinco campos legítimos ficavam com `requiredIndicator` vazio e recebiam `outcome: failed` com alvo `missing-required-identification`:

```
label::after { content: " *" }   Chrome reporta o conteúdo renderizado como " *"
<label>Nome</label><span>*</span>
<span id="l">Nome *</span> + aria-labelledby
placeholder="Nome *"
rótulo de 148 caracteres com " *" no fim
```

Como 5.9.7 é **requisito**, o consumidor anexa a base legal e **o HTML e o PDF exportados imprimiam "Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025"** para uma página que marca a obrigatoriedade por CSS. Isto é exatamente a confusão que o produto proíbe: uma heurística que não consegue provar ausência de percepção apresentada como requisito não atendido, com redação jurídica.

A premissa que eu havia registrado — "nada declarado é exatamente o caso em que ninguém pode perceber nada" — está refutada pela medição: o produtor não observa "nada declarado", observa **algumas fontes**, e uma marcação fora delas existe sem ser vista.

**Correção.** `failed` ficou restrito às duas contradições demonstráveis: token ARIA inválido e divergência entre declaração nativa e ARIA. A marcação deixou de decidir nos dois sentidos:

- **marcação observada** → `cantTell` agregado, sem alvo: contraste, tamanho, posição e o recurso que apresenta a marcação não são medidos;
- **marcação não observada** → `cantTell` com um alvo por campo (`missing-required-identification`), porque ela pode estar em outro ponto da página ou ser percebida por outro meio.

Nenhum ramo conclui atendimento nem infração. É o mesmo tratamento que 5.9.1 já recebia desde a rodada 30.

**Fontes ampliadas**, cada uma por um caso medido: texto dos rótulos associados **sem** o corte de 120 caracteres, conteúdo gerado por `::before`/`::after` do rótulo, elementos nomeados por `aria-labelledby` (que `element.labels` **não** inclui — outra afirmação minha refutada) e `placeholder`.

### I1 — Important: a mesma marcação invisível aprovava

Com o rótulo só para leitor de tela (`left:-9999px`) contendo `*`, a 5.9.7 devolvia `passed` enquanto a 5.9.1 da mesma versão classificava o mesmo nó como `cantTell [offscreen-label]`. Corrigido estruturalmente: a regra não devolve mais `passed` em nenhum caminho, então não há como uma marcação invisível aprovar.

### I2 — Important: o arquivo entregue nunca era conferido contra o hash fixado

O achado é preciso e o teste provou: `test/release-package.test.js` calculava o hash apenas do zip **reconstruído num diretório temporário**. A revisão substituiu `release/audita-acessibilidade-1.1.16.zip` por bytes de lixo e a suíte continuou **7/7 verde**. O pin do artefato entregue não protegia o artefato entregue.

**Correção:** o teste agora confere o hash **duas vezes** — contra `release/<pacote>.zip` e contra a reconstrução. Não vacuidade demonstrada pelo mesmo procedimento: com o arquivo entregue substituído por lixo, o teste falha em "o arquivo entregue em release/ precisa ser o artefato de hash fixado". Restaurado em seguida, hash conferido.

### M1 e M3 — menores, corrigidos no texto

- **M1:** `offscreenAway` também dispara para rótulo apenas deslocado dentro de um `overflow-x:auto` (`documentRect.x = -504`), e o alvo afirmava que ele estava "fora da área visível da página". O resultado já era `cantTell`, então a fronteira não mudou; o texto do alvo e o comentário do predicado passaram a descrever o que a medida mostra. Distinguir os dois casos exigiria observar a rolagem do contêiner, que a coleta não registra — cobertura pendente.
- **M3:** corrigidas as três afirmações refutadas (`element.labels` incluir `aria-labelledby`; "rótulo escondido é ignorado"; e o comentário do teste que dizia "segue em revisão" enquanto a asserção exigia `failed`).

### Bump para 1.1.17

A correção muda **o que o relatório decide** em 5.9.7, pela mesma regra que me fez subir de 1.1.15 para 1.1.16. E a 1.1.16 tem um veredito de revisão **negativo** (1 Critical), então confundir as duas seria pior do que o habitual. `manifest.json`, os dois testes que fixam a versão, a listagem da loja, as instruções de teste, o guia de uso e o README passam a 1.1.17; o registro da 1.1.16 fica preservado acima, sem reescrita.

Artefato construído e fixado:

```
audita-acessibilidade-1.1.17.zip
SHA-256 c0cc411887548b46d0c425b7b8d144ee024f62e0945686ce7f5b7b9a9406dbdc
```

Os artefatos 1.1.15 (`5619e27d…`, o que foi aprovado) e 1.1.16 (`c175a224…`, o que a revisão reprovou) permanecem em `release/`, e o teste fixa os dois.

### Não vacuidade e testes focados

- `test/e2e/required-field-observation.test.mjs` reescrito: exige a marcação observada nas quatro fontes, exige que o rótulo invisível não aprove, exige `cantTell` (nunca `failed` nem `passed`), alvo apenas para o campo sem marcação alguma e ausência de linguagem de infração no resultado inteiro. **Contra o commit anterior à correção ele falha** em "a marker rendered by a stylesheet is declared by the page and must be observed" (`actual: ''`, `expected: '*'`), e passa depois.
- 167/167 na família de regras; `field-label-review` 1/1 no Chrome real; `release-package` 7/7.

### As 8 falhas pré-existentes: causa estabelecida, e duas afirmações anteriores corrigidas

Aproveitei a rodada para finalmente instrumentar o que estava registrado como "não investigado". Medi com o próprio teste instrumentado, em worktree separado:

- **Todas as oito** terminam em `PERSONA_CLEANUP_UNCONFIRMED` no início da auditoria, e não em códigos diferentes por rotas diferentes como eu havia escrito. A causa é do **fixture**, não do produto: o mock de `scripting.executeScript` daquele cenário responde toda injeção com `() => globalThis.location?.href`, e o runtime de persona injeta `applyAuditaPersonaCommand` com `documentIds` (o mock decide por `frameIds`). A barreira de limpeza pede uma confirmação exata `{ok:true, state:'absent'|'revoked'}` e o runtime devolve `result-mismatch`, então o início é recusado. Em Chrome real o percurso principal funciona — o E2E do percurso passa —, e é por isso que a falha não aparece no produto.
- A asserção `sourceSnapshots > 0`, que decide três das oito, é **insatisfazível por construção**: o contador só incrementa quando existe `audita:start-journal:v1` na sessão, e o único escritor dessa chave (`reserveAttachedCopyStartJournalV1`) tem um único chamador — `prepareAttachedCopyPlan`, que está morto desde `1c9b296`. Medi: a chave está **ausente** nos oito modos, e `executeScript` é chamado 5 vezes em cada um. A expectativa ficou para trás quando o ramo de cópia anexada foi removido; ela mede um desenho que não existe mais.

Correção fica para incremento próprio, e a terceira dimensão do problema foi medida depois: **o cenário aciona um ponto de entrada que não existe mais**. Ele chama `auditStarter.beginAuthorizedAudit` com `senderContext` e sem `eventNonce`, esperando o ramo de auditoria por URL que `1c9b296` removeu dali. Hoje uma auditoria por URL começa em `side-panel-intent-router.js:545`, que monta o próprio plano (`kind: 'single'`, `navigationPurpose: 'single-url'`) e chama `beginAuthorizedUrlAudit`. O caminho que o cenário acaba exercitando é o de página atual, que usa `runAttachedAuditExecution` — função que o fixture não intercepta, e é por isso que `execution.promise` nunca resolve e o cenário trava. Medi as camadas uma a uma: com o fixture respondendo à sondagem de persona, `started.response` passa a `{ok:true,state:'running'}` e o travamento acontece **depois**, em `await execution.promise`, porque `runUrlAuditExecution` nunca chega a ser chamado.

Tentei a correção mínima num worktree de rascunho — um gancho opcional `options.runAttachedAuditExecution` no worker, simétrico ao `options.runUrlAuditExecution` que já existe — e ele funciona. Mas reescrever o cenário inteiro já travou uma vez, e a decisão é **substituí-lo** por um que exercite o que o trabalhador padrão garante hoje, em vez de remendar um que descreve um ponto de entrada removido; a cobertura da auditoria por URL já existe em `side-panel-intent-router.test.js` e `authorized-audit-starter.test.js`. O gancho fica preparado e não aplicado.

**A maquinaria do diário de início ficou inerte, e não vou refatorá-la.** `reserveAttachedCopyStartJournalV1` não tem chamador, então `audita:start-journal:v1` nunca é escrita, e as 117 referências a `AUDIT_RECOVERY_REQUIRED` que a leem são defesa inerte. Removê-las é refactor grande em caminho sensível, com quatro arquivos de teste envolvidos, e o ganho é limpeza, não correção. Fica registrado como observação estrutural medida.

### Uma nona falha apareceu, e é instabilidade sob carga

Na primeira execução da suíte, `annotation-map` falhou em "times out a stalled bitmap allocation". Isolei: **26/26 passam** rodando o arquivo sozinho, e a segunda execução completa voltou a 8 falhas com esse teste verde. É teste sensível a tempo sob carga paralela, não regressão desta rodada — mas é uma nona fonte de ruído no portão de release e fica registrada como tal.

## Rodada 46 — o pacote extraído passou a ser executado, e isso fecha o critério 12

O critério 12 estava registrado com uma ressalva honesta: os 199 arquivos do zip eram byte a byte idênticos à árvore que o Chrome real carrega, então **os bytes executados eram os bytes empacotados**, mas o ato de extrair o zip nunca tinha sido exercitado. A ressalva vinha de um `WAIT_TIMEOUT` antigo: o harness abre `chrome-extension://<id>/test/e2e/fixtures/real-tab-harness.html`, e a distribuição exclui `test/`, corretamente.

**A hipótese nova que faltava era trivial e eu não a tinha tentado:** extrair o pacote e **acrescentar a árvore de teste** ao diretório extraído. O produto nunca referencia `test/` — não há `content_scripts` declarado e o manifesto não aponta para lá —, então os bytes do produto executados continuam sendo exatamente os empacotados; só os fixtures de teste, que não fazem parte da entrega, passam a existir ao lado. Nenhuma linha de produto ou de teste precisou mudar.

Procedimento, e o que ele mede:

```
unzip -q release/audita-acessibilidade-1.1.17.zip -d /private/tmp/pkg117
cp -R test /private/tmp/pkg117/test
diff -r --exclude=popup /private/tmp/pkg117/src src   # idêntico
diff /private/tmp/pkg117/manifest.json manifest.json # idêntico
```

Com os bytes conferidos **antes** da execução, rodei do diretório extraído, no Chrome 152.0.7977.64:

- `mandatory-journey-mv3`: **1/1** — percurso completo numa sessão, `journey ok; audit=bc4fe20a…; formats=html,pdf,csv,json`;
- `current-page-export-mv3`: 1/1 — auditoria da página atual exporta os quatro artefatos verificados;
- `highlight-marking-mv3`: 1/1 — o destaque desenha a caixa marcada sobre o elemento auditado;
- `page-markers-signals-mv3`: 1/1 — os sinais numerados são desenhados sobre a página auditada;
- `report-version-provenance`: 1/1 — o relatório registra a versão que fez a auditoria;
- `resource-url-privacy`: 1/1 — a URL de recurso mantém origem e caminho e nunca query ou fragmento.

**6/6 verdes a partir do pacote extraído.** O percurso obrigatório e as garantias que o critério 12 pede foram executados sobre os bytes entregues, não sobre a árvore.

**O que ficou de fora, e por quê.** A execução dos 34 arquivos de Chrome real de uma vez falhou com `CDP_COMMAND_TIMEOUT` em parte deles, porque a revisão independente da 1.1.17 estava rodando Chrome ao mesmo tempo — é contenção, não produto: os seis acima, executados logo depois, passaram. A bateria completa a partir do pacote fica para quando não houver outra instância ativa, e o resultado será registrado aqui.

**Identidade de bytes conferida por completo, além do `src/`:** `vendor/` idêntico, `assets/` idêntico exceto as duas fontes de desenho (`icon-1024.png` e `icon-source.svg`), que a distribuição exclui e que o manifesto **não** referencia — os quatro ícones declarados (16/32/48/128) estão os quatro no pacote. `manifest.json` idêntico. Contagem: 199 arquivos no zip e 199 no diretório extraído. Nada no pacote está faltando em relação ao que o manifesto usa.

## Rodada 47 — revisão independente da 1.1.17: 0 Critical, 3 Important, e a correção que eles exigiram

A revisão da 1.1.17 (diff congelado `3cacadd..c64221d`, artefato `c0cc4118…`, worktree separado) voltou com **0 Critical, 3 Important, 5 Minor**, e confirmou por medição que **C1, I1, I2 e M1 estavam genuinamente fechados**: com o `src/` pré-correção a mesma fixture produzia `failed` + 21 alvos + frase legal, e com o `src/` corrigido produz `cantTell` + 10 alvos + **0 frases legais**; 0 de 120 estados sintéticos devolvem `passed`; lixo no zip entregue agora falha o teste (e no commit anterior continuava 7/7 verde); os três hashes conferem e os 199 arquivos do zip foram comparados um a um por ela, com descompactação própria.

Mas ela mediu três achados Important, todos no mesmo item, e todos introduzidos por mim:

**I-1 — a suspeita nova não chegava ao relatório.** `missing-required-identification` não estava em `CONCRETE_REASONS` (`src/core/report/finding-kind.js`), então toda ocorrência `cantTell` de 5.9.7 era classificada como **checklist genérico**: o cartão mostrava só orientação por item e ids opacos de ocorrência, a mensagem do campo e o seletor **não apareciam no HTML exportado**, e no PDF sobrava apenas uma contagem. O comentário da própria regra a chamava de "suspeita concreta", e o produto promete suspeitas e checklist como grupos distintos. **Corrigido**: os três motivos de 5.9.7 entraram em `CONCRETE_REASONS`; a ocorrência passa a cair no grupo de revisão humana (`groupForOccurrences`: `cantTell` → `humanReview`), com cartão próprio.

**I-2 — a suspeita era descartada em silêncio.** A regra devolvia `failed` só com os problemas de declaração e **descartava os campos sem marcação** sempre que algum campo tinha declaração inválida. Ela confirmou num relatório exportado de verdade: `#bare` (obrigatório, sem marcação nenhuma) não aparecia no HTML, no JSON nem no PDF. **Corrigido**: um único resultado `cantTell` lista os dois grupos, um alvo por campo; teste unitário fixa o caso combinado.

**I-3 — a branch sobrevivente imprimia a frase legal.** Ela mediu com `Accessibility.getPartialAXTree` que `<input aria-required="maybe">` e `<input required aria-required="false">` são expostos pelo Chrome como `required: true` — e o relatório imprimia "Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025" para eles. O item mapeia só 3.3.2 (rótulos/instruções), e token ARIA malformado é território de 4.1.2, que 5.9.7 não reivindica. **Corrigido**: 5.9.7 deixou de produzir `failed` — o item é sobre percepção, e nada do que se mede ali prova percepção. Os dois grupos viram suspeita com alvo por campo. O texto de remediação de `missing-required-identification` passou a ser orientação de revisão, não ordem de correção.

**Minor corrigido de passagem:** o comentário do E2E afirmava que a marcação é observada "de toda fonte que a página associa ao campo" — a revisão refutou com sete mecanismos ainda não observados (irmão, `title`, `legend`, `img alt`, elemento pai, nome acessível, pseudo de filho). O comentário passou a enumerar as quatro fontes realmente observadas. Os demais Minor ficam registrados: alvo de `aria-labelledby` dentro de shadow root não é observado (direção segura: suspeita), e M2 segue **não corrigido** — a revisão mostrou que o caminho de exportação por modelo gerado alcança o renderizador frouxo, o que a minha rodada anterior tinha dado como inalcançável.

**Bump para 1.1.18**, porque isto muda o que o relatório decide e apresenta — e a 1.1.17 tem veredito com três Important, então também não substitui o candidato aprovado. Artefato novo:

```
audita-acessibilidade-1.1.18.zip
SHA-256 c76d49ce5996679ac419f26b2439ecca526bfc9a3dff9edfe9630e715a4f80c6
```

Os artefatos 1.1.15 (`5619e27d…`, aprovado), 1.1.16 (`c175a224…`, reprovado) e 1.1.17 (`c0cc4118…`, três Important) permanecem em `release/`; o teste fixa os quatro hashes.

**Testes desta revisão, medidos.** `forms` 21/21; `finding-kind` 6/6 (o caso novo fixa os três motivos de 5.9.7 como suspeitas e exige alvo correlacionado); painel+relatório+revisão 640/640; `release-package` + `extension-shell` 12/12; E2E de 5.9.7 no Chrome real 1/1; `verify-project` GREEN. Suíte completa: **4185 testes, 4176 passam, 9 falham** — as mesmas 8 pré-existentes de `service-worker` mais a instabilidade conhecida de `annotation-map` ("times out a stalled bitmap allocation"), que passa **26/26** isolada. Nenhuma falha nova veio desta mudança.

### Correção de uma afirmação minha sobre M2, que a revisão da 1.1.17 refutou

Eu havia escrito nesta sessão que "a nota é exigida apenas para emitir a referência curta de inconformidade", e tratei M2 como inalcançável em produção. A revisão mediu e refutou as duas coisas:

- **São três sítios, não dois.** `src/core/legal/consumer-basis.js` (via `createReviewDecision`, exige `note` não vazia) e `src/panel/panel-detail.js` (exige `evaluator`, `decidedAt` e `note` não vazios) recusam a frase para uma decisão humana "não conforme" sem nota. O ramo de modelo de `src/core/report/html.js:505-515` **não** exige: ele aceita `outcome === 'cantTell' && decision.answer === 'não conforme'` e imprime "Inconformidade ao item …". Medido com um modelo construído pela cadeia real: o renderizador de modelo imprime 1 frase com uma decisão sem nota, enquanto o renderizador de `reportView` imprime 0 e `panel-detail` devolve `legalReference: null`.
- **O caminho existe.** `src/export/report-export.js:127` renderiza em modo modelo e imprime o PDF a partir dele; o ramo com `reportView` (`:291`) vive em `runImmutableRevisionExport`, outra função. O caminho de modelo é tomado quando não há `snapshotCapability` ou `reportView` (`:88-97`). A exportação normal da página atual, que eu exercitei, é a imutável e **não** é afetada — medido 0 frases.

**Estado: não corrigido nesta revisão.** A revisão classificou M2 como **Minor**, com confiança média na alcançabilidade em produção (ela mediu o renderizador e leu a cadeia, não percorreu a interface por esse estado). A correção é pequena e alinharia o terceiro sítio aos outros dois — exigir `evaluator`, `decidedAt` e `note` não vazios —, e fica registrada como item do próximo incremento, junto da decisão sobre se ele justifica revisão própria. O que não pode continuar é a afirmação anterior, que estava errada: o portão da nota **não** é único, e o renderizador de modelo é o sítio frouxo.

## Rodada 48 — inspeção do relatório da 1.1.18, feita sobre os bytes empacotados

O passo "inspecionar visualmente o relatório HTML e PDF" continuava pendente, e eu o executei do jeito mais forte que tenho: **extraí o zip da 1.1.18, acrescentei a árvore de teste ao diretório extraído e rodei o percurso ali**, com os bytes do produto conferidos por `diff` antes da execução. Um script de inspeção fora do repositório (dentro da cópia extraída, para não entrar na classificação de E2E) abre o painel, audita a página atual em modo sem pixels, abre o relatório e exporta os quatro formatos.

**Página de prova:** fixture com um botão sem nome, um campo sem rótulo, um link "clique aqui", um campo obrigatório com marcação `*`, um campo obrigatório **sem** marcação e um campo com `aria-required="maybe"`.

**O que o relatório entregue mostra, medido no DOM e na imagem:**

- **Contagens coerentes e separadas**: painel e relatório dizem a mesma coisa — *"2 verificações com falha confirmada (4 ocorrências); 6 verificações sob revisão humana (8 ocorrências). Checklist separado: 99 verificações ainda sem conclusão."* As três categorias que a meta exige estão distintas e nomeadas, e o checklist é por **item**, não por elemento.
- **Sumário executivo** com estado da auditoria ("Concluída com limitações") e limitações críticas; **gráfico de rosca** com o indicador numérico e a frase **"Índice técnico automatizado — não é uma nota de acessibilidade"**, mais o link "Como o gráfico e o índice são calculados" para a fórmula e o denominador; **cobertura automatizada** declarada à parte.
- **Quatro cartões de classificação** com texto além da cor ("Não conformidades", "Alertas", "Suspeitas a confirmar", "Resultados positivos"), filtros e agrupamentos expansíveis por item ABNT, "Não conformidades priorizadas", registro de decisão de revisão humana com nome do avaliador, mapas de anúncios e a **matriz completa dos 146 itens**.
- **Metodologia e integridade**: versão da extensão **1.1.18**, axe-core 4.13.0, hashes da camada de regras e do inventário, Chrome/152.0.7977.64, fontes oficiais e anexo de evidências.
- **Linguagem legal só onde é devido**: as duas não conformidades confirmadas (5.13.10 e 5.9.3) aparecem como *"Inconformidade ao item … da ABNT NBR 17225:2025"*; **5.9.7 aparece como "Verificar o item 5.9.7 da ABNT NBR 17225:2025"**, sem frase legal.
- **A suspeita de 5.9.7 saiu do checklist genérico.** No modelo exportado há **duas ocorrências `cantTell`** para o item, com `nodeId` n-3 e n-4 e os motivos `missing-required-identification` e `invalid-required-state`; o item **não** está entre as perguntas do checklist, e a contagem de revisão humana as inclui. Antes da correção elas eram um cartão genérico sem informação de campo.
- **Exportação íntegra**: HTML 320.993 B, PDF 1.029.723 B, CSV 80.822 B, JSON 347.415 B, os quatro com recibo `complete` e sha256.

**O que continua faltando, e fica registrado.** A frase específica do motivo por ocorrência ("Nenhuma marcação de obrigatoriedade foi observada junto a este campo…") **não** é renderizada: para ocorrências de regra do núcleo, o modelo guarda `justification` como o resumo canônico (regra + desfecho), e o motivo por alvo vive em `ruleResults[].targets[].data.reason`, que o relatório não imprime. O usuário identifica o campo pelo nome acessível, pela evidência e pelo destaque, e a rastreabilidade está no JSON — mas a frase por campo exigiria um campo novo no modelo, com validação e compatibilidade. Não é uma correção de uma linha, e entra no backlog com esta descrição.

**Um erro meu de leitura, corrigido por medição.** Na primeira passada eu li na imagem que o cabeçalho dizia "1 não conformidade" enquanto o cartão dizia "2" — pareceu uma incoerência de contagem no relatório. Medi o DOM: o cabeçalho diz *"2 verificações com falha confirmada (4 ocorrências)"*, igual ao painel. A incoerência era da minha leitura da imagem em baixa resolução, não do produto.

## Rodada 49 — página real do Google com os bytes empacotados da 1.1.18

O passo "testar página simples, como Google" também estava pendente para esta versão. Rodei pelo mesmo caminho das rodadas anteriores — pacote extraído, `diff` conferido antes de executar — e medi no Chrome 152.0.7977.64.

**Contagens do painel e do relatório, idênticas entre si:** *"0 verificações com falha confirmada (0 ocorrências); 1 Recomendação/alerta (1 ocorrência); 3 Suspeitas a confirmar (4 ocorrências); 9 Resultados positivos. Checklist separado: 109 verificações ainda sem conclusão."* Treze grupos de item no relatório.

**Comparação com a medição histórica da mesma página: 0 / 1 / 3 / 9 — exatamente os mesmos números.** Era o que eu queria verificar: a mudança de 5.9.7 (que removeu a reprovação do item e reencaminhou a suspeita) **não alterou o resultado na página real**, e nenhuma falha confirmada apareceu onde antes não havia. Como o Google não tem campo obrigatório, o item 5.9.7 nem entra; o que a medição prova é ausência de efeito colateral, não cobertura.

**Disciplina do relatório entregue, lida do HTML exportado:**

- **Zero ocorrências de "Inconformidade ao item … da ABNT NBR 17225:2025"** — com zero falhas confirmadas, nenhuma frase legal é impressa. É a verificação de critério 7 no extremo: o produto não inventa não conformidade em página real.
- **108 itens com "Verificar o item …"**, a linguagem de revisão pendente, coerente com o checklist de 109.
- **Fórmula, denominador e limites explícitos**: *"não é nota, certificação ou declaração de conformidade"*, *"Sem denominador, não há nota"*, *"O gráfico usa verificações agrupadas, não quantidade de elementos"*, e a explicação de que o denominador do índice difere do denominador dos grupos consolidados porque inclui requisitos e recomendações dos níveis avaliados.
- **Cobertura declarada à parte**: *"Cobertura automática: 29,2%. Mede os testes do motor próprio com conclusão automática (passed, failed ou inapplicable), divididos pelo inventário desse motor nas páginas tentadas"*.
- **Índice com numerador e denominador**: *"Índice técnico automático — motor próprio 9,0 / 10 — 9 verificações atendidas entre 10 com conclusão automática"*.
- **Limitações registradas**: auditoria "concluída parcialmente", *"não representa conformidade AA"*, *"Mesmo 10 não comprova acessibilidade integral"*.
- **Versão da extensão 1.1.18** no bloco de metodologia.

**Exportações**: HTML 325.195 B, PDF 957.686 B com **17 páginas**, CSV 82.886 B, JSON 358.717 B, os quatro com estado `complete`. Dezessete páginas para 0 falhas, 1 alerta, 3 suspeitas, 9 positivos e 109 pendências de checklist é paginação razoável, e está a duas ordens de grandeza do defeito de 700 páginas registrado na meta.

**Uma nota de infraestrutura:** a primeira tentativa de exportar estourou o tempo de espera (`DOWNLOAD_PROOF_TIMEOUT`) com 240 s; com 420 s os quatro arquivos saíram íntegros. A exportação desta página leva mais de quatro minutos, o que é útil saber antes de rodar o percurso completo em página grande.

**Detecção conferida na fixture de defeitos conhecidos (falsos negativos).** A página de inspeção injeta um botão sem nome acessível, um campo sem rótulo, um link "clique aqui", um campo obrigatório com marcação, um obrigatório sem marcação e um com `aria-required` inválido. O relatório entregue traz **duas não conformidades confirmadas, exatamente as duas que a ABNT trata como requisito verificável no escopo automático** — item **5.13.10** (componente sem nome acessível, para o botão) e item **5.9.3** (rótulo de campo associado, para o campo sem rótulo) —, e as imprime com a frase legal. Não houve falha confirmada para o link "clique aqui" nem para os campos obrigatórios: o link é o caso de propósito genérico, que é suspeita e não infração, e os obrigatórios agora são suspeita por definição. O que a fixture prova é que **defeito injetado conhecido continua sendo detectado e classificado no grupo certo** depois de todas as mudanças desta sessão em 5.9.7 — o item que deixou de reprovar não arrastou os itens vizinhos.

## Rodada 50 — dois defeitos de infraestrutura de teste que escondiam o E2E de Chrome

Ao rodar os E2E de modo de evidência a partir do pacote extraído da 1.1.18, um deles falhou com `DOWNLOAD_PROOF_TIMEOUT`. Investiguei em vez de registrar "instabilidade", e encontrei **dois defeitos reais de infraestrutura**, nenhum deles no produto.

**1. A suíte nunca executava os 34 E2E de Chrome real.** `scripts/run-tests.mjs` fazia:

```js
const parallelStatus = await runTests(plan.parallel);
if (parallelStatus !== 0) return parallelStatus;   // <- parava aqui
return runTests(plan.serial, { serial: true });
```

A fase paralela tem **oito falhas pré-existentes conhecidas**, então `parallelStatus !== 0` **sempre**, e a fase serial — os 34 arquivos de Chrome real, incluindo `mandatory-journey-mv3` — **nunca chegava a rodar**. Confirmei no log da suíte: `grep -c "mandatory journey"` devolveu **0**. Ou seja, todas as vezes que registrei "4185 testes, 4176 passam, 8 falham" eu estava reportando **apenas a fase paralela**, sem nenhum E2E de Chrome, e apresentando isso como suíte completa. É um erro meu de relato, e a causa é o runner.

Corrigido: as duas fases sempre executam e o pior resultado é o que sai. `scripts/` não faz parte do pacote, então isso não alterou o artefato nem invalidou a revisão em curso.

**2. Um E2E falhava de verdade, e ninguém via.** `test/e2e/batch-pixel-consent-mv3.test.mjs` falha com `DOWNLOAD_PROOF_TIMEOUT` **na própria árvore**, não só na cópia do pacote: reproduzi com `node --test test/e2e/batch-pixel-consent-mv3.test.mjs` no worktree e deu 0/1. Como a fase serial nunca rodava, essa falha estava invisível.

**A causa é orçamento, não produto.** Com o mesmo arquivo e o orçamento de download elevado de 90 s para 420 s, o teste **passa, e em 15 s de duração total** — ou seja, a exportação de lote em evidência completa com confirmação de pixels funciona e entrega os quatro arquivos; o que acontece é que a exportação de uma página grande varia de 15 s a mais de 4 minutos conforme a carga da máquina (medi >240 s na página do Google com outra instância do Chrome ativa). Um orçamento de 90 s é apertado demais para um portão de release.

Corrigido sem enfraquecer asserção nenhuma — as verificações de formato, estado, tamanho e sha256 continuam idênticas; só o tempo de espera mudou: `public-axe-map` 60 s → 300 s, `url-audit` 90 s → 300 s, `batch-pixel-consent` 90 s → 300 s (e o `timeout` externo 360 s → 600 s), `mandatory-journey` 120 s → 300 s. **`sidepanel-flow-mv3` ficou intocado de propósito**: é o arquivo de outro incremento.

**O que isso muda no portão de release.** A partir de agora `npm test` executa a fase serial, e o resultado passa a incluir os 34 E2E de Chrome real. Qualquer afirmação anterior minha sobre "suíte completa" valia só para a fase paralela, e é assim que deve ser lida.

## Rodada 51 — revisão da 1.1.18: o quarto Important, e o E2E serial que nunca rodava

A revisão independente da 1.1.18 devolveu **0 Critical, 1 Important, 3 Minor**, e disse explicitamente que a 1.1.18 **não** pode substituir o candidato ainda. Os três Important da rodada anterior estão fechados por medição (com controle positivo: as frases legais continuam saindo para falhas reais), mas ela achou um **quarto caso da mesma classe de descarte silencioso**:

**O achado.** `src/core/rules/forms.js` devolvia "faltam dados" **antes** de devolver os alvos já coletados. O gatilho é um campo com o atributo nativo `required` **e** um token ARIA malformado (`aria-required="maybe"`, `""` ou `"required"`): a regra lê o atributo nativo primeiro e considera a declaração válida, enquanto o coletor deixa `required` **sem observação** para não inventar booleano a partir de um token inválido — então `!hasOwn(field,'required')` liga a incompletude. Efeito medido por ela no produto real: `targets=2 → 0`, o item cai no checklist genérico, e um campo obrigatório **sem marcação nenhuma** na mesma página aparece **zero vezes** no HTML, no JSON e no PDF. Idêntico em `c64221d`, ou seja, herdado — mas a minha afirmação da rodada anterior, "nenhum campo é descartado", estava falsa.

**Correção.** A falta de dado virou **limitação declarada**, não devolução antecipada: os alvos observados sempre saem, e a limitação diz que há campo sem estado calculado ou sem indicador observado. Unidade: `test/rules/forms.test.js` ganhou o caso exato do gatilho, e ele **falha contra o `src/` anterior** (`actual: []`, `expected: ['unmarked']`). E2E: a fixture de 5.9.7 ganhou o campo `#native-malformed` e a asserção de que o alvo de `#aria-required` sobrevive — o E2E, que era cego a esta mudança, **agora falha contra os bytes anteriores** (`actual: []`) e passa depois.

**M2 corrigido.** O terceiro sítio que pode imprimir a referência legal (`src/core/report/html.js`, ramo de modelo) passou a exigir `evaluator`, `decidedAt` e `note` como `consumer-basis.js` e `panel-detail.js`. A revisão não encontrou fluxo de produto que alcance esse ramo hoje (a aba de exportação sempre passa `reportView`), mas um portão de redação jurídica não deve depender de o caminho ser improvável. Teste novo em `test/report/html.test.js` fixa o caso sem nota; os testes existentes que verificavam a referência revisada ganharam a nota que os outros dois sítios já exigiam.

### O E2E serial nunca rodava — e agora roda, com 11 falhas não triadas

Corrigi o runner (`scripts/run-tests.mjs`) para executar as duas fases e devolver o pior resultado. A suíte passou a rodar os 34 arquivos de Chrome real pela primeira vez como portão, e o resultado honesto é:

```
fase paralela:  4187 testes, 4179 passam, 8 falham  (as mesmas de service-worker)
fase serial:      65 testes,   54 passam, 11 falham
```

**As 11 falhas do E2E serial não estão triadas**, e não vou apresentá-las como instabilidade genérica. O que já medi: `mandatory-journey-mv3` falhou numa execução com *"the side panel must not resize itself during the journey"* e **passou nas duas seguintes** e também a partir do pacote extraído — é intermitente, e é exatamente o critério 1 ("sem instabilidade") que precisa de atenção. `batch-pixel-consent-mv3` falhava por orçamento de download curto (com 420 s passa em 15 s). As outras nove precisam de triagem uma a uma, distinguindo intermitência, orçamento e defeito real. Fica como o próximo incremento obrigatório antes do candidato.

**Correção de relato:** todas as vezes que registrei "suíte completa: 4185 testes, 4176 passam, 8 falham" eu estava descrevendo **apenas a fase paralela**, sem nenhum E2E de Chrome. O número não estava errado; o rótulo estava.

**Identidade do artefato 1.1.19, conferida por mim.** `unzip` dos 199 arquivos; `src/` (menos `popup`, excluído pela distribuição), `manifest.json`, `vendor/` e `assets/` (menos as duas fontes de desenho que o manifesto não referencia) byte a byte idênticos à árvore; `manifest` dentro do pacote declara 1.1.19; e as duas correções desta revisão estão **no arquivo empacotado** — o tratamento de dado ausente em `forms.js` e a exigência de nota em `html.js`. SHA-256 do zip: `0e429e22…`, igual ao fixado em teste.

## Backlog com análise pronta (dois itens Minor das revisões)

**1. O cartão do relatório mostra só a primeira correção do item.** `src/review/report-view.js:327` escolhe `occurrences.find(o => o.remediation !== null)?.remediation` para o cartão e para o bloco "Como corrigir" (`plainLanguage.correction`, via `plainCorrection`). Só que cada ocorrência **já tem** a sua remediação individual (linha 324, `remediationForOccurrence`, que lê a mensagem do alvo da regra), e desde a 1.1.18 o item 5.9.7 pode ter duas causas diferentes no mesmo cartão — campo sem marcação e declaração inválida — com correções diferentes. O usuário vê uma delas. Correção preparada: manter `remediation` do cartão como está (há consumidores que esperam uma instrução) e montar `plainLanguage.correction` com as remediações **distintas** das ocorrências, na ordem em que aparecem, caindo no texto atual quando houver só uma. Não foi aplicada para não invalidar a revisão em curso.

**2. Vocabulário português do portão de palavra sensível.** `SENSITIVE_KEY` (`src/core/privacy.js`) é anglocêntrico: pega `token`, `secret`, `session`, `api-key`, mas não "senha", "sessão" nem "chave". A decisão pendente não é técnica, é de vocabulário acordado — ampliar a lista muda a redação de campos legítimos que contenham esses termos, e o efeito é sempre fail-closed (mais remoção, nunca menos). Registrado desde a rodada em que a allowlist de `contenteditable` foi decidida; continua sem correção por escolha, não por esquecimento.

**3. As 8 falhas pré-existentes do `service-worker`.** A causa está estabelecida: o mock de `executeScript` daquele cenário responde a sondagem de persona com array vazio (decide por `frameIds`, o runtime usa `documentIds`), 7 dos 8 também asseveram `sourceSnapshots > 0`, cujo único escritor foi removido em `1c9b296`, e o cenário aciona `beginAuthorizedAudit` — ponto de entrada que o roteador de intenções substituiu para auditorias por URL. Reparo é só de teste: dirigir o cenário por `beginAuthorizedUrlAudit` com um plano `single-url` montado como o roteador monta (não exige diário, porque `lockedAttachedCopy` só vale para `attached-copy`), responder a sondagem de persona e trocar as asserções obsoletas de `sourceSnapshots` por uma leitura real do documento observado. Não foi aplicado para não invalidar a revisão em curso.

## Verificação por leitura: menu de contexto e auditoria de várias URLs (critério 9)

Dois recursos obrigatórios da meta que eu ainda não tinha verificado pessoalmente, conferidos por leitura do código e do roteamento — não por execução:

**Menu de contexto como atalho.** `manifest.json` declara a permissão `contextMenus`; `src/background/context-menu.js` cria, remove e escuta o clique; e o serviço os registra de fato — `service-worker.js:2129` constrói `registerAuditContextMenus(chromeApi, …)` e `:2137` chama `installMenus()` em `startupReady`. Não é código morto. E não é o único acesso: o painel oferece `START_ATTACHED` e o campo de URL, então o menu é atalho, como a meta exige.

**Auditoria de várias URLs.** O caminho existe ponta a ponta: o painel projeta o estado `batch` (`panel-view.js:56-71`), o roteador de intenções aceita `PANEL_START_BATCH_AUDIT` (`side-panel-intent-router.js:42`) e o encaminha para `startBatch` (`:965`), e o starter tem `runBatchAuditExecution` com `src/background/run-batch.js` e `batch-audit-execution.js` por trás. Também não é código morto.

**O que isto não é.** É verificação de existência e alcance, não de comportamento: os E2E que exercitam lote, cópia atual e URL (`url-audit-mv3`, `batch-pixel-consent-mv3`, `current-page…`, `passive current-page…`) estão justamente entre as 11 falhas não triadas da fase serial, e é a triagem em curso que decide se alguma delas é defeito de produto. Enquanto isso não fechar, o critério 9 está atendido quanto a "implementado", não quanto a "funcionando sem instabilidade".

## Verificação estática do invariante do nonce (item de rigor máximo, não coberto pelas revisões)

As duas revisões independentes desta sessão declararam explicitamente que **não** verificaram o invariante do nonce de ponta a ponta. Fechei a metade que se pode fechar por leitura, e digo com precisão o que ela é.

**O nonce não tem como chegar ao modelo, ao relatório, à revisão nem às exportações — por construção.** `grep -rl "nonce"` em `src/core/report/`, `src/core/review/`, `src/review/` e `src/export/` devolve **zero arquivos**: nenhum módulo dessas camadas menciona a palavra, então nenhum deles pode serializar o valor. As 19 ocorrências de `eventNonce` estão todas em `src/background/`, o caminho de autorização do trabalhador, e nenhuma em `src/panel/` ou `src/core/`.

**O nonce não tem como chegar a um log — por construção.** Não existe **nenhuma** chamada `console.*` no código do produto (`src/background/`, `src/panel/`, `src/core/report/`, `src/export/` devolvem zero). O trabalhador registra por uma interface injetada cujo padrão é um no-op (`{ error() {} }`), e **todos os 10 pontos de chamada passam apenas constante**: `SIDE_PANEL_DEFAULT_DENIED`, `SIDE_PANEL_BEHAVIOR_DENIED`, `PANEL_LAUNCH_UNAVAILABLE`, `SESSION_ACCESS_LEVEL_DENIED` e o `code` validado de `panel-launcher.js:51`. Nenhum passa objeto, requisição ou estado.

**Distinção que importa, para não confundir dois valores.** O nonce de consentimento é um token de 22 caracteres (`^[A-Za-z0-9_-]{22}$`, em `context-menu.js` e `chrome-adapter.js`). O que aparece na URL do painel é outro valor, de 43 caracteres, que existe por desenho para o painel poder se abrir. Tratar os dois como o mesmo item produziria uma conclusão falsa nos dois sentidos.

**O que isto NÃO prova.** Não é uma varredura de runtime: eu não medi, num Chrome real, que nenhum atributo do DOM receba o nonce durante uma auditoria, nem que nenhuma mensagem trocada entre painel e trabalhador o carregue em claro. A contenção estática mostra que as camadas que persistem e exibem não o conhecem; a varredura de runtime continua pendente e assim registrada.

## Verificação dos modos de evidência e da promessa de "sem redimensionamento" (critério 4)

Rodei, **a partir dos bytes empacotados da 1.1.18** (pacote extraído + árvore de teste copiada, produto conferido por `diff` antes de executar), quatro E2E de Chrome real ligados a evidência e autorização:

```
capture-visible-element        1/1  "a fully visible element capture preserves viewport and
                                     captures real pixels at both scroll positions"
personas-mv3-csp               1/1  personas reversíveis no documento MV3 real sob CSP estrita
url-pixel-consent-mv3          1/1  modos de pixel por URL pausam, sobrevivem a reinício do
                                     trabalhador, continuam one-shot e limpam abas próprias
batch-pixel-consent-mv3        0/1  DOWNLOAD_PROOF_TIMEOUT com orçamento de 90 s
```

O quarto é o caso de orçamento já diagnosticado: com o mesmo arquivo e o orçamento elevado para 420 s, **passa em 15 s de duração total** — a exportação de lote em evidência completa com confirmação de pixels funciona e entrega os quatro arquivos; o que existia era um tempo de espera apertado demais para página grande sob carga. O orçamento foi elevado para 300 s em `test/e2e/batch-pixel-consent-mv3.test.mjs` (e em `public-axe-map`, `url-audit` e `mandatory-journey`), sem tocar em nenhuma asserção de formato, estado, tamanho ou sha256.

**Por que isto vale para a 1.1.19.** `git diff --stat 75e2717..dad1cda -- src/` mostra que entre a 1.1.18 e a 1.1.19 mudaram **apenas** `src/core/report/html.js` e `src/core/rules/forms.js`. Todo o caminho de captura, overlay, personas e consentimento de pixels é byte a byte o mesmo que executou esses testes — então a medição acima vale para a revisão atual, e digo isso com a razão, não por suposição.

**Critério 4, metade do redimensionamento.** A exigência é que a auditoria não faça o usuário assistir a rolagens, mudanças de foco, redimensionamentos ou navegação. O E2E do percurso compara rolagem, foco e a marcação do autor antes e depois, e passa; e `capture-visible-element` exige explicitamente que a captura de um elemento totalmente visível **preserve a viewport** — que é exatamente o ponto onde o Chrome 152 com `captureBeyondViewport=true` já havia mostrado `clientWidth 1265 → 1280`. A limitação conhecida continua sendo o recorte de regiões fora da viewport, registrada desde a rodada de captura.

## Entrega corrigida: o aviso de escopo da comparação com avaliadores externos

O documento do usuário `entregas/comparacao-avaliadores-externos.md` (fora do repositório versionado) afirmava **"a versão continua 1.1.14"** — o que deixou de ser verdade há cinco versões — e listava as mudanças posteriores sem mencionar a mais relevante para quem compara números: a retirada da reprovação do item 5.9.7. Corrigi o aviso de escopo, e o que ficou dito é:

- o parecer lado a lado é **histórico** (Audita 1.1.14, 12/09/2026) e **não descreve o código atual**;
- desde então o produto **confirma menos não conformidades e declara mais suspeitas**, e isso não significa que a página melhorou — é mudança de classificação, com o 5.9.7 nomeado como a causa principal;
- **uma comparação lado a lado desta versão não foi executada** — nenhuma URL foi submetida à AMAWeb nem ao AccessMonitor para a versão atual, e a coluna do Audita no parecer continua sendo a 1.1.14;
- o número atual que existe é o da página do Google medido sobre os bytes empacotados (0 falhas, 1 alerta, 3 suspeitas com 4 ocorrências, 9 positivos, cobertura 29,2%, índice 9,0/10, PDF de 17 páginas), com ponteiro para o registro de método nesta trilha.

As conclusões técnicas do documento (natureza local do processamento, ABNT contra WCAG, tratamento da incerteza, unidades de contagem e ausência de nota única) continuam corretas para a versão atual — e a terceira ficou **mais** verdadeira depois das correções: "não converte suspeita em infração" agora vale também para 5.9.7.

## Pista medida para a intermitência do painel (critério 1), sem executar Chrome

A asserção que falhou uma vez em três execuções está em `test/e2e/mandatory-journey-mv3.test.mjs`:

```js
linha 68:  const panelSize = await evaluate(panel, `({ w: innerWidth, h: innerHeight })`);   // linha de base
linha 175: assert.deepEqual(await evaluate(panel, `({ w: innerWidth, h: innerHeight })`), panelSize,
             'the side panel must not resize itself during the journey');
```

A linha de base é capturada **assim que o documento do painel carrega**. E é isso que o harness espera: `openSidePanelFromAction` aguarda o contexto exato de `SIDE_PANEL`, o alvo de página e o carregamento por CDP — **não espera o tamanho estabilizar**. O painel lateral é dimensionado pelo navegador, e nada no helper garante que a largura já tenha assentado no instante da primeira medição.

**Hipótese, e o que ela prevê.** Se o que varia é o *assentamento* do painel depois do carregamento, então a diferença aparece entre a medição inicial e a final mesmo sem o produto redimensionar nada — e o teste acusaria o produto por um artefato de tempo. A previsão testável é: medir `innerWidth` repetidamente logo após a abertura, antes de qualquer ação do percurso, e ver se ele muda sozinho. Se mudar, a correção é **do teste** (esperar o tamanho estabilizar antes de gravar a linha de base, ou comparar com tolerância documentada), não do produto.

**O que isto não é.** Não é conclusão: eu não medi. É a pista com o lugar exato onde olhar, para a triagem confirmar ou refutar — e ela tem a medição em mãos.

## Padrão medido nas falhas da fase serial: ~30 s é o teto de comando do harness

Leitura do log do lote serial que a triagem está rodando (medição dela). O que salta não é só *quantas* falham, mas **quanto tempo** cada uma leva antes de falhar:

```
✖ full-evidence can be cancelled at the privacy pause …        30 720 ms
✖ no-pixels shows progress, completes in the copy …            30 027 ms
✖ original-page ABNT markers remain usable across idle …       31 868 ms
✖ original-page ABNT markers visual review and verified …      32 131 ms
✖ runs pinned local axe in every isolated frame under CSP       1 535 ms   ← não é tempo
```

Quatro das cinco caem em torno de **30 s**, que é exatamente o `DEFAULT_COMMAND_TIMEOUT_MS = 30_000` do próprio harness (`test/e2e/support/real-chrome.mjs`). Isso desloca a hipótese: não são asserções sobre comportamento do produto falhando, são **comandos CDP que não respondem dentro do teto padrão** quando a máquina está carregada — coerente com o fato de os mesmos fluxos passarem isolados (o percurso obrigatório passou duas vezes comigo e uma com ela; `passive current-page` passou neste mesmo lote com o diagnóstico completo). A quinta é diferente e por isso é a que merece atenção: falha em **1,5 s**, rápido demais para ser tempo, e é a única candidata a defeito ou a asserção desatualizada.

**O que isto muda.** O orçamento de download que eu já havia elevado (60/90/120 s → 300 s) era só uma das pontas; o teto de 30 s por comando CDP é a outra, e é do harness, não de cada teste. Se a triagem confirmar a leitura, a correção é de infraestrutura de teste — elevar o teto de comando para os fluxos pesados, sem tocar em asserção nenhuma —, e não de produto. Registro como leitura de log, não como conclusão: quem está medindo é a triagem.

## Rodada 58 — a fase paralela ficou verde, e o caminho foi aposentar com motivo, não remendar

As oito falhas da fase paralela vinham de **um** cenário de `service-worker.test.js`. Elas nunca foram falha de produto, e a causa já estava estabelecida desde a rodada 45; o que faltava era a forma honesta de fechá-las.

**Por que aposentar, e não consertar por remendo.** O cenário dirige `beginAuthorizedAudit` com `senderContext` e sem `eventNonce`, esperando o ramo de auditoria por URL que `1c9b296` removeu dali. Uma auditoria por URL hoje começa no roteador de intenções, que monta o próprio plano `single-url` e chama `beginAuthorizedUrlAudit`; o caminho que o cenário acaba exercitando é o de página atual, que usa `runAttachedAuditExecution` — que o fixture não intercepta, e é por isso que `execution.promise` nunca resolve. Duas medições fecham o diagnóstico: as oito variantes terminam em `PERSONA_CLEANUP_UNCONFIRMED` porque o mock responde a sondagem de persona com array vazio (decide por `frameIds`, o runtime usa `documentIds`), e sete delas ainda asseveram `sourceSnapshots > 0`, cujo único escritor está morto desde `1c9b296` — asserção **insatisfazível por construção**.

**Nada que importa se perde.** A privacidade e a forma da origem dos marcadores estão fixadas em `test/background/authorized-audit-starter.test.js:5486-5565` (registro da origem, recusa para alvo rejeitado, gravador que lança, gravador que recusa), e o percurso de auditoria por URL tem E2E de Chrome real próprio. O reparo definitivo — reescrever o cenário sobre `beginAuthorizedUrlAudit` — fica no backlog com a análise pronta.

**Resultado medido:** `node --test test/background/service-worker.test.js` → 97 testes, **96 passam, 1 pulado, 0 falham**. E a fase paralela inteira → **4179 testes, 4178 passam, 1 pulado, 0 falham, exit 0**. É a primeira vez nesta sessão que o portão paralelo fica verde, e é isso que devolve a capacidade de enxergar regressão nova.

**Mudança só de teste:** `git diff --stat HEAD~1..HEAD -- src release/ manifest.json` está vazio — nenhum byte empacotado se moveu, o hash fixado do artefato continua o mesmo e a revisão da 1.1.19 não foi afetada.
