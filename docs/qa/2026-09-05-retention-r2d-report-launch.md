# Retenção R2-D — limpeza dos lançamentos de relatório

## Contrato e escopo

Base: `1f2bd4e`. Alterações limitadas a `src/background/report-launch.js`, `test/background/report-launch.test.js` e este registro. R1, authority, painel e report Port permanecem congelados.

`reportLaunch.clearAudit(auditId) -> Promise<boolean>` é interno ao worker, sem modelo, relógio ou autorização de origem como dependência. `true` significa limpeza confirmada dos registros próprios e dos documentos cuja propriedade estava registrada; inclui repetição vazia. **`false` significa pendência**, inclusive erro operacional não confirmado. O futuro coordenador deve manter o tombstone nesses casos, e não tratar qualquer Promise resolvida como sucesso.

## Comportamento

- Reutiliza a fila compartilhada por armazenamento/auditoria. Captura launch, todos os consumidores próprios canônicos (inclusive antigos, órfãos, expirados ou revogados) e índices próprios. Agrupa os documentos históricos por aba/janela; não usa somente o launch mais recente.
- Revoga e confirma os registros antes do fechamento. Compara novamente os registros e índices atuais, sem apagar replacement estrangeiro. Falhas depois de uma gravação ou remoção são resolvidas por releitura; falta de confirmação mantém pendência recuperável.
- Fecha apenas aba/janela/URL canônica sem navegação pendente e documento reconhecido por `runtime.getContexts`. Há uma nova prova imediatamente antes de `tabs.remove`, depois das verificações de armazenamento.
- Um launch pré-conexão sem documento pode registrar o documento da URL canônica já estabilizada em seu próprio registro revogado; confirma a escrita e prova esse documento novamente antes de fechar. Não há novo tipo de registro.
- Erro de `tabs.get` não prova ausência. Quando necessário, `tabs.query({})` é examinado somente pelos IDs. Após a tentativa de fechamento, confirma a ausência antes de apagar os registros. Nenhum título ou URL de outras abas é persistido ou retornado.
- Índice órfão é apenas metadado: pode ser removido por correlação exata, mas nunca autoriza fechar uma aba.
- Falha de prova, navegação ou janela/documento substituído preserva a aba e o journal revogado. Uma nova tentativa pode concluir quando a identidade voltar a ser comprovável ou a aba estiver ausente.
- `handleWindowRemoved` relê o launch dentro da fila e confere janela/aba/emissão antes de revogar. Um inventário anterior não recria registros já apagados.

## Limite explícito

Uma interrupção entre criar `about:blank` e confirmar a navegação pode deixar um launch sem documento comprovado. A limpeza retorna `false`, preserva o registro e aguarda a URL canônica estabilizar ou a aba desaparecer. Não fecha uma aba em branco após possível intervenção do usuário. Isso é pendência visível a ser tratada pelo coordenador, não sucesso fictício nem remoção de uma aba sem prova.

Personas independentes, arquivos baixados, outros audits e suas abas não são alvos desta operação. A exclusão pública ainda usa o caminho anterior até a composição do coordenador de retenção.

## Evidências TDD

- RED inicial: **34 falhas**, API ainda ausente, em `/private/tmp/audita-retention-r2d-report-launch-red.log`. Dois testes adicionais de janela atrasada e índice órfão também falharam pela API ausente antes da implementação.
- Primeira implementação: **35/36**. O único RED restante demonstrou um launch revogado recriado pelo inventário antigo de `handleWindowRemoved`, em `/private/tmp/audita-retention-r2d-report-launch-first.log`.
- Correção mínima desse writer: releitura dentro da fila, com conferência da identidade da instância do lançamento.
- GREEN do módulo: **119/119**, sem skips, em `/private/tmp/audita-retention-r2d-report-launch-green.log`.
- GREEN integrado focado: **176/176**, sem skips/falhas, com `report-launch.test.js`, `report-port.test.js` e `service-worker.test.js`, em `/private/tmp/audita-retention-r2d-report-launch-integrated.log`.
- `git diff --check` aprovado. Sem suíte ampla, Chrome real ou empacotamento nesta fatia.

## Revisão e correção agrupada

A revisão independente encontrou três Important reproduzíveis, sem Critical:

1. Navegação pendente iniciada durante o último `getContexts` ainda permitia o fechamento. A prova agora relê a estabilidade da aba depois do contexto.
2. Um launch próprio sob chave estrangeira era ignorado. Agora mantém pendência, sem conceder autoridade para fechar ou apagar o registro transplantado.
3. O evento de remoção da aba antiga podia revogar um lançamento novo enfileirado. `handleTabRemoved` agora relê e confere a aba do evento antes da revogação.

Os três REDs foram confirmados antes da correção em `/private/tmp/audita-retention-r2d-review-red.log`: **3 falhas**, respectivamente sucesso indevido, sucesso indevido e novo launch revogado. Após a correção mínima agrupada, os três passam. Regressão focada: **179/179**, zero falhas/skips, em `/private/tmp/audita-retention-r2d-report-launch-corrected.log`. `git diff --check` aprovado.

Validação independente da versão corrigida: **C=0/I=0**, sem novo problema reproduzível com impacto. A reexecução independente dos três arquivos confirmou **179/179**, sem falhas, cancelamentos ou skips, incluindo os três REDs da revisão. `git diff --check` aprovado. A validação confirmou adoção pré-conexão com escrita confirmada/nova prova e coerência dos limites de pendência.

## Fontes oficiais consultadas

Consultadas em 05/09/2026: [tabs.query e propriedades das abas](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-query), [tabs.remove](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-remove) e [runtime.getContexts](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts). A distinção entre ausência de contexto da extensão e ausência de aba orientou a confirmação por IDs, sem interpretar mensagens de erro.

## Próxima integração

Ainda faltam a limpeza dos lançamentos de exportação e Blob URLs, a composição sequencial dos cleaners, gatilhos de prazo absoluto, confirmação manual one-shot, exclusão pós-exportação e validação pública nativa. Esta fatia não ativa retenção automática nem altera o pacote da beta 1.0.7.
