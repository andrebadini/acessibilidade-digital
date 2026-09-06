# Painel compacto — incremento após a beta 1.1.1

Base: `2047c2d`. Escopo: renderização e CSS do resultado, testes relacionados.
Nenhuma mudança em captura, autorização, modelo, cálculos, armazenamento ou protocolo.
O pacote 1.1.1 entregue permanece intacto; este incremento será incluído no próximo pacote.

## Resultado

- Resumo com quatro filtros antes dos blocos de ações e ajuda.
- Abrir relatório, refazer, mostrar/ocultar sinais e mensagens operacionais continuam visíveis, fora de expansores.
- Ajuda/legenda/contagens dos sinais ficam em expansor; ocorrência omitida continua avisada fora dele.
- Filtros de impacto/WCAG recolhidos por padrão, abertos quando ativos ou necessários para preservar foco após limpar o filtro.
- ABNT antes de cobertura e orientações complementares. Aviso de não certificação permanece visível; denominador e explicação integral da cobertura preservados juntos.
- Data disponível nas orientações; não eliminada. Títulos repetidos dos blocos de ações ficam disponíveis às tecnologias assistivas sem ocupar espaço visual.
- Fundos claros por classificação e grade intrínseca, sem comprimir palavras em colunas estreitas na ampliação.

## Evidências de verificação

1. RED: três casos novos falharam por ordem do resumo e ausência dos expansores.
2. RED adicional: limpar o último filtro ocultava seu destino de foco; corrigido sem mudar o reducer.
3. GREEN: 89/89 testes de `panel-view`, `panel-ui`, `panel-runtime` e `page-markers-session`.
4. Primeira prova visual: grupo ABNT terminava em 975 px, abaixo da tela de 900 px. Ajustados títulos repetidos e localização da data.
5. Imagem ampliada revelou quatro colunas estreitas apesar de não haver overflow. Nova asserção de largura reproduziu RED; grade `auto-fit` resolveu o defeito. O rótulo incorreto de filtros ativos após limpar também teve RED/GREEN.
6. Candidato final: cenário nativo `original-page ABNT markers visual review and verified exports` passou em 8,52 s, Chrome for Testing 152.0.7977.64. Auditoria silenciosa, confirmação de captura, sinais na original, seleção bidirecional, teclado, ir ao elemento, filtros, limpeza após navegação e quatro downloads verificados passaram.
7. Layout nativo: sem overflow horizontal em 320/360/600 px; alvos dos cartões de pelo menos 44 px; quatro cartões e primeiro grupo ABNT visíveis em 360 × 900. Ampliação **CSS** de 200% em viewport de 600 px validada por dimensões e imagem; não é uma alegação de teste do comando de zoom do navegador.
8. Revisão independente do diff congelado e validação agrupada: C=0/I=0; revisor executou 71/71 testes de view/runtime. `git diff --check` passou.

Não foram repetidos suíte ampla, todos os E2E, verify ou empacotamento. As reexecuções foram restritas ao cenário afetado. Uma execução diagnóstica parou por tentativa de sobrescrever imagem de QA (arquivos exclusivos); outra por resize tardio da abertura nativa do painel antes da linha de base da fixture. Nenhuma asserção foi relaxada; a execução final passou integralmente.

## Artefatos locais finais

Diretório: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-compact-nQHjv3`.

- `qa/compact-panel-360.png`
- `qa/compact-panel-enlarged-200.png`
- `qa/markers-panel-abnt-selected.png`
- `qa/markers-original-selected.png`
- `qa/markers-report-after-review.png`
- `downloads/`: HTML, PDF, CSV e JSON efetivamente exportados, validados pelo cenário.

Os limites anteriores dos sinais (64 ocorrências interativas, associação segura e prazo temporário) não mudaram. Edição executiva do PDF e ampliação da localização de elementos sem ID permanecem no backlog.
