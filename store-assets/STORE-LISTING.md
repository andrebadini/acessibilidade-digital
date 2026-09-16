# Conteúdo de distribuição — Audita Acessibilidade 1.1.25

Material local de referência; não representa publicação ou atualização de uma página de loja.

## Nome

Audita Acessibilidade

## Resumo

Audita páginas web conforme WCAG 2.2 e ABNT NBR 17225, com evidências, revisão humana e relatórios locais.

## Descrição detalhada

Audita Acessibilidade ajuda a examinar a acessibilidade de uma página web de forma automatizada e assistida. A extensão relaciona resultados à WCAG 2.2 e à ABNT NBR 17225:2025 e reúne as evidências necessárias para uma revisão técnica rastreável.

Principais recursos:

- auditoria da página HTTP ou HTTPS aberta no Chrome, em um clique e sem movimentar a página original: a coleta lê a própria página, sem criar aba, navegar, rolar ou mover o foco;
- auditoria de outra URL informada pelo usuário nos três modos de evidência, sem login e sem servidor externo;
- auditoria local de 2 a 20 URLs em lote nos três modos, com progresso por página e relatório consolidado, sempre em abas temporárias inativas;
- três modos de evidência: Evidência completa, Somente elementos e Sem imagens;
- pausa de privacidade e confirmação explícita antes de capturas potencialmente sensíveis, com confirmação individual por página em lotes;
- verificações automatizadas e indicação transparente dos itens que exigem julgamento humano;
- associação de ocorrências aos itens da ABNT e aos critérios WCAG correspondentes;
- captura da página inteira e de elementos relacionados às ocorrências, conforme o modo escolhido;
- moldura vermelha para não conformidades e âmbar tracejado para revisão pendente, sem alterar os PNGs originais;
- trecho HTML sanitizado, seletor e propriedades de acessibilidade;
- cálculo do nome acessível e prévia explicativa do anúncio esperado por tecnologia assistiva;
- revisão assistida com registro do avaliador, decisão, data e nota;
- relatórios locais em HTML, PDF, CSV e JSON-LD/EARL;
- painel lateral persistente, destaque vivo do elemento e relatório completo em aba própria;
- progresso real por etapa, com indicador da fase atual e confirmação visual das etapas concluídas;
- personas de leitor de tela, acromatopsia e navegação por teclado;
- processamento local, sem envio do conteúdo auditado para um servidor do desenvolvedor.

Importante: a auditoria representa somente a página e o estado observados. Itens contextuais, fluxos completos e equivalência de conteúdo podem exigir análise humana. O relatório não constitui certificação do site inteiro.

Antes de auditar, oculte dados pessoais ou sigilosos visíveis. As capturas são incorporadas aos relatórios baixados.

Audita Acessibilidade é uma ferramenta independente, sem vínculo institucional.

O mapa numerado e a legenda de anúncios estimados são incluídos no modo de evidência completa quando a coleta permite, com omissões explícitas. A retenção local tem prazo de 30 dias desde o primeiro registro persistido; a limpeza depende de o Chrome executar a extensão. A exclusão opcional após exportação exige a confirmação dos quatro downloads da mesma revisão e não apaga arquivos baixados. Consulte a política de privacidade para os limites da limpeza recuperável.

## Finalidade única

Auditar localmente a acessibilidade da página indicada pelo usuário, coletar evidências técnicas e gerar relatórios para revisão humana.

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

Necessária para executar os coletores e testes dinâmicos incluídos no próprio pacote, dentro da página que o usuário solicitou auditar. Não há código remoto.

### storage

Necessária para manter localmente o andamento da auditoria, o modelo de resultados e as decisões de revisão, inclusive após a suspensão do service worker.

### tabs

Necessária para identificar a página ativa escolhida e abrir as páginas locais de relatório e impressão, sem substituir a página auditada.

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

Categorias declaradas na Chrome Web Store: **Histórico da Web** e **Conteúdo do site**. O tratamento local também deve ser divulgado conforme a política oficial da loja.

Os dados não são transmitidos ao desenvolvedor, vendidos, usados em publicidade ou usados fora da finalidade única. Relatórios só deixam o armazenamento local quando o próprio usuário os compartilha.

## Público e regiões

- Visibilidade: pública.
- Regiões: Brasil na primeira publicação.
- Público principal: profissionais de acessibilidade, auditoria, qualidade, desenvolvimento e fiscalização técnica.

## Política de privacidade

Publicar o conteúdo integral de `docs/POLITICA-DE-PRIVACIDADE.md` em endereço HTTPS público e informar esse endereço no console.
