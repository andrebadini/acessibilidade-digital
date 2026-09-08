# Backlog das versões beta

Este arquivo registra melhorias que não bloqueiam a primeira beta utilizável. Elas não reduzem os controles de privacidade, autorização de capturas, correlação das evidências, limpeza de estado ou confiabilidade normativa.

## Incidente de compatibilidade — não confundir com refinamento menor

- **Produção pendente, 08/09:** a coleta real da 1.1.12 registra `versions.extension: 0.1.0` em vez de 1.1.12. RED confirmado contra o manifesto; corrigir a proveniência em novas auditorias sem modificar documentos históricos. A primeira tentativa do novo teste também teve `CDP_COMMAND_FAILED`, ainda sem causa isolada. Registro completo em `docs/qa/2026-09-08-google-1112-production-correction.md`. Não tratar o encerramento anterior como aceite do usuário à beta.

- A beta 1.1.2 pode persistir uma decisão humana com hash do modelo pendente e tornar esse relatório ilegível. A correção preventiva foi implementada após essa beta, com verificação do novo hash antes do commit atômico e exportação real da revisão. Registros já afetados **não são recuperados automaticamente**; preservar dados e arquivos previamente exportados. Recuperação exige uma base verificável, não a assinatura silenciosa de conteúdo antigo. Registro: `docs/qa/2026-09-06-live-review-refresh.md`.

## Entrega atual e histórico funcional

**Beta 1.1.13 entregue antes da pausa solicitada:** corrige a versão de origem em novos registros, preserva documentos históricos, 357 testes focados, duas revisões C=0/I=0/M=0, etapa nativa 39/39 e Google atual com quatro exportações/27 páginas. A falha documental do gate lógico e sua correção estão explicitadas em `docs/qa/2026-09-08-beta1113-release.md`. Desenvolvimento pausado, meta de produção não concluída. A primeira falha CDP do teste 1.1.12 e a apresentação explícita da versão no PDF permanecem para a retomada; a 1.1.13 já registra a versão correta no JSON.

**Beta 1.1.12 entregue:** preserva viewport observado quando a versão do navegador não pode ser lida e distingue recomendações na redação de novos registros, sem reescrever relatórios antigos. Candidato, correções das expectativas/ambiente de teste, gates, QA visual/PDF, limites e SHA em `docs/qa/2026-09-08-beta1112-release.md`. As indicações abaixo “fora do ZIP 1.1.11” continuam corretas para aquele pacote; os dois incrementos agora integram a 1.1.12.

- Aceite A → B complementado manualmente na 1.1.12: digitação literal na barra, páginas de conteúdo diferente, nova auditoria B e moldura vermelha no botão vazio de B, mantendo o painel aberto. O contexto interno é recriado legitimamente. O teste nativo separado prova A preservada. Refinamento de infraestrutura: incorporar esse percurso ao controlador reutilizável sem exigir contexto interno imutável; a asserção excessiva da sessão manual e seu alcance estão registrados em `docs/qa/2026-09-08-beta1112-release.md`. Não reabrir o mecanismo aprovado.
- QA da matriz PDF 1.1.12: evitar quebra interna do número ABNT na primeira coluna, mantendo o item inteiro legível numa linha. Agrupamentos e texto estão preservados; refinamento visual junto da compactação.

**Beta 1.1.11 entregue:** nova auditoria após navegação A → B, correlação de sinais axe com elementos/evidências, destaque preservado depois de exportar conteúdo inalterado e documentação alinhada com mapa/retencão existentes. Gate 4032/4032 lógicos, 39/39 na etapa serial Chrome, regressão documental 68/68; revisões finais C=0/I=0. Pacote, SHA e limites em `docs/qa/2026-09-08-beta1111-release.md`. Google atual: 27 páginas, checklist fora dos achados e seis sinais com captura correlacionada; comparação não simultânea em `docs/qa/2026-09-08-beta1111-google-comparison.md`.

- Menores da revisão documental 1.1.11: alinhar a descrição de `alarms` na política HTML à menção de retenção já existente no Markdown; explicitar nos guias que a migração de auditorias antigas deriva o prazo de `endedAt` e dados sem data válida podem estar imediatamente vencidos. O guia já manda exportar antes de atualizar; não há promessa de recuperação de dados antigos.
- Menor da revisão de destaque: transformar o diagnóstico nativo de revisão posterior/hash igual em asserção explícita. Casos unitários e destaque real após quatro downloads já aprovados; não reabrir o mecanismo sem RED novo.

**Beta 1.1.10 entregue anteriormente:** correção A → B, sinais inconclusivos separados do checklist e orientação de requisito/recomendação; ver `docs/qa/2026-09-08-beta1110-release.md`. Seus bytes permanecem inalterados.

**Beta 1.1.9 entregue:** separa achados e suspeitas concretas do checklist geral; este não soma problemas nem fichas no PDF. Corrige a apresentação do contraste ampliado como recomendação/AAA, acrescenta destaque direto e espera de estabilização inicial para a URL dinâmica do Google. Percurso real e PDF de 21 páginas: `docs/qa/2026-09-08-beta119-google.md`. Gates e hash: `docs/qa/2026-09-08-beta119-release.md`.

Refinos posteriores identificados no Google: compactar matriz/paginação do PDF; ajustar singular/plural e omitir “0 ocorrências” nos resultados positivos sem alvos. Nenhum desses refinamentos autoriza descartar registros ou relaxar prova de captura.

- Redação normativa corrigida no código após a beta 1.1.11: novos resumos/perguntas distinguem requisitos e recomendações. Relatórios antigos permanecem legíveis e não são reescritos. GREEN 201/201 e duas revisões C=0/I=0/M=0; JSON real 1.1.11 revalidado e reexportado com modelo idêntico. Ainda fora do ZIP 1.1.11. Registro: `docs/qa/2026-09-08-normative-wording.md`.

- Dimensões independentes da consulta de versão: corrigidas no código após a beta 1.1.11, com RED reproduzido, 324/324 testes focados e duas revisões C=0/I=0/M=0. Dimensões válidas permanecem observadas mesmo quando a versão é indisponível; valores não são estimados. Ainda fora do ZIP 1.1.11, aguardando o gate nativo do próximo candidato. Registro: `docs/qa/2026-09-08-independent-viewport.md`.

**Beta 1.1.7 entregue:** inclui os sete guias práticos 5.1.7–5.1.9 e 5.12.1–5.12.4, conferidos em Chrome, HTML e PDF. Percurso principal, relatório, sinais ABNT, personas, URL e lote aceitos; integração C=0/I=0 e produto C=0/I=0, com M1 de paginação registrado abaixo. Os incidentes de configuração dos gates e as correções focadas permanecem transparentes em `docs/qa/2026-09-06-beta117-release.md`. Não há nova funcionalidade inteira pendente demonstrada na reconciliação atual; os refinamentos listados não bloqueiam esta beta.

Reconciliação com fontes e testes atuais: `docs/qa/2026-09-06-goal-reconciliation.md`. Não usar checklists históricos vazios como prova de funcionalidade ausente. **Beta 1.1.6 entregue** após correção reproduzível da disponibilidade inicial de personas, testes focados, percurso nativo corrigido e duas revisões C=0/I=0. A execução ampla original com 37/38 nativos continua registrada, sem ser reclassificada como verde. Registro final: `docs/qa/2026-09-06-beta116-release.md`.

- orientação didática **entregue na beta 1.1.7**, depois da beta 1.1.6, para **5.1.7–5.1.9 (conteúdo adicional)** e **5.12.1–5.12.4 (espaçamento de texto)**. Resolve os dois exemplos concretos identificados na revisão (5.1.9 e 5.12.2), com procedimentos, proporções, exemplos, exceções e apoio técnico quando necessário. 222 testes focados aprovados; revisão independente C=0/I=0/M=0. Não incluída no ZIP antigo 1.1.6; registro `docs/qa/2026-09-06-spacing-hover-guidance.md`. Os demais fallbacks por família podem ser aprofundados incrementalmente; não declarar que todos os 146 itens têm instrução individual completa.

**Atualização 1.1.5:** os horários individuais e as orientações 5.13.6–5.13.8 descritos abaixo foram entregues após o gate de 3.977 testes lógicos, 38 nativos, verificação estática, QA visual/PDF e duas revisões independentes. As menções “fora do ZIP 1.1.4” permanecem corretas para aquele pacote, não indicam pendência na 1.1.5. Registro: `docs/qa/2026-09-06-beta115-release.md`.

- comparação explícita dos valores registrados em 5.13.7 entregue na beta 1.1.6: pares de texto visível/nome acessível, sem misturar elementos nem inferir resultado, no painel e nas três apresentações de relatório. GREEN173/173; revisão independente C=0/I=0, com 96/96 testes. Continua fora do pacote antigo 1.1.5. Prova nativa JSON/relatório/HTML e PDF real concluída na 1.1.6; registros `docs/qa/2026-09-06-recorded-label-comparisons.md` e `docs/qa/2026-09-06-beta116-release.md`.

- horário individual de recebimento de PNG implementado depois da beta 1.1.4: `metadata.captureReceivedAt`, preservação em modelos/JSON/orçamento e apresentação viva/HTML compartilhada com impressão. Relógio local explicitamente não certificado; datas antigas não são inventadas. Testes locais e duas revisões C=0/I=0; prova nativa concluída com 12 datas conferidas também no PDF e ausência de datas inventadas em no-pixels. Ainda fora do ZIP 1.1.4. Registros: `docs/qa/2026-09-06-capture-receipt-time.md` e `docs/qa/2026-09-06-capture-receipt-native.md`.

- explicações práticas de ABNT 5.13.6, 5.13.7 e 5.13.8 implementadas depois da beta 1.1.4, com comparação do nome visível/acessível, leitura contínua e teste seguro de mensagens de status. Resolvem a orientação genérica observada para 5.13.7 no PDF real, mantendo evidências e resultados. GREEN local113/113; revisão independente C=0/I=0/M=0. Ainda fora do ZIP 1.1.4. Registro: `docs/qa/2026-09-06-layperson-guidance-513.md`. Os demais fallbacks por família podem receber explicações mais específicas incrementalmente, sem apresentar isso como cobertura didática individual completa de todos os itens.

- histórico legível das decisões humanas entregue na beta 1.1.4: pessoa avaliadora, data UTC, conclusão, nota e evidências correlacionadas. PDF completo real e HTML validados; resumo executivo omite esses detalhes com aviso. A beta 1.1.3 exportava esses campos apenas no JSON. Registros: `docs/qa/2026-09-06-readable-human-history.md` e `docs/qa/2026-09-06-beta114-release.md`.

- conferência com múltiplos sinais clicáveis na página original: entregue desde a beta 1.1.1, com limite transparente de 64 ocorrências interativas e associação por identificador estável corroborado. A beta 1.1.4 acrescenta alternativa local para elementos sem ID com classes seguras e caminho estrutural coincidentes, validada no Chrome real e incluída no pacote. Elementos sem essa correspondência continuam não localizados. QA `docs/qa/2026-09-06-idless-page-markers.md` e `docs/qa/2026-09-06-beta114-native.md`; plano `docs/superpowers/plans/2026-09-06-in-page-abnt-markers.md`.

- mapa numerado consolidado incluído no candidato 1.0.8 e validado por E2E público; o pacote 1.0.7 permanece sem esse recurso;
- retenção automática por prazo e limpeza recuperável implementadas no candidato atual; personalização do prazo e indicação individual da data de expiração podem ser acrescentadas;
- atualizar as imagens e o texto de eventual canal público de distribuição após estabilização da beta.

## Refinamentos visuais não bloqueantes

- impressão completa da candidata 1.1.7: no PDF público, página 130, a última linha do horário de recebimento encosta no limite inferior da área impressa e o final “não certificado” parece parcialmente aparado; a página 131 continua a ficha em “URL da mídia”. O horário numérico permanece legível, o aviso é mantido em outros blocos e o texto extraído/JSON está íntegro. Revisor classificou C=0/I=0/M=1: melhorar paginação para evitar divisão de linha sem reabrir os guias ou bloquear a beta. Artefatos e hash: `docs/qa/2026-09-06-beta117-release.md`.

- comparação 5.13.7: quando houver vários pares de texto visível/nome acessível na ficha, acrescentar um identificador visível ou link à respectiva evidência para localizar a captura mais rapidamente. Os pares já permanecem associados ao mesmo artefato; não há mistura de valores entre elementos.

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

- substituir a captura de densidade de pixels denominada “persona-side-panel-200-percent” por prova real de zoom/CSS com imagem válida. O PNG repetido em tiles da 1.1.6 foi excluído do aceite visual; não demonstra falha de layout, mas também não prova zoom de 200%. Não confundir com a prova CSS independente do painel compacto.

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
