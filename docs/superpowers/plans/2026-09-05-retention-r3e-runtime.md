# R3-E — ativação da retenção no worker

**Pausado antes da implementação em 05/09/2026, por solicitação do usuário.** A entrega solicitada é a beta 1.0.9 com o código integrado até bdf50e9. Não executar este plano até nova solicitação de retomada.

Continuação do estado `bdf50e9`, conforme Task 5 do plano de privacidade/lote/retenção. Escopo fechado: `src/background/service-worker.js`, `test/background/service-worker.test.js` e registro QA. Contratos de store, coordinator, scheduler, ownership, launch, pixels e Blob permanecem congelados.

## Composição

`createAuditDeletionCoordinatorV1` recebe os treze campos exatos, usando os objetos locais completos: store original, authority, panelCoordinator, reportPortCoordinator, highlightController, highlightBindingStore, reportLaunch, exportLaunch, rawNavigationVault, pixelState, ownedTabRegistry, blobUrlPortBridge.registry e `now:modelNow` (ISO). Não passar wrapper reduzido, persona nem relógio epoch.

O fallback unavailableLaunch deverá expor clearAudit que rejeita com erro fixo: API indisponível nunca confirma ausência.

Após recovery de pixels, highlight, personas e auditorias, registrar `registerRetentionSchedulerV1(chromeApi,{store:auditStore,deletionCoordinator,now:modelNow})`. Guardar scheduler somente no built runtime privado. Resolver readiness antes de disparar run('startup') sem await; capturar falha de cleanup sem tornar a extensão indisponível. Assim o owner Blob pode reconectar. O scheduler já possui onStartup/onAlarm; não adicionar branch ao listener central.

Executar run('panel') ao abrir o painel. Após commit terminal confirmado pelo caminho real `pixelAttemptLifecycle.commitTerminal`, chamar scheduleNext sem aguardar sob locks do starter; o helper legado `commitTerminalAudit` não é chamado pelo starter. A recuperação inicial também agenda qualquer retention criada durante recovery. Descartar apenas listeners próprios, inclusive se a construção terminar após dispose.

## REDs focados

1. Modelo vencido é removido no startup pelo store real, limpeza concluída remove tombstone; modelo futuro e estado estrangeiro permanecem.
2. Fallback sem API de launch mantém tombstone/alarme de nova tentativa, mas startup continua pronto. Modelo não reaparece.
3. Recovery rejeitado não inicia retenção; nenhuma exclusão antes de concluir os recoveries existentes.
4. onStartup, alarme correto e painel executam uma vez por evento. Alarme estrangeiro não executa. Dispose remove só os listeners próprios.
5. Scheduler presente no built é validado, privado e descartado também após construção tardia.
6. Commit terminal agenda expiração sem esperar uma leitura de scheduling deliberadamente pendente; sumário/relatório continuam disponíveis.

## Saída

RED observado, GREEN dos testes afetados e regressão do worker/coordenador/scheduler; diff-check e busca dirigida de exposição. Duas revisões independentes do recorte congelado, C=0/I=0 antes do checkpoint com staging exato. Sem suíte ampla, Chrome ou ZIP. Manual/pós-exportação e UI pendente pertencem à próxima fatia, sem antecipação.
