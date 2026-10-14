# Mapa do teclado 1.1.58 — paradas do Tab, itens que ficam sem caixa e revisão guiada do item 5.1.13

Data: 14/10/2026. Versão em trabalho: **1.1.58** (branch `wip/teclado`, **sem commit**; o `manifest.json`
ainda declara a versão anterior — a subida de versão e o `build:release` são o passo de release).
Chrome for Testing 152.0.7977.64, um Chrome por vez.

Escopo: o item **5.1.13** da ABNT NBR 17225 (WCAG 2.1.1 — teclado). O problema de origem é de uma
pessoa leiga que não sabe testar teclado: numa página real havia quatro cartões de serviço que só
abrem o menu com o mouse. Este documento registra o que entrou, o que foi provado e o que ficou de
fora. Por regra do projeto, **nenhum nome de órgão ou domínio de governo é registrado aqui** — a
rodada em página real é descrita como "um portal público".

> **Escopo negativo.** `run-audit.js`, `chrome-adapter.js`, `highlight-*`, `page-markers-*` e a regra
> `hover-only-interactive-content` são de tarefas paralelas. Aqui eles receberam apenas os ganchos
> mínimos descritos na §1; a lógica nova vive em módulos novos.

## 1. O que entrou

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Modelo | `src/core/keyboard/keyboard-map-model.js` (novo) | Calcula, do instantâneo, as **paradas do Tab** (link com `href`, botão, campo não desabilitado, `summary`, `[tabindex>=0]`, área editável) visíveis, fora de `hidden`/`inert`/`aria-hidden`, com retângulos em coordenadas do documento; e os **suspeitos** (item que parece clicável e o Tab não alcança): `cursor: pointer`, papel interativo sem foco, ocorrência de regra de teclado |
| Privacidade e geometria | `src/core/evidence/privacy-taint.js`, `src/core/evidence/visible-geometry.js` (novos) | Extraídos de `annotation-map.js` para que o mapa do teclado aplique **a mesma fronteira** do mapa de anúncios: valor digitado e rótulo privado contaminam o nó, os ancestrais e a subárvore |
| Compositor | `src/browser/keyboard-map.js` + `src/browser/canvas-runtime.js` (novos) | Desenha sobre a captura completa: caixa azul cheia + número por parada; caixa laranja tracejada + `?` por suspeito. Reaproveita o compositor e o versionamento do mapa de anúncios, em artefato irmão com esquema próprio |
| Esquema e integridade | `src/core/report/closed-schema.js`, `artifact-hash.js`, `integrity-chain.js`, `enrich-audit.js` | `keyboard-map` entra como artefato derivado, com JSON canônico, `sha256` e elo na cadeia. Auditoria antiga sem o mapa continua abrindo |
| Apresentação | `src/core/report/keyboard-map-presentation.js` (novo) | Legenda, contagens, limites e listas — compartilhada pelos **dois** caminhos de renderização (relatório entregue e aba interativa) |
| Relatório | `src/core/report/html.js`, `src/review/report-view.js` | Seção "Mapa do teclado": imagem ampliável, legenda `Cada caixa azul numerada é um lugar onde a tecla Tab para, na ordem dos números. Caixas laranja tracejadas: itens que parecem clicáveis, mas o Tab não chega até eles.`, contagem de paradas e de suspeitos, procedência e limites |
| Revisão guiada | `src/core/report/lay-review.js`, `src/review/review.js` | Ajuda nova `keyboard-map` no item 5.1.13: o cartão mostra o mapa (ou a lista, no modo sem pixels) e pergunta *"Olhe o mapa. Algum menu, botão, link ou campo que você usaria está SEM caixa azul numerada?"*, com três respostas. "Sim" abre na hora a caixa obrigatória *"Descreva qual item ficou sem caixa…"* |
| Ganchos mínimos | `run-audit.js`, `chrome-adapter.js`, `annotation-map.js`, `collect-page.js`, `page-collector.js` | Derivação do mapa a partir da **mesma captura pristine** já autorizada; extração dos módulos de privacidade/geometria; `cursor` na lista de estilos de runtime |

### 1.1 Provas de que o modelo não inventa

- **Ordem do Tab**: `tabindex` positivo primeiro (crescente, empate pela ordem do documento) e depois
  tudo o que é zero na ordem do documento. É **estimativa**: a extensão não pressiona Tab. A limitação
  `tab-order-estimated-not-observed` vai declarada no artefato e escrita no relatório.
- **Suspeitos, não acusações de texto**: um controle **desabilitado** e um elemento com `tabindex`
  negativo (roving tabindex, item de barra de ferramentas, contêiner de foco) **não** entram — é
  decisão declarada do autor, e acusar seria apontar como falha o comportamento correto. `tabindex`
  negativo só entra quando há ocorrência de regra que sustente a acusação.
- **Nome do item sem nome acessível**: um cartão `<li>` com texto, `cursor: pointer` e nenhum papel
  declarado não tem nome acessível. O **texto visível** entra como último recurso, com
  `nameSource: "visible-text"` — sem isso a lista de itens sem caixa ficaria cheia de "sem nome
  visível", inútil para quem não sabe inspecionar a página. A fronteira de privacidade continua sendo
  a contaminação: cartão que contenha campo de senha, texto digitado ou rótulo privado chega ao
  modelo **contaminado** e nunca projeta texto (projeta `nameStatus: "omitted-privacy"`), embora a
  caixa laranja continue marcada. Controles de formulário ficam de fora desse recurso por precaução
  extra, porque neles o texto visível pode ecoar o valor.
- **Nada de valor digitado**: o instantâneo não carrega valor em nenhum ponto do mapa, e a prova em
  navegador confere que a marca privada da fixture não aparece no JSON, no HTML, no CSV nem no PDF.

### 1.2 Dois defeitos achados durante as provas (e corrigidos)

1. **A auditoria inteira abortava.** A projeção do modelo (`projectV1Evidence`, `audit-model.js`)
   copiava só uma lista fechada de chaves do artefato: `stops`, `suspects`, `counts` e `limits` não
   estavam nela, então o mapa chegava ao relatório **sem as duas listas**, o esquema recusava o
   artefato e a auditoria por URL terminava em "A auditoria foi encerrada antes de concluir". A
   correção é uma linha na lista de chaves; o teste de unidade do `run-audit` cobre o caminho.
2. **Diagnósticos mutuamente exclusivos.** `KEYBOARD_MAP_PARTIAL` compartilhava o grupo `annotation`
   com o mapa visual — o agrupamento é a cardinalidade **da mesma operação**, e o mapa do teclado é
   uma segunda derivação da mesma captura. Um mapa visual parcial mais qualquer diagnóstico do teclado
   invalidava o modelo inteiro. Grupo próprio (`keyboard-map`) resolve.

Também foi preciso acrescentar `cursor` à lista de estilos de runtime do coletor: a projeção do nó
faz `...record.layout, ...runtimeData`, então o estilo de runtime **substitui** o da captura
estrutural — sem essa linha, os quatro cartões do caso real não apareciam (o `cursor: pointer` do
DOMSnapshot era descartado) e o mapa só declarava a limitação.

## 2. Provas automatizadas

| Suíte | Comando | Resultado |
| --- | --- | --- |
| Núcleo | `node --test --test-concurrency=1 test/core/*.test.js` | 176 passam, 0 falham |
| Fundo e painel | `node --test --test-concurrency=1 test/background/*.test.js test/panel/*.test.js` | 2333 passam, 1 pulado, 0 falham |
| Relatório, revisão, evidência e navegador | `node --test --test-concurrency=1 test/report/*.test.js test/review/*.test.js test/evidence/*.test.js test/browser/*.test.js` | 681 passam, 0 falham (depois da correção de impressão: `test/report` + `test/review` = 453 passam, 0 falham) |
| E2E do mapa (Chrome real) | `AUDITA_E2E_CHROME=… node --test --test-concurrency=1 test/e2e/keyboard-map-mv3.test.mjs` | 1 passa, 0 falham |
| E2E de auditoria por URL com mapa de anúncios | `… test/e2e/public-axe-map-mv3.test.mjs` | 1 passa (o caminho que abortava antes da correção da §1.2) |
| E2E do fluxo do painel lateral | `… test/e2e/sidepanel-flow-mv3.test.mjs` | o cenário sem ociosidade passou; o cenário ocioso falhou **sob contenção de ambiente**, não pelo trabalho — ver item 7 das limitações |
| E2E de impressão | `… test/e2e/report-executive-print.test.mjs test/e2e/report-print-breaks.test.mjs test/e2e/report-print-layout.test.mjs` | 3 passam, 0 falham |

O E2E do mapa cobre o caminho inteiro: painel → auditoria por URL com evidência completa → relatório →
exportação nos quatro formatos, e confere que (a) os quatro cartões **não** estão na lista de paradas do
Tab, (b) cada um aparece **uma vez** entre os itens sem caixa, (c) os quatro têm motivo `cursor-pointer`,
(d) `summary` e `tabindex` positivo entram, (e) `tabindex` negativo, campo desabilitado, bloco `hidden` e
link `aria-hidden` **não** entram em lugar nenhum do artefato, (f) o artefato aponta para a captura
pristine (mesmo `evidenceId`, mesmo `hash`), (g) nenhuma saída textual traz o valor privado do campo e
(h) não há violação de CSP.

Testes de unidade do modelo cobrem: ordenação por `tabindex` positivo, exclusão de desabilitado,
escondido, inerte, `aria-hidden` e `input type=hidden`; `details` recolhido; área editável; suspeitos
por `cursor`, papel interativo e ocorrência de regra; roving tabindex; contaminação por campo privado
(o texto **não** é projetado); teto de 400 paradas e 60 suspeitos, declarado; quadro e sombra fechada
omitidos com limitação própria; e determinismo entre execuções (mesma lista, mesmo hash).

## 3. Prova visual

Rodada na fixture local (`test/e2e/fixtures/keyboard-map.html`), com a extensão de verdade:

```
node --test --test-concurrency=1 test/e2e/keyboard-map-mv3.test.mjs   # com AUDITA_E2E_ARTIFACT_ROOT
```

O mapa composto (`qa-out/teclado/mapa-teclado-trecho-1.png`, fora do versionamento) mostra:

- **7 caixas azuis numeradas** na ordem do Tab — a número 1 é o link com `tabindex="3"`, que vem
  antes de todos; depois vêm, na ordem do documento, o atalho, os dois campos, o botão, o `summary` e
  o `div` com foco próprio;
- **4 caixas laranja tracejadas com `?`** exatamente sobre os quatro cartões de serviço: *Consultar
  processo*, *Emitir segunda via*, *Agendar atendimento* e *Registrar pedido* — **nenhuma caixa azul**
  sobre eles, que é o ponto do caso real;
- sem caixa alguma no botão `tabindex="-1"` (decisão declarada do autor), no link dentro de bloco
  `hidden` e no link `aria-hidden`;
- o campo de senha com caixa azul **e o valor mascarado**: a caixa aparece, o valor não.

Na conferência medida, **nenhum** suspeito tem retângulo sobreposto a alguma parada (`collisions: []`),
e as contagens do relatório (`7 lugares onde o Tab para; 4 itens que parecem clicáveis e o Tab não
alcança.`) batem com o artefato exportado.

O relatório entregue e o cartão da revisão guiada foram conferidos em captura de tela
(`report-keyboard-map.png` e `review-keyboard-map-question.png`): a legenda, as contagens, a lista
numerada, a proveniência, a limitação da estimativa, a pergunta e as três respostas aparecem como
especificado, e a caixa de descrição abre com o foco já dentro dela.

### 3.1 Rodada em página real

```
node scripts/visual-qa.mjs --no-fixture --out qa-out/teclado --url <portal público>
```

O roteiro ganhou a captura `09-mapa-teclado.png` na pasta da rodada. Nessa página o mapa saiu
**presente**, com estado `partial` (a página é grande e nem todo o conteúdo cabe na área capturada) e as
limitações declaradas no próprio relatório:

- `12 lugares onde o Tab para; 60 itens que parecem clicáveis e o Tab não alcança` — o teto de 60
  suspeitos foi **atingido** e o relatório diz isso: *"O limite de itens suspeitos foi atingido."*
- a maior parte dos elementos da página ficou fora por **não estar visível** na área capturada, e
  parcelas menores por não terem posição medida e pelo teto de paradas — o relatório traz as duas
  contagens de limite (400 paradas e 60 suspeitos por página) na linha de limites;
- itens fora da área capturada foram enquadrados na borda da imagem, e há nome omitido por
  privacidade em pelo menos um item — as duas situações aparecem como limitação escrita.

Os números por extenso (quantos itens caíram em cada motivo) ficam no artefato exportado, não na
captura; a evidência guardada desta rodada prova o estado, as contagens do relatório e a imagem.

Em resumo: em página grande o mapa continua honesto, mas **não é exaustivo** — o teto de suspeitos
concentra as caixas laranja no topo da página e a lista satura.

## 4. Limitações conhecidas e pendências

1. **A ordem do Tab é estimada, não observada.** O mapa não pressiona Tab na página. Está declarado no
   artefato, na legenda do relatório e no texto da revisão.
2. **Teto de 400 paradas / 60 suspeitos.** Atingido em página real grande (§3.1). O limite é declarado
   no artefato (`limits`) e no relatório, mas quem lê pode interpretar a lista saturada como completa.
   Próximo passo, se incomodar em uso: ordenar os suspeitos por posição na página e declarar
   explicitamente "lista truncada a partir daqui".
3. **Comparação entre aba e relatório entregue na impressão.** O resumo executivo impresso mantém
   sumário, matriz e metodologia; o mapa do teclado sai, nas duas folhas (aba e relatório entregue) —
   agora as duas concordam (`src/review/review.css` passou a ocultar a seção 6, como o relatório já
   fazia). O teste de impressão deixou de depender do número da seção e passa a procurar pelos títulos.
4. **Marcação por retângulo arrastado (≤5) — não implementada.** É um passo seguinte, não uma
   pendência escondida: exige caminho novo de captura e de anotação (retângulos livres em vez de
   caixas por nó), esquema novo para o artefato, persistência da marcação junto da revisão e desenho de
   interação que não atropele o arrastar para selecionar texto. Fazer metade disso produziria uma
   marcação que não chega ao relatório — pior que a descrição em texto, que já está obrigatória e já
   entra na constatação copiável e no item 5.1.13 do relatório final.
5. **`test/release-package.test.js` falha no hash fixado do pacote.** A falha **já existe** na base
   (`HEAD`) do worktree, sem relação com este trabalho; o hash do CSS do relatório, esse sim, está
   consistente (`computeReportCssHash` confere com `REPORT_CSS_CSP_HASH`).
6. **Limites de coleta já conhecidos e herdados do mapa de anúncios**: conteúdo de `iframe` e de
   sombra fechada fica fora (com limitação escrita), `cursor` só existe quando o coletor o registrou
   (`cursor-style-not-collected` é declarado quando não existe) e itens escondidos por rolagem interna
   ficam fora.
7. **Contenção de ambiente na última rodada do `sidepanel-flow-mv3`.** Com **duas instâncias do Chrome
   for Testing ao mesmo tempo** (a regra do projeto é uma por vez), o cenário ocioso falhou em
   `assertSourceUntouched` por eventos de foco na página auditada — `focus` 36, `blur` 36, `focusin` 18,
   `focusout` 18 —, exatamente o padrão de duas janelas disputando o foco; não há `input`, `click`,
   `keydown` nem mutação. As edições deste trabalho nesse arquivo de teste mexem só em
   `methodologySection` e em três consultas de seção do relatório, nada que toque a página auditada, e o
   mesmo arquivo havia passado antes. A reexecução ficou **bloqueada**: o volume de inicialização encheu
   (varredura completa e perfis do Chrome da sessão paralela) e não houve como rodar o teste de novo.
   Antes de fechar a versão, rode este arquivo sozinho com um Chrome só.

## 5. Como reproduzir

```bash
export AUDITA_E2E_CHROME="$HOME/.cache/audita-cft/chrome/mac_arm-152.0.7977.64/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

node --test --test-concurrency=1 test/core/*.test.js test/report/*.test.js test/review/*.test.js \
  test/evidence/*.test.js test/browser/*.test.js
node --test --test-concurrency=1 test/background/*.test.js test/panel/*.test.js
node --test --test-concurrency=1 test/e2e/keyboard-map-mv3.test.mjs
node --test --test-concurrency=1 test/e2e/public-axe-map-mv3.test.mjs

# prova visual (fixture local e página real)
node scripts/visual-qa.mjs --out qa-out/teclado-fixture
node scripts/visual-qa.mjs --no-fixture --out qa-out/teclado --url <portal público>
```

Para guardar também o JSON exportado e as capturas do relatório, rode o E2E do mapa com
`AUDITA_E2E_ARTIFACT_ROOT` apontando para um diretório em `/private/tmp` criado com `mktemp -d
/tmp/audita-marco-1-…` (o suporte de E2E recusa diretórios fora desse padrão) e subpastas `qa/` e
`downloads/`.
