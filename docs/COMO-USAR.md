# Audita Acessibilidade — instalar e usar

Guia da versão 1.1.50. A disponibilidade do pacote depende do registro de entrega; este guia não constitui publicação na loja.

## Instalar ou atualizar, sem login

1. Descompacte o ZIP entregue em uma pasta permanente.
2. No Chrome, abra `chrome://extensions` e ative **Modo do desenvolvedor**.
3. Escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`.
4. Confira a versão **1.1.50** e fixe Audita Acessibilidade na barra, se desejar.

Não é preciso instalar bibliotecas, Node.js, axe-core ou criar conta. O motor já está incluído. O Modo do desenvolvedor é necessário para esta distribuição local; não implica programação pelo usuário.

Para atualizar uma instalação existente, exporte os relatórios que deseja guardar, substitua os arquivos na **mesma pasta** e pressione **Recarregar** em `chrome://extensions`. Não remova a extensão para atualizar: a remoção pode apagar seus dados locais. Mantenha os arquivos exportados fora da pasta substituída.

## Fazer a primeira avaliação

1. Abra uma página HTTP/HTTPS e clique no ícone da extensão. O painel lateral ficará ao lado da página.
2. Escolha **Evidência completa**, **Somente elementos** ou **Sem imagens**. Oculte dados pessoais antes de permitir capturas.
3. Use **Auditar a página atual**. O painel mostra o progresso. Os modos com foto **sempre concluem** sem pedir confirmação: não há pausa por conteúdo sensível (quem audita não usa senha nem dados sensíveis). Se a auditoria não puder prosseguir no modo escolhido, o painel **explica** o que aconteceu e sugere refazer no modo sem pixels; ele não volta ao início em silêncio.
4. Consulte o sumário. Clique em um cartão para filtrar e expanda um item ABNT para entender os resultados e as orientações.
5. Use **Mostrar sinais na página** e **Destacar elemento**, quando disponíveis, para localizar um achado. A moldura se refere ao elemento confirmado; se a página mudou ou o alvo não puder ser localizado, consulte a captura histórica.
6. Use **Abrir relatório completo**. A exportação entrega **HTML, PDF, CSV e JSON**. O HTML oferece detalhes expansíveis; o PDF reúne orientações essenciais e evidências sem repetir o dossiê de cada ocorrência. **Imprimir resumo / salvar PDF** gera uma edição executiva separada, que não substitui o relatório completo.
7. Para uma nova avaliação, use **Refazer auditoria** e confirme a página e o modo. O relatório anterior não é apagado por essa ação.

A inspeção da página atual acontece na própria página, somente para leitura: a extensão não cria aba, não navega, não rola e não move o foco, e a página permanece como você a deixou. Como o documento observado é o que está aberto, o estado atual — inclusive o que ainda não foi salvo — faz parte da avaliação. Os sinais são uma ação posterior solicitada por você, não parte da varredura invisível.

## Conferir a leitura por Tab, com ou sem áudio

1. Abra a página que deseja conferir e clique no ícone da extensão.
2. No painel, escolha **Conferir leitura por Tab**. Não é necessário iniciar uma auditoria nem permitir imagens.
3. O relatório abre em outra aba. Consulte a **Sequência estimada de Tab**: cada linha mostra o elemento,
   nome acessível, função, descrição, estados e anúncio estimado. Confira se esse anúncio explica corretamente
   o controle que a pessoa vai usar.
4. Leia o quadro **Em uma frase**: um semáforo resume a leitura (vermelho: o que confunde ou bloqueia;
   âmbar: o que merece conferência; verde: o que parece bem) e os cards **O que corrigir primeiro** mostram,
   em linguagem simples, o que um leitor de tela anunciaria, o que corrigir e um exemplo. Cada linha da tabela
   traz o mesmo semáforo. É uma estimativa para orientar a revisão, não uma conclusão da auditoria.
5. Escolha a **Leitura em voz alta**. **Sem áudio** é o padrão. **Com áudio** lê o anúncio estimado com uma
   voz instalada no computador; vozes on-line não são usadas, porque enviariam o texto da página a um serviço
   externo. Sem voz local em português, a opção continua sem áudio e explica o motivo.
6. Use **Percorrer a sequência de Tab**: a página mostra cada parada, uma por vez, com moldura e legenda; com
   áudio, cada anúncio é lido. **Parar percurso**, ou Escape na página, interrompem. Com áudio, o botão
   **Ouvir** de cada linha lê só aquele anúncio.
7. Use **Destacar** para localizar uma linha na página. A ação pode rolar até o elemento, mas não o aciona.
8. Use **Acompanhar Tab na página** e pressione Tab ou Shift+Tab na página original. A legenda e a moldura
   acompanham o foco. **Encerrar destaques** ou Escape removem essa visualização.
9. Confira **Fora da sequência de Tab**. Pode haver botões feitos sem suporte a teclado, controles com
   tabindex negativo ou opções de um grupo percorridas com setas. O relatório explica o motivo observado;
   verifique o contexto antes de concluir que há um problema.
10. Confira **Conteúdo estrutural** e **Elementos ocultos**. Títulos, textos e imagens normalmente são lidos por
   comandos diferentes de Tab. Elementos ocultos podem estar intencionalmente indisponíveis naquele estado.
11. Use **Atualizar inspeção** depois de mudar a página. Uma navegação para outro documento exige abrir nova
   conferência pelo painel. A sessão de destaques expira em dez minutos.
12. Use **Exportar HTML**, **Exportar CSV**, **Exportar JSON** ou **Imprimir / salvar PDF** para guardar todas as
   categorias. O HTML começa pelo quadro **Em uma frase** e pelos cards de correção; o CSV traz o semáforo e o
   resumo em linguagem simples de cada linha. Filtros de tela não removem itens dos arquivos. Exporte antes de fechar ou recarregar a aba.

O relatório complementar identifica seu próprio horário de inspeção e não modifica evidências nem conclusões
da auditoria ABNT/WCAG. O inventário é limitado a 1.000 elementos em até 5.000 nós; frames e Shadow DOM fechado
podem conter conteúdo não inspecionado. Limites e omissões são mostrados. Os valores digitados são omitidos;
outros textos podem conter dados pessoais. Revise os arquivos antes de compartilhar.

## Outros recursos

- **Outra URL:** informe o endereço e escolha o modo de evidência. O endereço é aberto em uma aba temporária inativa, removida ao final.
- **Lote de páginas:** informe de 2 a 20 URLs, uma por linha. O resultado é consolidado; não há descoberta ilimitada de links. Cada página é aberta em aba temporária inativa.
- **Personas:** leitor de tela com prévia falada/legenda, acromatopsia e navegação por teclado. São apoios de teste, não substitutos da experiência real de uma pessoa com deficiência. Use os controles de encerramento e Escape quando disponível.
- **Revisão guiada (revisão humana):** no relatório, a seção “Revisão humana guiada” reúne as perguntas que dependem do seu olhar, em linguagem simples e agrupadas pelo que você vê (página inteira, imagens, links, botões, formulários, teclado, cores, texto, organização, mídia e tempo). Os requisitos (obrigatórios) vêm primeiro; as recomendações ficam numa segunda parte, opcional. Veja a seção abaixo.

## Revisão guiada e quadro de constatações

A extensão só conclui sozinha o que consegue medir. O restante é perguntado a você, sem exigir conhecimento de HTML:

1. Abra o relatório completo e informe seu nome em **Nome da pessoa avaliadora**.
2. Em **Revisão guiada**, abra um cartão. Cada cartão mostra o elemento (captura, nome lido pela extensão e, quando houver, uma **pista** do que foi medido) e o botão **Mostrar na página**, que destaca o elemento na aba auditada.
3. Leia a pergunta e, se precisar, **Como verificar**. Algumas perguntas têm ajudas na própria página: **Ampliar para 200%**, **Ver como celular (320 px)**, **Aplicar espaçamento de leitura** e **Voltar ao normal**. Elas só mudam a apresentação na aba auditada e são desfeitas com **Voltar ao normal**.
4. Responda **Sim**, **Não**, **Não consegui verificar** ou **Não existe nesta página**. Na dúvida, use **Não consegui verificar**: ela não aprova nem reprova. Ao responder **Não**, descreva o que constatou; um rascunho editável já vem preenchido.
5. Nas imagens, uma única pergunta (“Para que serve esta imagem?”) resolve os itens 5.2.1 a 5.2.6, combinando sua resposta com o texto alternativo que a extensão leu.
6. Errou? Use **Rever resposta**. A resposta anterior continua registrada no histórico.

O **Quadro de constatações** lista os 96 requisitos da ABNT NBR 17225:2025 na situação observada: não atendidos, atendidos, não aplicáveis e sem conclusão. Cada requisito não atendido traz o elemento, a constatação (automática ou humana, com nome e hora) e um parágrafo pronto para citação, com a evidência. Use **Copiar texto para citação** e confira o texto antes de usá-lo. O quadro também aparece no HTML e no PDF exportados.

## Entender os resultados

Falhas detectadas, recomendações/alertas e suspeitas concretas são distintos. O **checklist geral ainda não avaliado** não conta como problema da página. Resultados positivos valem apenas para o que foi observado.

**Cobertura automática** mede conclusões automáticas do motor próprio sobre seu inventário. O **índice técnico** considera os testes aplicáveis concluídos desse motor; não inclui todas as revisões ou regras axe. As fórmulas estão explicadas no relatório. Nenhum deles representa certificação, nota oficial da ABNT ou determinação de multa.

Requisitos e recomendações ABNT são identificados separadamente. Contraste ampliado abaixo da recomendação não demonstra, sozinho, falha no contraste mínimo. Anúncios de leitor de tela são estimativas e podem variar entre programas e configurações. Casos não observáveis continuam sujeitos a revisão humana.

## Guardar e proteger os dados

O processamento é local, sem servidor de auditoria ou login. A navegação ainda acessa o site escolhido. Relatórios podem conter dados visíveis nas capturas; compartilhe-os com cuidado.

Auditorias locais têm retenção de **30 dias desde o primeiro registro**, sem renovação ao revisar ou exportar. A limpeza depende da execução do Chrome. Na migração de registros antigos, o prazo pode derivar do término da auditoria; registros sem data válida podem já estar vencidos. A exclusão opcional após exportação depende dos quatro downloads confirmados e não apaga arquivos baixados.

Relatórios antigos preservam sua versão de origem, mesmo quando incorreta ou desconhecida. A atualização não reconstrói evidências nem recupera automaticamente registros corrompidos da antiga beta 1.1.2. Exporte antes de atualizar; preserve os arquivos já disponíveis.
