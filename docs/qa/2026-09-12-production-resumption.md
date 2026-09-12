# Retomada da aceitação de produção

Base: `396b0ec`, beta 1.1.13 entregue. Retomada explicitamente solicitada em 12/09. Os pacotes anteriores permanecem inalterados.

## Identificação da versão nos relatórios

Causa demonstrada: `projectMethodology` já conserva `versions`, mas a apresentação viva e o ramo `ReportViewV1` do HTML/PDF não exibiam a versão da extensão. O renderer antigo já a exibia. A correção acrescenta a versão registrada à metodologia das duas apresentações faltantes, sem alterar modelo, hash, histórico ou origem dos dados.

RED: dois casos falharam por ausência da versão no texto visível, com produtor registrado `1.1.13` e `não disponível`. A fixture confirma explicitamente esses valores; seu enriquecimento utiliza outra versão instalada (`1.0.1`), portanto também verifica que o histórico não é relabelado.

GREEN: `node --test test/review/report-view.test.js test/report/html.test.js test/report/enrich-audit.test.js` — 94/94, sem falhas. `git diff --check` passou. Log: `/tmp/audita-production-producer-focused.log`.

A prova de renderização nativa/PDF deste incremento será feita no candidato integrado, não inferida desses testes lógicos.

## Incidente do controlador CDP

A tentativa inicial de 1.1.12 falhou com `CDP_COMMAND_FAILED`. O controlador temporário subsequente distingue clique, espera de início e resultado, e consulta um painel atualizado na falha. A tentativa seguinte e a execução da 1.1.13 passaram; isso não demonstra a causa do primeiro erro.

Não há RED de falha de produção associado a esse erro genérico do transporte de teste. A causa permanece indeterminada. Manter o diagnóstico no próximo percurso real e não repetir automaticamente um clique que possa ter iniciado uma auditoria. Nenhuma alteração especulativa no runner, consentimento ou protocolo foi feita.

## Aceitação ainda pendente

- Reconciliação final de requisitos com fontes atuais e limites explícitos.
- Candidato de produção congelado; suíte ampla, Chrome real e revisões independentes.
- Pacote conferido contra o código testado e novo teste do Google na versão final, incluindo leitura do PDF e versão visível.
- Entrega de produção e guia atualizado. A beta não encerra a meta.
