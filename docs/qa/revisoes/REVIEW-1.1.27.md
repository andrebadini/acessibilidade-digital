# Revisão adversarial independente — Audita Acessibilidade 1.1.27

- **Checkout congelado:** `/private/tmp/audita-review-127`, `HEAD d9a67e73d3393aa3d723be97fb7c3c7881aa867e`
- **Artefato medido:** `release/audita-acessibilidade-1.1.27.zip`, SHA-256 `1962d439718a828ae06bcb2b83e382302ccf99efee9ce2aa2961d3995043b586`
- **Produto medido a partir dos bytes empacotados**: extraído em `/private/tmp/adv127/work/ext` (com `test/`, `fixtures/` e `scripts/` copiados para dentro, conforme o brief). Nada foi editado no checkout congelado nem na árvore de desenvolvimento.
- **Chrome:** Chrome for Testing 152.0.7977.64 em `/private/tmp/audita-cft152-fixed` (um workload por vez, perfil temporário isolado, `TMPDIR` padrão).

---

## 1. Veredito

**A 1.1.27 é estritamente melhor que a 1.1.26 — mas NÃO a substitui como candidata aprovada.**

| | Contagem |
|---|---|
| **Critical** | **1** — o mesmo Critical C1 que o incremento declara fechado ainda entrega credencial da página ao modelo, ao relatório e aos artefatos HTML/JSON, medido ponta a ponta nos bytes empacotados, em duas formas comuns de HTML que o fixture do E2E não cobre |
| **Important** | **0** |
| **Minor** | **4** (+ 5 observações) |

O que a 1.1.27 de fato fechou, medido por mim: o **Important** da 1.1.26 (0 caracteres sobreviventes nas cinco formas declaradas, onde a 1.1.26 deixava 180/80/11/80/280), o **M1/A2** (README marca o radical antigo como histórico e aponta o vigente), o **M2/A3** (os seis E2E agora nomeiam `mandatory-journey-mv3`), o **M3/A4** (`compass` preservado sem perder `myPass`/`userPass`), o **A6/O5** na parte que importa (o E2E de exportação virou instrumento não vacuoso — provei por mutação) e o **N1 da 1.1.26** (as cinco caudas estrangeiras voltaram, no JSON e na URL). A monotonicidade do vocabulário contra a 1.1.24 e a 1.1.26 é **real e medida: zero perdas** no meu universo de 95 formas de credencial.

O que impede a substituição: o Critical que a própria 1.1.27 se propôs a fechar **não está fechado**. O tarjador de trecho conserta o caso `senha: X` no mesmo nó de texto, mas quando o rótulo e o valor estão em **nós de texto diferentes** — `<p>senha: <code>X</code></p>` ou `<th>chave:</th><td>X</td>` — a credencial inteira chega ao relatório, ao modelo/revisão guardados e aos artefatos HTML e JSON. Isso é literalmente a mesma classe e as mesmas superfícies do C1, e eu reproduzi a entrega com o código atual do pacote (não com o mutante): basta acrescentar a forma ao fixture. A regra do próprio projeto ("nenhuma versão desta sessão foi declarada candidata com Critical/Important aberto") mantém a 1.1.27 fora do posto de candidata até esse conserto.

Como linha de base de trabalho, porém, a 1.1.27 deve substituir a 1.1.26: em tudo que medi ela é igual ou melhor, com uma única regressão estreita (fragmento de URL com `authorize`, Minor).

---

## 2. Artefato e integridade (item 7 do brief) — tudo reproduzido

```
$ shasum -a 256 release/audita-acessibilidade-1.1.27.zip
1962d439718a828ae06bcb2b83e382302ccf99efee9ce2aa2961d3995043b586   (= esperado)
$ unzip -l ... | tail -3   -> 199 files, 4264019 bytes
```

Reconstrução independente a partir da árvore do commit congelado (sem tocar no checkout):

```
$ git -C /private/tmp/audita-review-127 archive HEAD | tar -x -C work/rebuild
$ node scripts/build-release.mjs
audita-acessibilidade-1.1.27.zip
SHA-256 1962d439718a828ae06bcb2b83e382302ccf99efee9ce2aa2961d3995043b586
```

Pacote ↔ árvore, nos dois sentidos (199 entradas do zip × 199 arquivos de runtime de `manifest.json`+`src/`+`vendor/`+4 ícones, comparados por SHA-256 byte a byte):

```
zip entries: 199        tree runtime files: 199
only in zip: (none)     only in tree: (none)     content differs: (none)
```

Gate declarado (`release-package` + `extension-shell` + `release-assets`), no clone com histórico git:

```
ℹ tests 20   ℹ pass 20   ℹ fail 0
```

A asserção de digest é **não vacuosa**: `test/release-package.test.js:143-145` compara o arquivo entregue em `release/` **e** o pacote reconstruído da árvore contra `1962d439…43b586`. Ou seja, o gate reprova se o fonte andar sem reconstrução e também se o zip entregue for trocado.

`verify-project` estático (com `AUDITA_VERIFY_SKIP_TESTS=1`, como o README manda):

```
verify-project: manifest/CSP e axe 4.13.0 aprovados no Chrome for Testing 152.0.7977.64;
mapa numerado aprovado; 130/146 (96/50), identidade neutra, HTML/JSON/PDF, fixtures e privacidade GREEN
EXIT=0
```

---

## 3. Cada item declarado

### Item 1 — Important da 1.1.26 (valor tarjado): **FECHADO para as cinco formas declaradas; a classe enunciada não está fechada** → ver C1

Comando: `node probes/p9-final.mjs` (sanitizadores das três gerações extraídos por `git show`), medindo caracteres do valor que sobrevivem:

| Entrada | 1.1.24 | 1.1.26 | **1.1.27** |
|---|---|---|---|
| `token: ` + JWT 300 | 0 | **180** | **0** |
| `api_key: ` + 200 `B` | 0 | **80** | **0** |
| `senha: p4ss;word-secreto` | sem tarjamento | **11** (`;word-secreto`) | **0** |
| `authorization: ` + 200 `Z` | 0 | **80** | **0** |
| `chave: ` + 400 `C` | sem tarjamento | **280** | **0** |

O Important está fechado. (O commit cita 213 caracteres para o JWT; com um JWT liso de 300 `A` a 1.1.26 deixa 180 — a diferença é o payload da medição anterior, não o defeito.)

**Quebra da nova métrica — quatro formas em que material sobrevive** (`node probes/p10-corrected.mjs`; métrica corrigida para contar o segredo em **toda** a saída, não só depois de `[redacted]`):

| Entrada | 1.1.24 | 1.1.26 | 1.1.27 | o que sobra |
|---|---|---|---|---|
| `senha: <S3CR3TX9>` | 8/8 | 8/8 | **8/8** | `senha:[redacted]<S3CR3TX9>` |
| `token: <` + 300 `A` + `>` | 300/300 (nem casa) | 300/300 | **300/300** | `token:[redacted]<AAA…>` |
| `{"senha": "S3CR3TX9"}` | 8/8 | 8/8 | **8/8** | intacto, sem nenhum tarjamento |
| `senha: ""S3CR3TX9` | 8/8 | 8/8 | **8/8** | `senha: [redacted]S3CR3TX9` |
| `senha: "S3CR3TX9" tail-S3CR3TX9` | 8/8 | 8/8 | **8/8** | `senha: [redacted] tailS3CR3TX9` |
| `senha: p4<S3CR3TX9` | 8/8 | 8/8 | **8/8** | `senha: [redacted]<S3CR3TX9` |
| `senha -> S3CR3TX9` | 8/8 | 8/8 | **8/8** | sem tarjamento (`->` não é `[:=]`) |

Causa raiz única: `VALUE_SOURCE = (?:"[^"]*"|'[^']*'|[^\n<]+)` (src/core/privacy.js:48). O `[^\n<]+` é **obrigatório** e não pode começar em `<`; quando o valor começa com `<`, o motor faz backtracking do separador e casa só o espaço — inserindo `[redacted]` **ao lado do valor intacto**. As formas entre aspas consomem só até a aspa de fechamento, devolvendo a cauda. O caso JSON não casa porque a aspa de fechamento da chave fica entre o rótulo e `:`.

**Agravante específico desta versão:** a saída contém `[redacted]` **e** o segredo. Um instrumento que decida "tarjado" pela presença do marcador perto do rótulo classifica essas formas como limpas — a mesma classe de vacuidade do A6 da revisão da 1.1.26, agora com um marcador que engana.

**Não vazam** (medidos): `\r`, separador NBSP, U+2028, tabulação, `=`, `==`, espaço antes dos dois pontos, `\\n` literal, quebra de linha real, `Bearer`, URL com userinfo, `?senha=`/`?pass=` no texto e via `sanitizeEvidenceUrl`, JSON aninhado por chave, chaves repetidas, valor em atributo HTML (o atributo inteiro é descartado pela regra de menção).

**Observação (comentário × código).** O comentário novo (privacy.js:41-42) afirma "A fronteira à direita continua, porque o rótulo precisa terminar antes do separador", mas a 1.1.27 **removeu o `\b`** que existia nas três versões anteriores (`\b(...)\b(\s*[:=]\s*)` → `(...)(\s*[:=]\s*)`). É inócuo — o próprio `[:=]` faz a fronteira — mas é documentação que descreve um código que não existe, no arquivo que o incremento reescreveu.

### Item 2 — Vocabulário unificado e monotonicidade: **REPRODUZIDO, zero perdas**

Comando: `node probes/p3-mono.mjs` (95 formas de credencial × 48 palavras inocentes × 3 gerações, testando o caminho de **chave** e o de **rótulo de valor**), mais `node probes/p4-vocab.mjs` para o vocabulário do próprio produto.

```
=== LOSSES in 1.1.27 (credential form caught before, missed now) ===
(none)
```

- **Zero perdas** contra a 1.1.26 e contra a 1.1.24, em chave e em rótulo.
- **Ganhas confirmadas**: as 8 grafias da N1 (`motdepasse`, `passwrd`, `passw0rd`, `palavra-passe`, `palavrapasse`, `frase-passe`, `frasepasse`, `passwort`) e as caudas estrangeiras (`passkod`, `passkode`, `passfrase`, `passsatz`, `passpasse`, `passwörter`, `passworter`), além de ganhos no rótulo que a 1.1.26 não tinha (`authToken`, `authTokens`, `oauth`, `oauth_token`, `hotp`, `totp`, `one-time`, `pass_word`, `authorizations`, `authorisation`).
- **Vocabulário do produto** (14.749 identificadores distintos — o mesmo universo da revisão da 1.1.26): 1.1.24 = 344 casam, 1.1.26 = 321, 1.1.27 = 242. A família `auth` cai de **106 → 24** identificadores (82 recuperados), incluindo `authorityExpiresAt`, `authorizedAt` e `firstAuthorization`… que na verdade **continua tarjado** (contém `authorization`, que é uma forma de credencial) — a recuperação medida é dos `author*`/`authority*`/`authorize*`, correta.
- **Falsos positivos novos no rótulo** (6, nenhum identificador do produto afetado): `surpass`, `trespass`, `overpass`, `underpass` (já eram FP de chave na 1.1.26) e `obsessão`/`obsessao`, que passaram a ser tarjados por causa da remoção do `\b` à esquerda (`sessão` casa como sufixo). Precisam de `:`/`=` logo depois para morder. **Observação**, não achado.

### Item 3 — Critical C1: **mutação REPRODUZIDA e não vacuidade CONFIRMADA; a classe, porém, não está fechada**

Mutação (cópia minha em `/private/tmp/adv127/work/mut`, `src/core/evidence/snippet.js` trocado pelo da 1.1.26 via `git show b54b673:...`), E2E rodado nos bytes empacotados:

```
✖ current-page audit exports four verified artifacts
  AssertionError: credencial da página chegou ao entregável em:
  relatório, modelo e revisão guardados, artefato html, artefato json
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

Com o código atual (bytes do pacote), o mesmo arquivo:

```
✔ current-page audit exports four verified artifacts (4329.225333ms)
ℹ segredos varridos=3; superfícies=9
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

**Não vacuidade:** o teste prova a fonte antes de varrer — `test/e2e/current-page-export-mv3.test.mjs:190` exige `rawPage.includes(CREDENTIAL) && rawPage.includes('4111 1111 1111 1111')` — e o fixture realmente contém `senha: S3GR3D0XYZQ` em texto, `cartão: 4111 1111 1111 1111`, `chave: …` em atributo e a credencial na URL. Eu estendi o fixture com dois sentinelas meus (`N3ST3D-S3CR3T-7Q` em `<code>` e `T4BL3-S3CR3T-9Z` em `<td>`) e a asserção de não vacuidade disparou para eles também, o que confirma que a prova de fonte funciona e não é decorativa. O PDF fica fora da varredura **declaradamente** (fluxo binário comprimido) — correto.

### Item 4 — `auth(?!or)` e `(?<!by)(?<!com)pass`: **cobertura REPRODUZIDA; uma piora de privacidade medida**

Cobertura (todas tarjadas em 1.1.27, no JSON e no rótulo): `auth`, `authorization`, `authorizations`, `authorisation`, `authorisations`, `authentication`, `authToken`, `authTokens`, `oauth`, `oauth2`, `oauth_token`, `authorization_code`. Preservadas: `author`, `authors`, `authority`, `authorities`, `authorized`, `authorize`, `authoring`, `authored`, `authorship`, `authoritative`, `coauthor`, `authory`. `compass`, `compassion`, `encompass` preservados; `myPass`, `userPass`, `newPassword`, `oldPassword`, `compassword` continuam tarjados.

**Piora de privacidade (Minor, regressão):** o teste do fragmento de URL é o mesmo `SENSITIVE_KEY`, e o fragmento só é apagado quando alguma palavra casa. Medido com sentinela neutro `Zq7Xk2` (`node probes/p10-corrected.mjs`):

| URL | 1.1.24 | 1.1.26 | 1.1.27 |
|---|---|---|---|
| `https://h/cb#/authorize?code=Zq7Xk2` | clears | clears | **KEEPS** |
| `https://h/cb#author=Zq7Xk2` | clears | clears | **KEEPS** |
| `https://h/cb#compass=Zq7Xk2` | clears | clears | **KEEPS** |
| `https://h/cb#passkod=Zq7Xk2` | clears | KEEPS | clears |
| `https://h/cb#/oauth/authorize?code=Zq7Xk2` | clears | clears | clears |

`#author=` e `#compass=` são o trade-off declarado (palavra inocente preservada). O caso `#/authorize?code=…` **não é declarado**: um fragmento de callback OAuth de SPA (rota `/authorize` com `code=`) passa a sobreviver inteiro à URL entregue, onde as duas gerações anteriores o apagavam. Alcance estreito (exige a palavra `authoriz*` no fragmento) — Minor, não bloqueante.

### Item 5 — 8 grafias e caudas estrangeiras no JSON **e** na URL: **CONFIRMADO**

`sanitizeJsonData({chave:'x'})` e `sanitizeEvidenceUrl('https://h/?chave=Zq7Sentinel')`, 1.1.27 × 1.1.26:

```
passkod   1.1.26=LEAK  1.1.27=ok        motdepasse   1.1.26=ok  1.1.27=ok
passkode  1.1.26=LEAK  1.1.27=ok        passwrd      1.1.26=ok  1.1.27=ok
passfrase 1.1.26=LEAK  1.1.27=ok        passw0rd     1.1.26=ok  1.1.27=ok
passsatz  1.1.26=LEAK  1.1.27=ok        palavra-passe/frase-passe/frasepasse/passwort  ok em ambas
passpasse 1.1.26=LEAK  1.1.27=ok        passwörter   1.1.26=LEAK  1.1.27=ok
```

**Lacuna pré-existente que o "plurais" da declaração não cobre** (idêntica nas três gerações, chave, rótulo, JSON e URL):

```
credenciais   LEAK em 1.1.24/1.1.26/1.1.27      cartões/cartoes        LEAK nas três
sessões/sessoes LEAK nas três                    autorizações           LEAK nas três
senhas / chaves / segredos: LEAK como RÓTULO (em chave de JSON são tarjados por substring)
```

São plurais portugueses que não contêm o singular como substring (`credencial`→`credenciais`, `sess[ãa]o`→`sessões`, `cart[ãa]o`→`cartões`, `autoriza[çc][ãa]o`→`autorizações`). Precedente: a própria declaração diz que o plural entrou por causa de `passwords`/`passcodes`. Minor.

### Item 6 — Números declarados

| Alegação | Comando | Medido | Veredito |
|---|---|---|---|
| Suíte sem `test/e2e/`: **4.156** testes, 4.154 passam, 1 pulado, 0 falham | `node --test $(todas as 177 listas menos test/e2e/)` no clone com histórico | **tests 4156, pass 4155, fail 0, skipped 1** (41,1 s) | **Total REPRODUZIDO exatamente**; a divisão está off-by-one: passam **4.155**, não 4.154 |
| (contexto) plano paralelo do runner | 179 arquivos | tests 4200, pass 4199, fail 0, skipped 1 | 0 falhas confirmado |
| Gate `release-package`+`extension-shell`+`release-assets` **20/20** com digest fixado | `node --test --test-concurrency=1` dos três | **20/20**, digest conferido no entregue e na reconstrução | **REPRODUZIDO** |
| Fase serial 35 arquivos: **34 verdes**, único vermelho `sidepanel-flow-mv3` | `node --test --test-concurrency=1` dos 35 | corrida 1: 8 falhas em `sidepanel-flow-mv3`(6)+`url-pixel-consent`(1)+`axe-mv3-csp`(1); corrida 2: 10 falhas nos mesmos 3 arquivos, incluindo `retention-indexeddb` | **NÃO reproduzido literalmente**; os vermelhos extras **passam isolados** (`axe-mv3-csp` 1/1, `url-pixel-consent` 10/10, `retention-indexeddb` 11/11) → são flakiness de carga do meu ambiente, não defeito de produto |
| Google real do pacote: 0 falhas, **1 alerta**, **3 suspeitas**, 9 positivos, 109 no checklist, 28,5%, 9,0/10, 18 páginas, 4 exportações, versão 1.1.27 | driver próprio (`/private/tmp/adv127/google-mine.mjs`) contra `/private/tmp/adv127/work/ext` | `version 1.1.27`; `0 verificações com falha confirmada`; `Recomendações e alertas: 1`; `Suspeitas a confirmar: 3`; `9 Resultados positivos`; `Checklist separado: 109`; `Cobertura automática: 28,5%`; `motor próprio 9,0 / 10`; PDF 18 páginas; 4 downloads `complete`; 0 frases legais | **REPRODUZIDO** |
| ~4,35 s nas quatro exportações | idem | 4/4 `complete`; espera dos downloads **2,03 s**, jornada total do teste 6,0 s | Substância confirmada; o número é dependente de ambiente |
| Artefato entregue: **146/146 ids e títulos**, 0 palavras partidas, notas **5/5** no PDF e no HTML, proveniência nos dois | `artcheck.py` (pypdf) sobre os meus artefatos e sobre os do autor | 146 itens, 146 ids únicos, 146 títulos; **0 ids e 0 títulos ausentes no HTML e no PDF**; 18 páginas; notas **5/5 no HTML e 5/5 no PDF**; `canonicalModelHash`, `exportDeliveryIdentity.modelHash`, `auditId` e a versão presentes nos dois | **REPRODUZIDO** |
| "28 formas" na métrica da classe | leitura dos literais do teste | **24** (14 em `formas` + 10 rótulos) | número superestimado |
| "dezesseis palavras legítimas recuperadas" | idem, teste da família `auth` | lista `inocentes` tem **15** itens; a varredura do produto mede **82** identificadores `author*` recuperados | número não reproduzível |
| "314 tokens do produto" casados pelo `auth` nu | meu scan do mesmo universo (14.749 identificadores) | 1.1.26 casa **321** identificadores distintos no total e **106** da família `auth` | **não reproduzido** (o universo é o mesmo; a ordem de grandeza é a mesma) |

### Item 7 — Integridade do artefato: **REPRODUZIDO** (ver §2)

---

## 4. Achados

### C1 — **Critical** (pré-existente, não é regressão desta versão; a alegação de classe fechada não se sustenta)

**Descrição.** O Critical que a 1.1.27 declara fechado continua aberto em duas formas comuns de HTML: quando o rótulo e o valor estão em **nós de texto diferentes**. O `sanitizeHtmlSnippetSource` tarja nó a nó, e nem o rótulo nem o valor, sozinhos, casam a regra `(rótulo)([:=])(valor)`.

**Medição 1 — sanitizador empacotado** (`node /tmp/adv127-residual.mjs`):

```
ok    | plain text node (E2E fixture form) | "<p id=\"credential-text\">senha: [redacted]</p>"
LEAK  | nested inline element            | "<p id=\"credential-nested\">senha:[redacted]<code>S3GR3D0XYZQ</code></p>"
LEAK  | bold nested                      | "<p>senha:[redacted]<b>S3GR3D0XYZQ</b></p>"
LEAK  | table label/value pair           | "<table><tr><th>chave:</th><td>S3GR3D0XYZQ</td></tr></table>"
LEAK  | dl label/value pair              | "<dl><dt>senha:</dt><dd>S3GR3D0XYZQ</dd></dl>"
LEAK  | JSON text node                   | "<pre>{\"senha\": \"S3GR3D0XYZQ\"}</pre>"
ok    | attribute (protected)            | "<div>x</div>"
```

**Medição 2 — ponta a ponta nos bytes empacotados.** Copiei o pacote extraído para `work/residual`, acrescentei ao fixture **apenas** duas formas (`senha: <code>N3ST3D-S3CR3T-7Q</code>` e `<th>chave:</th><td>T4BL3-S3CR3T-9Z</td>`), com prova de não vacuidade própria, e rodei o E2E **com o sanitizador atual do pacote**:

```
$ node --test --test-concurrency=1 test/e2e/current-page-export-mv3.test.mjs
✖ current-page audit exports four verified artifacts (5914.278209ms)
  AssertionError: credencial da página chegou ao entregável em:
  relatório [nested-inline], relatório [table-pair],
  modelo e revisão guardados [nested-inline], modelo e revisão guardados [table-pair],
  artefato html [nested-inline], artefato html [table-pair],
  artefato json [nested-inline], artefato json [table-pair]
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

Não é o mutante: `work/residual/src/core/evidence/snippet.js` é byte a byte o do pacote; o que mudou foi só o fixture (eu **reforcei** o teste, não enfraqueci).

**Por que é Critical e não Important.** A severidade do C1 original foi dada exatamente por "a credencial chega ao modelo guardado, ao relatório e aos artefatos HTML/JSON entregues". É o que esta medição mostra, nos mesmos quatro nomes de superfície. A forma `<th>chave:</th><td>valor</td>` é o layout mais comum de credencial em HTML — tabela de configuração, `<dl>` de propriedades, `<pre>` com JSON de resposta.

**Por que a métrica não pegou.** Os dois testes novos afirmam ser "a métrica da classe", mas nenhum exercita o caso entre elementos: `test/core/privacy.test.js` cobre 14 formas de valor + 10 rótulos e `test/evidence/snippet.test.js` cobre 11 casos; em nenhum deles o rótulo e o valor estão separados por marcação. O E2E cobre `senha: X` no mesmo nó de texto. Os três ficam verdes porque a forma que falha não está neles.

**Caminho exato do conserto recomendado (não aplicado):**
1. `src/core/privacy.js:48` — `VALUE_SOURCE` passa a `(?:"[^"]*"|'[^']*'|[^\n]+)` (tirar o `<` da classe) e o padrão do `.replace` da linha 199 ganha a aspa opcional de fechamento antes do separador, consumindo até o fim da linha: `` new RegExp(`(${VALUE_LABEL_SOURCE})("?)(\\s*[:=]\\s*)[^\\n]*`, 'giu') `` com substituição `'$1$2$3[redacted]'`. Validei esta variante em rascunho fora do produto (`probes/p11-proposed-fix.mjs`): fecha as **quatro** formas medidas (inclusive o JWT de 300 entre `<>`), mantém `author:`, `compass:`, `login:` e prosa sem rótulo intactos, e mantém zero sobreviventes nas cinco formas declaradas e nos casos `;`/multi-token.
2. `src/core/evidence/snippet.js` — o caso entre nós de texto não é resolvível por regex dentro de um nó. O arquivo **já tem o mecanismo pronto**: `pendingPrivateRoot` (linhas ~198-235) descarta o conteúdo do próximo elemento. Basta marcar esse estado quando um trecho de texto terminar em rótulo sensível + separador — `if (/(?:VALUE_LABEL)\s*[:=]\s*$/u.test(textRun)) pendingPrivateRoot = true;` — antes de emitir o próximo elemento. Isso é fail-closed (o valor some do trecho) e reaproveita o caminho existente de `privateTextDescendant`, sem inventar maquinário novo.
3. Prova: estender o fixture do E2E com `<p>senha: <code>X</code></p>` e `<th>chave:</th><td>X</td>` — é literalmente o patch que usei em `work/residual`. Sem isso, o portão continua sem cobrir a classe.

### M1 — **Minor**: plurais portugueses continuam fora do vocabulário (pré-existente, igual nas três gerações)

Medição: tabela do item 5. `credenciais`, `sessões`/`sessoes`, `cartões`/`cartoes`, `autorizações`, `autenticações` sobrevivem em chave de JSON, rótulo de texto **e** URL; `senhas`, `chaves`, `segredos` sobrevivem como rótulo. Não é regressão (a 1.1.24 e a 1.1.26 fazem igual), mas a declaração "os plurais" só vale para as formas do radical estrangeiro. Conserto: acrescentar as flexões (`credencia(is|ial)`, `sess(ão|ões)`, `cart(ão|ões)`, `autoriza(ção|ções)`, `autentica(ção|ções)`) — sem custo de falso positivo, porque nenhuma palavra inocente do produto casa esses radicais.

### M2 — **Minor**: a cauda do **mesmo fragmento** de texto legítimo é engolida (declarado, mas com dano medido em texto realista)

O preço do consumo até o fim é declarado em teste. Medido no sanitizador empacotado:

```
"<p>Senha: use pelo menos 8 caracteres. Veja nossas dicas de segurança.</p>"
  -> "<p>Senha: [redacted]</p>"            (perdeu 60 caracteres de texto de ajuda do formulário)
"<label>Sessão: expira em 30 minutos</label>"  -> "<label>Sessão: [redacted]</label>"
"<p>senha: <b>S3GR3D0XYZQ</b></p>"        -> o valor sobrevive (é o C1)
```

É a escolha fail-closed do autor e está fixada em teste; registro como Minor porque é perda de evidência em texto de interface comum ("Senha: use pelo menos 8 caracteres") e porque **nenhuma medição de alcance foi feita em artefato entregue** — nos artefatos do Google a varredura dá **0 ocorrências de `[redacted]`**, ou seja, esse caminho não é exercido lá. Alcance não provado, declarado como tal.

### M3 — **Minor**: fragmento de URL com `authorize` deixa de ser apagado (regressão desta versão)

Medição no item 4. `https://h/cb#/authorize?code=<segredo>` era apagado pela 1.1.24 e pela 1.1.26 e passa a ser preservado pela 1.1.27, porque o teste do fragmento usa o mesmo `SENSITIVE_KEY` e `auth(?!or)` deixou de casar `authorize`. Conserto: manter o vocabulário estrito do rótulo e, **só para o teste de fragmento** (privacy.js:175 e o equivalente em `snippet.js:sanitizeUrl`), usar `SENSITIVE_KEY` **ou** `/authori[sz]/iu` — é fail-closed e não reabre o falso positivo do `author`, que continua preservado como chave.

### M4 — **Minor**: números sem escopo, recorrência da mesma classe que o incremento diz fechar

- "**28 formas**" (commit, README e dois docs de QA) × **24** literais no teste (14 + 10).
- "**dezesseis** palavras legítimas recuperadas" × **15** itens na lista `inocentes` do teste; e a varredura do produto mede **82** identificadores `author*` recuperados.
- "**4.154 passam**" × **4.155** passam (4.156 = 4.155 + 1 pulado + 0 falhas).
- "**314 tokens** do produto" × **321** identificadores distintos no mesmo universo de 14.749 (família `auth`: 106, dos quais 82 recuperados).
- "Fase serial **34/35**" × duas corridas minhas com 8 e 10 falhas em 2–3 arquivos (todas as extras passam isoladas).

A 1.1.26 tinha exatamente dois Minors desta classe (M4 "17→16" e M5 "4.148→4.193"). É o mesmo defeito, no incremento que se propõe a fechá-lo.

### Observações (não pontuadas)

- **O1.** `src/core/privacy.js:41-42` afirma que "a fronteira à direita continua"; o `\b` foi removido e não existe no padrão novo. Inócuo (o separador faz a fronteira), mas é comentário descrevendo código inexistente.
- **O2.** Os seis falsos positivos novos de rótulo (`surpass`, `trespass`, `overpass`, `underpass`, `obsessão`, `obsessao`) decorrem da remoção do `\b` à esquerda; nenhum identificador do produto é afetado, e todos exigem `:`/`=` logo depois.
- **O3.** O Critical da 1.1.27 foi encontrado porque a varredura anterior era vacuosa. A varredura do artefato Google **continua vacuosa**: 0 `[redacted]` em JSON e HTML entregues, 0 pares rótulo/valor sensíveis na página. O instrumento que discrimina hoje é só o E2E — e ele não cobre a classe do C1. Um instrumento de varredura que decida "tarjado" pela presença de `[redacted]` **classifica como limpas** as formas `<valor>` e `""valor`, onde o marcador aparece ao lado do segredo intacto (medido).
- **O4.** O teste `test/panel/panel-detail.test.js` foi ajustado movendo `conteúdo público` para outro elemento e trocando `authorization=\[redacted\] token=\[redacted\]` por `authorization=\[redacted\]` + `doesNotMatch(/token=/)`. **Não é enfraquecimento** — a asserção negativa ficou mais forte e cobre o que o consumo até o fim passou a engolir. Registro porque é a mesma adaptação que esconde o preço do M2, e ela está declarada.
- **O5.** O `release/audita-acessibilidade-1.1.27.zip` está **não rastreado** no checkout congelado (todas as versões anteriores, de 1.0.1 a 1.1.26, são rastreadas). Consequência: `git status --porcelain` do checkout congelado **não** está vazio — contém exatamente `?? release/audita-acessibilidade-1.1.27.zip`. Não é defeito de produto; é higiene do artefato (o zip revisado não fica preservado no histórico, ao contrário dos anteriores).

---

## 5. Retratações

Acusações ou suspeitas minhas que a medição **não** sustentou:

1. **"A alegação de mutação do autor pode ser falsa."** Minha primeira execução do E2E mutado terminou com `exit code: 0` e eu quase registrei isso como refutação. Era **erro meu de cano**: o `exit code` era do `tail` no fim do pipe, não do `node --test`. O log dizia `✖ ... fail 1` com a asserção nomeando as quatro superfícies. A alegação do autor está **correta**.
2. **"O Critical não existe / a fixture é vacuosa."** Refutado por medição: a fixture contém a credencial e o teste prova isso antes de varrer (`rawPage.includes(CREDENTIAL)`), inclusive para os sentinelas que eu acrescentei.
3. **"A fase serial reprova em arquivos do produto."** Minhas duas corridas deram 2–3 arquivos vermelhos, mas `axe-mv3-csp` (1/1), `url-pixel-consent` (10/10) e `retention-indexeddb` (11/11) **passam isolados** no mesmo binário e no mesmo clone. São falhas de carga/tempo do meu ambiente (`WAIT_TIMEOUT`, `CDP_COMMAND_TIMEOUT`, limpeza de perfil), não defeito de produto — retiro qualquer acusação nessa direção. Fica só a nota de que a linha "34/35" não é reproduzível literalmente aqui.
4. **"`verify-project` está vermelho."** Minha primeira execução falhou porque o script roda `npm test` internamente, que inclui a fase serial com o arquivo vermelho conhecido. Com `AUDITA_VERIFY_SKIP_TESTS=1`, como o README manda, o estático é **verde** (`130/146 (96/50)`, identidade neutra). A alegação do autor está correta na acepção declarada.
5. **"O fragmento de URL regride em `#author=` e `#compass=`."** Sustentei por um momento que a mudança "piora a privacidade" nesses dois; são exatamente as preservações **deliberadas e declaradas** (palavra inocente). O achado que sobra é o `#/authorize?code=`, que não é declarado (M3).
6. **Métrica minha enviesada.** A primeira versão da minha tabela de sobreviventes contava caracteres só **depois** de `[redacted]`, então "sem tarjamento nenhum" aparecia como `0/8` (limpo). Corrigi para contar o segredo em toda a saída e a tabela do item 1 é a corrigida. A mesma correção invalidou uma medição de URL em que o meu próprio sentinela (`SECRET1`) continha `secret` e fazia o produto apagar o fragmento por conta dele — refeita com `Zq7Xk2`.
7. **"O commit cita 213 caracteres e a README 180 — uma das duas está errada."** Com um JWT liso de 300 caracteres a 1.1.26 deixa **180**; o 213 vem do payload específico da revisão anterior. Não é contradição relevante; cito o meu número.

---

## 6. O que eu não medi (risco residual)

1. **Os instrumentos do autor.** Não rodei `google-pkg127.mjs`, o "instrumento calibrado" do artefato nem o comparador de 5.943 sondas — construí os meus (`artcheck.py`, `google-mine.mjs`, `p3-mono.mjs`, `p11-proposed-fix.mjs`). Onde os meus números divergem dos dele, a divergência está reportada com o método.
2. **A suíte dentro do pacote extraído.** `test/personas/preview-runtime-parity.test.js` executa `git show 78ba813:...`, então a suíte completa **não roda** na raiz extraída (sem `.git`). Rodei no clone com histórico do mesmo commit — primeira corrida minha deu 1 falha exatamente por isso, e a atribuo ao meu harness, não ao produto.
3. **A fase serial completa e o `sidepanel-flow-mv3` isolado.** Não rodei esse arquivo sozinho (é o vermelho conhecido de outro incremento, ~10 min). Confirmei que ele está **modificado na árvore de desenvolvimento** (`M test/e2e/sidepanel-flow-mv3.test.mjs`, +87/−8 contra `e6c2619`) — a explicação do autor para não editá-lo é verdadeira —, mas **não** medi se as falhas vêm da modificação: a versão **do commit congelado** também falha no meu ambiente.
4. **"0 palavras partidas" no PDF.** Verifiquei que os 146 ids e os 146 títulos aparecem **contíguos** no texto extraído do PDF (é o detector que pegaria `Recomendaçã` + `o ABNT`), e que o PDF tem 18 páginas. Não rodei um detector de quebra de palavra com hifenização sobre o PDF inteiro.
5. **Alcance real do C1 fora do fixture.** Provei a entrega com um fixture sintético (realista, mas sintético) num servidor local. Não encontrei nem auditei uma página pública que exiba credencial em `<th>/<td>`; o alcance depende disso.
6. **Contagem de ocorrências das 3 suspeitas** ("4 ocorrências"): confirmei `3 verificações` nos meus artefatos entregues, mas não contei as ocorrências separadamente.
7. **Notas editoriais por outro caminho**: confirmei as 5 notas no JSON, no HTML e no PDF entregues; não testei a redação manual de uma nota pelo painel.
8. **Números históricos de 1.1.16–1.1.22**, `store-assets/`, o motor axe e o mapeamento WCAG (fora do delta).
9. **Duas execuções ao vivo do Google em momentos diferentes** para separar variação de rede das contagens; rodei uma vez (os números bateram com os do autor).

---

## 7. Isolamento e checkout congelado

```
$ git -C /private/tmp/audita-review-127 rev-parse HEAD
d9a67e73d3393aa3d723be97fb7c3c7881aa867e
$ git -C /private/tmp/audita-review-127 status --porcelain
?? release/audita-acessibilidade-1.1.27.zip
```

O checkout congelado terminou **intocado por mim**: HEAD ainda `d9a67e7` e a única entrada de status é o próprio zip sob revisão, que já estava lá antes de eu começar (untracked em `d9a67e7`; as versões 1.0.1–1.1.26 são rastreadas). Nada foi editado no checkout nem na árvore de desenvolvimento `/Volumes/SSD1/acessibilidade-digital/.worktrees/audita-mt` — todas as mutações, patches de fixture e reconstruções rodaram em cópias minhas sob `/private/tmp/adv127/`. Todos os E2E rodaram com **um** workload de Chrome por vez, perfil temporário isolado e binário Chrome for Testing 152.0.7977.64 de `/private/tmp/audita-cft152-fixed`. Nada foi publicado nem enviado a serviço externo; a única requisição de rede foi a leitura de `https://www.google.com/` pelo próprio produto, no percurso de auditoria, e nenhum dado privado de sessão foi lido ou registrado.
