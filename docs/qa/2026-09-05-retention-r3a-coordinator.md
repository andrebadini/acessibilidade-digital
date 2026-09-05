# Retenção R3-A — coordenador sequencial de exclusão

## Escopo e contrato congelado antes de RED

Esta fatia cria o coordenador e seus testes focados. Não integra worker, protocolo, UI, bridge nativa ou release. A revisão encontrou dois REDs de composição que exigiram ajustes delimitados nas dependências: domínio dos identificadores de cleanup e purga final dos journals. O store R1 permanece inalterado. A sequência abaixo substitui as assinaturas ilustrativas da Task 5 do plano de retenção.

`createAuditDeletionCoordinatorV1` recebe exatamente `{store,authority,panelPortRegistry,reportPortRegistry,highlightController,highlightBindingStore,reportLaunch,exportLaunch,rawNavigationVault,pixelCaptureState,ownedDisposableTabStore,blobRegistry,now}`. Captura os métodos utilizados antes de qualquer `await`. Não aceita dependência de persona. Retorna objeto congelado com somente `request` e `resumePending`.

- `request({auditId,reason,expectedRevision,terminalReceipt,manualAuthorization})`: somente `retention-expired` e os três últimos campos `null`. Shape inválido, ID não canônico, manual e pós-exportação retornam `{status:'denied',code:'AUDIT_DELETION_DENIED'}` congelado antes de chamar relógio, store ou cleaners. Objetos declarando autorização não concedem autoridade.
- Para pedido válido, captura `now()` uma vez e exige string ISO canônica. Chama `store.stageAuditDeletionV1({auditId,reason,now,expectedRevision:null,terminalReceipt:null})`. Somente envelope exato `staged` com tombstone validado por `validateDeletionTombstoneV1`, correspondente ao audit, permite cleanup. Envelope exato `denied` retorna a negativa fixa. Falha/retorno malformado do relógio ou stage rejeita com erro fixo, sem cleaners nem pendência inventada.
- Sucesso: `{status:'complete',auditId}` congelado. Cleanup não confirmado: tentar exatamente uma vez `recordDeletionCleanupFailureV1({auditId,at})`, reutilizando o instante capturado; somente `true` autoriza `{status:'pending',auditId}` congelado. `false`, retorno malformado ou exceção ao registrar falha rejeitam. O coordenador nunca restaura o modelo nem remove o tombstone antes de confirmar os cleaners.
- `resumePending({limit}) -> Promise<void>`, com shape exato e inteiro de 1 a 25. Valida toda a lista de tombstones antes de processar, sem restage. Cada tentativa efetiva captura um único instante canônico e usa o mesmo caminho de cleanup/registro. Um audit falhando não impede o processamento dos seguintes; indisponibilidade não confirmada é reportada como erro fixo após os demais candidatos.
- Todos os erros operacionais/constructor usam somente `Error('AUDIT_DELETION_UNAVAILABLE')`, sem `cause`, payload ou erro recebido. A exclusão manual/pós-exportação continua fechada nesta etapa.

## Ordem serial e confirmações

1. `authority.clearAudit(auditId)`: somente `{ok:true,invalidated:inteiro>=0}` exato.
2. `panelPortRegistry.clearAudit(auditId)`: somente `true`.
3. `reportPortRegistry.clearAudit(auditId)`: inteiro seguro não negativo.
4. `highlightController.clearAudit(auditId,'audit-deleted')`: somente `{ok:true,state:'clear'}` exato. Sem essa confirmação, não apagar binding.
5. `highlightBindingStore.deleteAudit(auditId)`: `true` ou `false`, ambos confirmam ausência idempotente.
6. `rawNavigationVault.clearAudit(auditId)`: inteiro seguro não negativo.
7. `pixelCaptureState.readSuspension(auditId)`: `null` confirma ausência. Caso contrário, exige suspensão real válida e do mesmo audit, e chama `revokeAudit({auditId,consentId,reason:'AUDIT_DELETED'})`. Exige envelope exato `{version:'PixelRevokeResultV1',status,suspension}`; `missing` com `null`, `revoked`, `already-revoked` ou `finished` com suspensão válida/correlata confirmam revogação. `mismatch` ou retorno malformado não confirmam. Não usa a assinatura antiga de dois argumentos.
8. `blobRegistry.clearAudit(auditId)`: inteiro seguro não negativo; ocorre antes de fechar documentos proprietários.
9. `exportLaunch.clearAudit(auditId)`: somente `true`.
10. `reportLaunch.clearAudit(auditId)`: somente `true`.
11. `ownedDisposableTabStore.clearAudit(auditId)`: inteiro seguro não negativo.

A primeira falha interrompe a sequência. Após as onze confirmações, a barreira final remove os journals que conservaram a identidade necessária ao cleanup:

1. Reler a suspensão de pixels. Ausência é idempotente; uma suspensão restante precisa conservar a identidade inicial, estar `revoked|finished` e ter `finish({auditId,consentId}) === true`.
2. `ownedDisposableTabStore.purgeRemovedAudit(auditId)` confirma, por número não negativo, a remoção dos journals V2 próprios já `removed`. Não remove abas novamente; estado próprio ativo, legado ou malformado impede a purga. A API singular `removeOwned` permanece inalterada.
3. `authority.finalizeAudit(auditId)` confirma exatamente `{ok:true,purged:inteiro>=0}`. Remove children invalidados antes de suas sessões revogadas, com readback, preservando a correlação caso ocorra falha parcial. [Contrato e testes](2026-09-05-retention-r3a-final-authority.md).

Somente então `store.completeAuditDeletionV1({auditId})` aceita `true` (removeu tombstone) ou `false` (tombstone já ausente). Qualquer outro retorno/exceção segue o caminho de registro de falha. Ausência confirmada não vira falsa pendência. O marker mínimo fechado de Blob (`version/auditId`, sem URL, documento ou conteúdo) permanece para impedir registro tardio.

Chamadas para o mesmo audit são serializadas entre factories que compartilham o mesmo objeto store, sem bloquear outros audits. Snapshots de listagem anteriores à conclusão não podem executar nova conclusão. Reinício sem memória transitória retoma a partir dos tombstones e repete o cleanup idempotente desde a primeira etapa.

A suspensão é validada integralmente pelo serviço interno de pixels. Não existe validator público de `AuditSuspensionV1` nesta base; o coordenador verifica o shape fechado, projeta somente audit/consent/tab/window/document/digest e estado/revisão do ACK. Não duplica a desserialização de policy, URL ou conteúdo. Essa composição reduz a fronteira ao necessário para confirmar o cleanup.

## Verificação planejada

Sete matrizes focadas: constructor/API; gate sem efeitos; ordem/argumentos/zeros/ausência idempotente; stage negado/malformado/exceção; falha em cada cleaner e confirmação de pendência; pixel real e overlay não confirmado; retomada, reinício e concorrência. Testes sem Chrome, sem suíte ampla e sem alterações nos componentes dependentes.

## Evidência local e congelamento

- RED: `node --test test/background/audit-deletion-coordinator.test.js`, **214 falhas**, factory ausente, zero cancelamentos/skips. Antes de aceitar o RED, as fixtures reais foram ajustadas ao hash sem prefixo do binding e à leitura de chave ausente como `{}`.
- Primeira implementação: **212/214**; a fixture terminal de pixels ainda estava pausada, pois `finish` não termina uma pausa diretamente. A fixture passou a reproduzir uma falha real de remoção após revogação e escrita do estado `finished`; não houve alteração no componente de pixels nem no critério do teste.
- GREEN: o mesmo comando, **214/214**, zero falhas/cancelamentos/skips. Inclui store R1 real em memória, reinício com tombstone, quatro estados reais de pixels, overlay real sem ACK nativo e retry confirmado.
- Métodos de dependências são capturados no constructor; mutação durante o `await` de staging não redireciona cleaners. Locks por audit são compartilhados pelo objeto store; somente scans em andamento guardam conclusões, sem cache permanente de IDs concluídos.
- Diff restrito aos três arquivos desta fatia; sem integração, Chrome, suíte ampla, commit ou ZIP. Congelado após GREEN para duas revisões independentes.

## Correção agrupada de composição

- Domínio: store e Blob aceitam IDs canônicos até 200; cinco cleaners limitavam a entrada a 160. O RED com serviços reais reproduziu 12 falhas para 161/200. Apenas as entradas de cleanup/leitura de raw, pixel, owned, report launch e export launch passaram a validar `canonicalAuditId`. Criação, autorização e parsers continuam em 160. As leituras reais não são puladas, e indisponibilidade não vira ausência. GREEN de domínio: 233/233 no coordenador então vigente e 94/94 regressões diretamente relacionadas.
- Purga: a revisão confirmou que revogar authority/pixel e remover abas ainda deixava journals pessoais no storage. RED de composição: 61 pass / 22 fail, incluindo pais; as quatro suspensões reais permaneciam após `complete`, e os finalizadores não eram chamados. A barreira final acima corrige o caso sem reescrever os onze cleaners.
- `purgeRemovedAudit`: RED 12/12 por ausência; GREEN 12/12 novos e 32/32 no arquivo owned-tabs. Inclui preflight dos próprios, foreign preservado, retry, commit-then-throw e espera de registro já iniciado na fila do mesmo audit.
- GREEN de composição final: **247/247** no coordenador; em conjunto com o scheduler isolado, **294/294**. Log `/private/tmp/audita-retention-r3a-r3c-composition-green.log`.
- Revisão local independente dos finalizadores: **148/148** (authority e owned-tabs), log `/private/tmp/audita-retention-r3a-finalizers-root-review.log`. Não houve novo achado Critical ou Important nessa leitura. Revisão independente adicional de authority e coordenador: **C=0/I=0**, 47/47 focados, log `/private/tmp/audita-retention-final-purge-independent.log`.
- Ainda não há caller público deste coordenador: integração com worker, bridge de Blob e UI continua pendente. A beta 1.0.8 entregue não foi alterada por este incremento.
- Fechamento da revisão agrupada: segunda revisão independente do coordenador e leitura independente de owned/domínio confirmaram **C=0/I=0**, repetindo 247/247, 32/32 e os gates de cleanup. Authority final teve a leitura independente do agente e do principal; o coordenador teve dois agentes independentes da implementação principal. Achados bloqueantes conhecidos desta fatia: zero.

## Reconciliação de domínio após revisão

A revisão independente identificou uma falha real de composição: o store aceita `canonicalAuditId` até 200 caracteres, mas cinco serviços negavam cleanup acima de 160 antes de verificar ausência. Um teste com R1 em memória, Blob registry real e cada cleaner real (mais a composição dos cinco) reproduziu **12 cenários RED** para 161/200 caracteres e seis positivos para 160; contando o teste agregador, **19 testes, 6 PASS/13 FAIL**. O modelo já estava indisponível e o tombstone permanecia. Na composição completa, raw navigation interrompia antes da limpeza do registro Blob.

Foi autorizada uma reconciliação limitada a `rawNavigationVault.clearAudit`, `pixelCaptureState.readSuspension`, `ownedDisposableTabStore.clearAudit`, `exportLaunch.clearAudit` e `reportLaunch.clearAudit`. Cada entrada passou a validar com `canonicalAuditId` e depois executar sua leitura/inventário normal. Não há atalho por tamanho nem conversão de indisponibilidade em ausência. Os validadores de criação, autorização e os parsers permanecem intactos em 160 caracteres. O coordenador não foi alterado.

Guardas acrescentadas no mesmo teste de integração: 201 caracteres e chave privada negados; criação 160 preservada e 161 negada; armazenamento indisponível para ID canônico de 200 caracteres não confirma limpeza. Com essas guardas, o RED pré-correção foi **1 PASS/18 FAIL**, ainda com 19 testes, sem expansão da matriz.

- GREEN integração de domínio: **19/19**.
- GREEN coordenador completo: **233/233**.
- Regressões diretas: **94/94**, executadas somente nos cinco arquivos de teste dependentes com `--test-name-pattern='clearAudit|audit cleanup|fails closed on malformed records|reads and confirms removal'`.
- Diff de produção adicional: cinco imports e cinco gates (12 inserções/5 remoções). Sem criação de API, mudança de criação/autorização, alteração de parser ou bypass no coordenador.
- Sem Chrome, suíte ampla, commit ou ZIP. Reconciliação congelada para revalidação única. A análise de eventual purga final dos journals é uma etapa distinta, fora desta alteração.
