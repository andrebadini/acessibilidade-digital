# Instruções para revisão da Chrome Web Store

## Acesso

A extensão não exige conta, credencial, assinatura ou serviço externo.

## Fluxo principal

1. Instale a extensão e clique no ícone Audita MT.
2. No campo “Endereço do site”, informe `https://www.w3.org/WAI/demos/bad/before/home.html`.
3. Selecione “Auditar”.
4. Aguarde a conclusão. A extensão cria uma aba descartável inativa, executa a coleta local, fecha essa aba e abre a tela de revisão.
5. Confirme que as ocorrências automatizadas têm evidências e que os itens contextuais permanecem como “Revisar”.
6. Em uma ocorrência de revisão, informe um nome de avaliador, selecione uma das três respostas, acrescente uma nota opcional e salve.
7. Selecione “Gerar relatório atualizado”.
8. Confirme os downloads HTML, JSON-LD/EARL e PDF.
9. No relatório, confirme a moldura vermelha nas não conformidades, a moldura âmbar nos itens pendentes, a moldura verde após uma resposta humana “conforme” e a seção separada de PNGs originais com hashes.

## Permissão debugger

A permissão é usada somente nas abas descartáveis criadas pelo fluxo acima. Ela permite obter DOMSnapshot, árvore de acessibilidade, métricas, capturas e PDF. A conexão é encerrada automaticamente.

## Privacidade

Todo processamento é local. A extensão não possui backend, analytics, publicidade ou código remoto. Os sites de teste recebem apenas a navegação normal do Chrome.
