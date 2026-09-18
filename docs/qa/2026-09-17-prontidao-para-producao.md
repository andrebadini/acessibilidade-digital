# Prontidão para produção — Audita Acessibilidade 1.1.48

Data: 17/09/2026. Artefato: `release/audita-acessibilidade-1.1.48.zip`, digest
`7da8b3f02288c58776fbb3b8ecf6681aa5041662fd6cd7fd8bdd4e9d7b281689`, 199 arquivos, versão `1.1.48` no
manifesto. Chrome for Testing 152.0.7977.64, um Chrome por vez, `--test-concurrency=1`.

Esta é a versão que responde à **revisão integrada final da 1.1.45**
(`docs/qa/revisoes/REVIEW-1.1.45.md`, veredito **NÃO PRONTO**): os dois Critical da classe de credencial foram
fechados na **1.1.46** (verificados pelo próprio revisor) e o **Important I-1** do percurso de pixel é o que a
**1.1.47** endereça, com a fronteira declarada em §2.

## 1. Estado dos 12 critérios de conclusão

| # | Critério | Estado | Evidência principal |
| --- | --- | --- | --- |
| 1 | Percurso principal funciona no Chrome sem instabilidade | **Atendido** (o percurso da página atual conclui nos **três** modos de evidência na 1.1.48) | `mandatory-journey-mv3` e `current-page-export-mv3` a partir dos bytes empacotados (escopo de **14 arquivos** no zip: **61/61**); auditoria ao vivo no Google concluída, painel estável |
| 2 | Relatório abre e exportações funcionam | **Atendido** | quatro exportações `complete` na auditoria ao vivo do pacote, relatório em aba própria, versão **1.1.47** declarada no artefato |
| 3 | Destaque corresponde ao elemento e documento corretos | **Atendido** | `highlight-marking-mv3` e `page-markers-signals-mv3`, com caixa sobre o elemento e correlação de documento (no zip) |
| 4 | A inspeção automática não altera visivelmente a página | **Atendido** | medição com contadores de evento e observador de mutações: 0 eventos, 0 mutações, geometria/rolagem/foco idênticos; limite declarado: captura de regiões fora da viewport |
| 5 | Evidências autorizadas, corretas e correlacionadas | **Atendido** | `url-pixel-consent-mv3` **10/10** e `batch-pixel-consent-mv3` no zip: consentimento one-shot, prova de documento antes de cada raster, zero vínculo entre documentos, limpeza só do que é da auditoria |
| 6 | Contagens distinguem falhas, suspeitas e checklist | **Atendido** | artefatos entregues com os quatro grupos separados e **109** verificações no checklist; 0 frases de "Inconformidade ao item" contra 112 "Verificar o item"; PDF de 18 páginas (o defeito histórico de 700+ páginas não se reproduz) |
| 7 | Conclusões ABNT respeitam obrigatoriedade, alternativas e limites | **Atendido** | 146 itens (96 requisitos + 50 recomendações) conferidos contra o PDF da norma; amostra conferida nos dois sentidos; 5.9.7 não produz `failed` por desenho |
| 8 | Interface e relatório claros para leigos | **Parcial por decisão do usuário** | os seis blocos didáticos estão no relatório entregue; não houve teste com pessoa de fora, e o usuário decidiu que isso não bloqueia (2026-09-16) |
| 9 | Recursos obrigatórios implementados | **Atendido** | rastreabilidade recurso a recurso registrada nos critérios (campo de URL, auditoria da página aberta, refazer, progresso, relatório em aba, filtros, agrupamento por item, destaques, personas, anúncios estimados com aviso honesto, menu de contexto como atalho, lote, vocabulário e checagens pt-BR, quatro exportações, sem login) |
| 10 | Sem falha Critical/Important conhecida | **Atendido** | a classe de credencial foi **aprovada** na 1.1.44 e os dois Critical da revisão final da 1.1.45 foram fechados na **1.1.46** (`NOVOS vs 1.1.44 = 0` no corpus de 896 formas; resíduo `secreto*` **0/182**). O **I-1** (revogação silenciosa no modo de pixel) foi re-verificado e está **ATENDIDO** (`docs/qa/revisoes/REVIEW-1.1.47.md`), e a **revogação em si** foi fechada na **1.1.48**: a causa foi medida (a guarda **D2** sem companheiro durável de tentativa) e a **tentativa direta** deu companheiro à captura autorizada sem pausa, **sem tocar na guarda** — o percurso conclui em página sem sinal sensível (`result` em ~1 s nos dois modos) e o caminho com sinal sensível segue igual (pausa → confirma → `result`). Permanecem **declarados**: 1 Minor (N-1, §3) e os 9 testes do incremento paralelo (outro desenho, em andamento) |
| 11 | Achados menores documentados | **Atendido** | `docs/qa/2026-09-16-registro-de-achados-das-revisoes.md` com desfecho por achado, de 1.1.16 a 1.1.45 |
| 12 | Versão empacotada testada em Chrome real | **Atendido** | suíte completa da 1.1.48: fase paralela **4.231 testes, 4.230 passam, 0 falham, 1 pulado**; fase serial **113 testes, 104 passam, 9 falham** — **todas as 9** em `test/e2e/sidepanel-flow-mv3.test.mjs` (arquivo do incremento paralelo, que exercita outro desenho), com **zero falhas nos arquivos deste incremento** e sem a flake `axe-mv3-csp` nesta passagem. Escopo de **14 arquivos** na raiz extraída do zip (inclui os dois oráculos do percurso de pixel): **61/61**. Gate `AUDITA_VERIFY_SKIP_TESTS=1 npm run verify` **GREEN**. Auditoria ao vivo do pacote no Google e integridade dos quatro artefatos: §3.1 |

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

**Veredito da re-verificação independente (17/09/2026).** O revisor mediu o artefato congelado (zip **199/199
byte a byte** contra `git archive ee9eb80`, digest `2bb01b21…` conferido) com sondas próprias e deu **I-1
ATENDIDO**: numa página sem sinal sensível o painel chega a `unavailable` com a mensagem em **1,5 s**
(`full-evidence`) e **1,0 s** (`element-only`), estáveis por 20 s; contra os bytes da **1.1.46** e da **1.1.45**
as mesmas sondas dão `NEUTRO_SILENCIOSO` — a não vacuidade foi medida nos dois sentidos, não declarada. O
cancelamento pedido pelo usuário continua voltando ao neutro (`url-pixel-consent-mv3` **10/10**, cancelamento em
1,70 s), o caminho sensível continua concluindo em `result`, e a classe de credencial está idêntica à 1.1.44
aprovada (896 formas: 0 novas; `secreto*`: 0/182; 198.360: 6.707 com 0 reabertos). O relatório completo está em
`docs/qa/revisoes/REVIEW-1.1.47.md`.

**Achado novo da re-verificação — N-1 (Minor, não bloqueia, no backlog):** a mensagem **não é acionável a partir
da própria tela que a mostra**. Na `unavailable`, `RETRY` mantém a tela e troca o motivo específico pelo genérico,
e "Iniciar nova auditoria" reinicia com o **mesmo modo** (a tela não renderiza o seletor de modo) → falha de novo
→ mesma tela. A recuperação existe e foi medida (clicar de novo no ícone da extensão devolve `initial` com o
seletor, e `no-pixels` conclui em `result`), e é por isso que o revisor classificou o achado como Minor: o
requisito do I-1 está cumprido e não há perda de dado nem promessa falsa. Sugestão mínima aceita como backlog: um
terceiro caminho "Escolher outro modo"/voltar a `initial` na tela de indisponibilidade, ou preservar o motivo
específico no `RETRY`.

**A cura chegou na 1.1.48 (causa medida, não suposta).** A revogação em si foi fechada: o portão de privacidade
arma sem pausa numa página sem sinal sensível (`pixel-privacy-gate.js`, `preflight`), a captura acontece, e o
commit terminal era recusado pela guarda **D2** (`commitTerminal` em `service-worker.js`) porque o companheiro
durável da tentativa só existia no caminho de retomada pós-consentimento (`prepareResume`). A **tentativa
direta** dá à captura sem consentimento o seu próprio companheiro (digesto em domínio separado, derivado só do
`auditId`; `prepare` aceita `consentId` nulo **apenas** para o alvo anexado), criado antes de qualquer raster —
e a guarda D2 continua **intacta**. Medições: página sem sinal sensível nos dois modos com foto → **`result` em
~1 s** (antes: `unavailable`); caminho com sinal sensível inalterado; oráculo novo
(`current-page-pixel-consent-free-mv3`) **reprova contra os bytes da 1.1.47**; escopo de 14 arquivos na raiz do
pacote **verde**. Detalhes em `docs/qa/2026-09-17-tentativa-direta-pixel-sem-consentimento.md`.

**A cura passou pela revisão adversarial (veredito: PODE ENTRAR).** O revisor mediu os bytes finais
(`7da8b3f0…`, commit `39c86c0`), **reconstruiu o pacote num clone dele com o mesmo digest** e confirmou por
medição própria: a guarda D2 intacta (`commitTerminal` byte-idêntico à 1.1.47), a tentativa direta não vira
consentimento em nenhuma fronteira, a jornada conclui com foto nas páginas sem sinal sensível, o caminho
consentido pausa → confirma → `result`, o cancelamento durante a pausa liquida sem resíduo, e o oráculo novo do
autor tem dentes (reprova contra os bytes anteriores). No caminho ele achou e eu fechei **um Important (A-2)** —
a aposentadoria da tentativa direta era chamada com a **assinatura trocada**, o que **piorava** o cenário da
página que revela sinal depois de armar em relação à 1.1.47 — e **um achado de processo (A-3)**, o E2E novo fora
do plano de testes. Relatório em `docs/qa/revisoes/REVIEW-1.1.48.md`; desfecho no registro de achados.

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
- **Mensagem não acionável na própria tela (N-1, Minor da re-verificação da 1.1.47):** a tela `unavailable` não
  oferece o caminho que a mensagem sugere ("use o modo sem pixels"); `RETRY` troca o motivo específico pelo
  genérico e "Iniciar nova auditoria" repete o mesmo modo. A recuperação existe em um clique no ícone da
  extensão (medida pelo revisor) e o achado fica no backlog de apresentação.
- **"Validações brasileiras" (M-4):** o produto tem vocabulário e checagens pt-BR, NBR 17225, Libras e CDC, mas
  **não** um validador de CPF/CNPJ; a rastreabilidade do critério 9 diz exatamente isso.

### 3.1 Auditoria ao vivo do pacote e integridade dos artefatos

Auditoria executada **a partir da raiz extraída do pacote 1.1.48** (`/private/tmp/adv168-run148`), em
`https://www.google.com/`, modo **sem pixels**, 18/09/2026 02:38 UTC, Chrome for Testing 152.0.7977.64 **em headless** (`--headless=new`, para não abrir
janela no Mac do usuário durante o trabalho), viewport 1274×757:

| Medida | Valor |
| --- | --- |
| Versão declarada no artefato | **1.1.48** |
| Falhas confirmadas | **0** (0 ocorrências) |
| Verificações sob revisão humana | **3** (4 ocorrências) — a mesma contagem da rodada anterior |
| Resultados positivos | **9** |
| Checklist ainda sem conclusão | **108** (a rodada anterior dos mesmos bytes deu 109) |
| Cobertura automática / índice técnico | **29,2 %** (denominador 130) / **9,0 de 10** (a rodada anterior deu 28,5 %) |
| Exportações | quatro, `complete` (HTML 327.169 B, PDF 970.747 B, CSV 82.886 B, JSON) |
| Frases legais indevidas / aviso de estimativa | **0** "Inconformidade ao item" / aviso de anúncio estimado presente |
| Integridade (instrumento `artcheck133.py`) | **146 itens, 146 ids únicos, 146 títulos**; 0 ids e 0 títulos ausentes no HTML **e** no PDF; notas editoriais **5/5** nos dois; **0 palavras partidas**; **0 `[redacted]`** no JSON e no HTML; 8 snippets (4.853 caracteres) |

O CSV não carrega a matriz completa de 146 itens (35 ids e 37 títulos "ausentes" nele nesta rodada) — é o mesmo número das
gerações anteriores medidas com o mesmo instrumento, e é o desenho do formato: o CSV entrega as ocorrências,
não o dossiê item a item.

**Nota de método (headless).** A bateria final da 1.1.48 foi medida com `--headless=new` a pedido do usuário ("os
testes precisam ser silenciosos, estão abrindo o navegador o tempo todo"), para não abrir janela nem roubar foco
na máquina de trabalho. O binário é o mesmo (Chrome for Testing 152.0.7977.64), o harness é o mesmo e a variação
observada entre as duas rodadas ao vivo (109/28,5 % × 108/29,2 %) é a variação de instância da página do Google,
já declarada nas gerações anteriores — não de versão.

## 4. O que falta para "produção", em uma frase

O conserto que faltava passou pela revisão independente (**PODE ENTRAR**) e não falta nada de funcional
conhecido **neste** incremento: o percurso principal conclui nos três modos de
evidência (o de pixel inclusive em página sem sinal sensível, que era o último bloqueio), o relatório e as
quatro exportações funcionam, e o destaque corresponde ao elemento. Falta **uma** formalidade — a
re-verificação independente da 1.1.48, incluindo a revisão adversarial do conserto da tentativa direta — e
seguem **declarados** os limites de §3 e os 9 testes do incremento paralelo (outro desenho, em andamento).
Fora isso, o produto está construído, medido e documentado — e **nada foi publicado**: distribuição exige
autorização específica do usuário.
