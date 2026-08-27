# Conteúdo da Chrome Web Store — Audita Acessibilidade 1.0.1

## Nome

Audita Acessibilidade

## Resumo

Audita páginas web conforme WCAG 2.2 e ABNT NBR 17225, com evidências, revisão humana e relatórios locais.

## Descrição detalhada

Audita Acessibilidade ajuda a examinar a acessibilidade de uma página web de forma automatizada e assistida. A extensão relaciona resultados à WCAG 2.2 e à ABNT NBR 17225:2025 e reúne as evidências necessárias para uma revisão técnica rastreável.

Principais recursos:

- auditoria de uma URL HTTP ou HTTPS informada pelo usuário;
- verificações automatizadas e indicação transparente dos itens que exigem julgamento humano;
- associação de ocorrências aos itens da ABNT e aos critérios WCAG correspondentes;
- captura da página inteira e de elementos relacionados às ocorrências;
- moldura vermelha para não conformidades, âmbar para revisão pendente e verde após conformidade confirmada;
- trecho HTML sanitizado, seletor e propriedades de acessibilidade;
- cálculo do nome acessível e prévia explicativa do anúncio esperado por tecnologia assistiva;
- revisão assistida com registro do avaliador, decisão, data e nota;
- relatórios locais em HTML, PDF e JSON-LD/EARL;
- processamento local, sem envio do conteúdo auditado para um servidor do desenvolvedor.

Importante: a auditoria representa somente a página e o estado observados. Itens contextuais, fluxos completos e equivalência de conteúdo podem exigir análise humana. O relatório não constitui certificação do site inteiro.

Antes de auditar, oculte dados pessoais ou sigilosos visíveis. As capturas são incorporadas aos relatórios baixados.

Audita Acessibilidade é uma ferramenta independente, sem vínculo institucional.

## Finalidade única

Auditar localmente a acessibilidade da página indicada pelo usuário, coletar evidências técnicas e gerar relatórios para revisão humana.

## Categoria

Acessibilidade.

## Idioma principal

Português (Brasil).

## Justificativas das permissões

### debugger

Necessária para usar localmente o Chrome DevTools Protocol na aba descartável de auditoria: coletar DOMSnapshot e árvore de acessibilidade, ler métricas, capturar a página e os elementos e gerar o PDF. A extensão desconecta o protocolo e fecha as abas exatas ao terminar.

### downloads

Necessária para salvar, mediante ação do usuário, os relatórios HTML, PDF e JSON-LD/EARL no dispositivo.

### scripting

Necessária para executar os coletores e testes dinâmicos incluídos no próprio pacote, dentro da página que o usuário solicitou auditar. Não há código remoto.

### storage

Necessária para manter localmente o andamento da auditoria, o modelo de resultados e as decisões de revisão, inclusive após a suspensão do service worker.

### tabs

Necessária para criar a aba descartável da URL auditada e a aba inativa de impressão, acompanhar o carregamento, obter a URL final e fechar somente essas abas ao concluir.

### Acesso aos hosts HTTP e HTTPS

Necessário porque o usuário pode informar qualquer página HTTP ou HTTPS para auditoria. O acesso é usado somente na URL iniciada pelo fluxo da extensão.

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
