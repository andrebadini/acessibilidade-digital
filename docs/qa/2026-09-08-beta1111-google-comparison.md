# Google — coleta atual e comparação com AMAWeb

## Identidade e limites

- Fonte atual: candidato 1.1.11 beta 1, código `cbba48b`, metadados locais 1.1.11 ainda não empacotados. Não confundir com a última beta distribuída, 1.1.10.
- Google observado em 08/09/2026, 19:30:12.728Z–19:30:14.577Z (15:30 em Cuiabá), Chrome for Testing 152.0.7977.64, perfil exclusivo sem login, página atual avaliada em cópia temporária inativa, full-evidence.
- AMAWeb: PDF fornecido pelo usuário, avaliação de 06/09/2026 às 09:08, WCAG 2.1, 29 práticas e 483 elementos. Não houve nova coleta pelo AMAWeb. Não são o mesmo DOM, instante ou inventário; esta comparação não mede superioridade nem precisão relativa.
- Fontes anteriores e divergências por critério: `2026-09-08-google-amaweb-comparison.md`.

## Resultados verificados

| Indicador | AMAWeb (06/09) | Audita candidato 1.1.11 (08/09) |
| --- | ---: | ---: |
| Erros/falhas obrigatórias confirmadas | 5 práticas | 0 verificações |
| Recomendações não atendidas | Contraste aprimorado dentro de revisão AAA | 1 verificação |
| Revisões/suspeitas concretas | 3 práticas | 3 verificações, 6 registros |
| Resultados positivos | 21 práticas | 11 verificações |
| Nota/índice | 8,0 | 9,2 (11/12 do motor próprio) |
| PDF | 13 páginas | 27 páginas |

As três revisões não são equivalentes: AMAWeb trata idioma, salto de blocos e contraste aprimorado. Audita separa contraste mínimo, alternativa de imagem e propriedade ARIA; o contraste aprimorado aparece em recomendação. As 103 perguntas agrupadas do checklist geral ficam fora dos achados e do gráfico. O índice Audita exclui axe-core/inconclusivos e não é comparável à nota AMAWeb. Zero falhas confirmadas não significa aprovação de todos os requisitos.

Os seis sinais axe-core possuem agora nodeId correlacionado e captura individual: quatro de contraste, um image-alt e um aria-valid-attr-value. Três têm anúncio estimado não vazio; isso não significa que todo elemento de texto deva ter anúncio como controle focável. Todos continuam `cantTell`, sem promoção automática a infração confirmada. Na coleta anterior os seis estavam sem alvo correlacionado.

## Explicação didática e fiscalização

Conferida no código distribuído 1.1.10 e nos novos HTML/PDF: observação original preservada, roteiro existente mantido, explicação adicional de requisito/recomendação, conformidade regular/plena, contraste mínimo/aprimorado e exemplo hipotético. No PDF novo, páginas 3–4 mostram esse complemento. Páginas 2 e 4 renderizadas e inspecionadas visualmente.

Base primária consultada: seção 4 e itens 5.11.2/5.11.3 da [ABNT NBR 17225:2025 disponibilizada pela Câmara](https://www2.camara.leg.br/a-camara/estruturaadm/gestao-na-camara-dos-deputados/responsabilidade-social-e-ambiental/acessibilidade/pdfs/ABNTNBR17225AcessibilidadeDigitalparaWeb.pdf), CDC, art. 39, VIII, e Decreto 2.181/1997, art. 12, IX, a. Textos normativos também disponíveis na Câmara: [CDC consolidado](https://www2.camara.leg.br/legin/fed/lei/1990/lei-8078-11-setembro-1990-365086-normaatualizada-pl.pdf) e [Decreto consolidado](https://www2.camara.leg.br/legin/fed/decret/1997/decreto-2181-20-marco-1997-445015-normaatualizada-pe.html).

Interpretação, não conclusão de um processo: recomendação descumprida, isoladamente, não demonstra descumprimento da conformidade regular. A referência do CDC às normas técnicas não elimina a distinção interna entre requisito e recomendação. Outra obrigação aplicável, oferta vinculante ou barreira com fundamento legal próprio pode exigir análise diversa. Não foi estabelecido precedente específico sobre esta hipótese nem há promessa de imunidade à fiscalização.

## Reprodutibilidade e verificações

- Roteiro local: `/private/tmp/audita-google-beta1111.mjs`; log final `/tmp/audita-google-beta1111-final.log`. Ajuste somente do diretório auxiliar para o tmpdir canônico aceito pelo harness; tentativas anteriores falharam antes de iniciar Chrome. Nenhuma proteção de produto foi alterada.
- Jornada: ação → painel → auditoria → sumário → relatório → quatro downloads; exit 0. Perfil/processo do teste encerrado pelo harness. Não altera o Chrome pessoal.
- Artefatos preservados em `/Volumes/SSD1/acessibilidade-digital/entregas/teste-google-com-1.1.11/`, HTML/PDF/CSV/JSON. IDs dos quatro downloads confirmados pelo harness; PDF contado com pypdf. Não são um pacote instalável.
- Candidato em execução previamente: `npm test` exit 0, 4032/4032 lógicos e 39/39 na etapa serial de navegador. A etapa inclui testes auxiliares, não 39 jornadas distintas. Log `/tmp/audita-beta1111-candidate-tests.log`.
- Duas capturas auxiliares da UI após reinício do worker atingiram timeout; não foram produzidas. Evidências reais e quatro exportações desses cenários passaram. Não confundir timeout de QA com evidência ausente.

## Melhorias posteriores, sem alterar conclusões agora

- Tornar ainda mais explícito no sumário que o índice exclui os sinais do motor suplementar; uma nota alta pode coexistir com suspeitas importantes.
- Separar visualmente a evolução em requisitos e recomendações, sem apresentar percentual como certificação.
- Remover redundância textual dos diagnósticos e melhorar singular/plural. O texto original do motor ainda chama o contraste aprimorado de “Requisito”, embora a classificação e o novo guia o identifiquem corretamente como recomendação; corrigir em incremento próprio sem reescrever evidência histórica.
- Compactar anexos/matriz na impressão preservando guias, capturas e rastreabilidade. As 27 páginas desta coleta não equivalem a 27 problemas.
- Investigar discrepâncias de cabeçalhos/listas/IDs com a mesma página renderizada. Nenhum dos cinco erros AMAWeb pode ser simplesmente descartado porque outra coleta não o confirmou.
