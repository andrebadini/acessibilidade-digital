# Backlog da beta 1.0.7

Este arquivo registra melhorias que não bloqueiam a primeira beta utilizável. Elas não reduzem os controles de privacidade, autorização de capturas, correlação das evidências, limpeza de estado ou confiabilidade normativa.

## Próximas entregas funcionais

- habilitar o mapa numerado consolidado dos anúncios estimados do leitor de tela após E2E próprio;
- implementar retenção automática por prazo, com limpeza recuperável e indicação visível da expiração;
- atualizar as imagens e o texto de eventual canal público de distribuição após estabilização da beta.

## Refinamentos visuais não bloqueantes

- trocar o título transitório “Avaliando a página atual” por uma mensagem específica ao auditar outra URL;
- evitar o possível recorte de metade do traço quando uma moldura derivada encosta exatamente na borda superior ou esquerda da captura;
- identificar, na legenda, as ocorrências que originaram cada tom quando a mesma evidência visual é compartilhada por falha confirmada e revisão pendente.
- compactar a apresentação impressa de auditorias com milhares de ocorrências, preservando os anexos e as referências; a fixture de estresse da beta gerou um PDF válido de 1.091 páginas.

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
