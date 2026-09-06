# Backlog das versões beta

Este arquivo registra melhorias que não bloqueiam a primeira beta utilizável. Elas não reduzem os controles de privacidade, autorização de capturas, correlação das evidências, limpeza de estado ou confiabilidade normativa.

## Próximas entregas funcionais

- mapa numerado consolidado incluído no candidato 1.0.8 e validado por E2E público; o pacote 1.0.7 permanece sem esse recurso;
- retenção automática por prazo e limpeza recuperável implementadas no candidato atual; personalização do prazo e indicação individual da data de expiração podem ser acrescentadas;
- atualizar as imagens e o texto de eventual canal público de distribuição após estabilização da beta.

## Refinamentos visuais não bloqueantes

- atualizar imediatamente o sumário visual após salvar uma decisão humana. Até esse refinamento, reabra o relatório para renovar a visualização ou use “Gerar relatório atualizado” para exportar a revisão persistida; o comando Imprimir do navegador imprime a visualização atualmente aberta.

- preservar o foco da página também no encerramento automático de uma persona já ausente; as atualizações passivas da legenda já preservam foco, rolagem e controles;

- trocar o título transitório “Avaliando a página atual” por uma mensagem específica ao auditar outra URL;
- evitar o possível recorte de metade do traço quando uma moldura derivada encosta exatamente na borda superior ou esquerda da captura;
- identificar, na legenda, as ocorrências que originaram cada tom quando a mesma evidência visual é compartilhada por falha confirmada e revisão pendente.
- a apresentação atual agrupa por item, recolhe fichas e evidências na tela, usa referência normativa curta e evita imagens repetidas no HTML/PDF (preservando molduras diferentes). Auditorias muito grandes ainda podem produzir PDFs extensos porque nenhum registro técnico é descartado. Baseline 1.0.8: 5.686 ocorrências, 254 artefatos, 5.896 usos de PNG; PDF marcado válido de 1.421 páginas e 18.519.470 bytes. Medir a nova apresentação no gate nativo; não estimar redução antes de medir. Tabelas ainda mais compactas por ocorrência ficam como refinamento futuro.
- quando o orçamento global do lote omitir os pixels de um mapa já composto, substituir a orientação “Localize o número na imagem” por aviso específico de omissão; a legenda e os hashes continuam preservados e a ausência de PNG já é exibida.

## Infraestrutura de testes não bloqueante

- aplicar limite temporal também à leitura do recibo de exportação no helper E2E, para que uma falha de armazenamento nunca deixe o teste aguardando indefinidamente.
- avaliar destaque incremental em auditorias acima do limite atual de 5.000 relações, preservando a verificação de identidade e sem omitir registros do relatório.
- ampliar a simulação de IndexedDB dos testes unitários com rollback e ordenação de transações; a prova do armazenamento real continua a cargo dos E2E no Chrome.
- complementar o teste das referências de captura integral nas fichas de revisão com a integração DOM de evidências cuja ordem original difira da ordem do anexo (correlação atual revisada, sem falha identificada).

## Aprofundamentos defensivos não bloqueantes

- avaliar recursos nativos futuros do Chrome que possam reduzir ainda mais o intervalo técnico inevitável entre a última verificação de sinais sensíveis e o efeito de captura, sem enfraquecer a prova do documento imediatamente anterior ao raster.

## Limites conhecidos

- a auditoria automática não certifica conformidade integral;
- itens contextuais continuam sujeitos a revisão humana;
- conteúdo protegido, canvas, vídeo, frames de terceiros e páginas que mudam durante a coleta podem limitar o resultado;
- o anúncio do leitor de tela é uma estimativa explicável, não uma reprodução garantida de todos os leitores de tela e configurações.
- o contrato atual registra o período de observação da página, mas não o instante individual de cada raster. O relatório distingue explicitamente esses conceitos; acrescentar carimbo por captura exige coleta/schema próprios e não pode ser reconstruído retrospectivamente.
