# R3-C — scheduler de retenção one-shot

Data: 2026-09-05. Incremento posterior ao beta 1.0.8 entregue, sem alteração do pacote.

## Contrato implementado

`registerRetentionSchedulerV1(chromeApi, { store, deletionCoordinator, now })` registra listeners locais de startup/alarme e retorna `{ run, scheduleNext, dispose }` congelado. Não inicia bootstrap automaticamente. As chamadas públicas retornam `Promise<void>` e compartilham uma fila serial por instância; uma rejeição não bloqueia a próxima chamada.

Cada operação captura uma única leitura ISO canônica de `now` ao começar sua execução. `run` chama `stageExpiredAuditDeletionsV1({ now, limit: 25 })`, depois `resumePending({ limit: 25 })` e então reagenda. Falha no stage não impede resume; falha em qualquer uma dessas fases não impede tentativa de reagendamento. O coordenador mantém seu próprio relógio para cleanup: isso não altera o instante capturado para seleção de expiração.

O reagendamento consulta separadamente `nextExpiresAtV1()` e `listDeletionTombstonesV1({ limit: 1 })`. Deadline deve ser ISO canônico ou `null`; a lista deve conter zero ou um tombstone V1 válido, sem buracos ou propriedades adicionais. Resultado malformado não significa ausência.

- Expiração conhecida: alarme no prazo absoluto, limitado inferiormente pelo instante capturado.
- Tombstone restante ou falha em stage/resume/consultas: candidato de retry em `instante capturado + 60_000`; uma expiração conhecida anterior vence esse retry.
- Ausência confirmada por ambas as consultas, sem falha anterior: limpar somente o alarme próprio.
- Qualquer falha operacional: tentar reagendamento conservador quando possível, depois rejeitar `Error('RETENTION_SCHEDULER_UNAVAILABLE')`, sem `cause` ou detalhes nativos. Pendência normal reagendada não é rejeição.

O único nome utilizado é `audita-retention-cleanup-v1`, com `{ when }`, sem `periodInMinutes`. Nenhum método altera `firstPersistedAt` ou `expiresAt`. O retry também cobre o caso de restarem mais de 25 tombstones após uma execução e não haver modelos com prazo futuro. Referência da API indicada pelo agente principal: [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms).

Startup delega `run('startup')`; alarmes com outro nome são ignorados. Rejeições originadas nesses listeners são absorvidas sem logging; chamadas públicas mantêm a rejeição observável. Relógio inválido interrompe antes de qualquer acesso ao store, coordenador ou alarme.

`dispose` é idempotente, remove somente as funções registradas por esta instância e impede novos trabalhos, trabalhos enfileirados ainda não iniciados e fases posteriores de operações suspensas em um await. Não apaga alarmes persistidos. Chamadas nativas/storage já iniciadas não são canceláveis; um commit já realizado permanece recuperável. Uma resposta tardia de consulta não inicia criação de alarme após dispose.

## TDD

Cinco grupos: prazo absoluto/ausência confirmada; liveness com store e coordenador reais; falhas parciais e respostas malformadas; serialização/captura do relógio; lifecycle e entradas inválidas. Os doubles de Chrome registram os argumentos efetivamente emitidos; os casos de liveness usam tombstones persistidos pelo store e cleanup executado pelo coordenador existentes.

- RED: `/private/tmp/audita-retention-r3c-red.log`, 0 pass / 47 fail, incluindo pais e subtestes. Factory ausente, antes de criar o arquivo de produção.
- GREEN: `/private/tmp/audita-retention-r3c-green.log`, 47/47, zero falhas.

```sh
node --test test/background/retention-scheduler.test.js
```

Verificação de whitespace/diff feita também com `git diff --no-index --check /dev/null <arquivo>` para os três arquivos novos, pois ainda não estão no índice.

## Limites e entrega

Sem wiring de worker, painel, criação de auditoria ou bootstrap; sem alteração de store/coordenador. Sem Chrome, suíte ampla, commit ou ZIP. A fila pertence à instância, prevista para um registro por lifecycle do worker. Indisponibilidade da própria API de alarmes rejeita sem loop de retries e exige um próximo startup/trigger externo; o código não garante execução pontual contra suspensão ou atraso do navegador.

Após GREEN e diffcheck, os três arquivos ficam congelados para revisão independente.

Fechamento: duas leituras independentes confirmaram **C=0/I=0**, com 47/47 repetidos pelo principal e pelo revisor. O teste de composição com o coordenador atualizado para purga final também permanece verde. Log da reexecução principal: `/private/tmp/audita-retention-r3c-root-review.log`. Checkpoint restrito aos três arquivos; wiring e entrega pública continuam fora deste incremento.
