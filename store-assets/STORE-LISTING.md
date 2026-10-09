# Conteúdo de distribuição — Audita Acessibilidade 1.1.56

Material local de referência; não representa publicação ou atualização de uma página de loja.

## Nome

Audita Acessibilidade

## Resumo

Audita páginas web conforme WCAG 2.2 e ABNT NBR 17225, com evidências, revisão humana e relatórios locais.

## Descrição detalhada

Audita Acessibilidade ajuda a examinar a acessibilidade de uma página web de forma automatizada e assistida. A extensão relaciona resultados à WCAG 2.2 e à ABNT NBR 17225:2025 e reúne as evidências necessárias para uma revisão técnica rastreável.

Principais recursos:

- auditoria da página HTTP ou HTTPS aberta no Chrome: a coleta lê a própria página original, sem criar aba, navegar, rolar ou mover o foco;
- auditoria de outra URL informada pelo usuário nos três modos de evidência, sem login e sem servidor externo;
- auditoria local de 2 a 20 URLs em lote nos três modos, com progresso por página e relatório consolidado, sempre em abas temporárias inativas;
- três modos de evidência: Evidência completa, Somente elementos e Sem imagens;
- verificações automatizadas e indicação transparente dos itens que exigem julgamento humano;
- associação de ocorrências aos itens da ABNT e aos critérios WCAG correspondentes;
- captura da página inteira e de elementos relacionados às ocorrências, conforme o modo escolhido;
- moldura vermelha para não conformidades e âmbar tracejado para revisão pendente, sem alterar os PNGs originais;
- trecho HTML sanitizado, seletor e propriedades de acessibilidade;
- cálculo do nome acessível e prévia explicativa do anúncio esperado por tecnologia assistiva;
- relatório complementar de leitura por Tab, independente da auditoria e sem imagens, com sequência estimada de foco, controles fora de Tab, conteúdo estrutural e itens ocultos;
- acompanhamento de Tab e Shift+Tab na página, com legenda e destaque do elemento observado, nome, função, estados e prévia explicativa;
- resumo em linguagem simples com semáforo, cards do que corrigir primeiro e exemplos de texto, para quem não é especialista;
- percurso guiado pela sequência de Tab, com ou sem áudio: sem áudio é o padrão; com áudio, o anúncio estimado é lido por uma voz instalada no computador, sem vozes on-line;
- exportação do relatório complementar em HTML, CSV e JSON, além de impressão para salvar PDF;
- revisão humana guiada em linguagem simples, sem exigir conhecimento de HTML: cada pendência vira uma pergunta sobre o que se vê na página (Sim, Não, Não consegui verificar ou Não existe nesta página), com o elemento descrito em palavras, destaque na página e ajudas opcionais de ampliação a 200%, largura de celular e espaçamento de leitura, desfeitas com um clique;
- registro da pessoa avaliadora, data e hora locais, nota e histórico das respostas revistas;
- quadro de constatações com a situação de cada requisito da ABNT NBR 17225:2025 (não atendido, atendido, não aplicável ou sem conclusão) e frases prontas para citação em relatórios, com página, elemento, data e evidência;
- relatórios locais em HTML, PDF, CSV e JSON-LD/EARL;
- painel lateral persistente, destaque vivo do elemento e relatório completo em aba própria;
- progresso real por etapa, com indicador da fase atual e confirmação visual das etapas concluídas;
- personas de leitor de tela, acromatopsia e navegação por teclado;
- processamento local, sem envio do conteúdo auditado para um servidor do desenvolvedor.

Importante: a auditoria representa somente a página e o estado observados. Itens contextuais, fluxos completos e equivalência de conteúdo podem exigir análise humana. O relatório não constitui certificação do site inteiro.

A conferência de teclado é uma ação separada, iniciada pelo usuário, e não altera as conclusões ou revisões de auditorias anteriores. A prévia de anúncio é uma estimativa a partir das propriedades de acessibilidade e não reproduz a fala literal de um leitor de tela. Controles fora da sequência de Tab podem usar outras formas válidas de navegação; a indicação exige revisão humana. A sequência estimada descreve o estado inspecionado e pode mudar em páginas dinâmicas.

Nos modos com imagens, a captura de regiões fora da área visível pode redimensionar a página por um instante. A geometria final é restaurada, mas páginas que reagem ao redimensionamento podem alterar seu conteúdo; essa limitação fica registrada no relatório.

Antes de auditar, oculte dados pessoais ou sigilosos visíveis. As capturas são incorporadas aos relatórios baixados.

Audita Acessibilidade é uma ferramenta independente, sem vínculo institucional.

O mapa numerado e a legenda de anúncios estimados são incluídos no modo de evidência completa quando a coleta permite, com omissões explícitas. A retenção local das auditorias tem prazo de 30 dias desde o primeiro registro persistido; a limpeza depende de o Chrome executar a extensão. A exclusão opcional após exportação exige a confirmação dos quatro downloads da mesma revisão e não apaga arquivos baixados. O relatório complementar de Tab é transitório: exporte o que deseja conservar antes de fechar ou recarregar a aba. Consulte a política de privacidade para os limites da limpeza recuperável.

## Finalidade única

Auditar e conferir localmente a acessibilidade da página indicada pelo usuário, coletar evidências técnicas e gerar relatórios para revisão humana.

## Categoria

Acessibilidade.

## Idioma principal

Português (Brasil).

## Justificativas das permissões

### debugger

Necessária para usar localmente o Chrome DevTools Protocol na página escolhida: coletar DOMSnapshot e árvore de acessibilidade, ler métricas, capturar evidências autorizadas e gerar o PDF. A extensão desconecta o protocolo ao terminar.

### downloads

Necessária para salvar, mediante ação do usuário, os relatórios HTML, PDF, CSV e JSON-LD/EARL no dispositivo.

### scripting

Necessária para executar os coletores e testes dinâmicos incluídos no próprio pacote, dentro da página que o usuário solicitou auditar. Também aplica e remove, somente quando o usuário pede a ajuda “Aplicar espaçamento de leitura” na revisão guiada, uma folha de estilo local que aumenta o espaçamento do texto na própria página auditada. Não há código remoto.

### storage

Necessária para manter localmente o andamento da auditoria, o modelo de resultados e as decisões de revisão, inclusive após a suspensão do service worker.

### tabs

Necessária para identificar a página ativa escolhida e abrir as páginas locais de relatório e impressão, sem substituir a página auditada. Também aplica o zoom à aba auditada, somente quando o usuário pede “Ampliar para 200%” ou “Ver como celular (320 px)” na revisão guiada, e restaura o zoom anterior em “Voltar ao normal”.

### sidePanel

Necessária para manter a interface de auditoria ao lado da página examinada.

### alarms

Necessária para agendar a expiração e a limpeza de estados temporários, como consentimentos de captura, personas e destaques.

### contextMenus

Necessária para oferecer um atalho opcional de auditoria pelo menu de contexto.

### Acesso aos hosts HTTP e HTTPS

Necessário para inspecionar localmente a página HTTP ou HTTPS que o usuário escolheu auditar.

## Código remoto

Não. Todo JavaScript executável está incluído no pacote Manifest V3. A política de segurança bloqueia execução remota.

## Declaração de dados

A extensão trata localmente conteúdo do site auditado, incluindo URL, DOM, árvore de acessibilidade, estilos necessários às regras, seletores, trechos sanitizados, capturas e URLs de mídia sanitizadas. Também trata o nome e as decisões que o avaliador informar na revisão.

Categorias a declarar na Chrome Web Store: **Histórico da Web**, **Conteúdo do site**, **Informações de identificação pessoal** (nome do avaliador, quando informado) e **Atividade do usuário**. Esta última se limita à observação transitória do foco e de eventos de navegação, como Tab, Shift+Tab e rolagem, durante o acompanhamento explicitamente ativado pelo usuário, sem registrar texto digitado ou histórico de teclas. O tratamento local também deve ser divulgado conforme a política oficial da loja.

Os dados não são transmitidos ao desenvolvedor, vendidos, usados em publicidade ou usados fora da finalidade única. Relatórios só deixam o armazenamento local quando o próprio usuário os compartilha.

## Público e regiões

- Visibilidade: pública.
- Regiões: todas as regiões, preservando a distribuição do item existente na loja.
- Público principal: qualquer pessoa que queira avaliar a acessibilidade de uma página — desenvolvimento, design, conteúdo, qualidade, pesquisa, ensino, órgãos de controle e cidadania em geral.

## Política de privacidade

Endereço público (GitHub Pages): **https://andrebadini.github.io/audita-acessibilidade-privacidade/**. Antes do envio, confira que o HTML publicado corresponde à política local vigente em `store-assets/privacy.html` e `docs/POLITICA-DE-PRIVACIDADE.md`. É esse endereço que vai no campo do console.

## Imagens para envio

As três capturas atuais são PNG RGB sem alfa, de 1280×800 pixels. Elas mostram uma execução real sobre uma página demonstrativa local com dados fictícios:

1. `screenshot-tab-report.png` — visão geral da conferência de leitura por Tab e totais por categoria.
2. `screenshot-tab-elements.png` — sequência estimada, nome acessível, função, prévia e ação de destaque.
3. `screenshot-tab-highlight.png` — elemento em foco na página, com moldura e legenda textual sem áudio.

Use também `promo-small.png`, a imagem promocional de 440×280. As capturas antigas `screenshot-panel.png`, `screenshot-evidence-failed.png` e `screenshot-evidence-review.png` são históricas e não compõem o envio de 1.1.50.
