# R3-F1 — exclusão manual atômica

Recorte: audit-retention.js, audit-store.js, audit-deletion-coordinator.js e três testes correspondentes. O caller manual e pós-exportação não fazem parte deste checkpoint.

Contrato manual: motivo explícito, revisão positiva atual, receipt nulo, prova interna de escopo one/all correlacionada ao auditId. Store verifica revisão, lease e journal antes de apagar; expiração futura não bloqueia exclusão manual autorizada. Modelo, revisão, checkpoint, retenção e latest correlacionado são removidos junto com a criação do tombstone, numa transação IndexedDB. Falha de cleaner mantém tombstone recuperável. Retenção preserva seu comportamento aprovado.

RED inicial 481/490, nove falhas esperadas. GREEN final **490/490** nos três arquivos focados; log `/private/tmp/audita-r3f1-final.log`. Revalidação do principal dos casos manual/R3-F1: **13/13**, exit 0, log `/private/tmp/audita-manual-checkpoint.log`. Diff-check aprovado.

Revisões independentes retention_runtime_review_a e retention_runtime_review_b: C=0/I=0 no mesmo diff congelado. Principal conferiu implementação e teste dirigido. Cobertura inclui rollback da transação, revisão divergente, exportação ativa, auditoria estrangeira, autorização inválida e retomada de limpeza. Não houve navegador, suíte ampla nem modificação dos callers neste incremento.
