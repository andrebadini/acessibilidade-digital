# R3-D1 — bridge privada de Blob URLs no worker

Data: 2026-09-05. Implementação limitada ao server Port e seus testes, conforme `docs/superpowers/plans/2026-09-05-retention-r3d-blob-channel.md`. Beta 1.0.8 intacta.

## Contrato

`createBlobUrlPortBridgeV1({ chromeApi, sessionArea, exportLaunch, auditStore, now })` retorna `{ registry, attachPort, dispose }` congelado. Cria o registry aprovado com callbacks nativos; não cria outro journal. Consome o protocolo compartilhado `audita-export-blobs-v1`, implementado separadamente pelo agente principal.

HELLO único usa `deriveTrustedExtensionContext`/`EXPORT_SURFACE`, sender capturado com extensionId/documentId/frame 0 e tab/window nativos correlacionados. A URL deve corresponder exatamente ao audit da página export. O canal pode conectar para cleanup mesmo com launch/session já ausentes ou revogados. Nenhum dado de owner/tab/window é aceito de mensagens de operação.

REGISTER revalida launch connected, session active, audit/capability/documento/tab/window, revisão, tentativa e expiração correlacionados. A lease precisa estar ativa em delivering, com revisão/tentativa correspondentes e owner derivado por `deriveExportLeaseOwner`. O relógio epoch é validado antes e depois da leitura da lease; expiração atingida durante o await impede persistência. Blob de outra extensão não é aceito.

RELEASE deriva `{ auditId, blobUrl, ownerDocumentId }` do bind e usa a confirmação do registry, sem exigir autoridade ativa. O registry impede liberar recurso do mesmo audit pertencente a outro documento.

`isOwnerAlive` consulta somente `getContexts({ documentIds: [ownerDocumentId] })`. Ausência exige array vazio estruturalmente válido. Um contexto único só confirma presença quando pertence à superfície export local, frame 0 e documento solicitado. Erro, resposta malformada, ambiguidade ou documento divergente mantêm cleanup pendente.

REVOKE é enviado apenas ao Port atual do documento/audit exato. O worker nunca chama `URL.revokeObjectURL`. A confirmação `revoked` precisa ter correlação pendente na mesma conexão e `ok === true`. Timeout de 5 segundos ou disconnect rejeita; o registry preserva o registro para recuperação. ACK é processado imediatamente, fora da fila register/release que aguarda o registry, evitando recursão/deadlock.

Operações são serializadas por Port, com no máximo 32 pendentes. Excesso, replay de requestId, segundo HELLO ou ACK sem correlação desconectam somente aquele Port. Operações ainda não iniciadas não persistem depois do disconnect/dispose. Uma operação de storage já iniciada não é desfeita: eventual registro permanece recuperável. Reconnect substitui somente o Port anterior do mesmo documento, sem ampliar autorização.

Erros de operação enviados ao documento são apenas `{ type: 'result', requestId, ok: false }`; falhas internas usam `BLOB_PORT_UNAVAILABLE` e o registry conserva seu erro fixo `BLOB_REGISTRY_UNAVAILABLE`. Sem URL/cause/log em erros. Dispose remove listeners e timers próprios sem apagar registros persistidos.

## TDD e provas

- RED inicial: `/private/tmp/audita-retention-r3d-server-red.log`, 0 pass / 52 fail, contando pais e subtestes. Factory da bridge ausente antes da produção.
- RED adicional: `/private/tmp/audita-retention-r3d-server-malformed-red.log`, 6 pass / 2 fail. Uma resposta `getContexts` vazia com propriedade extra era aceita como ausência; a validação foi corrigida antes do congelamento.
- GREEN final: `/private/tmp/audita-retention-r3d-server-green.log`, **56/56** combinando 53 casos da bridge e 3 do protocolo.

```sh
node --test test/export/blob-url-protocol.test.js test/background/blob-url-port.test.js
```

Cobertura: sender nativo adversarial; lease/session/revisão/tentativa; relógio cruzando expiry durante await; release após revogação; isolamento entre owners do mesmo audit; confirmação fora da fila; restart com records persistidos e autoridade ausente; ausência nativa versus erro; ACK falso/desconectado/incorretamente correlacionado/timeout real de 5 segundos; limite de 32 operações; produtor tardio negado pelo marker fechado existente.

Whitespace verificado com `git diff --no-index --check /dev/null <arquivo>` nos três arquivos novos: sem diagnósticos. O exit status 1 dessas comparações representa arquivos adicionados em relação a `/dev/null`, não falha de whitespace.

## Limites

Protocolo, cliente, registry, produtores, store, export-launch e wiring não foram editados. Os tests de Port substituem apenas o transporte Chrome; o registry é real. Confirmação da chamada nativa no documento e composição client/server pertencem às fatias R3-D2/D3. Sem Chrome, suíte ampla, ZIP, commit ou mudanças na versão pública. Após GREEN, estes três arquivos ficam congelados para revisão independente.

## Rodada única após revisão — deadline ISO da lease

As duas revisões encontraram o mesmo Important: `getExportLeaseState` retorna `retryAt` como ISO canônico, mas a bridge e sua fixture inicial o tratavam como epoch. Isso negava todo REGISTER com a lease real; a composição independente do principal também reproduziu o bloqueio em `/private/tmp/audita-retention-r3d-integration-contract-red.log`.

A correção é limitada a importar `canonicalRetentionInstant` e comparar `canonicalRetentionInstant(lease.retryAt).milliseconds` com o relógio epoch já capturado após o await. As fixtures agora reproduzem o ISO do store. Número epoch fictício e ISO não canônico são negados, sem ampliar o contrato. Os testes preservam tanto a expiração de launch/session durante a leitura quanto o caso de somente a lease expirar durante o await, com launch/session ainda ativos.

- RED: `/private/tmp/audita-retention-r3d-server-lease-iso-red.log`, 23 pass / 4 fail (três casos e parent): ISO válido negado e número fictício aceito antes da correção.
- GREEN atualizado: `/private/tmp/audita-retention-r3d-server-lease-iso-green.log`, **59/59**, com o mesmo comando focado protocolo + bridge.
- Diffchecks dos três arquivos sem diagnósticos. Cliente, teste de integração, protocolo e módulos aprovados não foram editados nesta rodada. Arquivos novamente congelados para validação final.
