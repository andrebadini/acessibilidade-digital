# Conteúdo interativo que só aparece com o mouse — 1.1.58

Versão alvo: 1.1.58 (branch `wip/hover`), sobre a base da 1.1.57 — o `manifest.json` ainda declara
1.1.57, porque a subida de versão acontece no processo de release.
Data da validação: 2026-10-14. Chrome for Testing 152.0.7977.64, janela 1280×900.

Motivação: um portal público de serviços traz quatro cartões (`<div class="service">`) cujo menu de
links (`<ul>`) fica oculto e só aparece no `:hover`. O cartão não é focável, não existe regra de
`:focus` nem de `:focus-within` e nenhum controle de teclado abre a lista. Quem navega por TAB nunca
alcança aqueles links. É a falha do item **5.1.13 — Acessibilidade por teclado parcial** (ABNT NBR
17225), ligada ao critério **WCAG 2.1.1 (Teclado)**.

Escopo: nova coleta por `CSS.forcePseudoState`, nova regra do motor próprio, testes unitários, teste
ponta a ponta em Chrome real, e validação na página real. Este documento registra o que foi medido,
o defeito encontrado na própria sondagem durante a validação e as limitações que permanecem.

---

## 1. O que mudou

| Peça | Arquivo | Papel |
| --- | --- | --- |
| Coleta | `src/browser/hover-only-probe.js` (novo) | Descobre os blocos com conteúdo interativo oculto, força `:hover` e `:focus` pelo motor de estilo, mede e desfaz |
| Regra | `src/core/rules/hover-only.js` (novo) | `hover-only-interactive-content`, lê só a observação já anexada ao snapshot |
| Gancho | `src/background/run-audit.js:29` e `:988` | Importa e chama `applyHoverOnlyProbe(state.snapshot, cdp, { signal })` |
| Norma | `src/core/normative/nbr17225.js:61` | Item 5.1.13 passa a listar também `hover-only-interactive-content` |
| Remediação | `src/core/report/remediation-policy.js:312-319` | Três motivos registrados no catálogo fechado |
| Contagem | `scripts/verify-project.mjs:63` | 130 → 131 regras próprias; a mensagem final passa a dizer `131/146 (96/50)` |
| E2E | `test/e2e/hover-only-content-mv3.test.mjs` (novo), registrado em `scripts/run-tests.mjs:33` | Percorre ação → painel → auditoria da página atual → relatório → sinais |
| Fixture | `test/e2e/fixtures/hover-only.html` (novo) | Três cartões: só-mouse (animado), com `:focus-within`, com botão focável visível |

A regra entra no motor pelas mesmas portas das outras: nenhum caminho especial no painel, no relatório
ou nos sinais na página. O que ela produz é uma ocorrência comum, com `nodeId` do snapshot, evidência
de elemento e sinal numerado — e por isso as auditorias antigas continuam abrindo: sem a observação
`document.hoverOnlyObservation` no snapshot, a regra devolve `cantTell` e não inventa falha
(`test/core/hover-only.test.js`, caso "an observation that was not collected … stays cantTell").

---

## 2. Como a coleta funciona

1. **Descoberta** (`Runtime.evaluate` autocontido): lista elementos interativos ocultos
   (`a[href]`, `button`, `input`, `select`, `textarea`, `[tabindex]`, `[contenteditable]`,
   `[role=link|button|menuitem|tab]`) e sobe até 6 níveis de ancestral procurando o bloco visível mais
   próximo que os esconde. O correlato é o caminho de índices, não um seletor: nada depende de
   unicidade nem de escape. Cada candidato carrega o caminho do alvo dentro do bloco.
2. **Sondagem por bloco** (`CSS.forcePseudoState`, que exige `DOM.enable` + `CSS.enable` e um
   `DOM.getDocument({depth:0})` de aquecimento): aplica `['hover']`, mede quantos alvos ficaram
   visíveis, **desfaz com `[]` no `finally`**; se algo aparece no hover, aplica `['focus']` nos
   controles focáveis do bloco e mede de novo.
3. **Classificação**: aparece no hover + nada focável no bloco → `failed`; aparece no hover e aparece
   no foco → `passed`; aparece no hover, tem controle focável e o foco não revela → `cantTell`; a
   animação não terminou dentro do teto → `cantTell` com motivo próprio.
4. **Restauração**: `verifyRestored` reconfere cada bloco depois da última liberação e, se algo
   continuar aberto, marca `restored: false` e a observação fica `incomplete` em vez de "tudo certo".

Nada de evento de ponteiro, nada de JavaScript do site, nada de mutação de DOM, atributo ou texto. É
por isso que a sondagem vale também no modo da página atual, onde a promessa publicada é de inspeção
somente leitura.

Limites (`HOVER_ONLY_PROBE_LIMITS`): 6 níveis de ancestral, 60 blocos, 20 alvos por bloco, 20 000
candidatos, 600 ms de espera por transição, 20 s de prazo total. Estourado o prazo, a observação fica
`incomplete` e a regra devolve dúvida — nunca um "passou" silencioso.

---

## 3. O defeito que a validação real revelou na própria sondagem

Na primeira rodada no portal, o item 5.1.13 saiu **`passed`, com zero ocorrências** — exatamente o
falso negativo que a tarefa existia para eliminar. Causa, medida com o diagnóstico
`/tmp/diag-portal6.mjs` (fora do repositório), depois de `CSS.forcePseudoState(['hover'])` no cartão:

```
FORÇANDO   0ms=hidden|0|454   55ms=visible|0.384|462   210ms=visible|0.99999|474   262ms=visible|1|474
DESFAZENDO 0ms=visible|1|474  157ms=visible|0.131|457  210ms=hidden|0|454
```

(`visibility | opacity | altura do <ul>`, amostrado a cada ~50 ms.)

O CSS do portal declara `.service ul { transition: opacity, padding, visibility / 0.2s }` e
`.service:hover { transition: 0.3s !important }`. **O estado forçado não vale no mesmo instante em que
é forçado**: a leitura imediata ainda devolve `visibility: hidden`; o valor só vira `visible` por volta
de 55 ms, `opacity` chega a 1 por volta de 210 ms e a altura final (454 → 474 px, o `padding` de 20 px)
só se completa por volta de 262 ms. A sondagem media imediatamente, então "provava" que nada aparecia.
No mesmo sentido, ao liberar o hover, a lista só voltava a `hidden` por volta de 210 ms — o que
também poderia reprovar a restauração de uma página que ficou limpa. Antes da correção, o diagnóstico
`/tmp/diag-portal5.mjs` já tinha mostrado o mesmo em uma leitura só: logo após forçar, `block/hidden`
com 0 links visíveis; 400 ms depois, `block/visible` com 5 links.

Correção (em `src/browser/hover-only-probe.js`):

- `pendingMs` lê `element.getAnimations()` com `effect.getComputedTiming()` e soma duração + atraso.
  Isso é legível **no mesmo instante** em que o estado é forçado, porque a própria leitura de
  `getComputedStyle` faz o recálculo que cria as `CSSTransition`. A sondagem só espera quando há
  animação de verdade, em vez de esperar sempre.
- `measureSettled` mede, e se algo ainda anima e nem tudo apareceu, espera até `maxSettleMs` (600 ms) e
  mede de novo, ficando com o maior número de alvos visíveis das duas leituras.
- Animação que ultrapassa o teto → grupo `unsettled: true` → regra devolve `cantTell` com o motivo
  `hover-only-observation-unavailable` ("a medição não terminou"), e **não** "passou". São duas dúvidas
  diferentes e com textos diferentes: `hover-only-observation-unavailable` fala da medição;
  `hover-only-keyboard-path-unconfirmed` fala do controle focável que não revelou o conteúdo.
- `verifyRestored` espera o fecho da transição antes de julgar restauração, pela mesma razão.

Total acrescentado ao caminho de auditoria no portal: 4 blocos animados × ~300 ms por fase (o teto
que o próprio CSS da página declara), cerca de 1 s a mais, bem dentro do prazo de 20 s.

---

## 4. Resultado na página real (portal público)

Comando, nas duas rodadas:

```
node scripts/visual-qa.mjs --no-fixture --out qa-out/<destino> --url <portal público>
```

| Medida | Antes da correção (`qa-out/hover`) | Depois (`qa-out/hover2`) |
| --- | --- | --- |
| Cartão 5.1.13 no painel | `passed`, 0 ocorrências | **`failed`, 4 ocorrências** |
| Elementos sinalizados | 42 | 46 |
| Ocorrências localizadas | 55 | 59 (+4) |
| Questões gerais | 6 | 6 |
| Ocorrências não localizadas | 17 | 17 |
| Achados com elemento | 72 | 76 |

Os quatro cartões entram como ocorrência, um sinal cada: **Sinais 18, 19, 20 e 21**, com o rótulo
"Sinal N: falha registrada na auditoria, 1 ocorrência. Abrir no painel." e o `checkKey`
`["page-1","audita-core","hover-only-interactive-content"]`.

### 4.1 O contorno cai sobre o cartão certo

Com os sinais ligados e a página rolada até a seção (os cartões ficam abaixo da dobra na abertura), o
diagnóstico `/tmp/diag-signals2.mjs` mediu cada contorno contra os quatro retângulos de cartão:

| Sinal | Caixa do contorno | Sobreposição por cartão (1º, 2º, 3º, 4º) |
| --- | --- | --- |
| 18 | `[100, 852, 235, 170]` | `1, 0, 0, 0` |
| 19 | `[330, 852, 235, 170]` | `0, 1, 0, 0` |
| 20 | `[559, 852, 235, 170]` | `0, 0, 1, 0` |
| 21 | `[330, 1017, 235, 170]` | `0, 0, 0, 1` |

Sobreposição 1,0 com o próprio cartão e 0,0 com todos os outros: o número não fica solto, o contorno
cobre o bloco defeituoso inteiro (o cartão mede 225×160; o contorno, 235×170, isto é, 5 px de folga de
cada lado).

### 4.2 A página continua como estava

Depois da auditoria, com os sinais ligados:

```
visibilidade das listas depois da auditoria: ["hidden","hidden","hidden","hidden"]
```

As quatro listas seguem fechadas. A sondagem forçou `:hover` nos quatro cartões e desfez em todos.

---

## 5. Fixture e teste ponta a ponta

`test/e2e/fixtures/hover-only.html` monta os três casos que interessam:

- `#so-mouse` — lista escondida por `visibility` **animada** (`transition: opacity .2s, visibility .2s`,
  e `.service--hover:hover { transition: .3s !important }`, imitando o portal), cartão não focável;
- `#com-foco` — mesma coisa, mas com `:focus-within` abrindo a lista;
- `#com-botao` — com um controle focável visível que já abre a lista.

O teste (`test/e2e/hover-only-content-mv3.test.mjs`, timeout 300 s) roda o caminho real e reprova se
qualquer uma das promessas cair:

- estado inicial `so-mouse: block/hidden`, `com-foco: none/visible`, `com-botao: none/visible`, e zero
  raízes de sinal na página antes da auditoria;
- o relatório traz **um único** cartão com 5.1.13, `classification: "failed"`, **1 ocorrência**, e o
  texto não pode citar `com-foco`, `com-botao`, "Protocolos" nem "Agendamentos" (os cartões sãos não
  podem virar falha);
- o texto de correção da ocorrência fala em mouse, teclado/TAB e foco, sem vazar código interno
  (`hover-only`, `not-keyboard-reachable`, `undefined`);
- com os sinais ligados, o sinal do cartão defeituoso está desenhado e o contorno sobrepõe o cartão em
  pelo menos 50%;
- depois de tudo, `display/visibility` das três listas, `scroll` e `focus` são **idênticos** ao estado
  inicial — a prova de que o hover forçado não ficou aplicado.

O caso animado é justamente o que a primeira versão do teste não pegava: o cartão 1 foi reescrito com
transição depois do falso negativo do portal, para a suíte reprovar se a espera for removida. Prova
disso (teste de mutação, executado uma vez e desfeito): trocando a espera da transição por zero
(`const budgetMs = min(pending, maxSettleMs)` → `0`), o e2e **reprova** em 32 s com `WAIT_TIMEOUT`
exatamente na asserção que exige o cartão como falha confirmada
(`test/e2e/hover-only-content-mv3.test.mjs:106`); com a espera no lugar, passa em 2,6 s. O arquivo foi
restaurado byte a byte (`diff` vazio) e o teste repetido depois da restauração: passa.

A fixture do `visual-qa` (página `marcacao.html`) não tem conteúdo só-mouse, e o item sai `passed` com
0 ocorrências ali — 46 elementos sinalizados, 121 ocorrências localizadas, 0 não localizadas. Serve de
contraprova de que a regra nova não transforma página comum em falha (`qa-out/hover-fixture`).

---

## 6. Checagem de falso positivo em site de comércio

Rodada contra `https://www.mercadolivre.com.br` — página densa em menus, submenus e cartões que abrem
no hover, o cenário mais provável de falso positivo.

O site **se recarrega sozinho** depois de abrir; a auditoria iniciada imediatamente aborta com o painel
em `unavailable` ("A página recarregou ou mudou durante a auditoria"). Esperando ~15 s a página
sossegar antes de começar, a auditoria conclui e o item 5.1.13 sai **`passed`, 0 ocorrências**, com o
texto "Resultado positivo / sem impacto associado / ABNT 5.1.13 / WCAG 2.1.1" — nenhum falso positivo.
Os outros cartões do painel seguem o que já se espera daquela página: falha confirmada em "Texto
visível no nome acessível", revisões manuais (contraste, título, idioma) e as demais regras de teclado
passando.

(`node scripts/visual-qa.mjs` naquele domínio terminou com `mostrar-sinais: WAIT_TIMEOUT` e
`sinais-indisponiveis` — a etapa de sinais do `visual-qa` não completou naquela página. É o mesmo
comportamento já observado antes desta tarefa em páginas muito pesadas e não tem relação com a regra
nova; a checagem de classificação foi feita pelo diagnóstico dedicado, que lê o cartão do painel.)

---

## 7. Limitações conhecidas

1. **Hover por JavaScript não é detectado.** A sondagem força a pseudo-classe no motor de estilo. Se a
   página revela o conteúdo por script (`mouseenter` → `style.display = 'block'`), não há evento de
   ponteiro e o bloco não é classificado como falha. A regra continua sendo a de conteúdo revelado por
   `:hover`/`:focus` de CSS.
2. **Animação mais longa que 600 ms vira dúvida, não falha.** É deliberado: "não deu para medir" não é
   "está certo". Nesses casos o texto manda confirmar com TAB e o motivo é
   `hover-only-observation-unavailable`.
3. **A busca para no 6º ancestral.** Um bloco visível que esconda o conteúdo a mais de 6 níveis acima
   do elemento interativo não é encontrado.
4. **Tetos de cobertura**: 60 blocos, 20 alvos por bloco, 20 000 candidatos, 20 s. Estourado, a
   observação fica `incomplete` e o item vira dúvida — nunca passa em silêncio.
5. **O contorno do sinal só é desenhado dentro da área visível.** A camada de sinais recorta a caixa
   pelo retângulo do viewport e devolve `null` quando o recorte fica vazio: elementos abaixo da dobra
   ganham número no painel, mas o anel só aparece depois de rolar até eles — foi exatamente o que
   aconteceu no portal, onde os cartões ficam abaixo da dobra. É comportamento preexistente da
   camada de sinais, não da sondagem; os sinais 18–21 só foram medidos depois de rolar a página.
6. **`visual-qa` naquela página**: as etapas `selecionar-1..3` terminam em `WAIT_TIMEOUT` e a lista de
   destaques ao vivo sai vazia, nas duas rodadas (antes e depois da correção) e também na fixture —
   comportamento preexistente do modo passivo dentro do `visual-qa`, sem relação com esta mudança. O
   que interessa aqui foi medido por fora dele: os quatro sinais da seção 4.1 e a classificação da
   seção 6.
7. **A validação real foi feita em uma página** (a que motivou a tarefa) e em um site de comércio para
   falso positivo. Padrões de hover mais exóticos (por exemplo conteúdo revelado por `:hover` em um
   ancestral distante combinado com `pointer-events`) não foram exercitados em página real.

---

## 8. Testes rodados

Unitários e integração:

```
node scripts/run-tests.mjs
```

- `test/browser/hover-only-probe.test.js` — FakeCdp que modela transição: cartão animado continua
  **falha confirmada** com `restored: true`; animação que passa do teto vira dúvida com
  `unsettled: true`; caso sem animação faz exatamente 2 leituras (hover + restauração), provando que a
  espera só acontece quando há o que esperar; limites conferidos; forma normalizada do grupo conferida.
- `test/core/hover-only.test.js` — mapeamento 5.1.13 + WCAG 2.1.1, falha com texto em linguagem
  simples, falha confirmada sobrevive a dúvida vizinha, dúvida de medição não se confunde com dúvida
  de controle focável, snapshot sem observação vira `cantTell`, grupo sem nó correspondente nunca vira
  "passou", e todo alvo produzido passa por `validateCoreRuleTargetInventory` (catálogo fechado).

Chrome real:

```
AUDITA_E2E_CHROME="…/Google Chrome for Testing" node scripts/run-tests.mjs
```

- `test/e2e/hover-only-content-mv3.test.mjs` — passa em 2,6 s, com as asserções da seção 5, tanto na
  varredura quanto isolado (`node --test test/e2e/hover-only-content-mv3.test.mjs`). Com a espera da
  transição neutralizada, o mesmo arquivo reprova (seção 5, teste de mutação).
- `scripts/verify-neutral-identity.mjs` — "identidade neutra: OK".
- `AUDITA_VERIFY_SKIP_TESTS=1 node scripts/verify-project.mjs` — "manifest/CSP e axe 4.13.0 aprovados
  no Chrome for Testing 152.0.7977.64; mapa numerado aprovado; **131/146 (96/50)**, identidade neutra,
  HTML/JSON/PDF, fixtures e privacidade GREEN". (A suíte de testes já havia sido rodada à parte; a
  variável só evita repeti-la.)

Os dois arquivos unitários novos, rodados isolados depois da mutação desfeita:
`node --test test/browser/hover-only-probe.test.js test/core/hover-only.test.js` → **31 passam, 0
falham**.

## 9. Resultado da varredura completa e pendências

`node scripts/run-tests.mjs` com `AUDITA_E2E_CHROME` apontando para o Chrome for Testing, em duas
fases:

| Fase | Passaram | Falharam | Pulados | Duração |
| --- | --- | --- | --- | --- |
| Unitários/integração (paralelo) | 4 444 | 1 | 1 | 42,9 s |
| Chrome real (serial) | 131 | **0** | 0 | 754,9 s |

Todas as 131 provas em Chrome real passaram — inclusive `hover-only-content-mv3` e o teste de
marcação original (`original-page ABNT markers remain usable across idle and preserve the report`),
que em uma varredura anterior havia falhado por disputa de foco de janela entre sessões de Chrome na
máquina e que, isolado, já passava.

- Falha conhecida, única: `test/release-package.test.js` — o ZIP reconstruído a partir desta árvore não
  bate com o hash do artefato entregue (`b03adbe1…` contra `58955cc1…`). É o item de processo de
  release já pendente: o pacote `release/audita-acessibilidade-1.1.57.zip` precisa ser reconstruído e o
  hash registrado atualizado quando a release sair. Não é efeito desta mudança — a mudança acrescenta
  arquivos, e qualquer alteração de fonte já reprova esse teste.
- O teste pulado é deliberado e traz a justificativa no próprio nome: cobre um ponto de entrada
  removido no commit `1c9b296`.
- Nenhuma outra falha da suíte é atribuída a esta tarefa.

Pendente para a release:

1. Reconstruir o pacote público e atualizar o hash registrado no teste (item acima).
2. Nada pendente de código para esta funcionalidade: módulo, gancho, regra, catálogo, teste unitário,
   fixture, e2e e validação real estão fechados.
