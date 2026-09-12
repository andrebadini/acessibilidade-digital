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

### Gate 1.1.14 — regressão de sinal vivo na retomada do lote

A suíte lógica ampla terminou com 4.047/4.048 aprovados, sem iniciar o Chrome. A falha foi reproduzida isoladamente em Node 26.5.0 e 24.19.0: `recover` congelava recursivamente o envelope incluindo `AbortSignal`; a próxima página sensível não conseguia registrar o listener de cancelamento (`Symbol(kEvents)` somente leitura).

Correção mínima: manter o envelope e seus dados congelados, mas preservar a referência viva do sinal sem congelá-la. Nenhuma mudança na autorização ou sequência de páginas. O teste de duas páginas sensíveis também exige que o sinal permaneça vivo. RED em `/tmp/audita-production1114-d3Cxqz/batch-red.log`; GREEN 91/91 em `batch-green.log`, abrangendo execução de lote e run-batch. O gate amplo original permanece registrado como falho; apenas os afetados são repetidos antes da etapa nativa ainda não executada.

Primeira revisão congelada de `81e56db`: C=0/I=0/M=0, 74/74 focados. A correção de lote terá revisão própria; não está coberta pela aprovação anterior.

- Reconciliação final de requisitos com fontes atuais e limites explícitos.
- Candidato de produção congelado; suíte ampla, Chrome real e revisões independentes.
- Pacote conferido contra o código testado e novo teste do Google na versão final, incluindo leitura do PDF e versão visível.
- Entrega de produção e guia atualizado. A beta não encerra a meta.
