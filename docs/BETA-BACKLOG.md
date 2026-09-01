# Backlog da beta 1.0.6

Este arquivo registra melhorias que não bloqueiam a primeira beta utilizável. Elas não reduzem os controles de privacidade, autorização de capturas, correlação das evidências, limpeza de estado ou confiabilidade normativa.

## Próximas entregas funcionais

- ampliar a auditoria em lote para os modos com capturas, mantendo consentimento explícito e execução invisível;
- habilitar o mapa numerado consolidado dos anúncios estimados do leitor de tela após E2E próprio;
- implementar retenção automática por prazo, com limpeza recuperável e indicação visível da expiração;
- atualizar as imagens e o texto de eventual canal público de distribuição após estabilização da beta.

## Refinamentos visuais não bloqueantes

- trocar o título transitório “Avaliando a página atual” por uma mensagem específica ao auditar outra URL;
- evitar o possível recorte de metade do traço quando uma moldura derivada encosta exatamente na borda superior ou esquerda da captura;
- identificar, na legenda, as ocorrências que originaram cada tom quando a mesma evidência visual é compartilhada por falha confirmada e revisão pendente.

## Infraestrutura de testes não bloqueante

- aplicar limite temporal também à leitura do recibo de exportação no helper E2E, para que uma falha de armazenamento nunca deixe o teste aguardando indefinidamente.

## Aprofundamentos defensivos não bloqueantes

- avaliar recursos nativos futuros do Chrome que possam reduzir ainda mais o intervalo técnico inevitável entre a última verificação de sinais sensíveis e o efeito de captura, sem enfraquecer a prova do documento imediatamente anterior ao raster.

## Limites conhecidos

- a auditoria automática não certifica conformidade integral;
- itens contextuais continuam sujeitos a revisão humana;
- conteúdo protegido, canvas, vídeo, frames de terceiros e páginas que mudam durante a coleta podem limitar o resultado;
- o anúncio do leitor de tela é uma estimativa explicável, não uma reprodução garantida de todos os leitores de tela e configurações.
