# R3-D3 — composição Blob no documento exportador

Data: 2026-09-05. Contratos de cliente/protocolo/bridge congelados em `75cc81b`.

## Escopo

Somente `src/export/index.js`, `test/export/export-page.test.js` e este registro. O
worker é integrado em recorte paralelo. Cliente, bridge, protocolo, produtores,
store, scheduler, exclusão manual/pós-exportação e beta pública não foram alterados.

O entrypoint cria `createExportBlobUrlClientV1` somente depois da validação de
`EXPORT_CONNECT` e da derivação do proprietário da lease. A factory recebe o
runtime nativo, a API URL do documento e audit/capability da conexão autorizada.
Somente `blobLifecycle` é adicionado às dependências existentes de
`runReportExport`; a conexão do cliente continua lazy.

O documento exportador registra um listener `pagehide` de execução única para
descartar seu cliente. Não há descarte em `finally`, no retorno do produtor, no
fechamento da aba de impressão ou antes da recuperação pendente. `closeOwnTab`
permanece inalterado: uma tentativa de fechamento que falha não descarta o cliente
da aba ainda viva. O descarte local não declara removido o journal remoto nem apaga
downloads concluídos.

## RED observado

Comando, antes de alterar produção:

```sh
node --test --test-name-pattern='Blob wiring' test/export/export-page.test.js
```

Resultado: **0 PASS / 2 FAIL**, saída 1. Falhas por comportamento ausente:

- Após autorização válida, nenhuma factory de cliente era chamada: `0 !== 1`.
- O documento não registrava listener `pagehide` para descarte: `0 !== 1`.

O harness executa o entrypoint real em `node:vm`, substituindo apenas a resolução
dos imports por fronteiras controladas; não reescreve funções nem o disparo de
`start()`. O cliente Blob é real, com Port e revogação nativa controlados. Não foi
criada seam pública ou dependência de teste em produção.

## GREEN e regressão direta

O mesmo comando passou **2/2**, saída 0. O primeiro caso prova bloqueio antes da
resposta, negação por audit divergente, argumentos exatos da factory, injeção dos
hooks e conexão lazy. O segundo prova revogação/desconexão em `pagehide` e
preservação do cliente durante cleanup pendente, confirmação terminal pendente e
falha do fechamento nativo; a entrega repetida do evento é idempotente.

```sh
node --test test/export/export-page.test.js test/export/export-page-failure-policy.test.js test/export/blob-lifecycle.test.js test/export/report-export.test.js
node --check src/export/index.js
git diff --check -- src/export/index.js test/export/export-page.test.js docs/qa/2026-09-05-retention-r3d-export-wiring.md
```

Regressão direta: **58/58 PASS**, saída 0. Syntax-check e diff-check: saída 0.
Os testes dos produtores preservam registro antes da entrega, as cinco URLs do
documento proprietário e recuperação sem apagar downloads concluídos.

Sem Chrome, suíte ampla ou alteração de ZIP. O principal e um revisor independente
concluíram C=0/I=0 sobre o source congelado
`6dc26582b19a2a003bcc224035a938d6435e258faa7bd935b15a9136223ef920`, sem correção adicional.
O foco composto com o worker passou **202/202** em
`/private/tmp/audita-retention-r3d-wiring-frozen-focused.log`; o worker tem seu próprio registro
de duas revisões. Chrome real permanece reservado ao candidato de entrega.
