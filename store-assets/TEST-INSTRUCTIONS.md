# Instruções de teste — Audita Acessibilidade 1.1.54

## Acesso

A extensão não exige conta, login, credencial, assinatura ou serviço externo.

## Instalação

1. Na primeira instalação, descompacte `audita-acessibilidade-1.1.54.zip` em uma pasta própria. Para atualizar, exporte o que deseja guardar, substitua os arquivos na mesma pasta da instalação anterior e use **Recarregar**; não remova a extensão, pois isso pode apagar dados locais. Na instalação pela loja, esse procedimento manual não é necessário.
2. Abra `chrome://extensions` no Chrome.
3. Ative **Modo do desenvolvedor**.
4. Selecione **Carregar sem compactação** e escolha a pasta descompactada, que contém `manifest.json`.
5. Fixe o ícone “Audita Acessibilidade” na barra, se desejar.

## Percurso principal

1. Abra uma página HTTP ou HTTPS que possa ser auditada.
2. Clique no ícone da extensão. Confirme que o painel lateral abre sem popup e permanece ao lado da página.
3. Escolha **Evidência completa**, **Somente elementos** ou **Sem imagens**.
4. Selecione **Auditar a página atual**. Confira o progresso por etapa: a etapa atual deve ficar indicada e cada etapa terminada deve receber uma confirmação verde antes do resultado.
   A extensão inspeciona a própria página, sem criar ou alternar abas, navegar, rolar, mover foco ou exibir destaques durante a coleta. Nos modos com imagens, a captura de regiões fora da área visível pode redimensionar a página por um instante; a geometria final é restaurada, mas uma página que reage ao redimensionamento pode alterar seu conteúdo. Confira que essa limitação aparece no relatório.
5. Se a página contiver campo de senha, pagamento ou outro marcador sensível, confirme que a auditoria pausa antes dos pixels. Escolha **Continuar e capturar** somente depois de ocultar dados reais; também verifique que é possível cancelar.
6. No sumário, confira os totais de falhas, alertas, revisão humana e resultados positivos, além dos filtros por impacto, WCAG e ABNT.
7. Abra uma ocorrência. Confira a explicação, o impacto, a correção sugerida, o nome acessível, o anúncio estimado, WCAG 2.2, ABNT NBR 17225, fundamentação legal, seletor, código e evidências.
8. Consulte a captura e as evidências da ocorrência. No painel da página original, use **Destacar elemento** ou **Mostrar sinais na página**; somente elementos cuja correspondência possa ser confirmada recebem moldura. Em **Outra URL**, **Ver e destacar na página** depende de a página auditada continuar disponível e corresponder ao documento observado. Se não houver prova do alvo, a interface deve explicar a indisponibilidade, sem inventar a posição.
9. Selecione **Abrir relatório completo**. Uma falha de abertura deve manter o sumário e permitir nova tentativa pelo mesmo botão.
10. No relatório, use **Imprimir resumo / salvar PDF** e escolha **Salvar como PDF** no diálogo. O resumo é uma edição executiva
    (totais, limitações, matriz ABNT e metodologia) e **não substitui** o relatório completo; confirme que ele identifica a mesma auditoria e revisão.
11. Na aba do relatório, registre uma decisão de revisão quando aplicável e selecione **Gerar relatório atualizado**.
12. Confirme os quatro downloads: HTML, PDF, CSV e JSON-LD/EARL.
13. Confira que as molduras vermelha e âmbar são derivações visuais e que os PNGs originais e hashes permanecem separados.
14. Volte à aba web e confira o destaque pelo painel após exportar. Navegue pela barra de endereço para outra página, use **Refazer auditoria** e inicie a nova avaliação. O novo resultado deve corresponder à nova página e não apagar o anterior.

## Outra URL

Abra **Outra URL**, informe um endereço HTTP ou HTTPS e repita o percurso nos três modos. Nos modos com imagens, confirme também a pausa de privacidade, a confirmação de uso único e a geração do relatório. A página original deve continuar ativa durante a coleta.

## Lote de páginas

Abra **Lote de páginas**, informe de 2 a 20 endereços HTTP ou HTTPS, um por linha, e escolha um dos três modos de evidência. Confira as cinco etapas da página atual, a barra de avanço do lote inteiro, o relatório consolidado e a presença de resultados de todas as páginas. Nos modos com imagens, cada página sensível deve solicitar sua própria confirmação. Uma página que não puder ser observada deve aparecer como tentativa não concluída no relatório, sem impedir as próximas após a limpeza da tentativa. Durante toda a coleta, as páginas devem ser avaliadas em abas temporárias inativas: a aba original deve permanecer visível, sem rolagem, troca de foco, destaque ou navegação perceptível.

## Conferência de leitura por Tab

1. Abra uma página HTTP ou HTTPS e selecione **Conferir leitura por Tab** no painel. Esse percurso funciona sem iniciar uma auditoria e sem capturar imagens.
2. Confira que abre um relatório complementar com data e estado da inspeção. Examine a sequência estimada de Tab, os controles fora dessa sequência, o conteúdo estrutural e os itens ocultos. Os registros devem apresentar nome, função, estados e uma prévia explicativa quando houver informação suficiente.
3. Selecione **Acompanhar Tab na página**, volte à página de origem e use **Tab** e **Shift+Tab**. A legenda e o destaque devem acompanhar o elemento que efetivamente recebe o foco. O acompanhamento não produz fala.
4. Use **Destacar** para conferir um elemento explícito e **Encerrar destaques** para encerrar a visualização na página.
5. Confira o quadro **Em uma frase** e os cards **O que corrigir primeiro**: o semáforo e o texto em linguagem simples resumem a inspeção. Cada linha da tabela mostra o mesmo semáforo.
6. Em **Leitura em voz alta**, **Sem áudio** vem marcado. Selecione **Percorrer a sequência de Tab**: a página deve mostrar cada parada, uma por vez, com moldura e legenda, sem fala. Pressione Escape na página ou **Parar percurso** para interromper.
7. Selecione **Com áudio** e repita o percurso: o anúncio estimado de cada parada deve ser lido por uma voz instalada no computador (no macOS, por exemplo, a voz Luciana). Com áudio, o botão **Ouvir** de uma linha lê só aquele anúncio. Se o computador não tiver voz local em português, a opção volta para **Sem áudio** e explica que vozes on-line não são usadas.
8. Use **Exportar HTML**, **Exportar CSV** e **Exportar JSON** para baixar cada formato separadamente. Use **Imprimir / salvar PDF** para salvar uma versão PDF pelo diálogo de impressão. Esses arquivos registram a conferência e não alteram as conclusões, evidências ou revisões de auditorias anteriores.
9. Exporte o que deseja guardar antes de fechar ou recarregar o relatório complementar: ele é transitório e não aparece no histórico das auditorias. Depois de dez minutos, a sessão de destaque expira e o relatório já coletado continua disponível para exportação enquanto a aba permanecer aberta.

Compare o percurso observado com os controles identificados fora da sequência de Tab. Um controle fora dessa sequência não é, por si só, uma falha: alguns componentes compostos usam as setas e outros atalhos. Confirme a operação real antes de registrar uma conclusão.

A prévia de anúncio é uma estimativa explicativa baseada nas propriedades de acessibilidade. Ela não é uma transcrição literal de NVDA, JAWS, VoiceOver ou outro leitor de tela, nem substitui um teste com tecnologia assistiva real. A ordem estimada é uma referência do estado inspecionado; conteúdo dinâmico pode mudar a sequência efetiva.

As imagens de referência deste percurso são `screenshot-tab-report.png`, `screenshot-tab-elements.png` e `screenshot-tab-highlight.png`, em `store-assets/`, todas de 1280×800 pixels. Elas mostram a execução real sobre uma página demonstrativa local; os valores de formulário visíveis na captura de destaque são fictícios.

## Limites declarados

O mapa numerado e a legenda de anúncios estimados são produzidos no modo de evidência completa quando a coleta permite; omissões são explícitas. A retenção tem prazo de 30 dias desde o primeiro registro persistido e a limpeza ocorre quando o Chrome puder executar a extensão. A opção de excluir após exportação começa desmarcada e exige os quatro downloads confirmados da mesma revisão. Arquivos baixados são preservados. A página aberta, outra URL, o lote nos três modos, as evidências individuais, o destaque quando há fonte viva, as personas e os quatro formatos de exportação fazem parte do percurso testável.

## Privacidade

Todo processamento da extensão é local. Não há backend, analytics, publicidade ou código remoto. A navegação normal da página auditada continua sujeita ao próprio site.
