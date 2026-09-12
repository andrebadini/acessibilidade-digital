# Reconciliação do candidato de produção 1.1.14

Base funcional: 1.1.13 (`396b0ec`), não o aceite histórico de beta. A candidata mantém o produto existente e acrescenta versão de origem visível no relatório. Esta matriz confirma localização da implementação e seleciona os gates; não declara que os novos gates já passaram.

| Pedido | Implementação e prova selecionada | Limite preservado |
| --- | --- | --- |
| Painel lateral, página atual/URL, progresso, refazer | `src/panel/panel-view.js`; E2E `sidepanel-flow-mv3`, `url-audit-mv3` | Páginas HTTP/HTTPS; não páginas internas do Chrome |
| Varredura sem movimentar a página original | Runner em cópia inativa; E2E `sidepanel-flow-mv3` | Estado não salvo pode diferir; informado antes da interpretação |
| Sumário, filtros e expansores ABNT | `src/review/report-view.js`, `src/panel/panel-view.js`; testes de apresentação e E2E público | Checklist geral não soma achados; positivos não certificam o site |
| Gráfico e índice explicáveis | `src/core/report/results-overview.js`, sumário do painel | Índice e cobertura usam o motor próprio, não são a nota do AMAWeb |
| Achados didáticos e fundamento ABNT/WCAG | `plain-language-guidance.js`, `nbr17225.js`, `axe-nbr-crosswalk.js` | Recomendação não é requisito mínimo; suspeita não é infração comprovada |
| Nome acessível, anúncio, evidência e legenda numerada | Coleta AX/DOM, `reader-map-presentation.js`; E2E `public-axe-map-mv3` | Prévia estimada, omissões declaradas, não transcrição universal |
| Sinais WAVE e destacar na página original | `page-markers-controller.js` e controles de destaque; E2E `sidepanel-flow-mv3` | Até 64 ocorrências interativas e correspondência confirmada; restantes no relatório |
| Relatório em aba e HTML/PDF/CSV/JSON | `src/review`, `src/export`; E2E público e impressão executiva | PDF de leitura evita repetição; JSON/HTML preservam detalhe integral |
| Personas/leitor/contexto | `src/personas`, worker e painel; E2E `personas-mv3-csp` | Simulação assistiva; funções também acessíveis sem menu de contexto |
| Múltiplas URLs | Batch público e E2E `batch-audit-mv3`, `batch-pixel-consent-mv3` | Lista explícita de 2–20, não descoberta ilimitada de links |
| Validações brasileiras e boas práticas | `accessibility-widgets.js`, regras `interactive.js`, `editorial.js` e textuais | Plugin detectado não prova Libras adequada; regras contextuais podem exigir revisão |
| Privacidade, integridade, exclusão | Gates nativos de consentimento, IndexedDB e retenção | Processamento local; site visitado ainda recebe navegação; arquivos baixados não são apagados |
| Uso sem login e bibliotecas | Manifesto e ZIP com `vendor`; testes de release | Instalação local exige Modo do desenvolvedor; publicação na loja não está sendo realizada |

## Classificação das pendências

Não foi identificada funcionalidade inteira ausente neste percurso a partir das fontes atuais. Os gates do novo candidato devem confirmar o comportamento, inclusive abertura do relatório, destaque e exportação. Não usar esse inventário como substituto de execução real.

A falha isolada `CDP_COMMAND_FAILED` permanece de causa indeterminada, sem reprodução de um defeito de produção. Diagnóstico de subetapa e estado atualizado permanece no controlador do Google. Não reabrir captura/consentimento por hipótese.

Refinamentos menores de paginação, singular/plural, sobreposição de sinais e aprofundamento de guias permanecem no backlog. Não se promete que todos os 146 itens tenham procedimento individual exaustivo. Limites técnicos e dados antigos corrompidos não são escondidos ou reconstruídos.

## Gate da candidata

- Versão inédita: 1.1.14; pacote 1.1.13 preservado.
- Metadados/release: 17/17 focados, log `/tmp/audita-1114-metadata-focused.log`.
- Chrome confirmado antes da suíte: 152.0.7977.64, binário isolado em `/private/tmp/audita-cft152-hqalvn/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
- Próximos: suíte ampla/nativa, verify, duas revisões independentes do mesmo SHA, inspeção visual/PDF e Google da versão empacotada. Ainda não há aceite de produção.
