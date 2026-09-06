# Audita Acessibilidade — beta 1.1.5

Esta atualização registra o horário em que a extensão recebeu cada captura e acrescenta explicações práticas para ordem de leitura, texto visível no nome acessível e mensagens de status. Mantém painel lateral, grupos ABNT, sinais clicáveis na página, conclusões humanas, relatório executivo e uso local sem login.

O horário é do relógio local do computador: **não é um carimbo de tempo certificado** nem uma prova do instante interno em que o navegador produziu a imagem. Relatórios antigos continuam sem esse horário quando ele não foi registrado.

## Atualizar sem remover a instalação

1. Preserve seus relatórios baixados. Feche o painel da extensão.
2. Descompacte `audita-acessibilidade-1.1.5.zip` e copie seu conteúdo para a **mesma pasta** usada na instalação anterior, substituindo os arquivos da extensão.
3. Em `chrome://extensions`, clique em **Recarregar** no cartão Audita Acessibilidade e confira a versão **1.1.5**.

Não remova a extensão para atualizar. Carregar outra pasta pode criar uma instalação separada e não mostrar suas auditorias antigas. A atualização não foi aplicada automaticamente ao seu Chrome.

Primeira instalação: em `chrome://extensions`, ative **Modo do desenvolvedor**, escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`. Não é necessário instalar bibliotecas, fazer login nem fornecer senha do macOS ou do chaveiro.

## Percurso sugerido

1. Abra uma página HTTP/HTTPS e clique no ícone da extensão. O painel lateral fica ao lado da página.
2. Escolha o modo e clique em **Auditar a página atual**. O indicador acompanha a etapa em execução; ✓ identifica etapas concluídas. A inspeção usa uma cópia temporária inativa, sem rolar ou clicar na página original. Se surgir um aviso de conteúdo sensível, confirme ou cancele a captura.
3. No sumário, clique nos cartões para filtrar. Abra um **item ABNT** para consultar suas ocorrências.
4. Use **Mostrar sinais na página** e clique em um sinal para abrir a ocorrência correspondente no painel. **Ir ao elemento** rola a página somente quando solicitado. **Ocultar sinais na página** encerra a marcação.
5. Consulte a explicação, os passos de revisão, o exemplo, ABNT/WCAG, nome acessível, anúncio estimado e evidências. Exemplos são hipotéticos, não fatos observados no site.
6. Clique em **Abrir relatório completo**. No anexo de evidências, confira **Captura recebida pela extensão (UTC)** para as imagens da nova auditoria.
7. Quando revisar um item, siga as instruções e registre nome, conclusão e nota. Consulte **Conclusões humanas registradas**. O nome é informado pela pessoa, não autenticado pela ferramenta.
8. Exporte **HTML, PDF, CSV e JSON** e confira os quatro arquivos. Para uma leitura curta, use **Imprimir resumo / salvar PDF** e escolha Salvar como PDF no diálogo. O resumo não substitui o relatório completo e suas evidências.
9. **Refazer auditoria** volta à escolha de página e modo, sem apagar o relatório anterior nem iniciar outra captura automaticamente.

## Limites que precisam continuar visíveis

- Há até 64 ocorrências interativas no painel; o relatório preserva todas. Os sinais só aparecem quando o elemento é localizado com segurança. Questões gerais e elementos não localizados são informados separadamente.
- Navegação, expiração ou reinício podem exigir uma nova auditoria para mostrar sinais. Lotes não recebem sinais na página original.
- **Cobertura automática** é a proporção de testes do motor próprio que chegaram a uma conclusão automática no inventário das páginas tentadas. Não é percentual de acessibilidade, de toda a ABNT/WCAG ou de conformidade jurídica.
- O anúncio do leitor de tela é estimado. Contexto, leitura real e atualizações dinâmicas podem exigir conferência humana; a ferramenta não certifica conformidade integral.
- Auditorias locais são retidas por até 30 dias desde o primeiro registro. Downloads não são apagados pela extensão.
- O relatório completo pode ser extenso por preservar os registros; a edição executiva é a opção resumida.

## Registros antigos da beta 1.1.2

Salvar decisões humanas na beta 1.1.2 podia deixar o hash pendente e impedir a leitura do relatório. A correção preventiva está presente desde a 1.1.3. **Registros já afetados não são recuperados automaticamente.** Preserve os dados e os arquivos já exportados; uma nova auditoria não recupera decisões antigas. Não continue salvando revisões na 1.1.2.
