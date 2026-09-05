# Retenção R2-A — encerramento das conexões de relatório

## Escopo

Base: `1b1cdfa`, fundação durável R1 revisada e integrada. Esta fatia implementa somente `reportPortCoordinator.clearAudit(auditId) -> Promise<number>`, em `src/background/report-port.js` e seu teste. Reaproveita `bindings`, `live` e `disconnect`; nenhuma dependência nova.

A operação remove conexões prontas e autenticações em andamento somente da auditoria solicitada. O retorno conta bindings removidos, não abas fechadas nem dados apagados da interface. Não há novo caller público: o coordenador de exclusão deve primeiro revogar a autoridade e, depois da limpeza das conexões e recursos dependentes do documento, fechar os contextos comprovadamente próprios.

## Invariantes e provas

- A identidade da auditoria e da sessão é associada antes de aguardar autorização. Segunda mensagem `hello` encerra a conexão sem trocar sua correlação.
- Uma conexão removida não pode voltar a publicar quando autorização ou leitura inicial terminam.
- Publicação em andamento confere o binding antes e depois da autorização; outros bindings removidos da cópia de iteração também são ignorados.
- Relatórios de outra auditoria e conexões ainda sem auditoria continuam utilizáveis; repetir a limpeza retorna zero.
- Entrada inválida produz erro fixo, sem reproduzir URL ou conteúdo recebido.

RED observado: cinco falhas e dois testes existentes verdes, em `/private/tmp/audita-retention-r2a-report-red.log`. Quatro falhas eram a API ainda ausente; a quinta reproduziu dois snapshots, de auditorias diferentes, no mesmo Port durante autenticação.

GREEN: sete testes do módulo, sem falhas ou skips; **57/57** com a regressão diretamente relacionada do worker, em 0,63 s, no log `/private/tmp/audita-retention-r2a-report-green.log`. `git diff --check` aprovado. Não houve suíte ampla, Chrome ou empacotamento.

Revisão independente do diff congelado sobre `1b1cdfa`: **C=0/I=0**. O revisor repetiu os sete testes do módulo e o diff-check, confirmando isolamento, idempotência e bloqueio das respostas tardias. Nenhuma correção adicional foi necessária.

## Fronteiras que permanecem congeladas

R1, captura/consentimento, regras normativas, relatórios/exportadores, painel, authority e launch registries não foram alterados. A beta 1.0.7 e seu ZIP permanecem intactos. Esta fatia não declara retenção automática pública concluída.

## Integração restante, baseada nos contratos reais

O levantamento somente leitura confirmou que a Task 5 original descreve várias APIs ainda ausentes. As próximas fatias devem permanecer pequenas:

1. Sessões/painel: adicionar revogação audit-scoped à authority e expor limpeza do painel usando locks e bootstraps existentes, incluindo bindings vivos sem bootstrap. Não tocar personas independentes.
2. Launches: implementar limpeza de relatório/exportação sob as filas existentes, com correlação exata antes de fechar qualquer aba; preservar abas/documentos estrangeiros.
3. Downloads: registrar Blob URLs e revogá-las no documento dono antes de encerrar o contexto. Arquivos já baixados não são apagados; não usar `downloads.removeFile/erase` para entregas terminais.
4. Coordenador e agendamento: compor os cleaners reais sobre R1, acrescentar enumeração de vencidos e próxima expiração ao armazenamento, retomar tombstones e integrar o alarme one-shot e a UI.
5. Exclusão manual/pós-exportação: preservar a exigência de confirmação one-shot e de recibo completo correlacionado. A autorização manual existente não deve ser implicitamente considerada equivalente à capability destrutiva prevista no plano.
6. Candidato integrado: executar prova IndexedDB nativa e percurso público de retenção/exclusão antes de liberar a próxima beta.

Não copiar o contrato antigo `pixelCaptureState.revokeAudit(auditId, reason)`: a API real exige `{auditId, consentId, reason}`. A correlação vem do próprio journal, não do modelo já removido. `highlightController.clearAudit` retorna `{ok,state}`; remover o binding somente após confirmação de overlay ausente. Raw navigation e owned tabs já têm limpeza recuperável própria e devem ser reutilizados.

A preparação apontou que anexar duas vezes o mesmo objeto nativo Port merece uma proteção adicional. Nenhum caller duplicado foi identificado no fluxo real; esse aprofundamento não amplia esta fatia nem bloqueia a beta. A identidade exata do binding já é conferida nos caminhos assíncronos alterados.
