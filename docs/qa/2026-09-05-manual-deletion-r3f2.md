# R3-F2 — exclusão manual unificada

Base: `85928cb`. Escopo: callers de exclusão manual, mensagem de limpeza pendente e inventário somente leitura necessário à exclusão em lote. Pós-exportação e preferência de retenção continuam fora deste incremento.

## Contratos

- O router usa a autorização existente do relatório, vinculada ao sender/documento/aba/janela e à intenção. Somente depois produz `manualAuthorization` interno, com relógio do worker. O protocolo público não recebe essa prova.
- Exclusão individual lê a revisão e chama o coordenador; não apaga dados, checkpoints, destaques ou sessões diretamente.
- Exclusão em lote lê `listAuditDeletionCandidatesV1()`: snapshot consistente de identificadores e revisões, sem modelos nem URLs. Essa API estreita foi necessária porque o store não tinha inventário público. Auditorias criadas depois do snapshot ficam fora da operação.
- Modelos retidos malformados, órfãos e registros internos não viram candidatos. Nenhum dado é escrito pelo inventário.
- Resposta individual distingue `complete` de `pending`. Resposta coletiva conta excluídas, pendentes e preservadas; em falha de armazenamento que impeça confirmar presença, acrescenta `unconfirmed`, sem afirmar preservação indevida.
- Notificações são individuais, somente para limpeza concluída. Nunca é emitida notificação global que pudesse apagar visualmente uma nova auditoria fora do inventário.
- Se a limpeza ou seu journal falhar depois do staging, ausência confirmada do modelo é apresentada como limpeza pendente, e não como dados preservados.
- A ligação tardia do coordenador não altera a ordem de recovery/startup do R3-E. A rota manual usa runtime messages; não mantém a fila de `reportLaunch.authorizeIntent` nem uma fila de exportação enquanto limpa recursos.

## Evidência

- RED: inventário inexistente e router sem prova interna; depois 4/4 focados verdes.
- RED: operações ainda usavam caminhos antigos. Durante a preparação corrigiu-se a fixture de storage.session para representar chave ausente por `{}`. Operações reais foram validadas com store e coordenador reais.
- RED de UI: callback não anunciava limpeza pendente. Teste executa o callback real, isolado do bootstrap Chrome, e verifica descarte da view e aviso sobre arquivos preservados.
- Regressões: expiração futura, revisão alterada após inventário, nova auditoria durante lote, lease ativa, auditoria ativa, cleanup pendente, falha de journal após staging, sender estrangeiro recusado, autoridade inválida após exclusão.
- O teste integrado antigo foi atualizado: exclusão direta, reutilização de sessão após excluir e ausência de scan de sessão não são mais contratos válidos com limpeza unificada.

Testes focados: `test/background/service-worker.test.js`, `test/background/side-panel-intent-router.test.js`, `test/storage/audit-store.test.js`, `test/review/review-delete.test.js`, `test/review/review-ui.test.js`.

Sem suíte ampla, Chrome real, pacote, publicação ou commit neste incremento. Revisão independente e validação integrada ficam a cargo do agente principal.

## Correção da revisão independente — alarme de limpeza pendente

Reproduzido no graph real: exclusão manual em 05/09 criava tombstone pendente, mas o alarme continuava apontando para a expiração antiga em 05/10. Isso também acontecia quando a gravação do journal de falha lançava depois do staging.

A ligação manual agora chama `scheduleNext()` em `finally`, sem aguardar sua promessa. O scheduler real passa a armar retry de 60 segundos para o tombstone, inclusive quando o coordenador lança após remover o modelo. Uma regressão mantém a leitura do scheduler suspensa e prova que a resposta manual continua sendo entregue.

RED: duas divergências de horário reproduzidas e scheduler não acionado. Apenas ligação worker, testes correspondentes e este registro foram alterados na correção; contratos de armazenamento/coordenador e outras áreas permanecem congelados.
