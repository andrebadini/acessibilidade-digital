# Diagnóstico da instabilidade registrada em vídeo

## Evidência observada

- Fonte: gravação de tela fornecida pelo usuário em 30/08/2026.
- Duração: 20,316 s; resolução: 4064 × 2150.
- O popup histórico aparece por volta de 3,3 s.
- Entre 3,3 s e 8,3 s, a borda esquerda alterna repetidamente entre seis posições, enquanto a borda direita permanece fixa.
- A largura observada varia aproximadamente entre 356 e 656 pixels físicos.
- Foram contadas 146 mudanças de estado da borda em cinco segundos.
- Os controles permaneceram desabilitados e a mensagem visível foi “Não foi possível preparar as ações locais.”

## Causa correlacionada

O popup removido combinava largura responsiva, largura mínima e uma media query no mesmo limiar em que o Chrome recalculava a largura do host a partir do conteúdo. Isso criava realimentação de layout. Os controles dependiam ainda da resposta de preparação de capacidades; falhas de comunicação, worker antigo ou autorização inválida eram reduzidas à mesma mensagem genérica.

## Correção arquitetural

O manifesto atual não declara `default_popup` e usa exclusivamente `side_panel.default_path`. O clique na ação configura `openPanelOnActionClick`, conforme a API nativa do Chrome Side Panel. O E2E em Chrome 152 comprovou uma única superfície `SIDE_PANEL`, zero `POPUP` e identidade documental estável entre início, resultado, detalhe e evidências.

## Regressões obrigatórias antes do release

1. Abrir pelo clique real no ícone e pelo menu de extensões.
2. Permanecer cinco segundos em repouso e durante a auditoria com um único painel lateral.
3. Repetir abertura e fechamento vinte vezes, sem portas ou listeners duplicados.
4. Validar 320, 380 e 600 CSS px e zoom de 200%, com URL longa, erro, sumário e detalhe.
5. Reiniciar o service worker com o painel aberto e exigir reconexão ou ação recuperável “Tentar novamente”.
6. Simular falha transitória de `setPanelBehavior` e permitir nova tentativa.
7. Atualizar uma instalação antiga e verificar que o pacote não contém `default_popup` nem `src/popup`.

## Conclusão

A falha filmada pertence à arquitetura antiga de popup e foi removida da arquitetura corrente. Uma instalação antiga já carregada precisa ser recarregada ou substituída para adotar o painel lateral.
