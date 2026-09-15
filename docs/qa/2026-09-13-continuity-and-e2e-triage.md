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

## Infraestrutura: Chrome for Testing corrompido

Todo E2E de Chrome real falhava com `CDP_CLOSED`. Causa demonstrada: o bundle registrado em `/private/tmp/audita-cft152-hqalvn` está incompleto — `Contents/Info.plist` ausente e `codesign --verify` reprovando com "code has no resources but signature indicates they must be present". Os processos Helper morriam com `EXC_BREAKPOINT`/`SIGTRAP` e o navegador abortava com `GPU process isn't usable. Goodbye.`

Reextrair o mesmo ZIP oficial `152.0.7977.64` restaurou o bundle e os E2E voltaram a executar. O binário antigo não deve ser reutilizado.

O Chrome estável instalado (`152.0.7977.84`) **não** substitui o CfT: o log do próprio navegador traz `--disable-extensions-except is not allowed in Google Chrome, ignoring.`, a extensão nunca carrega e a descoberta do service worker expira. O pin `Chrome/152.0.7977.64` do harness permanece inalterado.

Observação de ambiente: sob o sandbox de arquivos do harness, o Chrome não inicia (`sandbox initialization failed: Operation not permitted`) mesmo sem GPU desabilitada. Os E2E precisam ser executados fora desse sandbox.

## Correções de infraestrutura de teste

- **Plano da suíte.** Treze E2E de Chrome real não estavam em `REAL_CHROME_E2E`, e `createTestPlan` interrompia a suíte inteira com `TEST_PLAN_UNCLASSIFIED_E2E` antes de executar qualquer teste. Todos foram classificados para execução serial; nenhuma asserção foi enfraquecida.
- **Cleanup do perfil temporário.** `removeOwnedRunRoot` falhava com `ENOTEMPTY` quando o Chrome ainda terminava escritas no perfil após o processo principal sair, derrubando `batch-audit-mv3`. A remoção agora repete apenas as corridas transitórias (`ENOTEMPTY`, `EBUSY`, `ENOENT`) no caminho já validado por `realpath` e allowlist; qualquer outra falha continua surgindo.
- **Corrida no teste de retenção.** `R3-E terminal commit schedules retention` verificava um sinalizador que o caminho assíncrono define depois da publicação da chave de lançamento do relatório. O teste passa a aguardar a solicitação real de agendamento em vez de amostrar o sinalizador.

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
