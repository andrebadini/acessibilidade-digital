# Retenção R2-E — limpeza dos lançamentos de exportação

## Escopo e contrato

Base: `1bdedd0`. Arquivos: `src/background/export-launch.js`, `test/background/export-launch.test.js` e este registro. Relatório, painel, authority e armazenamento permanecem congelados; o pacote 1.0.7 não foi alterado.

`exportLaunch.clearAudit(auditId) -> Promise<boolean>`: `true` confirma a limpeza, inclusive repetição vazia; `false` mantém pendência recuperável. O futuro coordenador deve preservar o tombstone para `false`, rejeição ou retorno inesperado.

A operação não consulta modelo, recibo, lease, autorização do relatório, relógio, downloads ou histórico. É deliberadamente separada de `revoke`, que depende de lease e não cobre registros terminais. O teste torna essas dependências indisponíveis depois de preparar a exportação e exige zero chamadas na limpeza.

## Invariantes implementadas

- Fila compartilhada por auditoria/armazenamento; inventário canônico de launch, sessões antigas/órfãs/revogadas/terminais e índices. Registro próprio sob chave transplantada ou malformado mantém pendência sem efeitos sobre abas.
- Revogação confirmada antes do fechamento. A projeção de um registro terminal conserva os campos-base e remove `terminalProof`, proibido pelo parser em estado revogado. Isso não executa novamente conclusão, notificação ou exclusão pós-exportação.
- Sessões antigas não possuem `windowId`: seu documento e aba registrados precisam coincidir com um contexto TAB único da URL canônica e com leituras estáveis da aba/janela. Se houver launch correspondente, a janela registrada também precisa coincidir. Não há migração ou campo novo.
- Prova do documento e releitura de estabilidade após `getContexts` imediatamente antes de fechar. Navegação pendente, documento/URL/janela diferente ou replacement de índice preserva a aba e o journal.
- Um launch pré-conexão só adota documento na URL canônica estabilizada; grava o documento no registro revogado, confirma e prova novamente. `about:blank`, navegação pendente ou ausência de contexto ficam pendentes até existir prova ou ausência confirmada.
- Erro de `tabs.get` nunca equivale a ausência. `tabs.query({})` confirma somente pelos IDs; `tabs.remove` resolvido ou rejeitado exige confirmação posterior de ausência. Não são persistidos ou retornados títulos/URLs de outras abas.
- Comparação das linhas capturadas antes das operações e readback após gravação/remoção, inclusive commit seguido de exceção. No-op ou falha não confirmada permite repetir a limpeza com a prova remanescente.
- Índice órfão permite apagar somente metadado. Não autoriza fechar a aba. Outro audit, persona independente, arquivos baixados e histórico são preservados.

## REDs dos writers existentes

O preflight identificou três efeitos concretos da nova limpeza sobre eventos atrasados. Os testes reproduziram os problemas antes de alterar esses handlers:

1. `handleWindowRemoved` segurava um inventário antigo e recriava o launch após a limpeza.
2. `revokeInvalidSourceExports` podia fazer o mesmo quando a validação de origem antiga resolvia `false`.
3. `handleTabRemoved` podia usar o índice de uma aba antiga para revogar/fechar uma exportação nova em outra aba.

Os dois primeiros passam a reler e comparar o launch capturado dentro da fila antes de revogar. O terceiro também exige que o launch atual pertença à aba do evento. Não foi redesenhada a revogação normal ou antecipada a integração de retenção.

## Verificação

- RED inicial: **36 falhas**, API ausente, em `/private/tmp/audita-retention-r2e-export-red.log`.
- Primeira implementação do cleaner: **36/36**, em `/private/tmp/audita-retention-r2e-export-first-green.log`.
- RED dos eventos: **3 falhas/1 aprovação** (fila compartilhada já protegida), em `/private/tmp/audita-retention-r2e-events-red.log`.
- Correção mínima dos três handlers; GREEN do módulo: **65/65**, sem skips, em `/private/tmp/audita-retention-r2e-export-green.log`.
- GREEN integrado focado: **237/237**, sem falhas/cancelamentos/skips, com export launch, report launch e worker, em `/private/tmp/audita-retention-r2e-integrated-green.log`.
- `git diff --check` aprovado. Sem suíte ampla, Chrome real ou ZIP nesta fatia.
- Revisão independente do diff congelado: **C=0/I=0**. O revisor executou o módulo (65/65) e cinco cenários adicionais: sessão órfã sem launch, aba ausente, documento estrangeiro, contexto duplicado e índice isolado. Conferiu os efeitos nos mapas de abas/armazenamento, a preservação estrangeira e zero chamadas às dependências proibidas.
- Revalidação local antes do checkpoint: **237/237**, sem falhas/cancelamentos/skips, em `/private/tmp/audita-retention-r2e-final-check.log`; `git diff --check` aprovado.

## Integração seguinte

Continuam pendentes Blob URLs, coordenador sequencial, expiração absoluta, confirmação manual one-shot, pós-exportação e E2E público. Ao integrar pós-exportação, não chamar o coordenador de forma reentrante dentro da fila de `complete`: o cleaner de exportação usa essa mesma fila. O disparo deve ocorrer após a operação terminal sair da fila, conservando a correlação persistida do recibo/tentativa. Esta é uma restrição para a integração futura, não uma alteração implementada nesta fatia.

As garantias e limites das APIs nativas seguem as [fontes oficiais registradas em R2-D](2026-09-05-retention-r2d-report-launch.md#fontes-oficiais-consultadas). A limpeza pública ainda não usa este novo método até a composição do coordenador.
