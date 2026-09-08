# Audita Acessibilidade — beta 1.1.12

## Estado da versão

Beta validada no Chrome for Testing 152, com pacote conferido contra o código testado. A auditoria continua sujeita aos limites descritos abaixo; não é certificação de conformidade integral.

## Instalar ou atualizar

Na primeira instalação, descompacte o ZIP em uma pasta própria. Abra `chrome://extensions`, ative **Modo do desenvolvedor**, escolha **Carregar sem compactação** e selecione essa pasta.

Para atualizar, exporte antes os relatórios que deseja guardar. Substitua os arquivos **na mesma pasta** da instalação anterior, use **Recarregar** em `chrome://extensions` e confira a versão **1.1.12**. Não remova a extensão: isso pode apagar dados locais. Não é necessário login, biblioteca ou código-fonte do axe-core.

As auditorias locais têm retenção de **30 dias desde o primeiro registro persistido**, sem renovação ao revisar ou exportar. Na migração de dados antigos, o prazo pode ser calculado a partir do término da auditoria; dados sem data válida podem já estar vencidos. A limpeza ocorre quando o Chrome puder executar a extensão. A exclusão opcional após exportação começa desmarcada e depende dos quatro downloads confirmados da mesma revisão. Arquivos baixados não são apagados pela exclusão local.

## O que mudou

- Dimensões observadas da página são preservadas mesmo quando não é possível ler a versão do navegador. A ausência dessa versão permanece explícita; não são inventados metadados.
- Novos resumos e perguntas chamam recomendações de **recomendações**, distinguindo-as dos requisitos. Relatórios antigos continuam legíveis, sem alteração de seus textos ou evidências.
- Permanecem as correções de nova auditoria após trocar de página, ligação de sinais axe a elementos/evidências confirmados e destaque após exportação de conteúdo inalterado.

## Testar o percurso

1. Abra uma página HTTP/HTTPS e o painel lateral da extensão.
2. Escolha o modo e use **Auditar a página atual**. Confirme capturas se aparecer o aviso de privacidade.
3. Abra uma ocorrência no sumário e confira ABNT/WCAG, anúncio estimado e evidências.
4. Use **Destacar elemento** ou **Ver e destacar na página** quando o documento e o alvo puderem ser confirmados.
5. Abra o relatório completo e exporte HTML, PDF, CSV e JSON. Confira as dimensões no registro técnico e a distinção entre requisito e recomendação.
6. Volte à aba web de origem para usar o painel; selecione o achado, destaque novamente e limpe o destaque.
7. Navegue pela barra de endereço para outra página. Use **Refazer auditoria** e depois **Auditar a página atual**. O novo resultado deve corresponder à nova página, sem apagar a avaliação anterior.

O relatório de auditoria por URL pode ser somente leitura; nesse fluxo, use o painel para o destaque ao vivo. Quando a página mudar ou o alvo não puder ser confirmado, consulte as evidências registradas.

## Como interpretar

Falhas confirmadas, recomendações, suspeitas e resultados positivos são grupos distintos. Perguntas gerais ainda não avaliadas ficam no checklist e não contam como problemas. Ausência de falhas automáticas não certifica acessibilidade integral nem determina multa.

O relatório conserva os guias didáticos. Contraste aprimorado não atendido, isoladamente, não prova falha no contraste mínimo. O índice técnico considera apenas verificações aplicáveis concluídas do motor próprio; não equivale à nota do AMAWeb. Gráfico, índice e cobertura têm metodologias diferentes, explicadas no relatório.

A varredura da página atual usa uma cópia temporária inativa da URL; estado não salvo pode não ser reproduzido. Destaques são ações explícitas posteriores. Anúncios são estimativas, não reprodução garantida de qualquer leitor de tela. Evidências antigas não são reconstruídas retroativamente.
