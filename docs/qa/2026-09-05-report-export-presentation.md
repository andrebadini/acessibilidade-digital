# Relatório interativo baixado e impressão compacta

Base85928cb. O recorte de apresentação não altera modelo, mapeamento normativo, autorização de captura ou os registros de evidências.

- Quatro cartões do HTML baixado filtram resultados; script fixo local, CSP por hash exato, sem rede/armazenamento/execução de dados. Links abrem ancestrais recolhidos.
- PDF automático deriva da mesma revisão/identidade do HTML. Variante própria de apresentação sem script e com todos os details abertos, independentemente da CSP da extensão.
- Capturas repetidas são referenciadas por link. Uma imagem por evidenceId e tratamento necessário; falha vermelha/revisão âmbar distintas continuam disponíveis. Anexo mantém provenance/seletor/snippet e link para raster original usado sob a moldura derivada.
- Matriz e anexo recolhidos, barras proporcionais acompanhadas de contagens textuais, referência curta também no renderer legado. Filtros não mudam totais/modelo nem omitem registros do PDF.
- Impressão direta nativa: beforeprint abre detalhes e revela linhas filtradas; afterprint restaura. Listener anterior é removido ao renderizar nova revisão.

REDs: runtime3; HTML/print/dedup/legacy3; barras/matriz1; export-printBlob1. A revisão adicional reproduziu ausência de preparo nativo de impressão; teste RED do comportamento e correção local.

Comando final: `node --test test/report/html.test.js test/report/report-view-interactions.test.js test/review/report-view.test.js test/review/review-evidence-volume.test.js test/review/report-highlight-policy.test.js test/export/report-export.test.js` — **113/113 PASS**, exit0. Log `/private/tmp/audita-report-export-presentation-focused.log`. Diff-check aprovado.

Revisores independentes compact_report_review e compact_report_presentation: C=0/I=0 após a correção, último revisor executou o teste direto de impressão. Checkpoint aprovado; contagem real de páginas, estética, navegação nativa e PDF ainda precisam da validação Chrome do candidato. Não há pacote/release concluída neste registro.
