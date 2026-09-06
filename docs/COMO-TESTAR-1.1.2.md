# Audita Acessibilidade — beta 1.1.2

Esta beta reúne o painel de resultados compacto, os sinais clicáveis na página e uma opção de PDF executivo. A ABNT NBR 17225:2025 organiza as ocorrências; WCAG complementa a referência. Uso local, sem login ou instalação de bibliotecas.

## Atualizar preservando os dados

1. Exporte relatórios que queira conservar e feche o painel da extensão.
2. Descompacte `audita-acessibilidade-1.1.2.zip`.
3. Copie o conteúdo da nova pasta para a **mesma pasta** usada anteriormente em “Carregar sem compactação”, substituindo os arquivos da extensão.
4. Abra `chrome://extensions` e clique em **Recarregar** no cartão Audita Acessibilidade. Confira a versão **1.1.2**.

Usar a mesma pasta preserva o identificador da instalação e seu armazenamento local. Carregar outra pasta pode criar uma instalação com dados separados. Não remova a instalação anterior para atualizar.

Para instalar pela primeira vez: em `chrome://extensions`, ative **Modo do desenvolvedor**, escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`.

## Percurso de teste

1. Abra uma página HTTP/HTTPS, clique no ícone da extensão e escolha o modo de evidência.
2. Clique em **Auditar a página atual**. O indicador acompanha a etapa atual; etapas concluídas recebem ✓. A inspeção usa uma cópia temporária inativa, sem percorrer visualmente a página original.
3. Se houver aviso de conteúdo sensível, decida se deseja confirmar ou cancelar a captura.
4. No resultado, confira os quatro cartões de classificação. Clique em um cartão para filtrar as ocorrências e expanda um grupo ABNT.
5. Use **Mostrar sinais na página**. Clique num sinal para abrir sua ocorrência no painel. A seleção no painel também realça o elemento; **Ir ao elemento** rola a página somente quando solicitado.
6. Consulte explicação, item ABNT/WCAG, anúncio estimado e evidências. Use **Abrir relatório completo**.
7. No relatório, **Imprimir resumo / salvar PDF** produz a apresentação executiva. Escolha **Salvar como PDF** no diálogo do navegador. Confira totais, limitações e matriz ABNT.
8. Para conservar as fichas e evidências individuais, use a exportação completa de **HTML, PDF, CSV e JSON**. Confira os quatro arquivos. O resumo não substitui esses registros.
9. **Refazer auditoria** retorna à escolha de página e modo; não apaga o relatório anterior nem começa outra captura automaticamente.

## O que mudou nesta beta

- Resumo e grupos ABNT ganham prioridade; ajuda e filtros secundários ficam recolhidos para reduzir a rolagem inicial.
- Cartões adaptáveis a painéis estreitos, com cores e textos por classificação.
- Resumo para PDF disponível no relatório da extensão e no HTML baixado. Identifica a auditoria/revisão, mantém a matriz completa e omite fichas/capturas somente nessa impressão explícita.
- Impressão normal e exportação completa continuam preservando todos os registros.

## Limites importantes

- Até 64 ocorrências interativas no painel; o relatório mantém todas. Somente elementos com associação segura recebem sinais. Elementos não localizados e questões gerais são informados separadamente.
- Sinais são temporários; navegação, expiração ou reinício podem exigir nova auditoria. Lotes não recebem sinais na página original.
- A auditoria observa estados das páginas, não certifica o serviço inteiro. Itens marcados para revisão humana continuam exigindo análise.
- Anúncios são estimativas; podem diferir conforme leitor de telas e configuração.
- A indicação de cobertura descreve a cobertura das verificações segundo o denominador apresentado, não uma nota jurídica de conformidade.
- Auditorias locais são retidas por até 30 dias desde o primeiro registro. Downloads exportados não são apagados pela extensão.
- O PDF técnico pode ser longo. O resumo facilita leitura, mas as evidências individuais precisam ser consultadas no relatório completo.

Não é necessário fornecer senha do macOS ou de chaveiro para usar estes recursos. Nenhuma instalação pessoal do Chrome é atualizada automaticamente por este pacote.
