# Audita Acessibilidade — beta 1.1.6

Esta versão coloca, lado a lado no texto da ficha ABNT 5.13.7, o **texto visível registrado** e o **nome acessível registrado**. Assim, é possível comparar o que aparece no controle com o nome fornecido às tecnologias assistivas, sem procurar esses valores no código. Dado indisponível não é tratado como texto vazio. A apresentação não modifica a conclusão da auditoria.

Ao abrir o painel, as simulações podem mostrar **Preparando as simulações…** por um instante. Seus botões ficam disponíveis quando a verificação inicial termina, evitando que o primeiro clique seja ignorado. O formulário de auditoria continua disponível durante essa preparação.

## Atualizar mantendo suas auditorias

1. Preserve os relatórios já baixados e feche o painel da extensão.
2. Descompacte `audita-acessibilidade-1.1.6.zip` e copie seu conteúdo para a **mesma pasta** da instalação anterior, substituindo os arquivos da extensão.
3. Abra `chrome://extensions`, clique em **Recarregar** no cartão Audita Acessibilidade e confira a versão **1.1.6**.

Não remova a extensão para atualizar: carregar outra pasta pode criar uma instalação independente. A atualização não é aplicada automaticamente ao seu Chrome. Relatórios antigos afetados pelo incidente da beta 1.1.2 não são recuperados automaticamente; preserve os arquivos exportados.

Na primeira instalação, ative **Modo do desenvolvedor**, clique em **Carregar sem compactação** e selecione a pasta que contém `manifest.json`. Não é necessário instalar bibliotecas, criar conta ou fornecer senha do macOS/chaveiro.

## Percurso de teste

1. Abra uma página HTTP/HTTPS e clique no ícone da extensão. O painel fica ao lado da página.
2. Escolha o modo e clique em **Auditar a página atual**. **●** identifica a etapa em andamento; **✓ verde** identifica etapas concluídas. Se houver aviso de conteúdo sensível, confirme ou cancele a captura.
3. No sumário, clique em um dos quatro cartões para filtrar e abra um **item ABNT** para consultar suas ocorrências.
4. Clique em **Mostrar sinais na página**. Selecione um sinal para abrir a ocorrência no painel. **Ir ao elemento** desloca a página somente quando solicitado; **Ocultar sinais na página** remove as marcações.
5. Consulte o impacto, o que foi observado, o guia de revisão, ABNT/WCAG, anúncio estimado e evidências. Quando houver uma ocorrência 5.13.7 com esses dados registrados, confira o par texto visível/nome acessível.
6. Abra o relatório. Use a exportação para baixar **HTML, PDF, CSV e JSON**. Para uma leitura mais curta, use **Imprimir resumo / salvar PDF**; o resumo informa que não inclui todas as evidências técnicas.
7. Use **Refazer auditoria** para voltar à escolha de página sem apagar o relatório anterior. A exclusão é uma ação separada, com confirmação.

Os sinais são uma ajuda visual de conferência, inspirada no fluxo apresentado nas imagens do WAVE, mas organizada pela ABNT. O limite de 64 ocorrências interativas é informado; as demais continuam no relatório. A extensão não inventa uma localização quando não consegue confirmar o elemento na página atual.

## Como interpretar

- **Falha confirmada:** o teste registrou uma barreira dentro de seu alcance. Não significa condenação jurídica automática.
- **Alerta ou revisão humana:** siga o procedimento e registre sua conclusão; uma suspeita não é apresentada como falha comprovada.
- **Resultado positivo:** refere-se ao teste realizado, não à aprovação integral do site.
- **Cobertura automática:** percentual dos testes do motor próprio com conclusão automática — atendido, não atendido ou não se aplica. Não é a porcentagem de acessibilidade do site nem de todos os requisitos ABNT/WCAG.

Exemplo hipotético: um botão mostra “Buscar”, mas seu nome acessível é “Pesquisar”. A comparação ajuda a verificar por que um comando de voz com a palavra visível pode não encontrar o botão. O nome pode conter palavras adicionais; o guia do item orienta a revisão.

## Limites importantes

A inspeção da página atual usa uma cópia temporária inativa da URL, sem rolar nem clicar na original. Alterações não salvas e estado mantido apenas na memória da página original não são observados. A inspeção silenciosa é diferente da conferência visual com sinais, ativada explicitamente depois do resultado.

O módulo de leitor e seus anúncios são estimativas explicáveis, não uma reprodução garantida de todos os leitores de tela. Frames, páginas dinâmicas, conteúdo protegido e mídias podem exigir revisão humana. Horários de captura vêm do relógio local, não de um serviço de carimbo certificado.

Uso local, sem login e sem vínculo com órgãos estatais. Os arquivos já baixados permanecem no dispositivo mesmo após excluir uma auditoria da extensão.
