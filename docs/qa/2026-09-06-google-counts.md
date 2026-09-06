# Google: contagens e PDF — correção da beta 1.1.8

## Evidência e diagnóstico

O PDF Audita fornecido contém **726 páginas**, com 801 ocorrências (48 falhas e 753 revisões), 133 resultados de regras e 69 evidências. O resumo mostra 12 verificações falhas, 105 verificações humanas e 3 positivas. São unidades diferentes; 753 não representa 753 problemas comprovados.

O AMAWeb fornecido usa WCAG 2.1, URL `https://www.google.com/`, 29 práticas: 21 aceitas, 3 revisões e 5 erros. O Audita usa `https://www.google.com.br/index.html` e inventário ABNT/WCAG mais amplo. URLs, estado e metodologia diferem. Não adotamos a contagem do concorrente como oráculo nem declaramos equivalência normativa.

Reprodução anônima em Chrome for Testing 152.0.7977.64, sem pixels, perfil pessoal ou retenção do conteúdo bruto:

- idioma nativo `pt-BR` virava vazio: o DOCTYPE `html` era selecionado antes do elemento HTML;
- correlação por ordem/tag juntava elementos distintos, pois DOMSnapshot e runtime não enumeram a mesma árvore (incluindo shadow DOM interno do navegador);
- elementos ocultos recebiam dados incorretos ou perdiam a observação de visibilidade;
- `a[role=button]` e `button[role=link]` eram avaliados também pelo papel nativo contraditório;
- um campo com `aria-label` era acusado de ausência de associação;
- perguntas genéricas eram multiplicadas por cada controle: 12 regras × 39 controles = 468 registros no relatório fornecido.

## Correção delimitada

Normalização passa a selecionar HTML do tipo Element e correlacionar dados por backend ou seletor único contextual, nunca por ordinal. Razões explícitas de exclusão AX não confundem `uninteresting` com invisibilidade. O salto de shadow host segue o coletor existente, com teste de componente aninhado. Regras de papel e rótulo corrigem os casos reproduzidos. Perguntas genéricas com múltiplos candidatos viram uma tarefa de página por regra, ainda `cantTell`, não uma aprovação. Alvos de falhas específicas não são descartados nem limitados artificialmente.

Reprodução local antes: 701 alvos humanos; depois: 51, uma verificação falha de contraste aprimorado. Esses números descrevem uma captura pública dinâmica, não uma expectativa fixa para toda execução do Google. Não equivalem à contagem final do painel, que também inclui revisões de página sem alvo elementar e testes incompletos.

Fontes técnicas consultadas em 06/09/2026: [ARIA in HTML](https://www.w3.org/TR/html-aria/), [W3C ARIA14](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA14), [CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/).

## Apresentação e metodologia

- Gráfico: verificações agrupadas nas quatro categorias consolidadas; não conta nós nem itens não aplicáveis.
- Índice técnico automático: `10 × passed / (passed + failed)` dos resultados originais do motor próprio, uma vez por regra e página. Não aplicáveis, inconclusivos, não testados, decisões humanas e motores suplementares não entram na nota. Denominador zero: sem nota. Não certifica conformidade; pode existir nota alta com muitas pendências. Fórmula, contagens e diferenças de denominador aparecem junto ao gráfico.
- Cobertura automática permanece separada e mantém sua fórmula existente. O percentual mede conclusão no inventário do motor, não percentual acessível da página.
- PDF de leitura agrupa revisões, apresenta orientações essenciais e inventário de evidências. HTML conserva os guias completos e detalhes expansíveis; JSON preserva os registros técnicos. Nenhum dado do modelo original é reescrito para reduzir a paginação.
- Reimpressão diagnóstica do **mesmo modelo antigo**, sem remover suas 801 ocorrências: 726 → 49 páginas antes do fechamento de release. Isto é comparação de apresentação, não uma nova auditoria.

## Verificação focada

REDs observados: idioma, associação ordinal errada, visibilidade AX, papéis nativos/ARIA, aria-label, multiplicação de revisão e repetição de dossiê na impressão. Regressão de shadow aninhado encontrada pela revisão independente, reproduzida e corrigida. Núcleo: 55/55, revisão C=0/I=0. Núcleo + relatório: 137/137, `git diff --check` verde nesta etapa.

Os artefatos privados fornecidos e suas reimpressões diagnósticas não são incorporados ao repositório ou ao ZIP. Nenhum relatório antigo é corrigido retroativamente: é necessário refazer a auditoria.
