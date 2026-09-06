# Backlog das versões beta

Este arquivo registra melhorias que não bloqueiam a primeira beta utilizável. Elas não reduzem os controles de privacidade, autorização de capturas, correlação das evidências, limpeza de estado ou confiabilidade normativa.

## Próximas entregas funcionais

- conferência com múltiplos sinais clicáveis na página original: implementada e aprovada no gate nativo da beta1.1.1, com limite transparente de64ocorrências interativas e associação por identificador estável corroborado. Ampliar a localização segura de elementos sem ID em atualização incremental; a beta1.1.0 não contém os sinais. Plano `docs/superpowers/plans/2026-09-06-in-page-abnt-markers.md`.

- mapa numerado consolidado incluído no candidato 1.0.8 e validado por E2E público; o pacote 1.0.7 permanece sem esse recurso;
- retenção automática por prazo e limpeza recuperável implementadas no candidato atual; personalização do prazo e indicação individual da data de expiração podem ser acrescentadas;
- atualizar as imagens e o texto de eventual canal público de distribuição após estabilização da beta.

## Refinamentos visuais não bloqueantes

- conferência WAVE/ABNT: compactação implementada após a beta 1.1.1. Resumo primeiro, ajuda/cobertura/filtros secundários em expansores, avisos operacionais visíveis. QA nativo em 360 × 900 mostra os quatro cartões e o primeiro grupo ABNT; ampliação CSS de 200% mantém cartões legíveis. Registro: `docs/qa/2026-09-06-compact-result-panel.md`. Ainda não incluída no ZIP 1.1.1 entregue.
- sinais fora do viewport atualmente permanecem acessíveis por teclado; aprimorar posicionamento e prevenção de sobreposição em páginas com muitos alvos próximos, preservando o vínculo inequívoco e o comando explícito “Ir ao elemento”.

- impressão executiva implementada após a beta 1.1.1: ação explícita “Imprimir resumo / salvar PDF” no relatório vivo e HTML baixado, mantendo a matriz ABNT e identificação da revisão. Na fixture nativa, 22/29 páginas completas passam a 8 no resumo. A exportação automática dos quatro formatos permanece completa. QA: `docs/qa/2026-09-06-executive-print.md`. Ainda não incluída no ZIP 1.1.1; refinar a quebra entre cabeçalho da matriz e primeira linha sem bloquear a entrega. A redução anterior da fixture pública de 179 ocorrências, de 400 para 254 páginas completas, permanece válida e independente.

- atualizar imediatamente o sumário visual após salvar uma decisão humana. Até esse refinamento, reabra o relatório para renovar a visualização ou use “Gerar relatório atualizado” para exportar a revisão persistida; o comando Imprimir do navegador imprime a visualização atualmente aberta.

- preservar o foco da página também no encerramento automático de uma persona já ausente; as atualizações passivas da legenda já preservam foco, rolagem e controles;

- trocar o título transitório “Avaliando a página atual” por uma mensagem específica ao auditar outra URL;
- evitar o possível recorte de metade do traço quando uma moldura derivada encosta exatamente na borda superior ou esquerda da captura;
- identificar, na legenda, as ocorrências que originaram cada tom quando a mesma evidência visual é compartilhada por falha confirmada e revisão pendente.
- a apresentação atual agrupa por item, recolhe fichas e evidências na tela, usa referência normativa curta e evita imagens repetidas no HTML/PDF (preservando molduras diferentes). Auditorias muito grandes ainda podem produzir PDFs extensos porque nenhum registro técnico é descartado. Baseline 1.0.8: 5.686 ocorrências, 254 artefatos, 5.896 usos de PNG; PDF marcado válido de 1.421 páginas e 18.519.470 bytes. Medir a nova apresentação no gate nativo; não estimar redução antes de medir. Tabelas ainda mais compactas por ocorrência ficam como refinamento futuro.
- quando o orçamento global do lote omitir os pixels de um mapa já composto, substituir a orientação “Localize o número na imagem” por aviso específico de omissão; a legenda e os hashes continuam preservados e a ausência de PNG já é exibida.

## Infraestrutura de testes não bloqueante

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
- o contrato atual registra o período de observação da página, mas não o instante individual de cada raster. O relatório distingue explicitamente esses conceitos; acrescentar carimbo por captura exige coleta/schema próprios e não pode ser reconstruído retrospectivamente.
