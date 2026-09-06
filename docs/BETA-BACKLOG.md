# Backlog das versões beta

Este arquivo registra melhorias que não bloqueiam a primeira beta utilizável. Elas não reduzem os controles de privacidade, autorização de capturas, correlação das evidências, limpeza de estado ou confiabilidade normativa.

## Incidente de compatibilidade — não confundir com refinamento menor

- A beta 1.1.2 pode persistir uma decisão humana com hash do modelo pendente e tornar esse relatório ilegível. A correção preventiva foi implementada após essa beta, com verificação do novo hash antes do commit atômico e exportação real da revisão. Registros já afetados **não são recuperados automaticamente**; preservar dados e arquivos previamente exportados. Recuperação exige uma base verificável, não a assinatura silenciosa de conteúdo antigo. Registro: `docs/qa/2026-09-06-live-review-refresh.md`.

## Próximas entregas funcionais

- horário individual de recebimento de PNG implementado depois da beta 1.1.4: `metadata.captureReceivedAt`, preservação em modelos/JSON/orçamento e apresentação viva/HTML compartilhada com impressão. Relógio local explicitamente não certificado; datas antigas não são inventadas. Testes locais e duas revisões C=0/I=0; prova nativa concluída com 12 datas conferidas também no PDF e ausência de datas inventadas em no-pixels. Ainda fora do ZIP 1.1.4. Registros: `docs/qa/2026-09-06-capture-receipt-time.md` e `docs/qa/2026-09-06-capture-receipt-native.md`.

- explicações práticas de ABNT 5.13.6, 5.13.7 e 5.13.8 implementadas depois da beta 1.1.4, com comparação do nome visível/acessível, leitura contínua e teste seguro de mensagens de status. Resolvem a orientação genérica observada para 5.13.7 no PDF real, mantendo evidências e resultados. GREEN local113/113; revisão independente C=0/I=0/M=0. Ainda fora do ZIP 1.1.4. Registro: `docs/qa/2026-09-06-layperson-guidance-513.md`. Os demais fallbacks por família podem receber explicações mais específicas incrementalmente, sem apresentar isso como cobertura didática individual completa de todos os itens.

- histórico legível das decisões humanas entregue na beta 1.1.4: pessoa avaliadora, data UTC, conclusão, nota e evidências correlacionadas. PDF completo real e HTML validados; resumo executivo omite esses detalhes com aviso. A beta 1.1.3 exportava esses campos apenas no JSON. Registros: `docs/qa/2026-09-06-readable-human-history.md` e `docs/qa/2026-09-06-beta114-release.md`.

- conferência com múltiplos sinais clicáveis na página original: entregue desde a beta 1.1.1, com limite transparente de 64 ocorrências interativas e associação por identificador estável corroborado. A beta 1.1.4 acrescenta alternativa local para elementos sem ID com classes seguras e caminho estrutural coincidentes, validada no Chrome real e incluída no pacote. Elementos sem essa correspondência continuam não localizados. QA `docs/qa/2026-09-06-idless-page-markers.md` e `docs/qa/2026-09-06-beta114-native.md`; plano `docs/superpowers/plans/2026-09-06-in-page-abnt-markers.md`.

- mapa numerado consolidado incluído no candidato 1.0.8 e validado por E2E público; o pacote 1.0.7 permanece sem esse recurso;
- retenção automática por prazo e limpeza recuperável implementadas no candidato atual; personalização do prazo e indicação individual da data de expiração podem ser acrescentadas;
- atualizar as imagens e o texto de eventual canal público de distribuição após estabilização da beta.

## Refinamentos visuais não bloqueantes

- conferência WAVE/ABNT: compactação incluída na beta 1.1.2. Resumo primeiro, ajuda/cobertura/filtros secundários em expansores, avisos operacionais visíveis. QA nativo em 360 × 900 mostra os quatro cartões e o primeiro grupo ABNT; ampliação CSS de 200% mantém cartões legíveis. Registro: `docs/qa/2026-09-06-compact-result-panel.md`.
- sinais fora do viewport atualmente permanecem acessíveis por teclado; aprimorar posicionamento e prevenção de sobreposição em páginas com muitos alvos próximos, preservando o vínculo inequívoco e o comando explícito “Ir ao elemento”.

- impressão executiva incluída na beta 1.1.2: ação explícita “Imprimir resumo / salvar PDF” no relatório vivo e HTML baixado, mantendo a matriz ABNT e identificação da revisão. Na fixture nativa, 22/29 páginas completas passam a 8 no resumo. A exportação automática dos quatro formatos permanece completa. QA: `docs/qa/2026-09-06-executive-print.md`. Refino futuro: quebra entre cabeçalho da matriz e primeira linha. A redução anterior da fixture pública de 179 ocorrências, de 400 para 254 páginas completas, permanece válida e independente.

- atualização imediata do relatório após decisão humana implementada depois da beta 1.1.2; preserva formulários, notas, nome e foco. Filtros voltam a todos os resultados com aviso. Não usar a orientação antiga de apenas reabrir/exportar na beta 1.1.2: ela não corrige o incidente de integridade descrito acima.

- preservar o foco da página também no encerramento automático de uma persona já ausente; as atualizações passivas da legenda já preservam foco, rolagem e controles;

- trocar o título transitório “Avaliando a página atual” por uma mensagem específica ao auditar outra URL;
- evitar o possível recorte de metade do traço quando uma moldura derivada encosta exatamente na borda superior ou esquerda da captura;
- identificar, na legenda, as ocorrências que originaram cada tom quando a mesma evidência visual é compartilhada por falha confirmada e revisão pendente.
- a apresentação atual agrupa por item, recolhe fichas e evidências na tela, usa referência normativa curta e evita imagens repetidas no HTML/PDF (preservando molduras diferentes). Auditorias muito grandes ainda podem produzir PDFs extensos porque nenhum registro técnico é descartado. Baseline 1.0.8: 5.686 ocorrências, 254 artefatos, 5.896 usos de PNG; PDF marcado válido de 1.421 páginas e 18.519.470 bytes. Medir a nova apresentação no gate nativo; não estimar redução antes de medir. Tabelas ainda mais compactas por ocorrência ficam como refinamento futuro.
- quando o orçamento global do lote omitir os pixels de um mapa já composto, substituir a orientação “Localize o número na imagem” por aviso específico de omissão; a legenda e os hashes continuam preservados e a ausência de PNG já é exibida.

## Infraestrutura de testes não bloqueante

- horário de recebimento: acrescentar assertions específicas para Promise CDP rejeitada, tentativa de data em mapa derivado e adulteração do horário em elemento/artefato omitido. Guardas existentes revisados sem falha funcional; já há prova de data adulterada/removida na captura integral, ausência de data em mapa projetado e preservação no orçamento real.

- atualização viva da revisão: acrescentar uma asserção nativa direta sobre a mudança de contagem/célula/ocorrência. Já comprovados salvamento real, nova identidade, modelo/decisão exportados, matriz completa e preservação dos formulários; revisão independente C=0/I=0/M=1.

- continuidade W3, revisão06/09 C0/I0/M1: troca terminal→terminal preserva agendamento do timer de transporte; callback verifica estado atual e envia somente heartbeat sem dados. Não reutiliza autoridade nem despacha operação antiga. Eventualmente invalidar geração nessa troca para coincidir literalmente com a matriz de callbacks antigos; sem impacto funcional conhecido ou renovação de prazo.

- W3-wiring, revisão06/09 C0/I0/M1: a API manual `registration.dispose()` usada pelos testes ainda não garante ausência absoluta de uma publicação já admitida. Repro: publicação aguarda autorização; resolver autorização; enfileirar `queueMicrotask(() => bridge.dispose())`; o mesmo painel admitido pode receber o packet antes da continuação externa retornar `delivered:0`. Port pendente e novas publicações são bloqueados, sem efeito sobre pixels, evidências, armazenamento ou outra auditoria. Bootstrap de produção não retém/chama esse handle, e término nativo encerra o worker; nenhum percurso de produção foi demonstrado. Corrigir na fronteira final de envio antes de reutilizar dispose em produção como garantia de encerramento completo. Não ampliar Task6 por esse residual de teardown de testes.

- conferência na página W3-auth: acrescentar casos explícitos de consumer review+view-only e transplantes independentes mode/binding batch; a negação correspondente já está implementada e revisada C0/I0, com121 testes focados verdes. São refinamentos de cobertura, não falhas conhecidas de autorização.

- aplicar limite temporal também à leitura do recibo de exportação no helper E2E, para que uma falha de armazenamento nunca deixe o teste aguardando indefinidamente.
- avaliar destaque incremental em auditorias acima do limite atual de 5.000 relações, preservando a verificação de identidade e sem omitir registros do relatório.
- ampliar a simulação de IndexedDB dos testes unitários com rollback e ordenação de transações; a prova do armazenamento real continua a cargo dos E2E no Chrome.
- complementar o teste das referências de captura integral nas fichas de revisão com a integração DOM de evidências cuja ordem original difira da ordem do anexo (correlação atual revisada, sem falha identificada).

## Aprofundamentos defensivos não bloqueantes

- remover também os pequenos marcadores privados de preferência/fechamento que podem permanecer em storage.session após exclusão. O candidato nativo confirmou ausência de modelo, evidências, URLs privadas, recibos, abas próprias e tombstones; esses marcadores restantes não contêm conteúdo da página nem URLs.

- avaliar recursos nativos futuros do Chrome que possam reduzir ainda mais o intervalo técnico inevitável entre a última verificação de sinais sensíveis e o efeito de captura, sem enfraquecer a prova do documento imediatamente anterior ao raster.

## Limites conhecidos

- a auditoria automática não certifica conformidade integral;
- itens contextuais continuam sujeitos a revisão humana;
- conteúdo protegido, canvas, vídeo, frames de terceiros e páginas que mudam durante a coleta podem limitar o resultado;
- o anúncio do leitor de tela é uma estimativa explicável, não uma reprodução garantida de todos os leitores de tela e configurações.
- a beta 1.1.4 registra o período de observação da página, mas não o instante individual de cada raster. O código posterior passa a registrar o recebimento de cada PNG pela extensão, distinguindo-o do período observado e do instante interno do raster, que o navegador não atesta por esse fluxo. O relógio local não é certificado e datas antigas não podem ser reconstruídas retrospectivamente.
