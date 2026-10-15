# Impacto real nos achados do motor próprio — 1.1.60

Versão alvo: 1.1.60 (branch `wip160/impacto`), sobre a base da 1.1.59 — o `manifest.json` ainda
declara 1.1.59, porque a subida de versão acontece no processo de release.
Data da validação: 2026-10-15. Chrome for Testing 152.0.7977.64, janela 1280×900.

## 1. Problema

A ocorrência do motor próprio só trazia impacto quando a regra era a única exceção escrita à mão no
`makeOccurrences` (o caso do conteúdo que só aparece com o mouse). Todas as outras 130 regras caíam
no padrão de migração `minor` do modelo, e a pessoa leiga via **"Menor"** em tudo — inclusive em
falha que impede a tarefa, como um campo sem rótulo ou um controle sem nome acessível. Pior: a
mesma gradação era escrita com palavras diferentes em cada tela, o que fazia o mesmo achado parecer
outra coisa ao mudar de lugar:

| Onde | `serious` era | `minor` era |
| --- | --- | --- |
| Painel (`panel-view.js`, rótulo local) | "Sério" | "Menor" |
| Relatório HTML (`html.js`, `IMPACT` local) | "Alto" | "Menor" |
| Relatório vivo (`report-view.js`, `IMPACT_LABELS` local) | "Alto" | "Menor" |

Além disso, a suspeita (`cantTell`) era apresentada com a mesma afirmativa da falha confirmada —
"Impacto Alto" — como se o motor já tivesse confirmado a barreira.

## 2. Solução

### 2.1 Política fechada de impacto por regra

`src/core/rules/impact-policy.js` (novo) traz a tabela **fechada** `ruleId → impacto` para as **131**
regras do motor próprio, com o critério escrito no cabeçalho do módulo:

- **critical** — impede totalmente uma tarefa para algum grupo: controle, link ou botão sem nome
  acessível; imagem de conteúdo sem alternativa; campo sem rótulo; armadilha de teclado; conteúdo
  que só aparece com o mouse e não tem caminho pelo teclado; risco de convulsão.
- **serious** — dificulta muito, mas há caminho alternativo ou a barreira atinge parte do conteúdo:
  contraste de texto, indicador de foco invisível, ordem de foco, idioma ausente, mídia sem
  alternativa equivalente, mudança inesperada de contexto.
- **moderate** — estrutura e semântica: títulos, listas, regiões, tabelas, agrupamento de campos,
  identificação de finalidade que não chega a bloquear a tarefa.
- **minor** — recomendações e avisos: identificações complementares, ajudas de leitura (nível AAA no
  WCAG) e boas práticas que orientam a melhoria sem barreira confirmada.

Distribuição no inventário instalado:

| Impacto | Regras | Palavra na interface |
| --- | --- | --- |
| `critical` | 14 | Crítico |
| `serious` | 51 | Alto |
| `moderate` | 47 | Moderado |
| `minor` | 19 | Baixo |
| **Total** | **131** | — |

Coerência com o axe (`src/core/normative/axe-nbr-crosswalk.js`): onde existe regra equivalente
mapeada, o impacto do axe orienta a escolha — nome de controle e alternativa de imagem ficam
`critical`; idioma, título do documento, contraste, indicador de foco e tamanho mínimo de alvo ficam
`serious`; contorno de blocos fica `moderate`. **Divergência documentada no módulo:** o axe
classifica `list`/`listitem`/`definition-list` como `serious`; aqui a semântica de lista é
`moderate`, por ser estrutura que não bloqueia a tarefa, conforme o critério acima.

A política é uma tabela editorial fechada e versionada (`CoreRuleImpactPolicyV1`), não uma regra
derivada em tempo de execução: uma regra nova no inventário sem entrada na tabela **reprova o teste**
(`uncoveredCoreRuleIds`), em vez de cair em silêncio num impacto qualquer.

### 2.2 Aplicação na coleta

`src/background/run-audit.js`, em `makeOccurrences`: o caso especial do conteúdo só-mouse foi
substituído por `impact: coreRuleImpact(result.ruleId)`, que vale para toda ocorrência nova do motor
próprio. A ocorrência **não** perde a graduação quando é suspeita: o impacto é o mesmo para `failed`
e para `cantTell`; o que muda é o texto da interface.

### 2.3 Rótulos únicos e aviso de suspeita

`src/core/report/impact-labels.js` (novo) passa a ser a única fonte das palavras e do texto:

```js
impactText('critical')      // "Impacto Crítico"
impactText('serious', true) // "Impacto se confirmado: Alto"
```

| Peça | Arquivo | O que mudou |
| --- | --- | --- |
| Política | `src/core/rules/impact-policy.js` (novo) | Tabela fechada das 131 regras + validação |
| Rótulos | `src/core/report/impact-labels.js` (novo) | `IMPACT_LABELS`, `impactLabel`, `impactText` |
| Coleta | `src/background/run-audit.js:597` | `impact` por regra em vez do caso único do hover |
| Painel | `src/panel/panel-view.js` | Carta e detalhe usam `impactText`; `minor` diz "Baixo", não "Menor" |
| Relatório HTML | `src/core/report/html.js` | `IMPACT`/`impactLabels` passam a importar o módulo comum; chip e cartão de constatação avisam "se confirmado" |
| Relatório vivo | `src/review/report-view.js` | Remove o `IMPACT_LABELS` local ("Menor") e usa `impactText` |

No painel, o detalhe ganhou o aviso porque a carta já o carrega: quando o cartão está em revisão
humana, a linha do detalhe passa a ler **"Revisão humana · Impacto se confirmado: Crítico"**. O
`impact` **não** entrou como chave nova no pacote fechado do painel (`panel-result-bundle.js` valida
`detail.heading` com `exact()`): o estado de suspeita é derivado do próprio cartão
(`displayOutcome === 'cantTell'`) e passado como booleano.

### 2.4 Auditorias antigas

Nenhum registro guardado é reescrito. `audit-model.js` continua preservando o `impact` válido do
registro e só usa o padrão de migração (`minor`) como reserva; a tabela nova vale apenas para
ocorrências **novas** do motor próprio. O que muda para uma auditoria antiga é só a palavra exibida
— de "Menor" para "Baixo" —, com o token gravado intacto.

O CSV continua exportando o token fechado (`critical`/`serious`/`moderate`/`minor`,
`src/core/report/csv.js:98`), sem tradução: ele é dado de máquina para conferência, não texto de
interface.

## 3. Testes

Unitários (todos passam):

| Arquivo | O que fixa |
| --- | --- |
| `test/rules/impact-policy.test.js` (novo) | Cobertura das 131 regras, ausência de regra desconhecida, níveis válidos, tabela congelada, listas por nível e os textos de `impactText` |
| `test/report/html.test.js` | `Impacto Moderado` na falha confirmada e `Impacto se confirmado: Moderado` na suspeita; filtro com Crítico/Alto/Moderado/Baixo; nenhuma ocorrência de "Menor" |
| `test/review/report-view.test.js` | O relatório vivo não diz "Menor", o filtro e o texto das constatações usam as quatro palavras, a falha confirmada afirma o impacto sem condicional, e o impacto projetado é o gravado (`moderate`, `none`) |
| `test/panel/panel-view.test.js` | Carta e detalhe: "Impacto Crítico", "Impacto se confirmado: Crítico", filtro com as quatro palavras, nenhuma ocorrência de "Menor"/"Sério" |
| `test/report/legacy-1.1.56-compat.test.js` | A auditoria guardada de 1.1.56 abre, mantém as 88 ocorrências com `impact: 'minor'` e o relatório diz "Baixo" |

Ponta a ponta em Chrome real (um arquivo por vez):

| Arquivo | Resultado |
| --- | --- |
| `test/e2e/hover-only-content-mv3.test.mjs` | 1/1 |
| `test/e2e/report-executive-print.test.mjs` | 1/1 |
| `test/e2e/report-version-provenance.test.mjs` | 1/1 |
| `test/e2e/mandatory-journey-mv3.test.mjs` | 1/1 |
| `test/e2e/sidepanel-flow-mv3.test.mjs` | instável nos dois cenários `original-page ABNT markers …` (8/9, 8/9 e 7/9 em três execuções, com falhas de assinatura diferente — `PAGE_MARKERS_IDLE_BEFORE_SHOW_FAILED` com 7 eventos de `resize` e geometria idêntica, e uma em que a página de origem acumulou 6 eventos). **Anterior a esta mudança:** o mesmo `PAGE_MARKERS_IDLE_BEFORE_SHOW_FAILED` foi reproduzido no `HEAD` limpo, com o diff guardado fora do caminho e depois restaurado. O arquivo já é registrado como pertencente a outro incremento em `docs/qa/2026-09-13-continuity-and-e2e-triage.md` |

Bateria unitária completa (`node scripts/run-tests.mjs`, fase paralela — 204 arquivos): **4519
testes, 4517 passam, 1 falha esperada e 1 ignorado**. A única falha é
`test/release-package.test.js` ("o pacote construído a partir desta árvore precisa ser o artefato
entregue; se o fonte mudou, reconstrua e atualize o hash registrado"): o hash do ZIP só muda na
release, e esta branch altera o fonte de propósito. Os 51 arquivos de E2E de Chrome real são a fase
serial, rodada um a um (tabela acima).

## 4. Resultado em sites reais

Roteiro, idêntico nas duas pontas do produto:

```sh
export AUDITA_E2E_CHROME="$HOME/.cache/audita-cft/chrome/mac_arm-152.0.7977.64/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
node scripts/visual-qa.mjs --no-fixture --out qa-out/impacto-1.1.60-reais --url <PORTAL> --url <MARKETPLACE> --url <LOJA>
node scripts/visual-qa.mjs --out qa-out/impacto-1.1.60-fixture
```

### Antes

Não houve nova rodada com o código antigo: o "antes" é o que o produto publicado **registrava**.
A auditoria guardada de 1.1.56 (`fixtures/audits/legacy-1.1.56-full-evidence.json`) tem as **88**
ocorrências com `impact: 'minor'` — o padrão de migração — porque só a regra do conteúdo só-mouse
recebia graduação própria no `makeOccurrences`. Na interface isso virava "Menor" no painel, no
relatório HTML e no relatório vivo ("Menor" em todas as telas) e "Sério" a mais no painel para o
nível `serious`.

### Depois — portal público

| Medida | Valor |
| --- | --- |
| `outcome` | `result`, sem erros |
| Painel | 3 falhas confirmadas (6 ocorrências), 3 recomendações e alertas (25), 4 suspeitas a confirmar (51), 6 resultados positivos |
| Sinais / localização | 46 elementos sinalizados, 59 ocorrências localizadas, 17 não localizadas, 6 questões gerais, 0 omitidas |
| Relatório | aberto, 84 miniaturas, mapa de anúncios parcial |

Capturas conferidas (`qa-out/impacto-1.1.60-rotulos-portal/`, o mesmo `auditId` do `summary.json`):

- `painel-1-rotulos-group-failed.png` — carta de falha confirmada do item 5.1.13 (WCAG 2.1.1,
  acessibilidade por teclado parcial) dizendo **"Impacto Crítico"**, com a carta positiva seguinte
  dizendo "Sem impacto associado".
- `painel-2-rotulos-group-humanReview.png` — item 5.8.7 (WCAG 2.5.8) em revisão humana com
  **"Impacto se confirmado: Alto"**, e o item 5.9.3 (WCAG 1.3.1, rótulo de campo associado) com
  **"Falha confirmada · Impacto Crítico"**.
- `painel-detalhe-suspeita.png` — detalhe da área de acionamento mínima: **"Revisão humana ·
  Impacto se confirmado: Alto"**.
- `painel-3-rotulos-group-alerts.png` — item 5.3.4 (WCAG 2.4.10, seções com cabeçalhos) com
  **"Impacto Moderado"**, entre cartas positivas sem impacto.

O mesmo roteiro na página de teste local (`qa-out/impacto-1.1.60-fixture/…/01-painel.png` e
`qa-out/impacto-rotulos-fixture/`) repete os quatro rótulos e o aviso condicional, incluindo
"Impacto se confirmado: Crítico" numa suspeita de alternativa de imagem.

### Depois — marketplace e loja on-line

As duas páginas concluíram a auditoria (`outcome: result`, sem erros) e o painel fechou com os
mesmos quatro rótulos; o que mudou em relação ao portal foi só o volume de achados:

| Medida | Marketplace | Loja on-line |
| --- | --- | --- |
| Elementos sinalizados | 80 | 92 |
| Ocorrências localizadas | 90 | 93 |
| Questões gerais | 82 | 5 |
| Ocorrências não localizadas | 17 | 84 |
| Cartas em revisão humana | "Área de acionamento (mínima)" | "Texto alternativo para imagens de conteúdo" (45 ocorrências) |
| Cartas com alerta | "Seções com cabeçalhos" | — |

Nestas duas páginas o roteiro mediu `precisão: 11 de 12` e `11 de 16` contornos colados ao elemento
(as demais medidas do harness — sinais, persistência, mapa — fecharam como nas rodadas anteriores).
Isso é geometria de marcação na página, fora do escopo desta mudança, e está registrado aqui porque
aparece no `summary.json` da rodada.

## 5. Limitações

- A tabela é **editorial**: foi escrita regra a regra a partir do critério do cabeçalho e conferida
  contra o cruzamento do axe, não derivada de dados de uso. Regras de fronteira (por exemplo
  `images-of-text`, `custom-component-behavior` e `single-key-shortcuts`, hoje `serious`) podem
  mudar de nível numa revisão futura — a mudança é uma linha na tabela, versionada.
- A divergência com o axe na semântica de lista é deliberada e está declarada no módulo; quem
  comparar os dois relatórios lado a lado vai encontrar diferença ali.
- Em auditoria guardada antes desta versão, o impacto vem do padrão de migração, então quase tudo
  aparece como "Baixo" mesmo quando a regra hoje é crítica. O registro não foi reescrito — de
  propósito — e a interface não sinaliza essa origem; quem reabrir uma auditoria antiga e comparar
  com uma nova verá graduações diferentes para o mesmo achado.
- O aviso "Impacto se confirmado" depende do resultado consolidado (`cantTell`). Um achado que a
  pessoa revisora confirme como não conforme passa a afirmar o impacto — o que é o comportamento
  pretendido —, mas faz o texto da carta mudar depois da revisão.
- **Achado revisado como conforme continua exibindo o impacto da regra.** Medido: `occ-focus-review`
  com decisão "conforme" consolida em `passed` e o relatório autônomo mantém
  `<span class="chip">Impacto Moderado</span>` (e o painel, o mesmo texto na carta). O cartão de
  resultado positivo automático (`passedCard`) usa `impact: null` e diz "Sem impacto associado"; a
  carta vinda de revisão humana não. É comportamento anterior a esta mudança (antes dizia "Impacto
  Menor", o padrão de migração), e a gradação agora está correta — mas a combinação "Resultado
  positivo / Impacto Moderado" é ambígua para quem lê e merece decisão de produto sobre ocultar o
  impacto no resultado positivo, fora do escopo desta mudança.
- O CSV mantém o token cru por decisão de esquema fechado; quem abrir o CSV não verá as palavras
  Crítico/Alto/Moderado/Baixo.
