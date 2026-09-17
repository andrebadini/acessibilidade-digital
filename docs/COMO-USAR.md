# Audita Acessibilidade — instalar e usar

Guia da versão 1.1.47. A disponibilidade do pacote depende do registro de entrega; este guia não constitui publicação na loja.

## Instalar ou atualizar, sem login

1. Descompacte o ZIP entregue em uma pasta permanente.
2. No Chrome, abra `chrome://extensions` e ative **Modo do desenvolvedor**.
3. Escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`.
4. Confira a versão **1.1.47** e fixe Audita Acessibilidade na barra, se desejar.

Não é preciso instalar bibliotecas, Node.js, axe-core ou criar conta. O motor já está incluído. O Modo do desenvolvedor é necessário para esta distribuição local; não implica programação pelo usuário.

Para atualizar uma instalação existente, exporte os relatórios que deseja guardar, substitua os arquivos na **mesma pasta** e pressione **Recarregar** em `chrome://extensions`. Não remova a extensão para atualizar: a remoção pode apagar seus dados locais. Mantenha os arquivos exportados fora da pasta substituída.

## Fazer a primeira avaliação

1. Abra uma página HTTP/HTTPS e clique no ícone da extensão. O painel lateral ficará ao lado da página.
2. Escolha **Evidência completa**, **Somente elementos** ou **Sem imagens**. Oculte dados pessoais antes de permitir capturas.
3. Use **Auditar a página atual**. O painel mostra o progresso. Quando houver aviso de conteúdo potencialmente sensível, confirme ou cancele; sem confirmação, a captura não prossegue. Se a auditoria não puder prosseguir no modo escolhido, o painel **explica** o que aconteceu e sugere refazer no modo sem pixels; ele não volta ao início em silêncio.
4. Consulte o sumário. Clique em um cartão para filtrar e expanda um item ABNT para entender os resultados e as orientações.
5. Use **Mostrar sinais na página** e **Destacar elemento**, quando disponíveis, para localizar um achado. A moldura se refere ao elemento confirmado; se a página mudou ou o alvo não puder ser localizado, consulte a captura histórica.
6. Use **Abrir relatório completo**. A exportação entrega **HTML, PDF, CSV e JSON**. O HTML oferece detalhes expansíveis; o PDF reúne orientações essenciais e evidências sem repetir o dossiê de cada ocorrência. **Imprimir resumo / salvar PDF** gera uma edição executiva separada, que não substitui o relatório completo.
7. Para uma nova avaliação, use **Refazer auditoria** e confirme a página e o modo. O relatório anterior não é apagado por essa ação.

A inspeção da página atual acontece na própria página, somente para leitura: a extensão não cria aba, não navega, não rola e não move o foco, e a página permanece como você a deixou. Como o documento observado é o que está aberto, o estado atual — inclusive o que ainda não foi salvo — faz parte da avaliação. Os sinais são uma ação posterior solicitada por você, não parte da varredura invisível.

## Outros recursos

- **Outra URL:** informe o endereço e escolha o modo de evidência. O endereço é aberto em uma aba temporária inativa, removida ao final.
- **Lote de páginas:** informe de 2 a 20 URLs, uma por linha. O resultado é consolidado; não há descoberta ilimitada de links. Cada página é aberta em aba temporária inativa e cada página sensível exige confirmação própria.
- **Personas:** leitor de tela com prévia falada/legenda, acromatopsia e navegação por teclado. São apoios de teste, não substitutos da experiência real de uma pessoa com deficiência. Use os controles de encerramento e Escape quando disponível.
- **Revisão humana:** leia o guia e registre conclusão, nome, data e nota. Não transforme dúvida em falha confirmada. O histórico acompanha a revisão exportada.

## Entender os resultados

Falhas detectadas, recomendações/alertas e suspeitas concretas são distintos. O **checklist geral ainda não avaliado** não conta como problema da página. Resultados positivos valem apenas para o que foi observado.

**Cobertura automática** mede conclusões automáticas do motor próprio sobre seu inventário. O **índice técnico** considera os testes aplicáveis concluídos desse motor; não inclui todas as revisões ou regras axe. As fórmulas estão explicadas no relatório. Nenhum deles representa certificação, nota oficial da ABNT ou determinação de multa.

Requisitos e recomendações ABNT são identificados separadamente. Contraste ampliado abaixo da recomendação não demonstra, sozinho, falha no contraste mínimo. Anúncios de leitor de tela são estimativas e podem variar entre programas e configurações. Casos não observáveis continuam sujeitos a revisão humana.

## Guardar e proteger os dados

O processamento é local, sem servidor de auditoria ou login. A navegação ainda acessa o site escolhido. Relatórios podem conter dados visíveis nas capturas; compartilhe-os com cuidado.

Auditorias locais têm retenção de **30 dias desde o primeiro registro**, sem renovação ao revisar ou exportar. A limpeza depende da execução do Chrome. Na migração de registros antigos, o prazo pode derivar do término da auditoria; registros sem data válida podem já estar vencidos. A exclusão opcional após exportação depende dos quatro downloads confirmados e não apaga arquivos baixados.

Relatórios antigos preservam sua versão de origem, mesmo quando incorreta ou desconhecida. A atualização não reconstrói evidências nem recupera automaticamente registros corrompidos da antiga beta 1.1.2. Exporte antes de atualizar; preserve os arquivos já disponíveis.
