# Retenção R1 — exclusão vencida com registro recuperável

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans para executar este incremento localmente, com TDD e revisão do diff congelado.

**Goal:** Tornar uma auditoria vencida indisponível em uma transação e preservar um registro mínimo para a limpeza recuperável dos seus recursos transitórios.

**Architecture:** Reaproveitar os backends de armazenamento existentes e o prazo absoluto de 30 dias. Acrescentar o object store `audit-deletion-tombstones`; não ativar agendamento nem substituir exclusões públicas neste incremento. O coordenador e a integração com a interface constituem incrementos seguintes.

**Tech Stack:** JavaScript ES modules, IndexedDB nativo, testes `node:test` existentes. Nenhuma nova dependência.

**Spec:** Task 5 de `docs/superpowers/plans/2026-08-29-marco-3-privacidade-lote-retencao.md`, recortada conforme a metodologia acelerada aprovada pelo usuário. Base atual: `7a1feea`.

## Restrições

- Preservar trabalho válido e os commits do mapa. A beta 1.0.7 continua congelada.
- Somente expiração neste incremento. Manual e pós-exportação continuam nos caminhos atuais até integração explícita.
- Não alterar captura, autorização de pixels, runner, evidências, regras normativas, painel, Port, scheduler ou limpeza de abas.
- Não declarar retenção pública concluída por estes testes isolados; falta coordenar e confirmar a limpeza transitória antes da entrega dessa função.
- Somente testes afetados durante implementação; sem `npm test`, Chrome ou ZIP nesta etapa. Prova IndexedDB real no candidato integrado de retenção.

## Estado verificado no HEAD

- `audit-retention.js` já calcula `firstPersistedAt + 30 dias` e revisões preservam a primeira data.
- `audit-store.js` usa banco v2 com `audits` e `audit-retention`. O commit inicial já correlaciona modelo, revisão, latest, checkpoint e retenção.
- `cleanupExpiredAudits` apaga diretamente em transação e pode ser bloqueado por lease/journal ativo. Não há tombstone, coordenador, scheduler nem API `*Deletion*V1`.
- O contrato antigo dos cleaners não corresponde integralmente ao HEAD: não copiar chamadas do plano para o worker sem adaptar e testar seus argumentos reais.

## Arquivos autorizados

- `src/storage/audit-retention.js`: validar e construir o registro mínimo.
- `src/storage/audit-store.js`: upgrade v3 e operações equivalentes nos dois backends, preservando as APIs atuais.
- `test/storage/audit-retention.test.js`: invariantes do registro.
- `test/storage/audit-store.test.js`: transação, prazo, companions, retomada e isolamento.

## Contrato congelado de R1

```js
// Nenhum endereço, conteúdo, token, capability ou evidência neste registro.
const tombstone = {
  version: 1, auditId: 'audit-1', reason: 'retention-expired',
  requestedAt: '2026-08-31T00:00:00.000Z',
  phase: 'transient-cleanup-pending', attempts: 0, lastAttemptAt: null,
};

store.stageAuditDeletionV1({
  auditId: 'audit-1', reason: 'retention-expired',
  now: '2026-08-31T00:00:00.000Z', expectedRevision: null, terminalReceipt: null,
}); // {status:'staged',tombstone} ou {status:'denied',code}
store.listDeletionTombstonesV1({ limit: 25 }); // registros fechados, clonados
store.recordDeletionCleanupFailureV1({ auditId: 'audit-1', at: '2026-08-31T00:00:01.000Z' });
store.completeAuditDeletionV1({ auditId: 'audit-1' });
```

Razões manual/pós-exportação ainda são recusadas. Ausência de auditoria e tombstone não é sucesso de exclusão inventado. Repetir staging de um tombstone existente preserva seu `requestedAt`, tentativas e fase. Falhas de armazenamento usam erro fixo, sem conteúdo auditado. `completeAuditDeletionV1` apenas remove o tombstone; a autoridade de chamá-lo depois de todos os cleaners pertence ao coordenador futuro, nunca à UI.

## Ciclo de implementação

- [x] Escrever os REDs abaixo usando os backends e `terminalFixture()` existentes. Testes de rollback exercitam falha real de request/abort; a simulação foi ampliada com rollback opt-in apenas para a regressão de exclusão parcial.

```js
// Modelo persistido em T0; lease/journal ativos não prorrogam expiresAt.
const result = await store.stageAuditDeletionV1({
  auditId, reason: 'retention-expired', now: T30,
  expectedRevision: null, terminalReceipt: null,
});
assert.equal(result.status, 'staged');
assert.equal(await store.getAudit(auditId), undefined);
assert.equal(await store.getAuditRetention(auditId), undefined);
assert.equal((await store.listDeletionTombstonesV1({ limit: 25 })).length, 1);
```

- [x] Confirmar RED: `node --test --test-name-pattern='deletion staging|deletion tombstone' test/storage/audit-store.test.js test/storage/audit-retention.test.js` — 12 falhas iniciais por API/upgrade ausentes, mais RED da falha após deletes.
- [x] Implementar validação fechada do registro e upgrade v2→v3 sem reescrever dados existentes. Reaproveitar `canonicalAuditId` e `canonicalRetentionInstant`.
- [x] Implementar staging com uma única transação `readwrite` sobre os três stores: validar retenção, negar antes do prazo, apagar somente o grafo do `auditId` e latest correlacionado, apagar retenção, gravar tombstone. Abortar integralmente em falha; não ignorar request de erro.
- [x] Implementar listagem limitada, incremento de falha e conclusão idempotente sem recriar dados.
- [x] Provar os seis critérios: upgrade preserva dados; expiração exata vence lease e journal ativos; antes do prazo não muda nada; falha aborta tudo; reabertura conserva tombstone e indisponibilidade; conclusão afeta apenas tombstone próprio. Auditoria estrangeira preservada; atualizações concorrentes de tentativas serializadas.
- [x] Executar `node --test test/storage/audit-retention.test.js test/storage/audit-store.test.js` — **212/212**, 0 skips após correção — e `git diff --check`.
- [x] Agrupar achados críticos/importantes de uma revisão independente do diff congelado. Único I reproduzido, corrigido e validado; **C=0/I=0** restantes.
- [x] Integrar por staging exato dos quatro arquivos e deste registro, excluindo `node_modules`. Só então iniciar R2 (coordenador/limpeza), seguido da integração pública e prova real de retenção.

## Saída objetiva

APIs duráveis testadas, sem caminho público novo de exclusão, C=0/I=0 no escopo e checkpoint revisável. Agendamento, limpeza de Blob/abas/views e aviso de expiração não estão entregues por R1.

## Registro de execução

- Logs: `/private/tmp/audita-retention-r1-red.log`, `/private/tmp/audita-retention-r1-rollback-red.log`, `/private/tmp/audita-retention-r1-focused.log`, `/private/tmp/audita-retention-r1-storage-green.log`.
- A primeira regressão ampla dos dois arquivos teve apenas duas expectativas antigas de versão 2. Após alinhamento à migração comprovada para v3, 209 testes passaram em 14,4 s.
- O teste de aborto observa que os registros já foram removidos antes da falha assíncrona do `put` no tombstone, e compara os três stores após rollback. Não declara simulação completa de isolamento de readers concorrentes; a prova IndexedDB nativa permanece no candidato integrado.
- A prova real de retenção deverá atualizar sua leitura diagnóstica antiga `indexedDB.open('audita-mt', 2)` para abrir a versão corrente sem forçar downgrade. Não há essa chamada legada no código de produção.
- `recordDeletionCleanupFailureV1` retorna booleano (registro atualizado); `completeAuditDeletionV1` retorna booleano (registro removido). Ausência retorna `false`, não cria tombstone. Listagem usa ordem de chave `auditId`, limite 1–25 e registros imutáveis.
- A revisão inicial encontrou um Important: metadata órfã podia gerar sucesso de staging sem modelo. RED novo nos dois backends: `/private/tmp/audita-retention-r1-orphan-red.log`, 3 falhas. Correção mínima exige modelo presente depois de verificar tombstone preexistente e, no IndexedDB, dentro da mesma transação. O novo teste também confirma preservação de companions, latest e metadata quando a exclusão é negada. Restage legítimo continua idempotente.
- GREEN da correção: 3/3 na regressão específica; **212/212**, 0 skips, 14,4 s nos dois arquivos, registrado em `/private/tmp/audita-retention-r1-corrected.log`.
- Validação independente do diff corrigido: **C=0/I=0**, 16/16 testes de staging/tombstone, sem falhas ou skips. Confirmou negação sem mutação para órfão, expiração real, prazo, restage idempotente, retomada e rollback. Não houve reabertura de outros módulos nem execução de Chrome ou suíte ampla.
