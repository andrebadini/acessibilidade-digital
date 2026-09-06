# Relatório por item — checkpoint de apresentação

Base cc1a599; arquivos report-view.js/review.css/html.js/report.css.js e report-view.test.js. O relatório agora usa um expansor por ABNT, cartões métricos filtrantes no relatório vivo e fichas recolhidas com orientação didática. Observações originais permanecem consultáveis; referência curta distingue falha de pendência. Mapas e legendas foram preservados.

## Contrato reduzido após REDs concretos

A primeira versão colocava a ficha em um item e links nos demais. Revisão reproduziu contaminação de resultado, depois desalinhamento de classificação e perda de destaque quando o primeiro item era positivo. Conforme a metodologia do usuário, esse desenho foi substituído, não remendado outra vez.

Cada par `(check,item)` tem ficha própria com somente suas ocorrências, resultado, orientação, capturas correlatas e controles. IDs DOM únicos; data-report-check-key conserva a chave original para contar verificações únicas. Classificação de resultado e tipo normativo são separados. O modelo persistido, integridade e evidências não são alterados.

RED/GREEN: agrupamento, filtros, referência curta, guia; classificação real sem trocar o inventário do fixture; itens mistos nos dois ordenamentos com destaque; isolamento do resultado original. Comando final do principal:

`node --test test/review/report-view.test.js test/review/review-evidence-volume.test.js test/review/report-highlight-policy.test.js test/report/html.test.js`

**71/71 PASS**, exit 0; log `/private/tmp/audita-friendly-report-focused.log`. Diff-check aprovado. Revisor independente `compact_report_review` validou a substituição com seis testes diretamente relacionados: C=0/I=0 neste recorte.

## Próximo recorte e limites

O HTML baixado ainda tem comportamento estático neste checkpoint. Próximo recorte documentado em report-export-presentation: filtros locais no HTML, impressão explícita sem depender de script privilegiado, deduplicação de imagens, matriz/anexo recolhidos e referência curta no caminho legado. Recolher a tela sozinho não resolve PDF excessivamente longo. Não há declaração de QA visual/Chrome/PDF ou release concluída.
