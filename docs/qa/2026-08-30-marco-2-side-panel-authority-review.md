# Revisão crítica — autoridade do painel lateral

- Data: 2026-08-30
- Escopo: identidade do painel lateral, autoridade de lançamento, primeiro clique após inicialização fria, persistência, portas autenticadas e negação de mensagens privilegiadas avulsas.
- Resultado final: **GO**.
- Achados remanescentes: **0 Critical / 0 Important / 0 Minor**.

## Evidências verificadas

- O clique no ícone registra o listener de forma síncrona no service worker, emite um token de lançamento de uso único ligado à aba e à janela de origem e chama `sidePanel.setOptions()` antes de `sidePanel.open()` dentro do callback da ação do usuário.
- A admissão exige a URL exata contendo o token, um único contexto `SIDE_PANEL` vivo e uma conexão por `Port`; a desconexão revoga a autoridade.
- O painel admitido continua autorizado enquanto aquele documento e a porta permanecem vivos, sem expirar durante uma fiscalização longa. Tokens ainda não admitidos expiram e não podem ser reutilizados.
- Falha de persistência não inicia auditoria parcial nem cria autoridade utilizável.
- Intents privilegiados enviados por mensagens avulsas são negados; somente a porta admitida pode iniciar ações.
- A ordem assíncrona `running` antes do resultado do intent foi testada e não invalida mais uma solicitação válida.

## Verificação independente

- 243 testes focados aprovados.
- Matriz adicional com 14 casos de ataque e corrida aprovada.
- `git diff --check` aprovado.
- Chrome for Testing 152.0.7977.64: exatamente um contexto `SIDE_PANEL`, nenhum `POPUP`, largura estável de 360 px, auditoria e relatório concluídos e quatro exportações verificadas por tamanho e hash.

## Decisão

O fluxo nativo de painel lateral satisfaz o gate crítico de identidade e autorização desta etapa. Nenhuma exceção ou lane de compatibilidade privilegiada foi mantida.
