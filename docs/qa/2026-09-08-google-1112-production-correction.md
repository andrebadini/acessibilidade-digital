# Google 1.1.12 — nova coleta e correção do encerramento

## Estado da entrega

O usuário esclareceu que a meta é **produção**, não uma entrega encerrada como beta. O encerramento anterior e a atribuição de aceite da beta ao usuário foram incorretos. A meta foi reaberta. O pacote 1.1.12 continua identificado como beta; não foi promovido, renomeado nem republicado.

Esta nova coleta é da **1.1.12**, em 08/09/2026, 20:36:08.545Z–20:36:10.437Z (16:36 em Cuiabá), Google `https://www.google.com/`, Chrome for Testing 152.0.7977.64, perfil isolado sem login, evidência completa. Antes de abrir o navegador, o controlador confirmou o SHA-256 do ZIP entregue e comparou seus 198 arquivos byte a byte com o runtime carregado. O diretório de desenvolvimento fornece adicionalmente o harness de teste, ausente do ZIP; nenhum arquivo de produção foi alterado.

Pacote: `8202f4a1c87f2e5e9e0c954f0dbbf8afa8ff322be97a76103a875540ad35ceb9`.

## Resultado e comparação

| Indicador | AMAWeb fornecido pelo usuário, 06/09 | Audita 1.1.12, nova coleta 08/09 |
| --- | ---: | ---: |
| Falhas confirmadas | 5 práticas | 0 verificações |
| Recomendações não atendidas | Contraste aprimorado em revisão AAA | 1 verificação |
| Revisões concretas | 3 práticas | 3 verificações, 6 registros |
| Resultados positivos | 21 práticas | 11 verificações |
| Nota/índice | 8,0 | 9,2 (11/12 do motor próprio) |
| PDF | 13 páginas | 27 páginas |

Audita: cobertura automática 33,1%; checklist separado de 103 verificações, fora dos achados/gráfico. A comparação usa momentos, inventários e estados diferentes; não prova precisão superior nem conformidade integral. O relatório AMAWeb é o documento fornecido em 06/09, não uma nova execução simultânea. As divergências por critério permanecem em `2026-09-08-google-amaweb-comparison.md`.

Os seis sinais suplementares estão correlacionados com elemento e captura: quatro de contraste, um de alternativa de imagem e um de valor ARIA. São suspeitas, não seis infrações confirmadas. Viewport registrado 1390 × 856, escala 1; versão do navegador explicitamente indisponível no modelo. Advertência estrutural `RUNTIME_MATCH_AMBIGUOUS`; o resultado permanece concluído com limitações. A versão exata do Chrome acima provém do ambiente de teste, não de preenchimento retroativo do relatório.

## Arquivos reais

Preservados, sem reescrever conteúdo, em `/Volumes/SSD1/acessibilidade-digital/entregas/teste-google-com-1.1.12/`:

- `google-com-1.1.12.html`: `117d22704ad43bbdd771defe61b3c8d84375ae6be0f656b58916d40d2bf1148c`
- `google-com-1.1.12.pdf`: `d371d3243b764d35952568ec0b1aae4b70047119e3d39fdd447743bf81fa3072`
- `google-com-1.1.12.csv`: `2d34b4e159573579269f5147629deca3df00edab5fdad4ae66d5551dfd654841`
- `google-com-1.1.12.json`: `c691b611a6898b790327fdf1f4fb127d70d88bb81e7d4b0a2c6f2025c813f797`

Controlador `/private/tmp/audita-google-beta1112.mjs`. Execução concluída exit 0, quatro downloads confirmados. Artefatos de QA em `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-google-beta1112-9IkGAV/`. Sumário vivo e páginas 1 e 3 do PDF renderizados e inspecionados. Página 3 contém recomendação de contraste aprimorado, explicação didática e captura do botão Fazer login com moldura âmbar. Os guias anteriores foram preservados.

## Falhas que não podem ser apagadas pela repetição

1. Primeira execução (`.../audita-marco-1-google-beta1112-uvUwhI`, sessão 30069) terminou exit 1, `CDP_COMMAND_FAILED` na etapa `audit`, antes da espera de resultado. O controlador anterior não preservava subetapa/diagnóstico suficiente; a execução seguinte, com diagnóstico adicional, passou. **Causa ainda não demonstrada**; não declarar falha de produto ou simples falha ambiental sem reprodução. Investigar a fronteira de acionamento/reidratação antes da aprovação de produção.
2. **Falha importante de rastreabilidade confirmada no JSON:** `audit.versions.extension` é `0.1.0`, embora o runtime executado seja 1.1.12. Uma asserção independente contra `manifest.json` falhou reproduzivelmente. Os caminhos unitários de auditoria chamam `enrichAuditForReport` sem `manifestVersion`, que usa fallback histórico; o lote tem opção própria preenchida pelo service worker. Corrigir a proveniência em novas auditorias, abrangendo sucesso/cancelamento/retomada, sem alterar nem reassinar relatórios antigos. Este achado impede afirmar que a 1.1.12 está pronta para produção.

Não houve correção de runtime nesta coleta. A próxima versão precisa de novos testes e novos relatórios próprios; não reutilizar estes resultados como prova de execução de outra versão.
