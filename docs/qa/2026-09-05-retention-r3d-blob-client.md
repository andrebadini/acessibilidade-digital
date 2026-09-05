# Retenção R3-D2 — cliente local de URLs Blob

## Contrato e recorte

Implementação do plano congelado `2026-09-05-retention-r3d-blob-channel.md`, restrita ao cliente exportador e seus testes. Não modifica protocolo, servidor, registry, produtores ou wiring. Usa TDD com os hooks `Promise<void>` existentes.

`createExportBlobUrlClientV1({runtime,urlApi,auditId,sessionCapabilityId})` retorna `{blobLifecycle:{register,release},dispose}`, ambos os objetos congelados. Conexão lazy no primeiro pedido, aprovada no preflight. HELLO usa o audit/capability já recebidos, sem novo EXPORT_CONNECT.

URLs locais são rastreadas antes de enviar REGISTER. Só ACK remoto positivo e URL ainda viva permitem resolver `register` sem valor. REVOKE é atendido fora da fila de pedidos: revogação nativa primeiro, ACK depois; não chama nem aguarda `release`. A ausência de retorno da API nativa não é ACK remoto de registro ou liberação. URLs revogadas permanecem conhecidas até RELEASE confirmado; depois um estado local mínimo `released` permite repetição idempotente sem recriar ownership. RELEASE de URL nunca rastreada é negado.

Desconexão nunca repete REGISTER automaticamente. Pedidos RELEASE podem ser repetidos idempotentemente na conexão seguinte, dentro do prazo original de 5 segundos. Enquanto houver recursos ou pedidos, tenta reconectar com backoff de 250 ms até 5 segundos. Correlação pertence somente ao Port atual; mensagens antigas/tardias não resolvem pedidos novos. Reconexão permite cleanup e não prepara capability ou autorização nova.

Dispose cancela timers, rejeita pedidos, descarta listeners/Port e tenta revogar nativamente todas as URLs conhecidas ainda vivas. Não afirma que o journal remoto foi apagado. Erros públicos: somente `BLOB_CLIENT_UNAVAILABLE`, sem cause, URL, capability ou payload recebido.

## Verificação

O relógio é controlado somente pelos mock timers de `node:test`; nenhum hook de QA é acrescentado à API de produção.

- RED inicial: `node --test test/export/blob-url-client.test.js`, **20 falhas**, factory ausente, zero cancelamentos/skips.
- Primeiro GREEN: **20/20**. A conferência da fronteira nativa acrescentou um RED focado para métodos herdados de runtime/Port/Event; o cliente passou a capturar o método e seu receiver sem exigir propriedade própria de APIs nativas. Mensagens e opções continuam com shape fechado.
- GREEN final: o mesmo comando, **21/21**, zero falhas/cancelamentos/skips.
- Provas: ACK antes da entrega; rastreamento antes do envio; REVOKE antes de READY e durante REGISTER/RELEASE; registro tardio negado após revogação; revogação idempotente e sem release recursivo; native `undefined` não resolve RELEASE; URL estrangeira/desconhecida e retorno malformado negados; timeout de 5 s e IDs não reutilizados no mesmo Port; Port antigo ignorado; RELEASE repetido em nova conexão, sem novo REGISTER; backoff 250/500/1000/2000/4000/5000 ms e cancelamento ao encerrar; dispose local sem declarar journal apagado.
- Sem alteração em protocolo, bridge, registry, produtores, wiring ou pacote. Sem Chrome, suíte ampla ou commit. Cliente congelado após GREEN, sintaxe e diff-check para revisão independente e composição seguinte.
