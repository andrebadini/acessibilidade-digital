# Retenção R2-F — registro recuperável de Blob URLs

Base: `e7efe8b`. Escopo desta fatia: `src/background/blob-url-registry.js`, `test/background/blob-url-registry.test.js` e este registro. Os módulos aprovados anteriormente e a beta 1.0.7 permanecem inalterados. Esta API ainda não está conectada aos produtores nem ao coordenador público de retenção.

## Contrato congelado

`createBlobUrlRegistryV1({sessionArea,revokeInOwner,isOwnerAlive})` expõe:

- `register({auditId,blobUrl,ownerDocumentId}) -> Promise<void>`: confirma a gravação antes de permitir ao chamador oferecer o temporário. A mesma tupla é idempotente; outro audit/documento não pode assumir uma URL já registrada.
- `release({auditId,blobUrl,ownerDocumentId}) -> Promise<void>`: prova a liberação, sem apagar somente o journal por confiança no chamador. Registro ausente é idempotente. Não encerra a auditoria.
- `clearAudit(auditId) -> Promise<number>`: encerra registros futuros da auditoria e limpa somente seus recursos. Qualquer recurso próprio não resolvido rejeita com `BLOB_REGISTRY_UNAVAILABLE`, sem causas ou valores recebidos. Recursos próprios independentes podem avançar antes da rejeição agregada.

Registro exato em `storage.session`: `{version:1,auditId,blobUrl,ownerDocumentId}`, chave `audita:blob-url:v1:${encodeURIComponent(blobUrl)}`. São aceitas somente URLs Blob da origem de extensão, com identificador UUID, sem query/fragmento ou URL da página auditada. Nenhuma leitura/gravação em modelos, relatórios, logs, histórico ou arquivos baixados.

Um marcador mínimo `{version:1,auditId}`, sob `audita:blob-url-closed:v1:${auditId}`, é confirmado antes da limpeza e permanece até o fim da sessão do navegador. Esta adição deliberada impede que um produtor atrasado volte a registrar recursos depois da exclusão, inclusive após reinício do worker. O marcador não contém URL nem conteúdo. Não deve ser confundido com uma Blob URL ainda viva ou com limpeza pendente.

Há uma fila compartilhada entre instâncias que usam o mesmo objeto `sessionArea`, no mesmo worker. Os produtores deverão acessar a instância do worker, não construir registries independentes em documentos diferentes.

## Prova e recuperação

- `isOwnerAlive({ownerDocumentId})`: `true` significa documento exato comprovadamente vivo; `false` significa ausência explicitamente comprovada. Rejeição ou qualquer outro retorno é indisponibilidade, nunca ausência.
- `revokeInOwner({auditId,blobUrl,ownerDocumentId})`: somente `true` confirma que o documento verificou a tupla e executou a revogação nativa. O callback não pode chamar/aguardar `registry.release` recursivamente, pois a fila está ocupada por essa operação.
- Argumentos dos callbacks são projeções fechadas e congeladas. O registro é relido antes/depois das provas e antes de remover; um registro substituído não concede autoridade sobre o substituto.
- No-op e falhas de armazenamento mantêm pendência. Gravação/remoção seguida de exceção pode ser confirmada por releitura. Se o dono desaparece durante uma chamada sem confirmação, o journal permanece; a próxima tentativa pode confirmar a ausência.
- Os adaptadores nativos da futura integração devem impor timeout às chamadas de contexto/mensagens. O registro não assume que uma promessa nunca resolvida seja uma confirmação.

## Evidência local

- Preflight independente somente leitura definiu a matriz adversarial antes da implementação. Identificou os dois produtores de Blob URLs e a necessidade de confirmação explícita após a revogação nativa.
- RED: **46 falhas**, API ausente, `/private/tmp/audita-retention-r2f-blob-red.log`.
- GREEN: **46/46**, zero cancelamentos/skips, `/private/tmp/audita-retention-r2f-blob-first.log`.
- Cobertura: exclusividade da tupla; outro audit/persona preservados; encerramento tardio/restart; ausência comprovada; ACK ausente/malformado; no-op/falha/commit seguido de exceção; inventário indisponível; transplante; substituição antes/depois da prova; limpeza parcial; concorrência entre duas factories; dados inválidos sem efeitos ou exposição em erros.
- O limite de criação de agentes foi superado após autorização explícita do usuário para reutilizar um agente concluído somente como revisor do código novo.
- Revisão independente encontrou um Important: o registry limitava `auditId` a 160 caracteres, embora o contrato canônico aceite 200. RED dos limites 161/200 confirmado em `/private/tmp/audita-retention-r2fg-review-red.log`; o registry passou a reutilizar `canonicalAuditId`, mantendo a validação do documento separada. A tabela cobre 160/161/200 aceitos, 201 rejeitado e limpeza idempotente após nova instância.
- Correção validada independentemente: **C=0/I=0**, registry + lifecycle **67/67** em `/private/tmp/audita-retention-r2fg-review-green.log`. Aprovação restrita a esta fatia e aos produtores R2-G; não abrange a futura ponte nativa ou o coordenador público.
- Sem suíte ampla, Chrome real ou ZIP.

## Integração seguinte — produtores e transporte

1. `download-artifacts.js`: registrar imediatamente após criar a URL e antes de qualquer download. Falha de registro deve impedir o download e tentar revogação local; preservar journal quando a conclusão remota for incerta. O `finally` deve revogar nativamente antes de aguardar `release`.
2. `report-export.js`, `printFinalHtml`: aplicar o mesmo fluxo antes de criar a aba de impressão e na limpeza final. O proprietário é o documento de exportação que criou a URL, não a aba de impressão.
3. `export/index.js` e worker: derivar `ownerDocumentId` de contexto nativo autenticado; não aceitar identidade declarada pela página auditada. O recebimento da resposta de registro deve preceder o uso do temporário. Manter o recibo/modelo livre das URLs temporárias e dos IDs privados de contexto.
4. O transporte da revogação precisa atingir o documento da extensão. Não supor que `tabs.sendMessage`, voltado a content scripts, seja um canal para páginas da extensão. A confirmação deve ocorrer depois da chamada nativa, sem recursão na fila do registry.
5. Confirmar com teste real no candidato integrado: temporário dos quatro formatos e da impressão, limpeza após restart, timeout sem perda do journal, downloads já concluídos preservados. Somente depois conectar ao coordenador sequencial de retenção.

## Referências verificadas

Uma URL Blob identifica o recurso temporário; o navegador o libera quando o documento é descarregado. A limpeza explícita não deve ocorrer antes de terminar seu uso. [MDN: Blob URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob).

`URL.revokeObjectURL` retorna `undefined`, pode ser repetido para URL já revogada e não está disponível em Service Workers. Por isso o worker precisa da confirmação do documento proprietário, não de uma chamada nativa direta nem da conversão de `undefined` em sucesso remoto. [MDN: revokeObjectURL](https://developer.mozilla.org/en-US/docs/Web/API/URL/revokeObjectURL_static).

`runtime.getContexts` fornece os contextos ativos da extensão; seus filtros e o `documentId` nativo permitem identificar o proprietário na futura integração. [Chrome: runtime](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts).
