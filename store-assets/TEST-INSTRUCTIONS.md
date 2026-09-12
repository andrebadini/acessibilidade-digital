# Instruções de teste — Audita Acessibilidade 1.1.14

## Acesso

A extensão não exige conta, login, credencial, assinatura ou serviço externo.

## Instalação

1. Na primeira instalação, descompacte `audita-acessibilidade-1.1.14.zip` em uma pasta própria. Para atualizar, exporte o que deseja guardar, substitua os arquivos na mesma pasta da instalação anterior e use **Recarregar**; não remova a extensão, pois isso pode apagar dados locais.
2. Abra `chrome://extensions` no Chrome.
3. Ative **Modo do desenvolvedor**.
4. Selecione **Carregar sem compactação** e escolha a pasta descompactada, que contém `manifest.json`.
5. Fixe o ícone “Audita Acessibilidade” na barra, se desejar.

## Percurso principal

1. Abra uma página HTTP ou HTTPS que possa ser auditada.
2. Clique no ícone da extensão. Confirme que o painel lateral abre sem popup e permanece ao lado da página.
3. Escolha **Evidência completa**, **Somente elementos** ou **Sem imagens**.
4. Selecione **Auditar a página atual**. Confira o progresso por etapa: a etapa atual deve ficar indicada e cada etapa terminada deve receber uma confirmação verde antes do resultado.
   A página original deve permanecer visível e imóvel durante toda a coleta. A extensão faz a inspeção em uma cópia temporária e inativa, sem alternar a aba, rolar, mover foco ou exibir destaques na página original.
5. Se a página contiver campo de senha, pagamento ou outro marcador sensível, confirme que a auditoria pausa antes dos pixels. Escolha **Continuar e capturar** somente depois de ocultar dados reais; também verifique que é possível cancelar.
6. No sumário, confira os totais de falhas, alertas, revisão humana e resultados positivos, além dos filtros por impacto, WCAG e ABNT.
7. Abra uma ocorrência. Confira a explicação, o impacto, a correção sugerida, o nome acessível, o anúncio estimado, WCAG 2.2, ABNT NBR 17225, fundamentação legal, seletor, código e evidências.
8. Consulte a captura e as evidências da ocorrência. No painel da página original, use **Destacar elemento** ou **Mostrar sinais na página**; somente elementos cuja correspondência possa ser confirmada recebem moldura. Em **Outra URL**, **Ver e destacar na página** depende de a página auditada continuar disponível e corresponder ao documento observado. Se não houver prova do alvo, a interface deve explicar a indisponibilidade, sem inventar a posição.
9. Selecione **Abrir relatório completo**. Uma falha de abertura deve manter o sumário e permitir nova tentativa pelo mesmo botão.
10. Na aba do relatório, registre uma decisão de revisão quando aplicável e selecione **Gerar relatório atualizado**.
11. Confirme os quatro downloads: HTML, PDF, CSV e JSON-LD/EARL.
12. Confira que as molduras vermelha e âmbar são derivações visuais e que os PNGs originais e hashes permanecem separados.
13. Volte à aba web e confira o destaque pelo painel após exportar. Navegue pela barra de endereço para outra página, use **Refazer auditoria** e inicie a nova avaliação. O novo resultado deve corresponder à nova página e não apagar o anterior.

## Outra URL

Abra **Outra URL**, informe um endereço HTTP ou HTTPS e repita o percurso nos três modos. Nos modos com imagens, confirme também a pausa de privacidade, a confirmação de uso único e a geração do relatório. A página original deve continuar ativa durante a coleta.

## Várias páginas

Abra **Várias páginas**, informe de 2 a 20 endereços HTTP ou HTTPS, um por linha, e escolha um dos três modos de evidência. Confira as cinco etapas da página atual, a barra de avanço do lote inteiro, o relatório consolidado e a presença de resultados de todas as páginas. Nos modos com imagens, cada página sensível deve solicitar sua própria confirmação. Uma página que não puder ser observada deve aparecer como tentativa não concluída no relatório, sem impedir as próximas após a limpeza da tentativa. Durante toda a coleta, as páginas devem ser avaliadas em abas temporárias inativas: a aba original deve permanecer visível, sem rolagem, troca de foco, destaque ou navegação perceptível.

## Limites declarados

O mapa numerado e a legenda de anúncios estimados são produzidos no modo de evidência completa quando a coleta permite; omissões são explícitas. A retenção tem prazo de 30 dias desde o primeiro registro persistido e a limpeza ocorre quando o Chrome puder executar a extensão. A opção de excluir após exportação começa desmarcada e exige os quatro downloads confirmados da mesma revisão. Arquivos baixados são preservados. A página aberta, outra URL, o lote nos três modos, as evidências individuais, o destaque quando há fonte viva, as personas e os quatro formatos de exportação fazem parte do percurso testável.

## Privacidade

Todo processamento da extensão é local. Não há backend, analytics, publicidade ou código remoto. A navegação normal da página auditada continua sujeita ao próprio site.
