# QA — R3-E: retenção no runtime do worker

Data: 05/09/2026. Base: `5ab0678`, worktree `audita-mt`.

A retomada autorizada pelo usuário revogou o cabeçalho de pausa do plano `docs/superpowers/plans/2026-09-05-retention-r3e-runtime.md`. Implementação limitada ao worker, seu teste e este registro. TDD aplicado conforme `test-driven-development/SKILL.md` e `writing-good-tests.md`.

## Recorte implementado

- O coordinator recebe exatamente os treze campos congelados: store original, authority, panelCoordinator, reportPortCoordinator, highlightController original, highlightBindingStore, reportLaunch, exportLaunch, rawNavigationVault, pixelState, ownedTabRegistry, blobUrlPortBridge.registry e `now: modelNow` em ISO. Nenhuma persona ou wrapper reduzido de store/registry foi introduzido nessa composição.
- O fallback de launch tem `clearAudit` que rejeita com `AUDIT_DELETION_UNAVAILABLE`; nunca confirma ausência quando falta a API.
- O scheduler é registrado somente depois dos recoveries de pixels, highlight, personas e auditorias. É validado no built privado e não aparece no runtime público.
- `startupReady` é resolvida antes de disparar `run('startup')` sem await. Cleanup pendente ou rejeitado não retém a readiness; o owner Blob pode conectar enquanto a limpeza aguarda.
- Eventos de startup e alarme continuam sob os listeners próprios do scheduler. Toolbar e menu de contexto disparam `run('panel')` após a admissão do lançamento. Não há branch de retenção no listener central de alarmes.
- O caminho utilizado pelo starter envolve `pixelAttemptLifecycle.commitTerminal`, mantém seu recibo confirmado e dispara `scheduleNext` sem await. O helper legado `commitTerminalAudit` não foi usado para essa integração. Retenção criada durante recovery é alcançada pelo run inicial.
- Dispose remove os listeners próprios; scheduler e bridge construídos após dispose também são descartados.

## RED / GREEN

Comando dos seis grupos solicitados:

```sh
node --test --test-name-pattern='R3-E' test/background/service-worker.test.js
```

RED observado antes de alterar produção: **14 casos contados pelo Node, 5 pass / 9 fail / 0 cancel / 0 skip**, com falha nos seis grupos principais. Subtestes de rejeição que já eram negados pela implementação anterior passaram. Falhas esperadas: modelo expirado continuava disponível; execução startup ausente; modelo continuava após recovery bem-sucedido; built válido com scheduler era recusado; commit real não requisitava scheduling.

Antes desse RED válido, a preparação dos fixtures corrigiu o uso de `getReportRevision` em modelos de retenção sem checkpoint/integridade terminal: essas verificações usam `getAuditSnapshot`. O teste terminal mantém a revisão real e o relatório consolidado com integridade. A sentinela estrangeira de storage é colocada depois da construção do store, isolando a seleção de retenção da migração legada.

GREEN dos mesmos grupos: **14 pass / 0 fail / 0 cancel / 0 skip**. Cobertura:

1. Startup remove modelo vencido e tombstone concluído; preserva modelo futuro e sentinelas estrangeiras de storage/session.
2. Sem API launch, modelo fica indisponível, tombstone registra uma tentativa e alarme aponta para retry de 60 segundos; readiness permanece pronta e os erros são fixos.
3. Durante recovery pendente não há listener de retenção nem exclusão; rejection de pixels e recovery de auditoria bloqueado não iniciam retenção.
4. Startup, alarme de retenção, toolbar e contexto causam uma passagem por evento. Alarme estrangeiro não causa passagem; dispose mantém listeners estrangeiros.
5. Built privado aceita scheduler completo e rejeita ausência de cada método; readiness é observada antes do cleanup; Blob reconecta durante cleanup pendente; construção tardia é descartada sem execução.
6. Batch real chega a revisão 1, sumário do painel e abertura/conexão de relatório enquanto `nextExpiresAtV1` está deliberadamente pendente; ao liberar a leitura, alarme recebe a expiração absoluta de 30 dias.

Regressão permitida e concluída:

```sh
node --test test/background/service-worker.test.js test/background/audit-deletion-coordinator.test.js test/background/retention-scheduler.test.js
```

Resultado final: **366 pass / 0 fail / 0 cancel / 0 skip**, exit 0. A primeira execução da regressão teve 365 pass / 1 fail: a expectativa legada de chamadas Chrome ainda não incluía o novo clear do alarme vazio de retenção; a expectativa foi atualizada preservando a aridade Promise exata.

## Verificações e limites

`git diff --check` no recorte passou. Busca dirigida em `retentionScheduler`, `deletionCoordinator`, `clearAudit`, `console`, `logger.error`, `error.message`, `error.stack`, `postMessage` e `sendResponse`: nenhum novo envio de modelo, detalhe nativo, stack ou capacidade para UI/logs. Falhas de scheduling são capturadas; o fallback usa mensagem fixa. Métodos de retenção permanecem fora do runtime público.

Contratos de store/coordinator/scheduler/ownership/launch/pixels/Blob não foram editados. Exclusão manual e pós-exportação não foram ampliadas. Arquivos de painel, relatório e correção de integridade da base foram preservados por este recorte.

Sem suíte ampla, Chrome, ZIP, staging ou commit. Validação usa os componentes reais do repositório com o store em memória e fronteiras Chrome controladas; não constitui validação em navegador.

Ausência da API launch mantém limpeza pendente com retry por desenho. Duas revisões independentes, `retention_runtime_review_a` e `retention_runtime_review_b`, aprovaram o mesmo recorte congelado: C=0/I=0, sem correção solicitada. O agente principal conferiu o diff e reexecutou os 14 casos R3-E (14/14, exit 0) antes do checkpoint. Esta aprovação não substitui o E2E do candidato nem abrange exclusão manual/pós-exportação.
