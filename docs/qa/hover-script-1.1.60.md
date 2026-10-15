# Menu que o script abre no mouse — 1.1.60

Versão alvo: 1.1.60 (branch `wip160/hover-js`), sobre a base da 1.1.59 — o `manifest.json` ainda
declara 1.1.59, porque a subida de versão acontece no processo de release.
Data da validação: 2026-10-15. Chrome for Testing 152.0.7977.64, janela 1280×900.

Motivação: a sondagem da 1.1.58 força a pseudo-classe `:hover` no motor de estilo. Ela cobre o menu
que abre por regra de CSS — e **não cobre** o menu que abre por script (`mouseenter` →
`classList.add`). Nesse caso nenhuma pseudo-classe é o gatilho, a sondagem não vê nada e o bloco sai
como conforme mesmo sem nenhum caminho de teclado. Era a limitação nº 1 declarada no relatório da
1.1.58. Esta mudança fecha essa lacuna para o item **5.1.13 — Acessibilidade por teclado parcial**
(ABNT NBR 17225), ligado ao critério **WCAG 2.1.1 (Teclado)**.

Regra de ouro da detecção: **indício de abertura por mouse só vira achado quando não há caminho de
teclado**. Sem os dois lados, o bloco não entra no relatório.

---

## 1. O que mudou

| Peça | Arquivo | Papel |
| --- | --- | --- |
| Leitura de ouvintes | `src/browser/hover-script-probe.js` (novo) | `DOMDebugger.getEventListeners` no bloco e em até 3 ancestrais; classifica ouvintes de mouse e de teclado |
| Sondagem | `src/browser/hover-only-probe.js` | Segunda fase (`inspectScriptHoverGroups`) e confirmação com ponteiro de verdade (`confirmGroupWithPointer`) |
| Política de modo | `src/background/run-audit.js` | Uma leitura só da política do modo passa `allowPointerInteraction: !passive` para a sondagem |
| Regra | `src/core/rules/hover-only.js` | Terceiro motivo de dúvida (`hover-script-no-keyboard-path`) com o texto único da tarefa |
| Catálogo fechado | `src/core/report/remediation-policy.js` | Motivo `hover-script-no-keyboard-path` registrado |
| Apresentação | `src/core/report/finding-kind.js` | O motivo entra em `CONCRETE_REASONS`: vira suspeita com o texto e o seletor do bloco, não pergunta genérica de checklist |
| Fixture | `test/e2e/fixtures/hover-script.html` (novo) | Quatro cartões: script sem teclado, script com botão focável, script com tecla no ancestral, e o `:hover` de CSS como controle |
| E2E | `test/e2e/hover-script-menu-mv3.test.mjs` (novo), registrado em `scripts/run-tests.mjs` | Percorre as duas políticas de modo em Chrome real |

Nada muda nos esquemas: a observação continua sendo `document.hoverOnlyObservation` dentro do
snapshot, e os dois campos novos do grupo (`hoverScript`, `keyboardPath`) são opcionais. Um registro
antigo, sem eles, não gera achado nenhum (`scriptHoverWithoutKeyboardPath({})` é `false`) — as
auditorias guardadas continuam abrindo.

---

## 2. Como a detecção funciona

1. A primeira fase continua igual: descobrir os blocos com conteúdo interativo oculto, forçar
   `:hover` e `:focus` pelo motor de estilo, medir e desfazer.
2. **Segunda fase** — só nos blocos em que o `:hover` forçado não revelou nada, que ainda passariam
   como conformes e que **não têm controle focável visível dentro** (esses já têm caminho de teclado
   conhecido, e os que já são dúvida mantêm o motivo que têm).
3. Para cada bloco candidato, uma única chamada resolve o bloco e seus ancestrais até 3 níveis em
   objetos remotos; `DOMDebugger.getEventListeners` lê os ouvintes de cada um. Contam como indício de
   mouse `mouseenter`, `mouseover`, `pointerenter` e `pointerover`; contam como caminho de teclado
   `focus`, `focusin`, `keydown` e `click`, além do bloco focável e do controle focável **visível**
   dentro dele.
4. Indício de mouse **e** nenhum caminho de teclado → `cantTell` (revisão humana) com o texto único:
   *"Os links deste bloco parecem abrir por um script quando o mouse passa por cima, e não
   encontramos jeito de abri-los pelo teclado. Use a tecla Tab para conferir."* Com caminho de teclado
   → nada no relatório.
5. **Confirmação com o ponteiro de verdade** (só quando a política do modo permite interagir com a
   página): o ponteiro vai ao centro do bloco, os alvos são medidos, o ponteiro volta para um ponto
   neutro e a rolagem é restaurada. Revelou e não há caminho de teclado → `failed`. Antes de medir, a
   sondagem confere que o ponto central está mesmo sobre o bloco (`elementFromPoint`); se um banner
   cobre o cartão, não há confirmação e o bloco segue como dúvida.

A leitura dos ouvintes é **consulta pura**: nenhum ouvinte é chamado, nenhum evento é disparado,
nenhum atributo, texto ou classe muda, e o site não executa nada por causa dela. A confirmação com o
ponteiro é a **única** parte da sondagem que executa JavaScript do site, e é por isso que ela tem
autorização explícita e separada.

A prova de restauração, que já existia, roda depois de tudo: se algo continuar aberto, o bloco deixa
de ser conclusão e a observação fica `incomplete`.

Limites (`HOVER_ONLY_PROBE_LIMITS` + `HOVER_SCRIPT_LIMITS`): fase 2 com teto de 60 blocos e 6 s de
prazo, 200 ouvintes por bloco, 3 níveis de ancestral, 15 s por consulta, e no máximo 5 blocos
confirmados com ponteiro (250 ms de acomodação por rolagem). Falha de leitura, prazo estourado ou nó
sem objeto remoto → observação incompleta com o aviso `PROBE_FAILED`/`TIMEOUT`, nunca um "passou"
silencioso, e nunca uma auditoria quebrada.

---

## 3. O que acontece em cada modo

| Modo | O que a sondagem faz | Resultado no painel |
| --- | --- | --- |
| Página atual (anexada, passiva) | Só a leitura dos ouvintes. Nenhum evento de ponteiro chega à página | Suspeita ("Suspeitas a confirmar"), com o texto e o seletor do bloco |
| Página descartável (auditoria por URL, interativa) | Leitura dos ouvintes + ponteiro de verdade sobre o bloco | Falha confirmada, com o texto do mouse |

O que foi medido, com a fixture:

- **Página atual**: depois da auditoria, `window.__pointerEvents` continua **0**, nenhum cartão fica
  aberto, a rolagem e o foco ficam onde estavam, e o item 5.1.13 sai como 1 suspeita com 1 ocorrência
  (`manual-review`). A fixture inteira fecha em 0 falhas, 1 alerta, 1 suspeita e 8 resultados
  positivos.
- **Página descartável**: o `mouseenter` do cartão dispara de verdade (medido com beacons de rede na
  cópia de depuração da fixture) e o item fecha como **falha confirmada**, com o texto do mouse — já
  sem nenhuma menção a script, porque a abertura deixou de ser suposição.
- **Auditoria por URL com pixels** ("Evidência completa", o modo padrão do painel): a confirmação com
  o ponteiro também roda — o diagnóstico do painel mediu o mesmo cartão como falha confirmada.
- **A página atual dentro do `visual-qa`** roda na política passiva, e por isso o artefato de QA
  mostra a suspeita, não a falha. As três páginas reais da seção 5 foram validadas assim.

---

## 4. Fixture e teste ponta a ponta

`test/e2e/fixtures/hover-script.html` tem quatro cartões e nenhum deles é decorativo:

1. `#script-no-keyboard` — só um ouvinte de `mouseenter` abre a lista; o cartão não é focável e não
   tem controle focável visível. **É o achado**: suspeita na página atual, falha na página
   descartável.
2. `#script-with-button` — tem ouvinte de `mouseenter` **e** um botão focável visível que abre a
   lista por clique e por tecla. Nenhum achado.
3. `#script-ancestor-key` — tem ouvinte de `mouseenter` e um ouvinte de `keydown` no `<section>`
   ancestral. Nenhum achado.
4. `#css-hover` — o caso que a sondagem da 1.1.58 cobre, agora com link focável visível e
   `:focus-within`. Serve de controle: o teclado também abre. Nenhum achado.

O cartão de controle é **sem animação de propósito**: a primeira versão usava transição de
`visibility` e a leitura de restauração pegava a animação ainda correndo (o `getComputedStyle`
dispara recálculo e a transição discreta troca no meio), o que marcava a página como alterada. Com um
`display` simples, três rodadas seguidas da sondagem fecharam em `status: complete`, `restored: true`
e página intacta.

`test/e2e/hover-script-menu-mv3.test.mjs` percorre as duas políticas em Chrome real:

- **Página atual**: o item 5.1.13 sai com 1 ocorrência, `manual-review`, texto casando com
  "script", "mouse" e "Tab"; e a página é conferida antes e depois (menus fechados, 0 eventos de
  ponteiro, rolagem e foco iguais).
- **Página descartável** (URL descartável, sem pixels): 1 ocorrência, `failed`, texto do mouse e
  **nenhuma** ocorrência falando de script.

---

## 5. Resultado em páginas reais

Rodada com `node scripts/visual-qa.mjs --no-fixture --out qa-out/hover-script-real` nas três páginas
do roteiro, mais duas rodadas de fixture: a página desta mudança servida localmente
(`test/e2e/fixtures/hover-script.html`, `qa-out/hover-script-local`) e a fixture própria do roteiro,
sem `--no-fixture` (`qa-out/hover-script-fixture`). Todas concluíram a auditoria, sem erro, e as
capturas foram abertas e conferidas (painel, sinais na página, ocorrência selecionada e relatório).

| Página | Item 5.1.13 | O que a varredura mostrou |
| --- | --- | --- |
| Portal público | **Falha confirmada**, 4 ocorrências | 21 blocos sondados: 4 falhas (as mesmas dos cartões de serviço do relatório da 1.1.58), 1 bloco com ouvinte de mouse **e** caminho de teclado (sem achado), **0** blocos de script sem teclado |
| Loja on-line 1 | **Passou**, 0 ocorrências | 5 blocos sondados, 3 com controle focável dentro, 0 com ouvinte de mouse |
| Loja on-line 2 | **Passou**, 0 ocorrências | 10 blocos sondados, **todos** com controle focável dentro, 0 com ouvinte de mouse |
| Página da fixture | **Suspeita**, 1 ocorrência | 0 falhas, 1 alerta, 1 suspeita, 8 positivos — exatamente o esperado |

**Antes e depois.** Antes desta mudança, essas páginas davam o mesmo resultado do caminho de CSS: as
4 falhas do portal e nenhum achado nas duas lojas. A mudança **não acrescentou nenhum achado nas três
páginas reais** — nem suspeita, nem falha: onde há menu de mouse, ou o bloco tem controle focável
dentro (as duas lojas), ou o caminho de teclado existe por outra via (o bloco do portal com ouvinte
de mouse e ouvinte de teclado no ancestral). O que ela acrescenta é a *capacidade* de ver o menu de
script; nas três páginas medidas não havia bloco de script sem teclado para apontar.

Falso positivo seria apontar um menu que abre por teclado, e é isso que foi conferido:

- **Loja on-line 1**: dos 5 blocos com conteúdo oculto, 3 têm gatilho focável visível e nenhum tem
  ouvinte de mouse; o item passou.
- **Loja on-line 2**: os 10 blocos têm gatilho focável visível e nenhum tem ouvinte de mouse —
  nenhum bloco entrou na segunda fase.
- **Portal público**: nenhum bloco de script foi apontado; o único bloco com indício de mouse tinha
  caminho de teclado e ficou de fora, como manda a regra.

Na sondagem isolada, aquela página ainda fechou a observação como `incomplete`, com o aviso
`PROBE_FAILED`: 4 blocos têm animação que passa do teto de medição e viram dúvida por falta de
medição, não por causa desta mudança. No relatório, as 4 falhas confirmadas ocupam o item (a
precedência da limitação 4), e nenhuma delas é de script.

Os 4 blocos apontados no portal são o caso de `:hover` de CSS já publicado na 1.1.58, e continuam
sendo barreira de verdade — foi medido por fora da extensão, com uma caminhada de Tab (`Tab` enviado
pelo protocolo, 45 vezes) na mesma página:

- os quatro cartões têm `tabIndex: -1`;
- o menu (`<ul>`) de cada um fica `visibility: hidden; opacity: 0` em repouso e **nunca** ficou
  visível durante a caminhada;
- nenhum cartão chegou a `:focus-within`, e o foco nunca entrou em um cartão;
- os links ficam dentro do menu oculto — sem `display`, não são focáveis.

Nada disso vem da mudança desta versão: o caminho de falha por `:hover`/`:focus` de CSS está
inalterado, e a regra continua lendo só a observação.

---

## 6. Limitações conhecidas

1. **A leitura de ouvintes sobe até 3 níveis de ancestral.** Um menu aberto por um ouvinte delegado
   num contêiner distante, ou por `mousemove`/`mouseout` (que não são lidos), não é detectado. O erro
   é por omissão: o bloco passa como conforme em vez de virar achado — nunca o contrário.
2. **Ouvinte no ancestral compartilhado conta como caminho de teclado.** Se um `<nav>` acima dos
   cartões tem um ouvinte de `click`, todos os blocos daquele trecho entram como "tem caminho de
   teclado" e deixam de ser apontados. Também é omissão, não falsa falha.
3. **A confirmação com o ponteiro só existe no modo interativo.** Na página atual a sondagem não mexe
   no mouse, e por isso ali o indício nunca vira falha confirmada: fica como revisão humana, que é o
   que a promessa publicada de leitura permite afirmar.
4. **Falha confirmada esconde dúvida na mesma regra.** É a convenção do projeto: quando há falha
   confirmada, os alvos de revisão do mesmo resultado não aparecem. No portal, por exemplo, as 4
   falhas de CSS ocupam o item, e uma eventual suspeita de script na mesma página não seria exibida
   junto (um teste unitário garante o lado oposto: dúvida de medição **não** esconde falha
   confirmada).
5. **A confirmação com ponteiro é limitada e conservadora**: no máximo 5 blocos por auditoria, exige
   que o ponto central esteja sobre o bloco e exige que a medição termine; quando não dá, o bloco
   continua como dúvida em vez de virar falha.
6. **O menu de script continua invisível para a sondagem de `:hover`** — o que mudou é que ele agora
   tem um caminho próprio, por leitura de ouvintes, e um motivo próprio no relatório.
7. **Tetos de cobertura**: 60 blocos na segunda fase, 200 ouvintes por bloco, 6 s de prazo próprio.
   Estourado o teto, o bloco fica **sem veredito** e a observação inteira fica `incomplete` (aviso
   `TIMEOUT`/`PROBE_FAILED`) — de novo, dúvida, nunca "passou".
8. **O artefato de `visual-qa` mostra a política passiva** (página atual). A falha confirmada do modo
   descartável foi medida no teste ponta a ponta e no diagnóstico do painel, não nas capturas do
   `visual-qa`.

---

## 7. Testes rodados

Unitários (a parte sem Chrome de `node scripts/run-tests.mjs`):

```
node --test $(find test -name '*.test.js')
```

Resultado: **4 484 provas, 4 481 passam, 2 falham, 1 pulada, 74,9 s**. As duas falhas:

- `test/release-package.test.js` — a falha de processo de release já conhecida: o ZIP reconstruído a
  partir desta árvore não bate com o hash do artefato entregue (`442ac300…` contra `8546d99f…`).
  Qualquer alteração de fonte reprova este teste, e não é efeito desta mudança.
- `test/browser/annotation-map.test.js` — *"times out a stalled bitmap allocation…"*, prova sensível a
  tempo que depende de a alocação estourar o prazo. Rodado isolado logo depois,
  `node --test test/browser/annotation-map.test.js` → **33 passam, 0 falham**: é oscilação sob a carga
  da varredura completa, em área que esta mudança não toca (mapa de anotação/captura de bitmap).

O que os arquivos desta mudança cobrem:

- `test/browser/hover-only-probe.test.js` — CDP falso que modela ouvintes: bloco com ouvinte de mouse
  e sem teclado vira `cantTell`; com teclado (no bloco, no ancestral ou por controle focável) não vira
  nada; ponteiro só é autorizado quando o modo permite; falha de leitura vira observação incompleta;
  limites e forma normalizada conferidos.
- `test/browser/hover-script-probe.test.js` — o catálogo de eventos é explícito; a classificação não
  confia na forma da lista devolvida pelo CDP; a cadeia é lida nível a nível, incluindo o ouvinte do
  ancestral; bloco sem leitura possível fica **sem veredito** em vez de "sem ouvinte", e um lote
  quebrado nunca é confundido com página limpa; níveis e blocos respeitam os limites declarados.
- `test/core/hover-only.test.js` — o motivo novo produz o texto único, o resumo próprio e o alvo
  certo; dúvida de script **não** esconde falha confirmada na mesma página; grupo sem nó
  correspondente nunca vira "passou"; todo alvo passa pelo catálogo fechado.
- `test/report/finding-kind.test.js` — o motivo entra como suspeita do alvo correlacionado e continua
  pergunta geral para outro nó; as outras dúvidas do mesmo item seguem no checklist.

Chrome real (um arquivo por vez, `AUDITA_E2E_CHROME` apontando para o Chrome for Testing):

```
node --test test/e2e/hover-script-menu-mv3.test.mjs
node --test test/e2e/hover-only-content-mv3.test.mjs
```

- `test/e2e/hover-script-menu-mv3.test.mjs` → **2 passam, 0 falham** (14,8 s): a suspeita na página
  atual com a página intacta, e a falha confirmada na página descartável.
- `test/e2e/hover-only-content-mv3.test.mjs` (da 1.1.58, sem alteração) → **1 passa, 0 falham**
  (2,5 s): o caminho de `:hover` de CSS continua o mesmo.

Portas do projeto:

```
node scripts/verify-neutral-identity.mjs
AUDITA_VERIFY_SKIP_TESTS=1 node scripts/verify-project.mjs
```

- `verify-neutral-identity` → OK (nenhum nome de órgão, domínio ou loja no que é versionado).
- `verify-project` → "manifest/CSP e axe 4.13.0 aprovados no Chrome for Testing 152.0.7977.64; mapa
  numerado aprovado; **131/146 (96/50)**, identidade neutra, HTML/JSON/PDF, fixtures e privacidade
  GREEN". A contagem de regras não muda: esta versão acrescenta um motivo, não uma regra.

---

## 8. Pendências

- `test/release-package.test.js` continua sendo a falha conhecida e reproduzível: o ZIP reconstruído a partir
  desta árvore não bate com o hash do artefato entregue. É processo de release (reconstruir o pacote e
  atualizar o hash registrado), não efeito desta mudança — qualquer alteração de fonte já reprova esse
  teste.
- A varredura completa em Chrome real (`node scripts/run-tests.mjs` com `AUDITA_E2E_CHROME`) é a
  etapa do orquestrador: aqui foram rodados os unitários e os dois arquivos de E2E desta mudança, um
  por vez, para não disputar o navegador com as tarefas paralelas.
