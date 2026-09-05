# Mapa visual de anúncios — continuação após a beta 1.0.7

Base: `fb4dba5`. O ZIP e a pasta instalável da beta 1.0.7 permanecem congelados.

## Escopo e saída

- **Mapa-1 — apresentação:** exibir os segmentos PNG derivados, números, legenda completa e proveniência no ReportView e no HTML usado para PDF. Não modificar o modelo nem a captura original.
- **Mapa-2 — ativação:** autorizar a composição somente em `full-evidence`, após captura original autorizada; manter `element-only` e `no-pixels` sem mapa. Provar o percurso público em Chrome real e inspecionar o PDF.
- Saída: testes afetados verdes, `git diff --check`, nenhuma falha Critical/Important conhecida e E2E real do mapa aprovado. Retenção é o próximo incremento, não parte deste diff.
- Permanecem congelados: correlação atômica, consentimento one-shot, prova de documento antes de cada raster, regras normativas, destaque e os artefatos da beta entregue.

## Evidência observada

1. RED de apresentação: três falhas reais por ausência de imagens e legenda no relatório atual. GREEN inicial: 58/58 testes de ReportView, HTML e modelo de mapa.
2. Revisão independente identificou controles bidirecionais crus na legenda interativa, divergindo do PNG e HTML. RED adicional confirmou a diferença. Correção mínima neutraliza esses controles na projeção visual, preservando o texto e o hash do artefato original. GREEN: 147/147 testes de apresentação e integração do painel.
3. RED da ativação: cinco falhas no modo completo e wrapper desativado; dois REDs adicionais de integração não chegavam à composição. As quatro validações fechadas de política foram atualizadas conjuntamente.
4. GREEN da ativação: 432/432 testes de política, runner, pipeline, adapter, compositor, auditoria e router do painel. Inclui troca de documento durante composição com zero commit, fonte/identidade/hash divergentes descartados, captura original preservada, pausa sem raster/mapa e ausência de compositor quando a fonte não existe.
5. Três expectativas antigas do router ainda omitiam o mapa em `full-evidence`; foram alinhadas à política aprovada sem alterar os modos restritos.
6. A fixture de suspensão do Port também continha a política antiga. Após alinhamento, **95/95** testes do Port passaram, incluindo reidratação e confirmação.
7. A revisão de integração encontrou ordem lexicográfica incorreta para ordinais de lotes com 10+ páginas. RED reproduziu `page-1, page-10, …, page-2`. Remover apenas a ordenação da projeção executiva preserva a ordem canônica de `model.pages`. **76/76** testes de apresentação, HTML, artefatos e agregação passaram.

## Chrome real e PDF

- O primeiro E2E parou em `WAIT_TIMEOUT` por seletores antigos do próprio teste: ele buscava `privacy-paused` no `body`, em vez de `running` com `data-session-status="privacy-paused"`, e o nome antigo do botão de confirmação. Foi atualizado para os controles públicos existentes, sem contornar autorização.
- E2E público `public-axe-map-mv3.test.mjs`: **aprovado**, Chrome for Testing 152.0.7977.64, perfil temporário e fixture local com CSP estrita. Confirmação, mapa visual, legenda completa, quatro downloads reais e ausência de violações CSP comprovados. Execução final: **6,12 s**.
- Inspeção visual do mapa na tela e da página correspondente do PDF: números ligados aos elementos, legenda dentro da captura e legenda textual ampliada legíveis. O PDF final possui **189 páginas**, 3.841.694 bytes; a compactação de auditorias com muitas revisões já é backlog de apresentação.
- PDF inspecionado com `pypdf 6.10.0` e páginas renderizadas com Poppler: todos os quatro anúncios do mapa encontrados no texto; os três marcadores privados da fixture ausentes. A extração não é prova de remoção de dados pessoais de pixels autorizados: o relatório informa essa limitação.
- O mapa resultou `partial` porque o conteúdo interno do frame não foi anotado; isso é declarado no próprio card, sem inferir conformidade.

O gate foi promovido de `ANNOTATION_MAP_MV3_E2E_PENDING` para `ANNOTATION_MAP_MV3_E2E_PASSED` somente após a prova real. Nenhum novo ZIP foi gerado nesta etapa.

## Revisão

- Revisão da apresentação: inconsistência bidi corrigida por RED/GREEN e validada independentemente na revisão seguinte.
- Revisão da integração: C=0/I=1 apenas pela ordem dos ordinais; demais fronteiras do mapa aprovadas.
- Validação pontual independente da correção de ordem: **C=0/I=0**, RED antigo e GREEN 1/1 confirmados pelo revisor. Nenhum achado Critical ou Important conhecido permanece no escopo deste incremento.

## Achado menor encaminhado

Quando o orçamento do lote remove os pixels de um mapa já composto, a imagem aparece indisponível, mas o resumo ainda orienta localizar números na imagem. A correção de texto está registrada no backlog; dados, legenda e hashes não são apagados nem apresentados como pixels existentes.

## Artefatos locais

- Logs focados: `/private/tmp/audita-reader-map-activation-green.log` e `/private/tmp/audita-reader-map-review-green.log`.
- E2E: `/private/tmp/audita-reader-map-mv3.log`.
- Capturas e downloads: `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-reader-map.65bhvtWOMz`.
- Execução final: `/private/tmp/audita-reader-map-mv3-final.log`; artefatos em `/private/var/folders/3b/dv2ydqf51zq_qdv0gp1xmzzr0000gn/T/audita-marco-1-reader-map-final.n23Q0aN6ts`.
