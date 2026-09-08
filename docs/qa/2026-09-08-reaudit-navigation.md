# Nova auditoria após navegação — correção local

## Reprodução

Chrome for Testing 152.0.7977.64 em perfil temporário; teste público em `test/e2e/sidepanel-flow-mv3.test.mjs`, nome `new audit after address-bar navigation preserves A and audits B in the same panel`.

Auditoria sem pixels de `/current` termina, navegação para `/other` na mesma aba, nova tentativa pelo painel: a primeira revisão existe, mas a segunda não chega a ACTIVE. Painel `unavailable`, mensagem `Não foi possível concluir a operação local.`; bootstrap anterior `consumed` e novo journal `claimed`. RED nativo reproduzido antes da correção. A primeira execução preparatória falhou no próprio harness porque a armação de invariantes modificava history depois da seleção; corrigida a preparação antes de testar o percurso.

## Causa e correção

`registerPendingBootstrap` recusava qualquer bootstrap com outra identidade, inclusive o ponteiro para resultado terminal anterior. Além disso, a publicação de running atende binding `bound-idle`, não o anterior `bound-session`.

A substituição agora só é aceita com sessão anterior `result`, `view-only` ou `revoked`, mesma janela e ausência comprovada de ACTIVE. Mantém `replaceBootstrap` com conferência do registro anterior e readback. Só depois de confirmar a gravação, o binding que corresponde exatamente à sessão anterior passa a idle. Nenhum relatório, sessão anterior ou evidência é apagado. Captura, autorização e prova do documento não foram alteradas.

## Verificação

- RED unitário do novo registro observado; regressão de recusa para running, privacy-paused e ACTIVE preservada.
- Testes focados panel-port, panel-port-admitted-intents e authorized-audit-starter: exit 0.
- GREEN nativo: 1/1, 4,5 s. Segundo auditId diferente, URLs pedida/final apontam para B; fingerprint da revisão e checkpoint de A permanece idêntico.
- Revisão independente somente leitura: aprovada, C=0/I=0, 133/133 testes panel-port. Não executou Chrome novamente.
- `git diff --check` aprovado.

Não é fechamento da meta ou release. Sem novo ZIP nesta etapa; revalidação integrada e empacotamento ainda necessários. O teste exercita navegação nativa na mesma aba pela API de navegação do harness, equivalente à troca do documento pela barra de endereço, não digitação física na barra. Modalidade de evidência completa já coberta em outros percursos, mas não deve ser apresentada como testada neste novo caso sem pixels.
