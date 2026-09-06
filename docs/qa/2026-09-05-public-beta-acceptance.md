# Aceite do candidato público — A–H

Este registro separa implementação de validação nativa. Nenhuma porcentagem indica certificação jurídica.

| Pedido | Implementação | Prova antes do candidato |
| --- | --- | --- |
| A agrupamento ABNT | Um expansor por item; ficha própria de cada relação verificação/item | Painel125; relatório71; revisão C0/I0 |
| B referência e linguagem | Referência curta; resultados incertos não viram inconformidade; guia e exemplos hipotéticos, 17 itens com procedimentos específicos | Guia18; regressões guia/detalhe/relatório74; revisão C0/I0 |
| C cartões clicáveis | Filtros no painel, relatório e HTML exportado; contagens globais preservadas | Projeções/controller e script HTML |
| D cobertura | Denominador e limites explicados na UI/README | Fórmula existente preservada |
| E relatório | Sumário com cores/barras, grupos recolhidos, código expansível, matriz/anexo recolhidos, imagens sem repetição desnecessária, impressão completa | Exportação/apresentação113; impressão/harness68; PDF real inspecionado |
| F pendências | Retenção30dias, exclusão manual unificada, exclusão opcional após quatro downloads | R3E dualreview; F1/F2 dualreview; F3 revisão integrada |
| G refazer | Retorna à escolha sem apagar anterior nem iniciar captura | Controller/reducer com regressão duplo clique |
| H melhorias | HTML interativo, filtros reversíveis, impressão sem depender de scripts, recuperação após interrupção | Focados; candidato nativo pendente |

## Percurso nativo obrigatório

- [x] Painel lateral; modos e progresso verificados no percurso nativo.
- [x] Página atual inspecionada na cópia temporária, sem ações visíveis na original.
- [x] Sumário, filtro, grupo, ficha; destaque quando documento vivo correspondente está disponível.
- [x] WCAG/ABNT, guia, nome acessível, anúncio estimado e evidências.
- [x] Mapa com números e legenda; HTML autocontido, PDF legível e arquivos CSV/JSON completos.
- [x] Refazer sem apagar anterior.
- [x] Lote, personas e confirmação de privacidade.
- [x] Retenção, exclusão manual e opt-in pós-quatro downloads; arquivos preservados.
- [x] Nenhum Critical/Important conhecido no recorte A–H validado; novo percurso WAVE ainda pendente.

Limitações de tecnologia assistiva, páginas protegidas, conteúdo dinâmico, cobertura manual e modos sem pixels são características declaradas, não resultados positivos presumidos. Capturas refletem o estado observado; o período de observação não deve ser apresentado como instante individual de cada raster.

## Evidência do candidato

- Suíte lógica ampla: 3.776/3.780 inicialmente; as quatro expectativas legadas foram atualizadas em d2c577d, arquivo9/9GREEN. Não houve nova execução ampla; os testes de produção acrescidos/corrigidos foram executados nos conjuntos focados registrados.
- Verificação estática: PASS com `AUDITA_VERIFY_SKIP_TESTS=1`.
- Nativo inicial: 23/30, com sete falhas depois diagnosticadas. Reruns limitados: URL/live highlight2/2; publicaxe/map1/1; personas1/1; batchpixel1/1; retenção real1/1. Página atual: **5/5 PASS** no fechamento, incluindo cancelamento, no-pixels, element-only e full-evidence após reinício do worker, quatro downloads físicos e limpeza. Log: `/private/tmp/audita-beta110-export-proof.log`.
- Duas capturas auxiliares de QA da interface no full-evidence pós-reinício excederam o timeout do CDP. Não foram produzidas nem contadas como sucesso visual. As imagens da auditoria, a integridade dos quatro arquivos, a privacidade e a limpeza permaneceram obrigatórias e passaram; outras capturas de painel/relatório/mapa foram inspecionadas nos percursos registrados.
- PDF público da mesma fixture (179 ocorrências): 400 páginas antes → 254 páginas no candidato corrigido; A4, marcado, sem JavaScript, 6.146.969 bytes. Primeiras três páginas e capturas do sumário/ficha/mapa inspecionadas. O documento ainda é extenso por incluir todas as fichas e o anexo técnico; não alegar que seja um resumo de poucas páginas.
- A correção de limpeza após exportação tem RED reproduzível e duas revisões C0/I0; 373 regressões focadas passaram. O E2E de retenção confirma oito arquivos, exclusão manual e pós-exportação, ausência dos tombstones e preservação dos downloads.

## Novo esclarecimento WAVE

As imagens recebidas durante o fechamento acrescentam a conferência com vários sinais interativos na página original. Isso **ainda não está entregue** no candidato1.1.0; não confundir o mapa do relatório ou o destaque único em Outra URL com esse percurso. Implementação separada em [Conferência na própria página](../superpowers/plans/2026-09-06-in-page-abnt-markers.md), preservando a ABNT como eixo.
