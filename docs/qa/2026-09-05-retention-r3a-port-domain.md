# R3-A — domínio canônico no cleanup dos Ports

Data: 2026-09-05. Correção limitada aos gates de `clearAudit` de panel-port e report-port; criação, `HELLO`, parsers, coordenador, worker e demais cleaners não foram alterados.

## Contrato

Os dois cleaners aceitam exclusivamente o domínio canônico de auditoria já definido por `canonicalAuditId`: identificadores públicos de 1 a 200 caracteres. A ampliação é cleanup-only.

- `panelPort.clearAudit(auditId)` confirma ausência real com `true` para IDs canônicos sem estado, inclusive nos limites 160, 161 e 200; entrada inválida continua retornando `false`.
- `reportPort.clearAudit(auditId)` confirma ausência real com `0` para IDs canônicos sem binding, nos mesmos limites; entrada inválida continua lançando `TypeError('REPORT_PORT_CLEANUP_DENIED')`.
- O limite 201 e o identificador privado `__latest__` são negados antes de qualquer efeito.
- Estado e Port estrangeiros, além de registros independentes de persona, são preservados.
- O regex local de 160 caracteres permanece intacto para criação, autenticação `HELLO` e parsing de mensagens. Nenhuma autoridade nova é conferida por aceitar um ID maior apenas no caminho de remoção/ausência.

O marker local de preferência, sem URL, documento ou evidência, permanece backlog de integração para os futuros gatilhos manual/pós-exportação. Este incremento não altera starter/schema e não afirma a ausência de todos os markers.

## TDD e evidência

O RED focado foi executado antes da alteração de produção:

```sh
node --test --test-reporter=spec \
  --test-reporter-destination=/private/tmp/audita-retention-r3a-port-domain-red.log \
  test/background/panel-port.test.js test/background/report-port.test.js
```

Resultado RED: 120/122 passaram e exatamente os dois casos novos falharam no primeiro identificador acima do domínio antigo (161): panel retornou `false`; report lançou `REPORT_PORT_CLEANUP_DENIED`.

Após substituir somente os dois gates de `clearAudit` por `canonicalAuditId`, o mesmo comando, com destino `...-green.log`, passou 122/122, sem falhas, cancelamentos, skips ou pendências. Os testes cobrem ausência 160/161/200, negativa 201/privado e preservação foreign/persona.
# Revisão independente

Duas leituras independentes do recorte congelado confirmaram C=0/I=0. O principal e o revisor repetiram 122/122, sem alterações adicionais. Logs `/private/tmp/audita-retention-r3a-port-domain-root.log` e `/private/tmp/audita-retention-port-id-independent.log`. A implementação dos dois gates é a única alteração de produção deste checkpoint.
