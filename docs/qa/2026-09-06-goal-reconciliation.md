# Reconciliação da meta com o produto entregue

Estado examinado: `2774ab3`, candidata 1.1.6; pacote anterior entregue: 1.1.5 (`9a27833`). Esta matriz substitui a leitura dos checklists históricos como se todos os quadrados vazios fossem funcionalidades ausentes. Não reclassifica testes antigos como executados hoje nem altera o escopo solicitado.

**Fechamento posterior:** candidata corrigida `a41ddc1`, beta 1.1.6 entregue. Os itens 1–2 de “O que realmente falta” abaixo foram tratados por diagnóstico/RED/correção focada, E2E posterior e conferência/entrega do pacote. A execução ampla original continua 37/38; ver `2026-09-06-persona-bootstrap-readiness.md` e `2026-09-06-beta116-release.md`. O item 3, aprofundamento didático, permanece em andamento; o restante do texto preserva o ponto da reconciliação inicial.

**Incremento posterior à entrega:** os dois exemplos concretos do item 3 foram corrigidos junto aos itens próximos: sete perfis 5.1.7–5.1.9 e 5.12.1–5.12.4, 222 testes focados e revisão independente C=0/I=0/M=0. Ver `2026-09-06-spacing-hover-guidance.md`. Ainda fora do ZIP 1.1.6; não houve novo gate nativo ou pacote nesse incremento. Os demais refinamentos didáticos não significam uma funcionalidade inteira ausente nem justificam alegar que todos os 146 itens já têm guia individual completo.

O turno anterior produziu progresso verificável: commit `f6fda0e`, comparação dos valores registrados em ABNT 5.13.7, 173 testes focados aprovados e revisão independente C=0/I=0. A meta permanece ativa.

## Evidência de implementação e entrega

| Requisito | Fonte atual | Situação |
| --- | --- | --- |
| Cinco etapas, indicador adjacente, ✓ verde ao concluir | `src/panel/panel-view.js`, `panel.css`; `test/panel/panel-view.test.js`; E2E `sidepanel-flow-mv3` | Entregue em 1.1.5. Indicador atual ●, sem alegar animação. |
| Relatório funcional, aba própria, HTML/PDF/CSV/JSON | `src/review`, `src/export`; E2E público, URL, lote e página atual | Entregue e comprovado em Chrome 152 na 1.1.5; novo gate em andamento. |
| Auditoria silenciosa da página atual | `test/e2e/sidepanel-flow-mv3.test.mjs` verifica foco, rolagem, DOM, seleção, entradas e limpeza | Entregue. Usa cópia inativa; não observa estado não salvo da original. |
| ABNT agrupada em expansores, quatro cartões-filtro, refazer | `src/panel/panel-view.js`, `panel-state.js`, `src/review/report-view.js`; E2E público | Entregue. Repetir não apaga o relatório anterior. |
| Referência normativa curta e adequada ao resultado | `src/panel/panel-detail.js`, `src/review/report-view.js`, `src/core/report/html.js` | Entregue. Pendência não é acusada como falha; achado suplementar sem vínculo não recebe item inventado. |
| Cobertura explicável | `src/panel/panel-summary.js`, `panel-view.js` | Entregue. Testes próprios concluídos automaticamente / inventário próprio nas páginas tentadas; não mede acessibilidade integral. |
| Relatório resumido, técnico expansível, cores e molduras | `src/review/report-view.js`, `review.css`, `src/core/report/html.js`; E2E executivo | Entregue. Resumo PDF real da fixture tem 8 páginas; exportação completa mantém todas as fichas/evidências. |
| WAVE: sinais na página e seleção nos dois sentidos | `src/background/page-markers-controller.js`, overlay e bridge; E2E `sidepanel-flow-mv3` | Entregue. Limite explícito de 64 ocorrências interativas; outras preservadas no relatório. |
| Nome acessível, anúncio estimado, mapa numerado/legenda | Modelo/evidências, `reader-map-presentation.js`, E2E público | Entregue. Não é transcrição garantida de qualquer leitor de tela. |
| Comparação visível/nome acessível na observação 5.13.7 | `f6fda0e`, novo aceite público em `2774ab3` | Implementado depois de 1.1.5; somente integra entrega após gate da 1.1.6. |
| axe-core local, WCAG e ABNT | `vendor`, `src/core/axe`, `src/core/normative`; E2E CSP/público | Entregue. Matriz completa de 146 itens preserva pendências, sem prometer automação integral. |
| Personas, módulo de leitor e legendas | `src/personas`, controles do painel, E2E personas | Implementado/entregue em 1.1.5. A execução nativa da candidata 1.1.6 falhou; diagnóstico necessário antes de liberar. |
| Outra URL e lista de URLs | Fluxos públicos do painel; E2E URL/lote/consentimento | Entregue. Lista explícita de 2–20 URLs; não se afirma descoberta ilimitada de links. |
| VLibras/Hand Talk, links genéricos, nova aba, texto justificado, lorem ipsum | Coletor, `src/core/detection/accessibility-widgets.js`, regras interativas/textuais/editoriais | Implementado, testes lógicos existentes. Presença de plugin não certifica Libras; alertas contextuais não viram falhas automaticamente. |
| Retenção, exclusão e histórico humano | Coordenador/store/revisão; E2E retenção | Entregue, inclusive exclusão opcional após quatro downloads; arquivos baixados preservados. |
| Sem login, local, sem marca estatal | Manifesto, CSP, arquivos empacotados e guia público | Entregue. Nenhuma alteração na instalação pessoal feita pelo agente. |

A revisão independente de produto inspecionou o estado congelado, executou os 173 testes focados e não encontrou uma funcionalidade inteira ausente nesses percursos. A revisão de integração executou 96 testes e não identificou C/I no delta. Isso não equivale a aceitar o candidato com falha nativa pendente.

## O que realmente falta

1. Diagnosticar o teste de personas que falhou no gate atual; não descartar como ambiental sem evidência. Concluir o restante da fila já em execução, sem reiniciá-la.
2. Conferir os artefatos visuais e PDF da nova comparação e, após aprovação, empacotar/verificar/entregar exatamente os bytes da candidata aceita.
3. Aprofundar a orientação didática onde o fallback por família ainda é pouco específico. Exemplos confirmados na revisão: **5.12.2** (instrução genérica de ajuste textual; exemplo de sigla) e **5.1.9** (navegação genérica em vez de explicar o fechamento do conteúdo adicional). O guia existe, mas não há prova de tratamento didático individual completo dos 146 itens. Não declarar essa abrangência como concluída.

Os demais refinamentos visuais e de cobertura de testes continuam em `docs/BETA-BACKLOG.md`, sem reabrir infraestrutura aprovada nem bloquear beta por cenários teóricos. O incidente de registros antigos da 1.1.2 continua destacado: a prevenção foi entregue, mas não há recuperação automática dos registros já afetados.

Prova histórica completa e hashes da entrega anterior: `docs/qa/2026-09-06-beta115-release.md`. Gate atual: `/tmp/audita-beta116-gate.LzLXU6/npm-test.log` e `verify.log`. A aprovação final deve registrar o resultado terminal, não somente sucessos parciais.
