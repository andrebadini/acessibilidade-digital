# R3-B — seleção de expiração no store

Data: 2026-09-05. Incremento posterior ao beta 1.0.8 entregue; o pacote não foi alterado.

## Contrato

- `nextExpiresAtV1()` retorna `Promise<string|null>` com o menor `expiresAt` absoluto entre metadados que ainda possuem modelo. Inclui instantes já vencidos; não consulta relógio, lease, preferência de exportação ou cursor de cleanup antigo. Não modifica dados.
- `stageExpiredAuditDeletionsV1({ now, limit })` captura um registro fechado de propriedades de dados antes de qualquer acesso ao armazenamento. `now` deve ser ISO canônico; `limit` é inteiro de 1 a 25, obrigatório. Entrada inválida rejeita com `AUDIT_DELETION_DENIED`.
- Seleciona no máximo `limit` auditorias com `expiresAt <= now`, ordenadas por `expiresAt` e depois `auditId`. O mesmo instante capturado é usado durante toda a operação, sem ampliação por atrasos.
- A seleção IndexedDB conclui sua transação readonly antes de iniciar o staging. Cada candidato reutiliza `stageAuditDeletionV1` R1 em uma transação independente: remove o grafo durável e grava seu tombstone atomicamente, antes de qualquer cleanup transitório futuro. Não chama `cleanupExpiredAudits`.
- Retorna um array congelado de tombstones congelados. Contenção utiliza o resultado idempotente de R1; eventual negativa de revalidação não inventa tombstone. Tombstones antigos não entram na seleção normal.
- Uma falha operacional não vira lista vazia: os demais candidatos selecionados ainda são processados e, ao final, a operação rejeita com `AUDIT_STORAGE_UNAVAILABLE`, sem erro nativo. Commits bem-sucedidos continuam recuperáveis por `listDeletionTombstonesV1`.
- Metadados órfãos são ignorados e preservados. Auditorias futuras e estado estrangeiro permanecem intactos. O store indisponível também expõe os dois métodos com rejeição fixa.

## TDD e evidência

Seis grupos novos cobrem: próximo prazo absoluto; lote inclusivo de 25 com desempate; grafo terminal com lease/entrega ativos; contenção, órfãos e reabertura; falha parcial com rollback e recuperação; argumentos fechados/capturados e independência do relógio. Os cenários funcionais são executados em memória e IndexedDB. A falha de escrita é injetada no IndexedDB após exclusões reais e antes de persistir o tombstone da auditoria intermediária.

RED antes de produção: `/private/tmp/audita-retention-r3b-red.log`, 14 pass / 18 fail, contando testes pais e subtestes. Os seis grupos novos falharam pela ausência dos métodos; os casos R1 selecionados passaram.

O fake IndexedDB existente contava o cursor inteiro como uma única requisição pendente. A seleção nova continua o cursor a partir do callback de leitura do modelo, expondo uma contagem incorreta no fake. O helper de teste agora contabiliza cada despacho do cursor, inclusive quando a continuação vem de uma requisição irmã. Nenhum workaround foi adicionado ao código de produção. Os testes diretos do cleanup anterior também foram executados para verificar esse ajuste de fixture.

GREEN final: `/private/tmp/audita-retention-r3b-green.log`, 38/38, zero falhas, comando:

```sh
node --test --test-name-pattern='expiration selection|deletion staging|deletion tombstone|incremental cleanup|cleanup resumes|IndexedDB retention expiration|retention expiration removes' test/storage/audit-store.test.js
```

`git diff --check` passou nos três arquivos desta fatia.

## Limites

Sem worker, scheduler, coordinator, UI, Chrome, suíte ampla, commit ou ZIP. R1 permanece semanticamente inalterado. O incremento seleciona e faz staging durável; não executa cleanup transitório nem agenda alarmes. Após GREEN, estes três arquivos ficam congelados para revisão independente.

## Revisões e checkpoint

O diff congelado foi revisado independentemente pelo agente de contratos e pelo agente principal. Ambas as revisões encerraram com **C=0/I=0**. Foram conferidos o corte inclusivo, a ordenação nativa do índice com desempate por chave primária, a conclusão da transação de seleção antes dos stagings, a ausência de prorrogação por lease e a recuperação dos commits parciais. Cada revisor repetiu somente o foco documentado: **38/38**, sem falhas. Log do principal: `/private/tmp/audita-retention-r3b-root-review.log`.

Checkpoint autorizado somente para os três arquivos desta etapa. Nenhuma integração pública ou alteração do pacote 1.0.8 está incluída nesta aprovação.
