# Audita Acessibilidade — beta 1.1.7

O painel organiza a conferência por **item da ABNT**, com grupos expansíveis e sinais clicáveis na página, seguindo o tipo de interação mostrado nas imagens do WAVE. Esta versão acrescenta instruções práticas para revisar dicas temporárias e espaçamentos de texto, com exemplos e exceções. Não exige conta, bibliotecas ou senha do macOS/chaveiro.

## Atualizar sem remover suas auditorias

1. Preserve os relatórios baixados e feche o painel.
2. Descompacte `audita-acessibilidade-1.1.7.zip`. Copie seu conteúdo para a **mesma pasta** usada na instalação anterior, substituindo os arquivos da extensão.
3. Abra `chrome://extensions`, clique em **Recarregar** no cartão Audita Acessibilidade e confira **1.1.7**.

Não remova a extensão para atualizar. Carregar outra pasta pode criar uma instalação independente. Na primeira instalação, ative **Modo do desenvolvedor**, use **Carregar sem compactação** e escolha a pasta que contém `manifest.json`.

## Teste o percurso completo

1. Abra uma página HTTP/HTTPS e clique no ícone da extensão para abrir o painel lateral.
2. Escolha o modo e use **Auditar a página atual**. A etapa atual recebe **●** e as concluídas recebem **✓ verde**. Se surgir um aviso de privacidade, confirme ou cancele a captura.
3. No resultado, clique nos cartões de falhas, alertas, revisão humana ou resultados positivos para filtrar. Expanda um **item ABNT** para ver suas ocorrências.
4. Use **Mostrar sinais na página**. Clique em um sinal para abrir sua ficha no painel. **Ir ao elemento** desloca a página por sua solicitação; **Ocultar sinais na página** remove as marcações.
5. Leia quem é afetado, o que foi registrado, como revisar e corrigir. Consulte ABNT/WCAG, nome acessível, anúncio estimado e evidências. Os exemplos são hipotéticos, não fatos observados no site.
6. Abra o relatório e exporte **HTML, PDF, CSV e JSON**. Para uma versão mais curta, use **Imprimir resumo / salvar PDF**; o resumo avisa que não contém todas as evidências técnicas.
7. Use **Refazer auditoria** para iniciar outra avaliação sem apagar a anterior. Excluir uma auditoria é uma ação separada, com confirmação.

Os sinais têm limite explícito de **64 ocorrências interativas**; as demais continuam no relatório. Se não conseguir confirmar a correspondência do elemento na página atual, a extensão informa a limitação e não inventa uma posição.

## O que mudou nas explicações

- **ABNT 5.1.7–5.1.9:** como encontrar uma dica, conferir sua permanência e verificar se pode ser dispensada sem mover o ponteiro ou foco. Esc aparece como exemplo, não como única solução obrigatória. As exceções do item são explicadas.
- **ABNT 5.12.1–5.12.4:** como distinguir espaçamento de linhas, parágrafos, letras e palavras, com proporções e exemplos calculados. A orientação pede apoio técnico quando a medição não puder ser confirmada; não manda adivinhar medidas pela captura.

Exemplo hipotético: uma dica cobre um parágrafo. A revisão confere se é possível dispensá-la e continuar no mesmo ponto, e se alguma exceção normativa se aplica. Uma captura ajuda a localizar o conteúdo, mas não prova, sozinha, como a dica se comporta.

As demais orientações por família continuam disponíveis e podem receber aprofundamentos futuros. Esta versão não promete um procedimento individual exaustivo para cada um dos 146 itens.

## Interpretação e limites

**Cobertura automática** mede a proporção dos testes do motor próprio com conclusão automática — atendido, não atendido ou não aplicável. Não é a porcentagem de acessibilidade do site nem de todos os critérios ABNT/WCAG.

Uma falha registrada refere-se ao alcance do teste, não a uma condenação jurídica automática. Alertas e verificações humanas precisam de conclusão fundamentada; resultados positivos não aprovam o site inteiro.

A auditoria silenciosa usa uma cópia temporária inativa da URL: não rola nem clica na original, mas também não observa alterações não salvas ou estado mantido apenas na memória da página original. A conferência visual com sinais é uma ação explícita posterior.

Personas e leitor são simulações. Anúncios são estimados, não falas garantidas de todos os leitores de tela. Frames, mídia, conteúdo protegido e páginas dinâmicas podem exigir revisão humana. Horários provêm do relógio local, não de um serviço certificado.

A atualização não recupera automaticamente relatórios antigos afetados pelo incidente da beta 1.1.2; preserve os arquivos já exportados. O uso é local, sem login e sem vínculo com órgãos estatais.
