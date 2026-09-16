# Estado dos 12 critérios de conclusão — 1.1.19

> **Incremento 1.1.27, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.27.zip` (`1962d439…43b586`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.26 inteiro: o **Important** (o teto de 120 caracteres e o `;` devolviam a
> cauda do valor tarjado), o Minor das formas de credencial que a 1.1.24 tarjava e a 1.1.26 ainda
> perdia, o `compass`, o `auth`/`author*`, os dois nomes de E2E do README e os números sem escopo.
> Para os critérios: **5** é onde está a mudança séria — a revisão mediu que a minha varredura de
> credencial do artefato era **vacuamente verde** (zero rótulos com valor nos quatro formatos) e, ao
> medir sem vacuidade numa fixture que **contém** credencial, apareceu um defeito **Critical
> pré-existente**: o sanitizador de trecho tinha o terceiro e o quarto vocabulário do produto, só em
> inglês, e copiava valor de atributo literalmente, então `senha: S3GR3D0XYZQ` e
> `cartão: 4111 1111 1111 1111` chegavam ao modelo, ao relatório e aos artefatos HTML/JSON entregues.
> As quatro listas passam a vir do mesmo radical, o texto e os atributos usam o mesmo tarjador, e o
> E2E de exportação audita uma página com credencial e **falha** se ela chegar a qualquer superfície
> entregue (provado por mutação). **10** volta a **Atendido** depois da correção, com o Critical
> registrado e fechado — nenhuma versão desta sessão foi declarada candidata com Critical/Important
> aberto. **11** ganha os achados da 1.1.26 (O4 documentado) e o **C1**. **8** continua **Parcial**,
> porque o que falta é teste com pessoa leiga, e isso não se resolve por código.

> **Incremento 1.1.25, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.25.zip` (`499e1de3…d6a23`), **sem revisão independente ainda**.
> Fecha o veredito da 1.1.24 inteiro (A1 a A6) mais os Minors herdados V6, V7 e V9. Para os critérios:
> **5** melhora em dois pontos medidos — o radical de senha voltou a tarjar `bypasscode` e companhia
> (regressão que eu havia introduzido) e o tarjador de valores passou a conhecer rótulos em português;
> **11** fica com o backlog de Minors **vazio**; **2** e **12** foram medidos nos bytes empacotados
> (paralela 4.145/4.144/0 com 1 pulado, `release-package` + `extension-shell` + `release-assets` 19/19
> com o digest fixado, seis E2E do escopo 6/6, E2E de consentimento de pixels 10/10 com a asserção nova
> da manchete, auditoria real do Google com 0 falhas, 9 positivos, 109 no checklist, 18 páginas e quatro
> exportações completas, artefato entregue com notas 5/5 nos dois formatos e proveniência presente);
> **9** ganha a verificação estática do `verify-project` (modo `AUDITA_VERIFY_SKIP_TESTS=1`, verde na
> 1.1.25): manifest MV3 com CSP sem origem remota e sem `unsafe-eval`, axe-core fixado em 4.13.0 no
> pacote e no lock, catálogo **130/146 (96 requisitos / 50 recomendações)**, **identidade neutra**
> (nenhuma marca institucional), HTML/JSON/PDF, fixtures, privacidade e varredura de segredo/origem
> remota em `src/`. **7** fica coberto por essa mesma checagem mais a conferência normativa dos 146
> itens. **10** segue pendente até a revisão da 1.1.25; **8** continua **Parcial**. A execução completa
> do `verify-project` (que roda `npm test`, incluindo a fase serial de Chrome real) fica para depois da
> fase serial.

> **Incremento 1.1.24, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.24.zip` (`978fa19e…665c01`), **sem revisão independente ainda**.
> Ele carrega o que o veredito da 1.1.22 pediu — a cláusula e a lista derivando da mesma fonte, a regra
> de impressão chegando ao Ctrl+P da aba interativa, o oráculo de largura do E2E derivado do `@page`,
> as cinco frases de documentação corrigidas, o import morto e o `node_modules/` no `.gitignore` — mais
> o que a 1.1.23 trouxe em privacidade. Para os critérios: **2** e **12** medidos nos bytes empacotados
> (fase paralela 4.140/4.139/0 com 1 pulado, `release-package` + `extension-shell` 12/12 com o digest
> fixado, seis E2E de Chrome real 6/6, auditoria real do Google com 0 falhas, 9 positivos, 109 no
> checklist, 18 páginas e quatro exportações completas, CSP do HTML entregue batendo com o `<style>`);
> **10** segue pendente até a revisão da 1.1.24; **8** continua **Parcial**.

> **Incremento 1.1.23, e o que ele muda aqui.** Artefato corrente
> `release/audita-acessibilidade-1.1.23.zip` (`7e816d7b…12068`), **sem revisão independente ainda**.
> Três correções, todas com defeito medido antes: o vocabulário sensível passa a cobrir português
> (`?senha=`, `?cpf=` sobreviviam à URL anunciada como sanitizada), o radical de senha deixa de tarjar
> `passed`/`passes`/`bypass`/`passive` (vocabulário do próprio produto) e `listedLimitations` deixa de
> falhar aberto. Para os critérios: **12** está medido nos bytes empacotados desta versão — seis E2E de
> Chrome real **6/6**, auditoria real do Google com 0 falhas, 9 positivos, 109 no checklist, 18 páginas,
> quatro exportações completas e artefato entregue conferido (notas 5/5, proveniência presente, 0
> palavras partidas); **5** e **6** ganham a verificação de que a expansão do vocabulário não alterou o
> relatório entregue; **10** segue pendente até a revisão da 1.1.23; **8** continua **Parcial**.

> **Incremento 1.1.22, e o que ele muda aqui.** O artefato corrente é
> `release/audita-acessibilidade-1.1.22.zip` (`c2d6c44d…5951b5`), ainda **sem revisão independente**.
> Ele fecha três Minors da revisão da 1.1.21: a cláusula em linguagem simples passa a chegar ao
> **PDF/HTML entregue** (não só à aba) e passa a ser derivada do **código** do diagnóstico em vez da
> forma exata da frase; o cabeçalho da tabela de anexos deixa de partir palavra (`Evidênc`/`ia`,
> 3 → 0); e o comportamento de impressão da matriz ganha **guarda automatizada** — um E2E que mede a
> folha na largura real da página e **falha na CSS da 1.1.20** (50 quebras sob compressão) e passa na
> atual. Leva também ao entregue a proveniência que só existia no modelo (viewport, ledger normativo
> com arquivo e SHA-256, método e as cinco notas de integridade normativa), medida nos bytes
> empacotados. Para os critérios: **12** passa a ter medição na versão efetivamente empacotada
> (auditoria real do Google: 0 falhas, 9 positivos, 109 no checklist, 18 páginas, quatro exportações
> completas, notas 5/5 e 0 palavras partidas); **7** ganha rastreabilidade normativa no artefato
> entregue; **2** foi re-verificado (fase paralela 4.137/4.136/0 com 1 pulado, `release-package` +
> `extension-shell` 12/12, seis E2E de Chrome real verdes); **10** segue pendente até a revisão da
> 1.1.22; **8** continua **Parcial**. A frase "mesma paginação de 18 páginas" do bloco abaixo está
> **corrigida** pela revisão da 1.1.21: no A/B controlado a regra imprime uma página a menos, e o
> total depende do conteúdo da captura.

> **Incremento 1.1.20 (apresentação), e o que ele muda aqui.** O artefato corrente passou a ser
> `release/audita-acessibilidade-1.1.20.zip` (`140e30bb…6e1b1`), com duas correções de apresentação
> medidas no artefato entregue da página real: a limitação deixou de ser dita duas vezes no sumário
> executivo (8 → 6 entradas, 2 → 0 repetições, título coerente com a lista) e o rótulo do item deixou
> de quebrar no meio na matriz impressa (**56 → 0**). **A paginação não ficou igual:** em A/B controlado
> sobre o mesmo modelo e o mesmo HTML, a regra da 1.1.21 imprime **uma página a menos** (no HTML da
> 1.1.21, 15 → 14; no HTML da 1.1.22, que acrescenta a proveniência, 16 → 15), e a 1.1.20 tinha trocado
> as 56 quebras de rótulo por **50 palavras partidas** (`Recomendaçã`/`o ABNT`), corrigidas na 1.1.21. Nada
> disso altera contagem, classificação, frase legal ou conclusão. Para os critérios: **2 e 12** foram
> re-verificados com o artefato novo (fase paralela 4180/4179/0, `release-package` 7/7, quatro E2E de
> relatório, impressão e exportação verdes, e `verify-project` **estático** verde com os testes
> pulados — a execução completa do `verify`, que roda a suíte, fica para depois do veredito porque o
> Chrome está com a revisão); **8** melhora em legibilidade mas continua **Parcial**
> por falta de teste com pessoa leiga; **10** volta a depender de veredito, porque a revisão
> independente **do artefato 1.1.20 ainda não saiu** — o checkout congelado é `a73a9e3` em
> `/private/tmp/audita-review-120`. Os números das linhas abaixo continuam sendo os medidos na
> 1.1.19, que é o que eles documentam.

Registro de 16/09/2026, na revisão `dad1cda` (manifest 1.1.19, artefato `audita-acessibilidade-1.1.19.zip`,
SHA-256 `0e429e226e07e5de365e1fed6542398f1d2acb8e80eada4babb78e0e0af14ec9`). Cada linha diz **o que foi
medido**, **como** e **o que falta**. Onde não há medição, está escrito que não há — este documento não
transforma leitura de código em teste de comportamento.

| # | Critério | Estado | Evidência e limite |
|---|---|---|---|
| 1 | Percurso principal sem instabilidade | **Atendido** | O percurso completo roda numa sessão a partir dos **bytes empacotados** (`mandatory-journey-mv3`, 1/1, com o diagnóstico `journey ok; formats=html,pdf,csv,json`). A intermitência de *"the side panel must not resize itself during the journey"* tem **causa estabelecida e é do teste, não do produto**: a linha de base era lida logo após `visibilityState === "visible"`, e isso **não** implica layout — medido no mesmo ponto, `innerWidth/innerHeight` devolveu `0×0` e, mais tarde, na mesma sessão, `360×765`. Quando o layout já ocorreu, a linha de base é real e o percurso passa; quando não, a comparação final culpa o painel por um layout do navegador. A captura passou a esperar por uma caixa definida (a asserção não mudou, e um redimensionamento real continua a falhar), e **3 de 3 execuções passaram** depois disso. |
| 2 | Relatório abre e exportações funcionam | **Atendido** | Quatro formatos com recibo `complete` e sha256, medidos a partir do pacote extraído — na fixture (HTML 321 KB, PDF 1,03 MB, CSV 81 KB, JSON 347 KB) e **na página real do Google, com os bytes da 1.1.19** (HTML 337.235 B, PDF 993.996 B com 18 páginas, CSV 86.142 B, JSON 374.160 B), com o percurso inteiro em **4,3 s**. Inspeção do relatório renderizado feita por captura e pelo HTML entregue: zero "Inconformidade ao item …", 112 "Verificar o item …", avisos de fórmula, denominador e estimativa presentes. Rodada 52. |
| 3 | Destaque corresponde ao elemento e documento corretos | **Atendido** | `highlight-marking-mv3` 1/1 e `page-markers-signals-mv3` 1/1 a partir do pacote, com a caixa marcada sobre o elemento auditado; o percurso exige `z-index 2147483647`, área visível e cobertura do elemento. |
| 4 | Inspeção automática não altera visivelmente a página | **Atendido** | O percurso compara rolagem, foco e a marcação do autor antes e depois e passa; `capture-visible-element` 1/1 exige que a captura **preserve a viewport** — o ponto exato onde o Chrome 152 já havia mostrado `clientWidth 1265 → 1280`. Limite conhecido: captura de regiões fora da viewport. |
| 5 | Evidências autorizadas, corretas e correlacionadas | **Atendido** | `url-pixel-consent-mv3` 1/1 (pausa, one-shot, reinício do trabalhador, limpeza só das abas próprias) e `capture-visible-element` 1/1, executados a partir do pacote. `batch-pixel-consent-mv3` era o único arquivo, além do arquivo do outro incremento, que falhava sozinho: `DOWNLOAD_PROOF_TIMEOUT` aos ~311 s, sempre no mesmo ponto e com quase nenhuma CPU (`user 5,24 s` de 311 s de parede — **esperava**, não calculava). Instrumentei o passo e a prova foi satisfeita **na primeira consulta**, com 5 s de janela; o experimento de uma variável só, com controle nos mesmos minutos, deu arquivo intocado ✖ 312,02 s contra **apenas** `intervalMs: 50` → `250` ✔ **14,93 s**. A consulta a 20 Hz ao IndexedDB da extensão concorria com a exportação de lote em evidência completa que ela esperava. Corrigido no arquivo (a asserção não mudou: quatro artefatos, completos, com byte length e sha256) e verificado na árvore do produto: **14,9 s, 1/1**. **Varredura de segredos em tempo de execução** (nova): o E2E `current-page-export-mv3` agora **pede um destaque** — parte do percurso obrigatório — e por isso a auditoria emite o **nonce do destaque** (`audita:highlight-bindings`, campo `nonce`), além dos ids opacos de capacidade de sessão e de alvo e de qualquer `owner_…`. Ele exige que **nenhum** deles apareça na página auditada, no painel, no relatório, nas URLs de todas as abas, no armazenamento **durável** (`chrome.storage.local`), no modelo e na revisão guardados, nem nos três artefatos de texto entregues (HTML, CSV, JSON; o PDF é fluxo binário comprimido e o teste **não** afirma tê-lo varrido). Medido: **3 segredos — dois ids de capacidade e o nonce do destaque — × 9 superfícies, zero vazamentos**, com asserção de não vacuidade (`highlightNonces > 0`) para que a varredura do nonce não possa passar sem ter varrido nonce nenhum. Antes disso havia só contenção estática em testes unitários. **Na 1.1.27**, a revisão da 1.1.26 mediu que a varredura de rótulo sensível do artefato era **vacuamente verde** (0 rótulos-com-valor em HTML, JSON, CSV e PDF: qualquer lista, inclusive vazia, passaria) e o meu driver do Google não tinha varredura nenhuma. Medindo sem vacuidade — fixture com `senha: S3GR3D0XYZQ` em texto, `cartão: 4111 1111 1111 1111` e `chave: …` em atributo e credencial na URL, no percurso real de exportação — apareceu o **Critical C1**: o sanitizador de trecho (`src/core/evidence/snippet.js`) tinha o terceiro e o quarto vocabulário do produto, só em inglês, e copiava valor de atributo literalmente, então as duas credenciais chegavam ao modelo guardado, ao relatório e aos artefatos HTML/JSON entregues. Corrigido: as quatro listas vêm do mesmo radical de `privacy.js`, o texto e os atributos passam pelo mesmo tarjador, e o E2E de exportação agora **exige** a credencial na página (fonte provada) e a proíbe em painel, relatório, URLs, armazenamento durável e de sessão, modelo, revisão e nos três artefatos de texto — com a URL do escopo sanitizada e sem a consulta inteira quando algum parâmetro é sensível. Não vacuidade provada por mutação: com o sanitizador anterior o E2E reprova nomeando `relatório, modelo e revisão guardados, artefato html, artefato json`. |
| 6 | Contagens distinguem falhas, suspeitas e checklist | **Atendido** | Medido no produto entregue, **na versão atual e em rodadas rastreáveis**: fixture com quatro defeitos injetados (rodada 53) — **4 falhas confirmadas (5 ocorrências), 0 recomendações, 7 suspeitas (7 ocorrências), 6 positivos, 104 no checklist separado**, e no JSON as 146 asserções separadas em **4 `failed` / 107 `cantTell` / 29 `inapplicable` / 6 `passed`**, com as 4 frases legais correspondendo exatamente aos 4 itens confirmados. Página real do Google (rodada 52) — **0 / 1 / 3 (4 ocorrências) / 9 e 109 no checklist**, com **zero** frases legais. Checklist por **item**, não por elemento. |
| 7 | Conclusões ABNT respeitam obrigatoriedade, alternativas e limites | **Atendido** | Texto de 5.9.1 e 5.9.7 lido no PDF do usuário (impressas 22–23). Zero "Inconformidade ao item …" no Google (0 falhas) e no relatório de fixture apenas para as duas falhas reais (5.13.10, 5.9.3); 5.9.7 sai como "Verificar o item 5.9.7". Três revisões independentes mediram a retirada das condenações indevidas. **E os 146 itens foram conferidos um a um contra o PDF** (16/09): natureza e título sem nenhuma divergência, referências WCAG iguais em 143 e nas 3 restantes a diferença está medida e declarada — incluindo 5.9.4, em que a norma imprime nível A e o catálogo normaliza para AA com nota editorial própria. |
| 8 | Interface e relatório completos, claros, usáveis por leigos | **Parcial** | Inspeção do relatório entregue confirma sumário executivo, rosca com "não é uma nota de acessibilidade", fórmula e denominador explícitos, cobertura à parte, quatro grupos nomeados com texto além da cor, prioridades, registro de decisão, mapas de anúncios, matriz dos 146 itens, metodologia com versão e hashes. Os seis blocos didáticos que a meta exige estão no relatório entregue: **quem é afetado** (`impact`), **o que foi observado** (`observed`), **por que importa**, **como corrigir** (`correction`), **como verificar manualmente** (`guidance.reviewSteps` + `guidance.example`) e **quais evidências permitem concluir e quais faltam** — este último como bloco explícito de confirmação, diferenciado por desfecho: `html.js:227-232` diz o que confirmar para resultado positivo ("mantenha este registro como evidência positiva … e reavalie se a página mudar"), revisão humana ("registre a decisão humana, a justificativa e as evidências consideradas"), alerta e falha ("repita a verificação após a correção"), e `:463` imprime "Como confirmar" com a instrução específica da ocorrência. Não fiz teste de usabilidade com pessoa leiga. |

> **O que a varredura automática acrescenta ao critério 8, e o que ela não substitui.** A interface do
> próprio produto passou a ser conferida por nome acessível em três superfícies: o **painel** nas sete telas
> (`initial`, `running`, `result`, `batch`, `single-url`, `start-failed`, `unavailable`), a **casca estática
> da aba** (campo do avaliador com `<label for>`, diálogo com `aria-labelledby`) e o **documento entregue**
> nas duas variantes (vivo e resumo impresso). Resultado: nenhum `button`/`input`/`select`/`textarea`/`a` sem
> nome, e a checagem tem teste contra exemplo sintético para não ser vacuosa. Isso cobre o que se pode
> afirmar por medição automática sobre a interface; **não fecha o critério 8**, que continua **Parcial**
> porque clareza para leigos só se mede com uma pessoa de fora tentando usar o produto.
| 9 | Recursos obrigatórios implementados | **Atendido** | Verificados por execução: percurso, exportações, destaques, personas sob CSP (1/1 a partir do pacote) e auditoria de várias URLs (`audits exactly two explicit URLs invisibly in one sanitized no-pixels batch report`, medido pelo revisor). Verificados por leitura (existe e é alcançável, não código morto): menu de contexto (`contextMenus` + `service-worker.js:2129/2137`) e o caminho de lote (`PANEL_START_BATCH_AUDIT` → `startBatch`). Módulo de leitor de tela e anúncios: `src/panel/persona-session.js` mais o mapa de anúncios que liga marcador, elemento e prévia (`html.js:550`), e o aviso honesto exigido pela meta está em **cinco** pontos do relatório entregue — `html.js:250` ("não é transcrição literal de tecnologia assistiva"), `:466` ("não é transcrição literal de VoiceOver, NVDA, JAWS ou outro leitor de tela"), `:550`, `:755` ("pode variar conforme o navegador, a API da plataforma, o leitor, o modo e as preferências") e `report-view.js:744`, que é o caminho de produção. Limite: não testei com leitor de tela real — que é exatamente o que o aviso declara. |
| 10 | Sem falha Critical/Important conhecida | **Atendido** | As revisões da 1.1.16 a 1.1.18 acharam 1 Critical e 6 Important, **todos corrigidos** com não vacuidade demonstrada. A revisão independente da 1.1.19 deu **0 Critical e 2 Important, nenhum dos dois no produto**: (a) a limitação da 5.9.7 é canonizada antes da entrega e por isso não chega aos artefatos — conferi por medição que o item **não** desaparece (146 asserções, uma por item, sempre; `cantTell` ≠ `passed` no texto entregue), de modo que a afirmação a corrigir era a minha, não o código; (b) cinco documentos de usuário afirmavam inspeção em cópia temporária para a página atual, que desde `1c9b296` roda na própria página — corrigidos, e as três cadeias **do produto** que falam em cópia foram conferidas por alcance e só valem no fluxo de URL `attached-copy`, onde são verdadeiras. A mesma revisão **refutou** a minha hipótese de que as 4 falhas de prontidão seriam teto de 30 s do harness: elas são cascata do primeiro subteste, que morre antes de cancelar e deixa o painel em `privacy-paused`. **Nenhuma das 9 falhas morre em asserção sobre o resultado de uma auditoria**, e a varredura de 34 arquivos isolados confirmou: 32 passam sozinhos. Medição final da fase serial, depois das correções: **65 testes, 56 passam, 9 falham — e as 9 estão todas em `test/e2e/sidepanel-flow-mv3.test.mjs`**, o arquivo do outro incremento. `axe-mv3-csp` e `batch-pixel-consent-mv3` deixaram de falhar. **A revisão da 1.1.26 deu 0 Critical, 1 Important e 5 Minor**, e o Important era regressão minha do conserto do N2 (teto de 120 caracteres e `;` devolviam a cauda do valor tarjado). **Na 1.1.27** esse Important está fechado com métrica da largura da classe (28 formas, zero sentinela sobrevivente), junto com os cinco Minors e as três observações pertinentes. E a mesma revisão, ao pedir medição sem vacuidade, levou ao **Critical C1** (credencial da página chegando aos artefatos entregues), **pré-existente e não uma regressão de incremento**, também corrigido e fixado por E2E com prova de mutação. Estado corrente: nenhum Critical/Important conhecido em aberto. |
| 11 | Achados menores documentados | **Atendido** | Trilha `docs/qa/2026-09-13-continuity-and-e2e-triage.md` e `docs/qa/2026-09-12-form-family-review.md`: M2 (corrigido), remediação por ocorrência no cartão (analisado), vocabulário português do `SENSITIVE_KEY` (decisão pendente do usuário), técnicas restantes de ocultação em 5.9.1, `inputPurpose` de 5.9.8, alvo de `aria-labelledby` em shadow root, rótulo em contêiner com rolagem, limitação de captura, as 8 falhas obsoletas do `service-worker` com causa estabelecida, e **os três achados de apresentação da inspeção visual da 1.1.19 (rodada 54)** — limitações duplicadas no sumário executivo, códigos internos no sumário (deliberado, fixado em teste) e **56 dos 146 números de item quebrados no meio na matriz do PDF**. |
| 12 | Versão empacotada testada em Chrome real | **Atendido** | Os 199 arquivos do zip são byte a byte idênticos à árvore (conferido por mim em 1.1.17, 1.1.18 e 1.1.19, e por dois revisores de forma independente), **e** o pacote extraído foi executado em Chrome real: percurso completo, exportações, destaques, sinais, privacidade de URL e persona sob CSP. **Na 1.1.19, e em página real**, a rodada 52 executou o pacote extraído contra `https://www.google.com/` e fechou o percurso em 4,3 s com as quatro exportações `complete`, o relatório declarando 1.1.19 e o HTML entregue sem nenhuma frase legal. **A execução sobre bytes empacotados continuou em cada incremento desde então** — 1.1.22, 1.1.23, 1.1.24 e 1.1.25 têm, cada uma, os seis E2E do escopo verdes na raiz extraída do zip e uma auditoria real empacotada conferida (notas 5/5 nos dois formatos, proveniência presente, 0 palavras partidas); os números de cada uma estão nos blocos do cabeçalho deste documento. A única etapa não exercitada é o ato de descompactar em si, que é o que o `unzip` faz. |

## O que impede declarar produção agora

1. **Nada do meu lado está em aberto nos critérios 1, 5 e 10.** A correção da linha de base do painel não só passa 3 de 3 como foi **falsificada**: forçando uma mudança real de caixa durante o percurso (321×654), a asserção reprova com a mensagem certa, e a linha de base agora é um `360×765` de verdade — os dentes continuam lá. A falha de exportação de lote era a taxa de consulta do próprio teste (controle: 312 s falhando; só o intervalo alterado: 14,9 s passando).
2. **Trabalho que não é meu** — as **9** falhas restantes da fase serial estão todas em `sidepanel-flow-mv3.test.mjs`, e pedem reescrita das expectativas de posse para o modo anexado (e um `finally` que cancele a tentativa do primeiro subteste, para acabar com a cascata). O arquivo está modificado no worktree por outro incremento, com fixture de observação passiva ainda em andamento; editar por cima seria adivinhar trabalho alheio. O achado está registrado com medição e o caminho de correção escrito.
3. **Critério 10 fecha** com 0 Critical e 2 Important, ambos de documentação/afirmação e ambos resolvidos sem tocar em byte de produto — que é o que a própria revisão recomendou. Nenhuma versão desta sessão foi declarada candidata com falha Critical/Important aberta.
4. **Critério 8** continua **Parcial**: não houve teste de usabilidade com pessoa leiga, e isso não se resolve por leitura de código.
5. **A suspeita sobre `persistExportSuccess` foi fechada por leitura da cadeia, sem mudança de produto** — o estado `report.status: 'pending'` criado pelo agregado de lote (`aggregate-audits.js:154`) nunca chega à exportação: `runBatch` sempre enriquece antes de devolver (`run-batch.js:391`, `return finalModel`) e o enriquecimento grava `review-ready` com artefato `pending` (`enrich-audit.js:111-113`), que é exatamente o par que escolhe o validador tolerante a recibo parcial (`export-controller.js:185-189`). Não há caminho em que o painel ofereça exportar e o `pending` derrube a exportação; a decisão de produto está registrada no registro de achados (**auditoria com artefato pendente é exportável**, com recibo `partial` e limitações quando houver). Fica faltando **um teste**, não um conserto: o caminho imutável com recibo parcial, a escrever com RED próprio quando o fluxo de lote rodar em Chrome.

## Decisões que dependem do usuário, não de mim

- **Vocabulário do portão de privacidade** (`SENSITIVE_KEY`): ampliar para "senha", "sessão", "chave" e afins muda a redação de campos legítimos que contenham esses termos. O efeito é sempre fail-closed, mas a lista é uma decisão de produto, e está registrada como tal desde a rodada em que a allowlist de `contenteditable` foi definida.
- **Publicação**: nenhuma ação externa de distribuição foi executada, e nenhuma será sem autorização específica.
