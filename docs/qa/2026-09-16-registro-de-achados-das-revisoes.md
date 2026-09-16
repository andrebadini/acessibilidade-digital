# Registro de achados das revisões independentes — 1.1.16 a 1.1.19

Consolidação de **todo achado** das três revisões independentes desta sessão, com o desfecho de cada um e a evidência que o sustenta. Existe para que a afirmação "não há falha Critical/Important conhecida" (critério 10) seja conferível linha a linha, e não uma frase de fé.

Legenda de desfecho: **corrigido** (com medição de não vacuidade) · **documentado** (backlog com análise) · **delimitado** (fronteira de projeto, não defeito) · **aberto** (ainda sem desfecho).

## Revisão da 1.1.16 → veredito 1 Critical, 2 Important, 3 Minor

| # | Sev. | Achado | Desfecho | Evidência |
|---|---|---|---|---|
| C1 | Critical | 5.9.7 condenava marcação legítima (`label::after`, irmão, `aria-labelledby`, `placeholder`, rótulo de 148 caracteres) e imprimia a frase legal | **corrigido** | Reproduzido por mim em Chrome real; depois, `cantTell` com 0 frases legais. E2E falha contra os bytes anteriores (`actual: ''`, `expected: '*'`) e passa depois |
| I1 | Important | O mesmo produtor aprovava marcação invisível | **corrigido** | 0 de 120 estados sintéticos devolvem `passed`; 0 ocorrências estáticas de `result('passed'` no produtor — medido por mim e confirmado pela revisão seguinte |
| I2 | Important | O zip entregue nunca era conferido contra o hash fixado | **corrigido** | Lixo no arquivo entregue passou a **falhar** a suíte (7/7 verde antes) — procedimento repetido por mim e pela revisão |
| M1 | Minor | Alvo "fora da tela" também dispara em contêiner com rolagem, e o texto afirmava "fora da página" | **corrigido** | Texto do alvo e comentário do predicado reescritos; resultado já era `cantTell` |
| M2 | Minor | Renderizador de modelo imprimia a frase legal para decisão humana sem nota | **corrigido** na 1.1.19 | Os três sítios passam a exigir `evaluator`, `decidedAt` e `note`; teste novo fixa o caso sem nota |
| M3 | Minor | Três afirmações documentais refutadas por medição | **corrigido** | `element.labels` não inclui `aria-labelledby`; "rótulo escondido é ignorado" era falso; comentário de teste contradizia a asserção |

## Revisão da 1.1.17 → veredito 0 Critical, 3 Important, 5 Minor

| # | Sev. | Achado | Desfecho | Evidência |
|---|---|---|---|---|
| A | Important | A suspeita por campo de 5.9.7 caía no checklist genérico e a mensagem do campo não chegava ao HTML/PDF | **corrigido** | Os três motivos entraram em `CONCRETE_REASONS`; as ocorrências passaram ao grupo de revisão humana. Teste de classificação novo |
| B | Important | Campos sem marcação eram descartados em silêncio quando algum campo tinha declaração inválida | **corrigido** | Um único `cantTell` lista os dois grupos; teste unitário falha contra o `src/` anterior (`actual: []`) |
| C | Important | A branch sobrevivente imprimia a frase legal para campo que a árvore do Chrome expõe como obrigatório | **corrigido** | 5.9.7 deixou de produzir `failed`; `Accessibility.getPartialAXTree` mostrava `required: true` nos dois casos |
| M-a | Minor | E2E sem asserção sobre a cadeia de relatório, e duas asserções de linguagem legal que passavam no código anterior | **delimitado** | A cadeia genérica já é fixada em `test/report/html.test.js`; a regra agora está fixada em unidade e no E2E |
| M-b | Minor | Comentário do E2E afirmava observação "de toda fonte" | **corrigido** | Comentário passou a nomear as quatro fontes observadas |
| M-c | Minor | Alvo de `aria-labelledby` dentro de shadow root não é observado | **delimitado** | Direção segura: suspeita, nunca violação |
| M-d | Minor | M2 não corrigido e a afirmação de inalcançabilidade estava errada | **corrigido** na 1.1.19 | Ver M2 acima |
| M-e | Minor | Relato impreciso das 8 falhas do `service-worker` | **corrigido** | Causa estabelecida e cenário aposentado com motivo escrito |

## Revisão da 1.1.18 → veredito 0 Critical, 1 Important, 3 Minor

| # | Sev. | Achado | Desfecho | Evidência |
|---|---|---|---|---|
| — | Important | A devolução antecipada de "faltam dados" descartava **todos** os alvos de 5.9.7 (gatilho: `required` nativo + token ARIA malformado) | **corrigido** na 1.1.19 | Falta de dado deixou de devolver cedo e virou limitação **na camada da regra** — a frase não chega aos artefatos entregues, ver A2 abaixo; unidade e E2E falham contra os bytes anteriores (`actual: []`, `expected: ['unmarked']`) |
| m1 | Minor | M2 ainda aberto | **corrigido** na 1.1.19 | Ver M2 acima |
| m2 | Minor | HTML/PDF mostram o seletor por ocorrência, mas não o motivo de cada uma | **documentado** | O motivo por alvo existe no JSON e no detalhe do painel; renderizá-lo por ocorrência exige campo novo no modelo |
| m3 | Minor | O E2E revisado era cego ao delta da 1.1.18 | **corrigido** | A fixture ganhou o campo com `required` + token malformado e o E2E passou a falhar contra os bytes anteriores |

## Revisão da 1.1.19 → veredito 0 Critical, 2 Important — nenhum dos dois no produto —, 0 Minor

A revisão da 1.1.19 julgou duas coisas ao mesmo tempo: a correção do campo obrigatório sem estado observado **e** a triagem das nove falhas da fase serial de Chrome real. Sobre a correção, o veredito é favorável e medido: contra os bytes anteriores o produtor devolve `targets: []` e contra os atuais devolve dois alvos (`#a-maybe`, `#unmarked`); no modelo entregue as ocorrências de 5.9.7 vão de 1 para 2 com `nodeId` (`n-6`, `n-7`) e a pergunta genérica sai do checklist (93 → 92); a página em que **todos** os campos carecem de estado observado sai byte a byte idêntica nas duas revisões, ou seja, a correção não extrapola; o M2 fecha com os três sítios concordando, inclusive a nota só com espaços; e dois dos três guardas novos **falham** contra os bytes anteriores, o que os torna não vacuosos.

| # | Sev. | Achado | Desfecho | Evidência |
|---|---|---|---|---|
| A2 | Important | A limitação declarada da 5.9.7 ("sem estado calculado ou sem indicador observado") não chega a nenhum artefato entregue: `canonicalCoreRuleLimitations()` (`audit-model.js:240`) troca toda limitação de regra pela frase canônica de revisão humana, e o `:326` ainda *valida* que a justificativa da ocorrência seja igual ao resumo canônico | **afirmação corrigida — sem mudança de produto** | Medi o artefato entregue: o JSON técnico traz **146 asserções**, uma por item ABNT, sempre. `passed` → "Resultado agregado: passed." (sem ponteiro); `cantTell` → "conclusão dependente de revisão humana" (com ponteiro quando há ocorrência). O item **não desaparece** e os dois estados **não se confundem**; o que não é entregue é o *motivo* da inconclusão, não o estado. A frase a corrigir era a minha ("limitação declarada"), não o código |
| B1 | Important | Cinco documentos de usuário afirmavam que a inspeção da página atual ocorre em "cópia temporária e inativa"; desde `1c9b296` ela ocorre **na própria página**, e a limitação sobre estado não salvo estava invertida | **corrigido** | Código: `startAttached` (`side-panel-intent-router.js:499`) não emite `ownershipId` nem token de navegação, enquanto `startUrl` (`:525`) emite os dois; `collectPage` (`collect-page.js:74`) injeta `collectRuntimePageData` na aba recebida. Medição em Chrome real sobre os bytes empacotados: nenhuma aba criada em quatro momentos, `mode: "attached"`, origem ativa e intacta. Corrigidos `README.md`, `docs/COMO-USAR.md`, `docs/USO-FISCAL.md`, `store-assets/STORE-LISTING.md` e `store-assets/TEST-INSTRUCTIONS.md` |

**Sobre o B1, o que ficou intacto e por quê.** As três cadeias *do produto* que falam em cópia — `ATTACHED_COPY_RELOADED` (`run-audit.js:321`), `ATTACHED_COPY_EVIDENCE_ONLY_MESSAGE` (`report-view.js:910`, protegida por `hasAttachedCopyReloadedLimitation`) e o parágrafo `#report-source-explanation` (`review/index.html:19`) — só valem no fluxo de URL com finalidade `attached-copy`, onde **de fato** existe cópia própria recarregada e onde a ressalva sobre estado não observado é verdadeira. Alcance conferido por código. Nenhum byte de produto mudou, e nenhum dos cinco arquivos corrigidos entra no pacote (os 199 do zip são `assets/`, `src/`, `vendor/` e `manifest.json`), de modo que o `sha256` entregue tinha de continuar `0e429e22…` — e continuou.

## A triagem das nove falhas seriais: o que cada uma é

| # | Teste | Classificação medida |
|---|---|---|
| 1 | `mandatory-journey` → "the side panel must not resize itself during the journey" | **intermitente de teste**; produto exonerado. A causa está estabelecida: a linha de base é lida depois de `visibilityState === "visible"`, e isso **não** implica layout — a sonda leu `{w:0,h:0}` nesse ponto e `{360,765}` depois |
| 2 | `batch-pixel-consent` → lote com evidência completa | **classificação da triagem corrigida por medição: não era orçamento.** Falhava de forma **determinística** aos ~311 s (três vezes, sozinho, com ~5 s de CPU: esperava, não calculava). Com controle no mesmo ambiente: arquivo intocado ✖ 312 s; **só** `intervalMs: 50` → `250` ✔ 14,9 s. A 20 Hz a prova de download concorre com a exportação que ela espera. Corrigido no arquivo, verificado na árvore do produto (14,9 s, 1/1) |
| 3 | `axe-mv3-csp` → axe local em cada frame | **artefato de desmonte**: as asserções passam, quem falha é o estágio `removeProfile` da limpeza, com orçamento de 2 000 ms. Isolado, passa em 1,1 s; sob carga estourava. Orçamento do estágio elevado para 15 s (a remoção continua tendo de **funcionar**: `rm` ainda precisa concluir) |
| 4–6 | `sidepanel-flow` → dois de marcadores e um de cancelamento | **contrato obsoleto**: esperam `audita:owned-tab:v2:*` em `retained-for-consent`; o fluxo anexado não cria dono nenhum (`ownedTabKeys: []` nos quatro momentos) |
| 7–10 | `sidepanel-flow` → quatro subtests de página atual | **cascata**: o primeiro morre antes de cancelar, o painel fica em `privacy-paused` e os seguintes esperam `initial` |
| 11 | `passive current-page observes memory-only elements…` | **não reproduzida** (passa no lote e isolada) |

**Varredura por arquivo (34 arquivos, um Chrome por vez): 32 passam sozinhos.** Falham apenas dois: o do outro incremento (contrato de posse obsoleto, as mesmas 7 falhas do lote) e o de exportação de lote — que, pela medição acima, era taxa de consulta do próprio teste, não produto. Nenhum dos 32 morre em asserção sobre resultado de auditoria.

**Hipótese minha, refutada pela triagem.** Eu havia pré-validado subir o teto de comando do harness (`DEFAULT_COMMAND_TIMEOUT_MS`) de 30 s para 120 s — 39/39 no arquivo de contrato do próprio harness, ou seja, a constante é livre para mudar — e estava a um passo de aplicá-la. A triagem refuta a necessidade: os dois `CDP_COMMAND_TIMEOUT` (subtests 8 e 9) **têm causa** no painel deixado em `privacy-paused` pelo primeiro subteste, não em teto insuficiente. Com o teto maior, 30 s de falha virariam 120 s de falha. **Não aplicada**, e a hipótese fica retirada com o motivo escrito: mudança pré-validada não é mudança justificada.

## O que continua aberto, e não é achado de revisão

- **Critério 1** — a intermitência da asserção de tamanho do painel tem **causa estabelecida e confirmada pelo próprio diff da falha** (`expected {w:0,h:0}` contra `actual {w:360,h:765}`). Corrigido na captura da linha de base, com a asserção intacta; **3 de 3 execuções passam** depois, e a falsificação foi feita: forçando uma mudança real de caixa (321×654 contra a linha de base real de 360×765), a asserção **reprova** com a mensagem certa — os dentes continuam lá.
- **Fase paralela é instável sob carga — pré-existente, não desta mudança.** A mesma fase, no checkout **limpo** em `dad1cda`, falha **9** testes (`4187 testes, 4178 passam, 9 falham`), incluindo `times out a stalled bitmap allocation, closes the late bitmap and avoids a render canvas` e a família de cache de bitmap (`cache-reject`, `cache-throw`, `factory-throw`, `source-failure`, `vault-failure`, `vault-invalid`, `stored`). Na minha árvore a mesma fase falha **1** — exatamente o mesmo teste de bitmap — e esse teste passa **3 de 3** quando roda sozinho. Ou seja: é flake de tempo sob 179 arquivos em paralelo, e a minha árvore está **melhor** que a revisada, não pior. Fica registrado como fragilidade conhecida da suíte paralela, sem correção por enquanto: corrigir exigiria medir por que a alocação estagnada não estoura o prazo sob carga.
- **Triagem da fase serial** — concluída, e as duas falhas que sobravam têm desfecho medido: a de exportação era a taxa de consulta do teste, e a de tamanho do painel era a linha de base. As 7 restantes são do arquivo do outro incremento (expectativas obsoletas de posse + cascata) e não são minhas para editar.
- **Backlog documentado com análise pronta**: remediação por ocorrência no cartão; vocabulário português do `SENSITIVE_KEY` (decisão do usuário); reescrita do cenário aposentado sobre `beginAuthorizedUrlAudit`; técnicas restantes de ocultação em 5.9.1; `inputPurpose` de 5.9.8; verificação com leitor de tela real.
