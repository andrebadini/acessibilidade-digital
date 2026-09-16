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
