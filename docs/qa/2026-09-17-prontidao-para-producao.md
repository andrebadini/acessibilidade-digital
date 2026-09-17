# Prontidão para produção — Audita Acessibilidade 1.1.47

Data: 17/09/2026. Artefato: `release/audita-acessibilidade-1.1.47.zip`, digest
`2bb01b211cbf79d21fd9692f680931014d4762161d4731ab796298cade9347ac`, 199 arquivos, versão `1.1.47` no
manifesto. Chrome for Testing 152.0.7977.64, um Chrome por vez, `--test-concurrency=1`.

Esta é a versão que responde à **revisão integrada final da 1.1.45**
(`docs/qa/revisoes/REVIEW-1.1.45.md`, veredito **NÃO PRONTO**): os dois Critical da classe de credencial foram
fechados na **1.1.46** (verificados pelo próprio revisor) e o **Important I-1** do percurso de pixel é o que a
**1.1.47** endereça, com a fronteira declarada em §2.

## 1. Estado dos 12 critérios de conclusão

| # | Critério | Estado | Evidência principal |
| --- | --- | --- | --- |
| 1 | Percurso principal funciona no Chrome sem instabilidade | **Atendido** | `mandatory-journey-mv3` e `current-page-export-mv3` a partir dos bytes empacotados (escopo de 13 arquivos no zip: **59/59**); auditoria ao vivo no Google concluída, painel estável |
| 2 | Relatório abre e exportações funcionam | **Atendido** | quatro exportações `complete` na auditoria ao vivo do pacote, relatório em aba própria, versão **1.1.47** declarada no artefato |
| 3 | Destaque corresponde ao elemento e documento corretos | **Atendido** | `highlight-marking-mv3` e `page-markers-signals-mv3`, com caixa sobre o elemento e correlação de documento (no zip) |
| 4 | A inspeção automática não altera visivelmente a página | **Atendido** | medição com contadores de evento e observador de mutações: 0 eventos, 0 mutações, geometria/rolagem/foco idênticos; limite declarado: captura de regiões fora da viewport |
| 5 | Evidências autorizadas, corretas e correlacionadas | **Atendido** | `url-pixel-consent-mv3` **10/10** e `batch-pixel-consent-mv3` no zip: consentimento one-shot, prova de documento antes de cada raster, zero vínculo entre documentos, limpeza só do que é da auditoria |
| 6 | Contagens distinguem falhas, suspeitas e checklist | **Atendido** | artefatos entregues com os quatro grupos separados e **109** verificações no checklist; 0 frases de "Inconformidade ao item" contra 112 "Verificar o item"; PDF de 18 páginas (o defeito histórico de 700+ páginas não se reproduz) |
| 7 | Conclusões ABNT respeitam obrigatoriedade, alternativas e limites | **Atendido** | 146 itens (96 requisitos + 50 recomendações) conferidos contra o PDF da norma; amostra conferida nos dois sentidos; 5.9.7 não produz `failed` por desenho |
| 8 | Interface e relatório claros para leigos | **Parcial por decisão do usuário** | os seis blocos didáticos estão no relatório entregue; não houve teste com pessoa de fora, e o usuário decidiu que isso não bloqueia (2026-09-16) |
| 9 | Recursos obrigatórios implementados | **Atendido** | rastreabilidade recurso a recurso registrada nos critérios (campo de URL, auditoria da página aberta, refazer, progresso, relatório em aba, filtros, agrupamento por item, destaques, personas, anúncios estimados com aviso honesto, menu de contexto como atalho, lote, vocabulário e checagens pt-BR, quatro exportações, sem login) |
| 10 | Sem falha Critical/Important conhecida | **Atendido com ressalva declarada** | a classe de credencial foi **aprovada** na 1.1.44; os 2 Critical da revisão final da 1.1.45 foram fechados na **1.1.46** (`NOVOS vs 1.1.44 = 0` no corpus de 896 formas; resíduo `secreto*` **0/182**). O **I-1** exigia que a revogação do modo de pixel **nunca** terminasse em silêncio: a **1.1.47** entrega a mensagem explícita e o oráculo que a mede nos dois sentidos (§2). **Ressalva:** numa página **sem** sinal sensível a auditoria ainda é **revogada** — o percurso de pixel da página atual não chega a começar —, e a **causa raiz dessa revogação continua não medida** (a hipótese de ordenação do bootstrap foi **refutada** pela revisão; ver §2). O arquivo é do incremento paralelo. O que a 1.1.47 mudou é que a falha **explica** por que não começou |
| 11 | Achados menores documentados | **Atendido** | `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md` com desfecho por achado, de 1.1.16 a 1.1.45 |
| 12 | Versão empacotada testada em Chrome real | **Atendido** | suíte completa: fase paralela **4.225 testes, 4.224 passam, 0 falham, 1 pulado**; fase serial **111 testes, 101 passam, 10 falham** — **9** delas em `test/e2e/sidepanel-flow-mv3.test.mjs` (arquivo do incremento paralelo) e **1** a flake declarada `axe-mv3-csp`; o conjunto caiu de **12 para 10** contra a medição anterior do mesmo dia, sem nenhuma falha nova. Escopo de 13 arquivos na raiz extraída do zip: **59/59**. Gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` **GREEN**. Auditoria ao vivo do pacote no Google e integridade dos quatro artefatos: §3.1 |

## 2. O Important I-1: o que a 1.1.47 fecha e o que continua com o incremento paralelo

**O achado, como a revisão final o mediu.** Com `element-only` ou `full-evidence`, "Auditar a página atual"
leva a tela a `running` e, em menos de um segundo, ao neutro ou a `reconnecting`; a confirmação de captura nunca
aparece, nenhum trabalho é criado e **o usuário não recebe mensagem alguma**. Numa página **com** sinal sensível
o mesmo percurso **funciona** (pausa, confirma e conclui), o que refuta o diagnóstico anterior deste dossiê
("o percurso não começa"). A prova exigida passou a ser binária: **ou a confirmação, ou uma mensagem explícita —
nunca o retorno silencioso ao neutro**.

**O que a 1.1.47 entrega (medido nos dois sentidos).**

| Medida | Comando | Resultado |
| --- | --- | --- |
| Oráculo novo nesta árvore | `node --test test/e2e/current-page-pixel-abort-mv3.test.mjs` | **2/2**, ~2 s por modo, tela `unavailable` com o motivo |
| Oráculo novo na raiz extraída do **pacote 1.1.47** | `AUDITA_EXT_PATH=/private/tmp/adv164/run147 node --test …` | **2/2**, ~2 s por modo |
| Não vacuidade (bytes da **1.1.46**) | `AUDITA_EXT_PATH=/private/tmp/adv162/run node --test …` | **0/2** — reprova e imprime a trajetória `running` → `reconnecting` → `initial` |
| Caminho do cancelamento preservado | `node --test test/e2e/url-pixel-consent-mv3.test.mjs` | **10/10**; o caso do cancelamento em **1,3 s** (era `WAIT_TIMEOUT` de 31 s com a fronteira larga) |
| Painel | `node --test "test/panel/*.test.js"` | **260/260** |
| Suíte completa | `npm test` | paralela **4.225/4.224/0** (1 pulado); serial **111/101/10**, conjunto de falhas **12 → 10**, zero novas |

**A fronteira, e a regressão que ela custou.** A primeira versão disparava a mensagem para qualquer bootstrap
ocioso com o painel em `running` e **quebrou** o cancelamento durante a pausa (`url-pixel-consent-mv3`,
`WAIT_TIMEOUT` de 31 s). A segunda usou `shouldShowPanelStartFailure` (`running` sem `auditId`) e falhou do
outro lado. Uma cópia instrumentada mediu que, na revogação, o bootstrap ocioso chega **com `auditId` já
preenchido** pelos pacotes de progresso; o que separa os dois desfechos é o **pedido do usuário**
(`cancellationRequested`). O detalhamento está em `docs/qa/2026-09-17-percurso-pixels-pagina-atual.md` (seção
"CONSERTO … 1.1.47") e na rodada 93 de `docs/qa/2026-09-13-continuity-and-e2e-triage.md`.

**O que continua aberto, com dono declarado — e o que a revisão REFUTOU sobre a causa.** A causa raiz continua
**não medida**. A hipótese que este dossiê declarava antes ("o registro `audita:panel-bootstrap:v1:<windowId>` é
publicado depois da suspensão") foi **refutada pela revisão final da 1.1.45**, que leu a árvore: em
`beginAuthorizedAudit` o `registerPendingBootstrap` (linha 2326) e o `publishRegisteredBootstrap` (2356) rodam
**antes** de `execute()` (2385), que é onde o portão de privacidade pausa — a ordem estava **invertida**. O que
a revisão mediu no lugar: sem sinal sensível a auditoria é **revogada** (`session:"revoked"`,
`target-capability:"invalidated"`), **sem** `active-audit-job`, **sem** `panel-bootstrap` e **sem**
`pixel-capture` — não é "pausa sem registro": **não há pausa alguma**. Quem for consertar precisa medir a
**revogação** (o que a dispara), não a ordem do bootstrap. O arquivo `src/background/authorized-audit-starter.js`
é **congelado** do incremento paralelo "Página atual sem interação visível"; editá-lo por cima violaria a regra
de nunca editar os mesmos arquivos em paralelo. O histórico do diagnóstico, com a retratação, está em
`docs/qa/2026-09-17-percurso-pixels-pagina-atual.md`.

## 3. Resíduos declarados (medidos; nenhum é vazamento)

- **Identificador ambíguo:** em `id`/`classe` que contém radical de credencial o conteúdo é tratado como valor
  (decisão de produto em `docs/qa/2026-09-17-decisao-identificador-ambiguo.md`). Preço medido: 20 de 25 ids do
  corpus PT-BR do revisor (15 são rótulo de credencial de verdade) e **99** palavras do dicionário perdem texto
  na medição do autor — o revisor da 1.1.45 mediu **91** no método dele; a diferença é de método, não de código.
- **Contagem de palavras partidas:** o instrumento de integridade conta **0 palavras partidas** e **24 quebras
  em hífen legítimo** (por exemplo `acessibi-` + `lidade`), que não são palavras partidas — a distinção passou a
  ser explícita depois do Minor M-2 da revisão final.
- **Outros:** rótulo em `name`/`aria-label`/`autocomplete`/`data-*` e em nós irmãos; formas literais
  `id="sen&#104;a"`/`id="sen\nha"`/`id="sen%68a"` (inalcançáveis pelo `DOM.getOuterHTML`); radicais curtos sem
  cobertura de chave (`puk…`, ~100 formas, mesmo número da 1.1.40); `codigo*`/`conta*`; `api.key`;
  `private_key`; `chave·de·api`; separadores exóticos; 10 rótulos artificiais `pix-<família>` em prosa.
- **Captura:** `captureBeyondViewport` altera a geometria real no Chrome 152; o produto usa
  `captureBeyondViewport=false` quando o recorte cabe na viewport e declara o limite para regiões fora dela.
- **5.9.1:** a automação da identificação visual do campo continua `cantTell` agregado (um só, `targets=[]`),
  sem produtor de evidência visual suficiente — declarado, não é falso positivo nem falso negativo.
- **Campo customizado com nome vazio:** cobertura pendente, com a fronteira de privacidade preservada.
- **Divergência interna da norma (M-1):** a seção 5 imprime `5.12.1 Espaçamento entre as linhas` e o **Anexo C**
  imprime `5.1.12`; o catálogo guarda os dois (`id` da seção e `printedId` do anexo) com nota editorial.
- **Clareza para leigos (M-3):** "Limitações registradas (6)" com 5 marcadores, códigos em CAPS, termos em
  inglês e "Nome acessível: ." ficam no backlog de apresentação; o critério 8 é Parcial por decisão do usuário.
- **"Validações brasileiras" (M-4):** o produto tem vocabulário e checagens pt-BR, NBR 17225, Libras e CDC, mas
  **não** um validador de CPF/CNPJ; a rastreabilidade do critério 9 diz exatamente isso.

### 3.1 Auditoria ao vivo do pacote e integridade dos artefatos

Auditoria executada **a partir da raiz extraída do pacote 1.1.47** (`/private/tmp/adv164/run147`), em
`https://www.google.com/`, modo **sem pixels**, 17/09/2026 20:10 UTC, Chrome for Testing 152.0.7977.64,
viewport 1266×757:

| Medida | Valor |
| --- | --- |
| Versão declarada no artefato | **1.1.47** |
| Falhas confirmadas | **0** (0 ocorrências) |
| Verificações sob revisão humana | **3** (4 ocorrências) |
| Resultados positivos | **9** |
| Checklist ainda sem conclusão | **109** |
| Cobertura automática / índice técnico | **28,5 %** (denominador 130) / **9,0 de 10** |
| Exportações | quatro, `complete` (HTML 339.209 B, PDF 1.006.016 B, CSV 86.142 B, JSON) |
| Frases legais indevidas / aviso de estimativa | **0** "Inconformidade ao item" / aviso de anúncio estimado presente |
| Integridade (instrumento `artcheck133.py`) | **146 itens, 146 ids únicos, 146 títulos**; 0 ids e 0 títulos ausentes no HTML **e** no PDF; notas editoriais **5/5** nos dois; **0 palavras partidas**; **0 `[redacted]`** no JSON e no HTML; 11 snippets (5.228 caracteres) |

O CSV não carrega a matriz completa de 146 itens (34 ids e 36 títulos "ausentes" nele) — é o mesmo número da
1.1.46 medida com o mesmo instrumento, e é o desenho do formato: o CSV entrega as ocorrências, não o dossiê
item a item.

## 4. O que falta para "produção", em uma frase

Falta **uma** coisa funcional que não é deste incremento — entender e corrigir a **revogação** que faz o
percurso de pixel da página atual não começar numa página sem sinal sensível, dentro de
`authorized-audit-starter.js`, arquivo congelado do incremento paralelo (a falha **silenciosa** já está fechada, e
a hipótese de ordenação antes declarada aqui foi **refutada** pela revisão) — e **uma** formalidade: a
re-verificação independente deste artefato. Fora isso, o produto está construído, medido e documentado — e
**nada foi publicado**: distribuição exige autorização específica do usuário.
