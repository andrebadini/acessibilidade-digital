# Continuidade 5.9.1/5.9.7/5.9.8 e triagem de E2E — retomada de 2026-09-13

Ponto de partida confirmado no worktree `feature/audita-mt`: HEAD `c213a27`, incremento 5.9.1 sem commit, suíte completa impossível de planejar. Este documento registra o que foi executado, o que foi corrigido e o que permanece aberto. Não é aprovação de produção.

## Entregas desta rodada

| Commit | Escopo |
|---|---|
| `e7adb4d` | 5.9.1: separa identificação visual de nome acessível; pendência agregada sem alvos por campo. |
| `5da4a6d` | 5.9.7 e 5.9.8: fecha as duas lacunas de contrato de observação; classifica todos os E2E de Chrome real no runner. |

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
