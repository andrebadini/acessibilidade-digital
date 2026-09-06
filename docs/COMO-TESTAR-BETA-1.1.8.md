# Audita Acessibilidade — beta 1.1.8

Esta versão corrige a multiplicação de revisões genéricas e falsos positivos reproduzidos na página do Google. Mantém as orientações didáticas, os grupos ABNT, os filtros e os sinais na página. Acrescenta gráfico de distribuição, índice técnico com fórmula explícita e PDF de leitura sem repetir um dossiê completo por ocorrência.

## Atualizar preservando o histórico

1. Preserve seus arquivos exportados e feche o painel.
2. Descompacte `audita-acessibilidade-1.1.8.zip` e copie o conteúdo para a **mesma pasta** da instalação anterior, substituindo os arquivos da extensão.
3. Abra `chrome://extensions`, clique em **Recarregar** no cartão Audita Acessibilidade e confira **1.1.8**.
4. Abra o painel e use **Refazer auditoria**. Os resultados antigos não são recalculados automaticamente.

Não remova a extensão para atualizar: isso pode apagar auditorias locais. Na primeira instalação, ative **Modo do desenvolvedor**, escolha **Carregar sem compactação** e selecione a pasta que contém `manifest.json`. Não é necessário login, instalar bibliotecas ou informar senha do macOS.

## Conferir a correção

1. Abra `https://www.google.com.br/index.html`, abra o painel e escolha **Auditar a página atual**. Escolha o modo de evidências e, se houver pausa de privacidade, confirme ou cancele.
2. Veja o sumário. **Revisão humana não significa erro confirmado.** Uma pergunta geral aplicável à página não deve aparecer uma vez por botão ou campo.
3. Expanda um grupo ABNT e uma ocorrência. As instruções continuam explicando o impacto e como verificar, com exemplos. Alvos concretos continuam disponíveis para **Mostrar sinais na página**; perguntas sobre a página inteira não ganham posições fictícias.
4. Abra o relatório completo. O gráfico mostra verificações agrupadas; a nota informa seu denominador e as exclusões. Abra **Como o gráfico e o índice são calculados**.
5. Use **Exportar HTML, PDF, CSV e JSON**. O PDF apresenta a edição de leitura, com revisões agrupadas, orientações essenciais, evidências e inventário. O HTML conserva explicações completas e detalhes expansíveis; o JSON preserva todos os registros. Para uma edição ainda menor, use **Imprimir resumo / salvar PDF**.

## Entender os números

- **Índice técnico automático:** `10 × testes atendidos ÷ (atendidos + falhos)`, uma vez por regra e página do motor próprio, antes de decisões humanas. Exclui não aplicáveis, inconclusivos, não testados e motores suplementares. Sem testes concluídos aplicáveis, não há nota.
- **Gráfico:** distribuição das verificações consolidadas entre falhas, alertas, revisões e resultados positivos. Não representa quantidade de elementos da página. Seu conjunto inclui resultados suplementares e pode diferir do denominador da nota.
- **Cobertura automática:** proporção do inventário do motor próprio que teve conclusão automática, incluindo não aplicáveis. Não é a porcentagem de acessibilidade do site.

Uma nota 10 não certifica acessibilidade: pode coexistir com pendências relevantes. Não é a nota do AMAWeb e não permite comparar diretamente motores ou versões diferentes. Google pode entregar estados distintos conforme região, idioma, consentimento e momento da visita; não há uma contagem fixa prometida.

O roteiro ABNT contém perguntas que dependem de contexto e juízo humano. Elas permanecem pendentes em vez de serem silenciosamente aprovadas. A avaliação cobre o estado observado, não todo o site. Anúncios do leitor são estimados; datas provêm do relógio local, não de um serviço certificado.

Consulte o [diagnóstico e verificações](qa/2026-09-06-google-counts.md). Uso local, sem login e sem vínculo com órgãos estatais.
