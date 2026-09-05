# R3-A — purga final da authority

Data: 2026-09-05. Incremento posterior ao beta 1.0.8 entregue; pacote, worker e coordenador não foram alterados.

## Contrato

`authority.finalizeAudit(auditId)` é a barreira terminal da authority para o futuro coordenador de exclusão. Retorna exatamente `Promise<{ok:true,purged:number}|{ok:false,code:'CAPABILITY_UNAVAILABLE'}>` e reutiliza a fila compartilhada por `sessionArea` e o domínio `MODEL_ID` de 1 a 200 caracteres.

- `clearAudit` permanece a revogação recuperável inicial e não muda: sessões ficam `revoked`; target/navigation correlacionados ficam `invalidated` enquanto os demais recursos ainda usam esses vínculos.
- `finalizeAudit` somente purga uma auditoria já revogada. Planeja e valida o grafo inteiro antes da primeira remoção. Sessão própria ativa, child próprio ativo, locator transplantado ou record atribuível malformado retornam a negativa fixa sem remover nada.
- Targets e navigation capabilities exatos, não-persona e correlacionados são removidos e têm ausência confirmada antes das sessões parents. Assim, falha parcial nunca perde a correlação necessária ao retry.
- Cada remoção aceita commit seguido de exceção somente após readback de ausência. Readback indisponível retorna a negativa fixa; repetição recomeça com os parents ainda recuperáveis ou confirma a ausência já persistida.
- Foreign, persona, capability sem sessão própria e outros prefixos são preservados. Não há marker novo, acesso ao modelo ou caller público.
- Repetição vazia é sucesso congelado com `purged:0`. `purged` conta os records próprios presentes no plano confirmado daquela chamada.

O futuro coordenador deve chamar esta API somente depois dos onze cleaners e das demais purgas finais de journals. Somente sua confirmação exata permite remover o tombstone.

## TDD e evidência

O RED focado foi executado antes da produção:

```sh
node --test --test-name-pattern='final authority purge' test/background/target-capabilities.test.js
```

Resultado RED: 6/6 falhas pela ausência de `finalizeAudit`. Os cenários usam a authority e o armazenamento reais do teste, com sessão attached, navigation child, foreign e persona.

Após a implementação mínima, o mesmo recorte passou 8/8, incluindo os subcasos isolados de sessão ativa e child ativo. O arquivo focado completo passou 116/116, sem falhas, cancelamentos ou skips:

```sh
node --test test/background/target-capabilities.test.js
```

As provas cobrem ordem children-before-parents, readback de commit-then-throw, retry após child removido com readback indisponível, idempotência e domínio `MODEL_ID` até 200. Nenhuma criação, `clearAudit`, persona, worker, coordenador, Chrome ou release foi modificada.

Revisão final do recorte congelado: **C=0/I=0** em duas leituras independentes da implementação. O principal repetiu os 116 testes da authority junto aos 32 de owned-tabs (148/148); o outro revisor executou o foco de authority/purga do coordenador (47/47). Logs `/private/tmp/audita-retention-r3a-finalizers-root-review.log` e `/private/tmp/audita-retention-final-purge-independent.log`. A integração no coordenador está documentada no [registro R3-A](2026-09-05-retention-r3a-coordinator.md).
