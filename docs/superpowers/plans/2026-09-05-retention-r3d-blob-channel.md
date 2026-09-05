# Canal local de arquivos temporários — R3-D Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans e TDD nos recortes abaixo; os contratos ficam congelados antes da edição paralela.

**Goal:** Registrar URLs Blob antes de oferecer seus bytes e revogá-las no documento proprietário, inclusive após reinício do worker.

**Architecture:** Um protocolo pequeno compartilhado conecta o documento de exportação ao worker por runtime.Port. A bridge cria o registry existente com callbacks nativos; o cliente fornece os hooks `register/release` já aceitos pelos produtores. Não há novo journal, backend, permissão ou token de autorização.

**Tech Stack:** JavaScript ES modules, Chrome MV3 (mínimo existente 116), node:test.

**Spec:** Task 5 de `2026-08-29-marco-3-privacidade-lote-retencao.md`, contratos R2-F/R2-G e preflight independente de 05/09/2026. APIs oficiais verificadas: [runtime](https://developer.chrome.com/docs/extensions/reference/api/runtime), [messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging).

## Restrições

- A beta pública 1.0.8 permanece intacta. Somente testes focados e diff-check durante o incremento.
- URLs Blob e vínculos ficam no canal privado/storage.session existente; nunca em UI, modelo, logs, erros ou relatório.
- Não chamar `URL.revokeObjectURL` no worker. A aba de impressão não é proprietária: o documento de exportação criou seu Blob.
- Não alterar registry, produtores, store, export-launch, regras normativas ou consentimento de pixels.
- ACKs de revogação precisam ser processados fora da fila que aguarda registry.release/clearAudit, evitando deadlock.
- Somente ausência nativa comprovada encerra ownership sem ACK. API indisponível não significa documento ausente.

## Contrato compartilhado congelado

`src/export/blob-url-protocol.js` exporta `BLOB_URL_PORT_NAME = 'audita-export-blobs-v1'`, `parseBlobPortMessageV1(value, source)` e `isExportBlobUrlV1(value, extensionId)`.

`source` é `client` ou `worker`. O parser retorna cópia rasa congelada de objeto fechado ou `null`. Sem accessors, símbolos, campos extras ou coerções. Identificadores de pedido são inteiros seguros positivos. Audit é o domínio de URL de exportação existente `[A-Za-z0-9_-]{1,160}`; capability tem 22 caracteres base64url. Blob tem exatamente o formato de URL aceito pelo registry; verificação de origem exige o extensionId local.

| Origem | Shape exato |
| --- | --- |
| cliente | `{type:'hello',auditId,sessionCapabilityId}` |
| cliente | `{type:'register'|'release',requestId,blobUrl}` |
| cliente | `{type:'revoked',requestId,ok:boolean}` |
| worker | `{type:'ready'}` |
| worker | `{type:'result',requestId,ok:boolean}` |
| worker | `{type:'revoke',requestId,blobUrl}` |

O nome versionado do Port define a versão. Não duplicar envelope protocol/version em cada mensagem. Números de correlação pertencem somente ao Port atual e nunca são reaproveitados dentro dele.

## R3-D1 — protocolo e bridge do worker

**Files:** `src/export/blob-url-protocol.js`, `test/export/blob-url-protocol.test.js`; `src/background/blob-url-port.js`, `test/background/blob-url-port.test.js`.

**Produces:**

```js
createBlobUrlPortBridgeV1({ chromeApi, sessionArea, exportLaunch, auditStore, now })
// frozen { registry, attachPort, dispose }
// now -> epoch milliseconds; attachPort(port) -> boolean; dispose() -> void
```

Bridge instancia `createBlobUrlRegistryV1` com seus callbacks `revokeInOwner/isOwnerAlive`. `attachPort` registra somente o nome próprio e valida HELLO uma vez. Usa `deriveTrustedExtensionContext` com `EXPORT_SURFACE`; exige frame 0 e igualdade de document/tab/window nativos. A URL deve ser a export canônica do audit. Cleanup-only pode conectar mesmo se a sessão expirou ou já não existe.

REGISTER lê `exportLaunch.getLaunch(auditId)` e `getSession(sessionCapabilityId)`: connected/active, documento/tab/window, audit, revisão, tentativa e expiração correspondentes. `auditStore.getExportLeaseState(auditId,{now:ISO})` precisa estar ativo, em delivering, com mesma revisão/tentativa e `ownerId === deriveExportLeaseOwner(auditId,attemptId)`. Verificar expirações com o relógio após as leituras. Somente então registry.register recebe `{auditId,blobUrl,ownerDocumentId}` derivados. RELEASE não precisa de autorização ativa: a tupla derivada e o registry limitam o efeito.

`isOwnerAlive` consulta `runtime.getContexts({documentIds:[ownerDocumentId]})`: array vazio confirmado retorna false; um único contexto correspondente de exportação retorna true; erro/ambiguidade rejeitam. REVOKE vai exclusivamente ao Port daquele documento/audit. Precisa de ACK true na mesma conexão. Timeout 5 s ou disconnect rejeita com erro fixo. Não esperar registry.release no handler do ACK. Operações register/release são serializadas por Port; o registry mantém sua própria fila existente. No máximo 32 operações pendentes por Port; excesso desconecta e não cria novo recurso.

- [ ] Escrever REDs de protocolo fechado/direção/origem e observar a ausência das exports.
- [ ] Implementar parser mínimo; executar `node --test test/export/blob-url-protocol.test.js`.
- [ ] Escrever REDs da bridge: autorização nativa, lease, revogação durante registro, ACK correto/negado/perdido, restart e isolamento de owner.
- [ ] Implementar bridge mínima sem wiring. Exemplo de prova obrigatória:

```js
await owner.register(blobUrl);
await bridge.registry.clearAudit(auditId);
assert.deepEqual(nativeRevocations, [blobUrl]);
assert.equal(foreignRevocations.length, 0);
assert.equal(liveRegistryRows().length, 0);
```

- [ ] Executar `node --test test/export/blob-url-protocol.test.js test/background/blob-url-port.test.js`; congelar após GREEN/diff-check para revisão.

## R3-D2 — cliente do documento exportador

**Files:** `src/export/blob-url-client.js`, `test/export/blob-url-client.test.js`.

**Consumes:** Protocolo acima, `runtime.connect`, `urlApi.revokeObjectURL` e capability de EXPORT_CONNECT já existente.

**Produces:**

```js
createExportBlobUrlClientV1({ runtime, urlApi, auditId, sessionCapabilityId })
// frozen { blobLifecycle: frozen { register(blobUrl), release(blobUrl) }, dispose() }
// register/release -> Promise<void>; dispose -> void
```

Rastrear URL antes de REGISTER. Atender REVOKE inclusive durante o await de registro; confirmar somente depois da revogação nativa. Nunca chamar release nesse handler. Manter estado privado revoked para repetição idempotente; após RELEASE confirmado, conservar somente o estado efêmero released até o documento encerrar, para negar novo registro da mesma URL e permitir release repetido. REGISTER confirmado ainda precisa encontrar a URL viva antes de permitir sua entrega.

Reconexão usa o mesmo documento e HELLO, sem novo EXPORT_CONNECT e sem replay automático de REGISTER. Releases podem repetir de forma idempotente. Backoff começa em 250 ms e limita a 5 s enquanto existirem recursos/pedidos; timeout de operação 5 s. Resposta tardia não resolve pedido novo nem reaproveita número no mesmo Port. Erros usam apenas `BLOB_CLIENT_UNAVAILABLE` sem cause. Dispose interrompe timers/pedidos/Port e revoga localmente URLs conhecidas, sem declarar removido o journal; a confirmação remota ou ausência nativa continua necessária.

- [ ] RED de register aguardando ACK, revogação antes do ACK, release sem autorização ativa, resposta tardia/Port antigo e reconexão.
- [ ] Implementar cliente mínimo usando o protocolo congelado. Prova obrigatória:

```js
const registering = client.blobLifecycle.register(blobUrl);
worker.send({ type: 'revoke', requestId: 1, blobUrl });
assert.deepEqual(nativeRevocations, [blobUrl]);
worker.send({ type: 'result', requestId: registerRequestId, ok: true });
await assert.rejects(registering, /BLOB_CLIENT_UNAVAILABLE/);
```

- [ ] Executar `node --test test/export/blob-url-client.test.js`; congelar para revisão.

## R3-D3 — composição dos módulos congelados

**Files:** teste de integração `test/background/blob-url-port-integration.test.js`, `src/export/index.js`, `src/background/service-worker.js` e testes diretamente relacionados.

- [ ] Testar client + bridge + registry reais com Ports pareados: cinco URLs normais (print + quatro formatos), cleanup enquanto o owner está vivo, reinício, owner encerrado e ausência de transmissão para foreign.
- [ ] Criar cliente depois do EXPORT_CONNECT já autorizado; injetar somente `blobLifecycle` em runReportExport. Encerrar cliente no fechamento do próprio documento, sem tocar em downloads já concluídos.
- [ ] Criar bridge no buildDefaultRuntime após exportLaunch; direcionar seu nome no connectListener e descartar somente seus listeners no dispose. Não duplicar handler de Port.
- [ ] Compor coordinator/scheduler em fatia de wiring seguinte: retention depois do recovery existente; alarme próprio sem branch duplicado; fire-and-forget após commit terminal para não criar ciclo de locks. Exclusão manual/pós-exportação ficam para seu contrato autorizado específico, sem falso sucesso.
- [ ] Testes focados + busca dirigida de vazamento + diff-check. Duas revisões independentes antes do checkpoint de fronteira crítica. Chrome/ZIP somente no candidato integrado de entrega.

## Backlog explícito, não bloqueante deste canal

Status de 05/09: protocolo, bridge, cliente e wiring no worker/exportador concluídos; composição local com store/launch reais verde. Revisões e evidências em `docs/qa/2026-09-05-retention-r3d-blob-composition.md`, `2026-09-05-retention-r3d-worker-wiring.md` e `2026-09-05-retention-r3d-export-wiring.md`. Agendamento da retenção, manual/pós-exportação e Chrome do candidato continuam separados.

O conjunto de requestIds usados na bridge e os estados released do cliente permanecem em memória até o Port/documento encerrar. São limitados pelo uso normal (cinco URLs), não são expostos e não bloqueiam a entrega. Um limite explícito para sessões excepcionalmente longas é melhoria incremental.

O marker `audita:retention-preference:v1:*` ainda pode sobreviver ao sucesso do starter. Contém apenas audit, preferência false e instantes, sem URL/evidência/documento/capability. Sua remoção será integrada ao fechamento de preferências manual/pós-exportação; não se afirma ausência de todos os markers. O marker mínimo fechado de Blob continua necessário contra produtor tardio.
