# R3-F3 core — finalização preservada e exclusão pós-exportação recuperável

Base de integração: `aca0786` (R3-F2 aprovado). Escopo exclusivo: audit-store, audit-retention, audit-deletion-coordinator e seus testes. Inventário manual e callers permanecem congelados.

## Contrato entregue

- `finalizeExportAndMaybeDelete` nunca exclui diretamente, mesmo com opção `true`: confirma entrega, persiste modelo/revisão R+1 e libera a entrega existente.
- Quando a finalização contém `exportDeliveryIdentity` canônica, persiste o recibo por auditoria em `__audit_export_receipt__:<auditId>`, no mesmo store/transação. Não há alteração de versão do IndexedDB.
- `getExportReceipt` usa journal terminal enquanto presente, depois o companion correlacionado a R+1. A leitura legada via latest continua disponível, mas não é prova suficiente para staging pós-exportação.
- Trocar latest por outra auditoria não perde o recibo. Prefixo privado e caminhos de exclusão existentes incluem o companion.
- `validateTerminalExportReceiptV1` reutiliza a identidade de entrega existente e valida o envelope de sete campos e os formatos canônicos, sem executar getters e sem transportar dados adicionais.
- Staging `post-export` exige receipt complete de quatro formatos, identidade exata com o companion persistido, revisão atual R+1 igual à esperada, opt-in persistido e ausência de lease/journal de entrega ativo. A comparação e a exclusão+tombstone pertencem à mesma transação.
- Coordenador aceita o envelope existente com `manualAuthorization:null`; faz somente staging e retorna `pending`, sem executar cleaner algum. A integração deve chamar recuperação depois de sair da fila de exportação.
- Finalização legada sem identidade continua preservando dados e não produz recibo elegível para autoexclusão. Opt-out, recibo parcial/ausente/divergente e revisão obsoleta preservam a auditoria.

## RED / GREEN

- Boundary RED: 261/263; faltavam validador e razão post-export.
- Store RED: 0/8; finalização apagava diretamente, recibo dependia de latest e staging pós-exportação não existia.
- GREEN funcional inicial: 11/11.
- GREEN dos três arquivos focados: **507/507**, sem falhas; `git diff --check` aprovado.
- Rollback testado no IndexedDB simulado: falha ao gravar companion preserva modelo/revisão/ownership/journal anteriores; falha de tombstone restaura modelo e recibo juntos.

Log: `/private/tmp/audita-r3f3-focused.log`.

Sem Chrome, E2E, suíte ampla, pacote ou commit. Implementação de UI/preferência, protocolo, completion e scheduler pós-fila pertence ao agente principal. Este incremento aguarda revisão independente do diff congelado.
