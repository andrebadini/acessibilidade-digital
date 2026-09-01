# Instruções de teste — Audita Acessibilidade 1.0.2 beta 1

## Acesso

A extensão não exige conta, login, credencial, assinatura ou serviço externo.

## Instalação

1. Descompacte `audita-acessibilidade-1.0.2.zip` em uma pasta vazia.
2. Abra `chrome://extensions` no Chrome.
3. Ative **Modo do desenvolvedor**.
4. Selecione **Carregar sem compactação** e escolha a pasta descompactada, que contém `manifest.json`.
5. Fixe o ícone “Audita Acessibilidade” na barra, se desejar.

## Percurso principal

1. Abra uma página HTTP ou HTTPS que possa ser auditada.
2. Clique no ícone da extensão. Confirme que o painel lateral abre sem popup e permanece ao lado da página.
3. Escolha **Evidência completa**, **Somente elementos** ou **Sem imagens**.
4. Selecione **Auditar a página atual** e aguarde o resultado.
5. Se a página contiver campo de senha, pagamento ou outro marcador sensível, confirme que a auditoria pausa antes dos pixels. Escolha **Continuar e capturar** somente depois de ocultar dados reais; também verifique que é possível cancelar.
6. No sumário, confira os totais de falhas, alertas, revisão humana e resultados positivos, além dos filtros por impacto, WCAG e ABNT.
7. Abra uma ocorrência. Confira a explicação, o impacto, a correção sugerida, o nome acessível, o anúncio estimado, WCAG 2.2, ABNT NBR 17225, fundamentação legal, seletor, código e evidências.
8. Use **Ver e destacar na página**. O destaque só deve aparecer se a página ainda corresponder ao documento auditado.
9. Selecione **Abrir relatório completo**. Uma falha de abertura deve manter o sumário e permitir nova tentativa pelo mesmo botão.
10. Na aba do relatório, registre uma decisão de revisão quando aplicável e selecione **Gerar relatório atualizado**.
11. Confirme os quatro downloads: HTML, PDF, CSV e JSON-LD/EARL.
12. Confira que as molduras vermelha e âmbar são derivações visuais e que os PNGs originais e hashes permanecem separados.

## Limites declarados da beta

**Outra URL**, **Lote de páginas** e o mapa numerado consolidado de anúncios aparecem como indisponíveis nesta beta. A auditoria da página aberta, as evidências individuais, o destaque, as personas e os quatro formatos de exportação fazem parte do percurso testável.

## Privacidade

Todo processamento da extensão é local. Não há backend, analytics, publicidade ou código remoto. A navegação normal da página auditada continua sujeita ao próprio site.
