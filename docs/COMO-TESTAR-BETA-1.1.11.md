# Audita Acessibilidade — beta 1.1.11

## Atualizar sem perder auditorias

Exporte os relatórios que deseja guardar. Descompacte o ZIP e substitua os arquivos **na mesma pasta** usada pela extensão anterior. Em `chrome://extensions`, clique em **Recarregar** e confira a versão **1.1.11**. Não remova a extensão: isso pode apagar auditorias locais. Não precisa de login, bibliotecas ou código-fonte do axe-core.

As auditorias locais têm retenção de **30 dias desde o primeiro registro persistido**, sem renovação ao revisar ou exportar. A limpeza ocorre quando o Chrome puder executar a extensão. A exclusão opcional após exportação começa desmarcada e depende dos quatro downloads confirmados da mesma revisão. Guarde os arquivos baixados: a extensão não os apaga ao excluir a auditoria local.

## O que mudou

- Sinais suplementares do axe-core podem ser ligados ao elemento, ao trecho e ao anúncio estimado, inclusive abaixo de componentes personalizados e em árvores profundas.
- Se autorizado pelo modo escolhido, a evidência inclui a miniatura do elemento. No modo sem imagens, não se produz captura.
- Localizar um elemento não transforma uma suspeita em infração: aplicabilidade e conclusão normativa permanecem explícitas.
- Exportar conteúdo inalterado não invalida mais o vínculo do destaque. Documento alterado, evidência divergente ou vínculo vencido continuam bloqueados.

## Testar o percurso

1. Abra uma página HTTP/HTTPS e o painel lateral da extensão.
2. Escolha o modo e use **Auditar a página atual**. Confirme as capturas se aparecer o aviso de privacidade.
3. No sumário, abra uma ocorrência e confira o item ABNT/WCAG, o anúncio estimado e as evidências.
4. Use **Destacar elemento** ou **Ver e destacar na página**. O botão só fica disponível quando o documento e o elemento podem ser confirmados.
5. Abra o relatório completo e exporte HTML, PDF, CSV e JSON.
6. Volte à aba web de origem para usar o painel; selecione o achado, destaque novamente e limpe o destaque.
7. Navegue pela barra de endereço para outra página. No painel, use **Refazer auditoria** e então **Auditar a página atual**. O novo resultado deve corresponder à nova página, sem apagar a avaliação anterior.

O relatório de auditoria por URL pode ser somente leitura; nesse fluxo, use o painel para o destaque ao vivo. Quando a página mudar ou o alvo não puder ser confirmado, consulte as evidências registradas.

## Como interpretar

Falhas confirmadas, recomendações, suspeitas e resultados positivos são grupos distintos. Perguntas gerais ainda não avaliadas ficam no checklist separado e não contam como problemas. Ausência de falhas automáticas não certifica acessibilidade integral nem autoriza multa automática.

O relatório conserva as explicações didáticas e diferencia requisito de recomendação. Contraste aprimorado não atendido, isoladamente, não prova falha no mínimo. O índice técnico é calculado apenas sobre verificações aplicáveis concluídas do motor próprio; não é a nota do AMAWeb. Gráfico, índice e cobertura têm metodologias diferentes, explicadas no relatório.

A varredura da página atual usa uma cópia temporária inativa da URL. Estado não salvo da aba original pode não ser reproduzido. O destaque é uma ação explícita posterior. Anúncios são estimativas; condições que exigem julgamento humano continuam identificadas. Nenhuma auditoria antiga tem suas evidências reconstruídas retroativamente pela atualização.
