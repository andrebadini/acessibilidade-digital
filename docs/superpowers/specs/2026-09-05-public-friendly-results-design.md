# Resultados compreensíveis para o público

Base: beta 1.0.10, HEAD 5ab0678. Pedido A–H do usuário em 05/09/2026. A pausa foi revogada pelo pedido de implementação. A autorização anterior para decisões autônomas permanece aplicável; não repetir rodadas de aprovação de apresentação.

## Decisão

Reorganizar a apresentação existente, preservando modelos, evidências e decisões. Não reconstruir motor, integridade, consentimento ou correlação. Alternativas consideradas: somente renomear botões (não resolve redundância); substituir toda a arquitetura (aumenta risco e tempo); projeções e componentes de apresentação compartilhados (escolhida).

- Uma entrada expansível por item ABNT, com verificações e ocorrências relacionadas dentro dela. Os números distinguem verificações de ocorrências. Resultados sem ABNT ficam em grupo próprio, nunca recebem item inventado.
- Cartões dos quatro resultados são filtros operáveis por teclado, com estado selecionado e opção de limpar. Cor complementa texto/ícone: falha vermelha, revisão âmbar, resultado positivo verde, alerta destacado separadamente.
- Na referência de falha confirmada: “Inconformidade ao item N da ABNT NBR 17225:2025”. Pendência: “Verificar o item N…”. Resultado positivo não é rotulado inconformidade. A advertência geral de limites fica na metodologia, sem repetição por ocorrência. Não alterar retrospectivamente evidências assinadas ou decisões humanas.
- Explicações por tema dizem quem pode encontrar dificuldade, o que a ferramenta observou e como testar/corrigir. Exemplos são hipotéticos e separados do registro factual. Revisão humana oferece passos, condições de conclusão e permite permanecer inconclusiva.
- Sumário primeiro; verificações expansíveis depois; detalhes técnicos e evidências completas sob demanda. Mapa numerado, legendas e molduras das capturas preservados. Exportação deve preservar todos os dados, mesmo quando a interface está filtrada.
- Cobertura: testes do motor próprio com conclusão automática (passed/failed/inapplicable) divididos pelo inventário desse motor nas páginas tentadas. Não é fração de conformidade, de toda WCAG/ABNT ou de todos os elementos; o restante inclui inconclusivos e não executados.
- Refazer auditoria inicia nova execução pelo fluxo autorizado, sem reaproveitar consentimento e sem apagar resultado anterior. Permitir escolher novamente origem/modo; não presumir que URL antiga ainda representa a aba atual.

## Sequência e segurança

1. Navegação e filtros do painel, agrupamento, explicação de cobertura, refazer.
2. Guia didático compartilhado e referência normativa curta.
3. Relatório compacto e visual, com paridade HTML/PDF e evidências mantidas.
4. Inventário das pendências da meta: concluir retenção R3-E e origens manual/pós-exportação/UI, seguido das lacunas de entrega documentadas em beta 1.0.9. Não declarar completo com base apenas em unidades isoladas.
5. Candidato integrado: suíte lógica ampla, verify, Chrome real e pacote; durante implementação somente testes relacionados e diff-check.

Critérios: agrupamentos sem duplicatas; cartões filtram sem alterar totais/exportações; estado desconhecido nunca promovido a falha; dados novos continuam validados; captura só pelo fluxo existente autorizado; relatório extenso abre sem perder evidências; revisão e exportação operáveis por teclado. Pendências gerais não ficam silenciosamente omitidas.
